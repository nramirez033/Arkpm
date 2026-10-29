package com.ark.arkpm

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import android.util.Base64
import android.view.WindowManager
import androidx.activity.result.ActivityResult
import androidx.core.content.ContextCompat
import androidx.documentfile.provider.DocumentFile
import com.getcapacitor.PermissionState
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import com.jcraft.jsch.Channel
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.ChannelSftp
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import com.jcraft.jsch.SftpException
import com.jcraft.jsch.SftpProgressMonitor
import com.jcraft.jsch.UserInfo
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.InputStream
import java.io.InputStreamReader
import java.io.OutputStream
import java.security.MessageDigest
import java.security.Security
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicLong

/**
 * SSH / SFTP para Arkpm en Android (JSch). Misma interfaz que electron/ssh.js:
 * connect, exec, streams (logs en vivo), listado y lectura/escritura SFTP, subida y descarga con progreso,
 * selector de archivos (SAF) y almacén de secretos con Android Keystore.
 *
 * Todas las operaciones se ejecutan fuera del hilo de Capacitor (que es único) para que un comando largo no bloquee a los demás.
 */
@CapacitorPlugin(name = "ArkpmSsh", permissions = [Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications")])
class ArkpmSshPlugin : Plugin() {

    private class Sess(val id: String, val session: Session) {
        val lock = Any()
        @Volatile var sftp: ChannelSftp? = null
    }

    private class Job {
        @Volatile var cancelled = false
        val channels = CopyOnWriteArrayList<Channel>()
    }

    private val sessions = ConcurrentHashMap<String, Sess>()
    private val streams = ConcurrentHashMap<String, Channel>()
    private val jobs = ConcurrentHashMap<String, Job>()
    private val pool = Executors.newCachedThreadPool()
    private val sched: ScheduledExecutorService = Executors.newSingleThreadScheduledExecutor()
    private val busy = AtomicInteger(0)

    override fun load() {
        // El proveedor «BC» recortado de Android no sabe de Ed25519/X25519:
        // se reemplaza por BouncyCastle completo.
        try {
            Security.removeProvider("BC")
            Security.insertProviderAt(
                org.bouncycastle.jce.provider.BouncyCastleProvider(),
                1
            )
        } catch (_: Throwable) {
            // Sin BouncyCastle: se usan los algoritmos del sistema.
        }

        MonitorEngine.start(context)

        // Avisa a la app cuando una sesión se cae (red, servidor reiniciado…).
        sched.scheduleWithFixedDelay({
            for ((id, s) in sessions) {
                if (!s.session.isConnected) {
                    sessions.remove(id)
                    notifyListeners("closed", JSObject().put("sessionId", id))
                }
            }
        }, 5, 5, TimeUnit.SECONDS)
    }

    override fun handleOnDestroy() {
        for (s in sessions.values) {
            try {
                s.session.disconnect()
            } catch (_: Throwable) {
            }
        }

        sessions.clear()
        pool.shutdownNow()
        sched.shutdownNow()

        if (!MonitorEngine.backgroundOn(context)) {
            MonitorEngine.stop()
        }
    }

    // ------------------------------------------------------------------
    // Utilidades

    private fun bg(call: PluginCall, block: () -> Unit) {
        pool.execute {
            try {
                block()
            } catch (e: Throwable) {
                call.reject(clean(e))
            }
        }
    }

    private fun clean(e: Throwable): String {
        val m = e.message ?: e.toString()

        return when {
            e is SftpException &&
                e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE ->
                "No existe en el servidor: $m"

            e is SftpException &&
                e.id == ChannelSftp.SSH_FX_PERMISSION_DENIED ->
                "Permiso denegado en el servidor"

            else -> m
        }
    }

    private fun sess(call: PluginCall): Sess {
        val s = sessions[call.data.optString("sessionId")]

        if (s == null || !s.session.isConnected) {
            throw IllegalStateException(
                "Sesión SSH cerrada. Vuelve a conectar."
            )
        }

        return s
    }

    private fun str(call: PluginCall, k: String): String? =
        call.data.optString(k, "").ifEmpty { null }

    private fun sq(s: String) =
        "'" + s.replace("'", "'\\''") + "'"

    private fun fingerprint(blob: ByteArray) =
        "SHA256:" + Base64.encodeToString(
            MessageDigest.getInstance("SHA-256").digest(blob),
            Base64.NO_PADDING or Base64.NO_WRAP
        )

    /**
     * Mantiene la pantalla encendida mientras haya transferencias
     * (Android puede congelar la app en segundo plano).
     */
    private fun keepAwake(on: Boolean) {
        val n = if (on) busy.incrementAndGet() else busy.decrementAndGet()

        activity?.runOnUiThread {
            val w = activity?.window ?: return@runOnUiThread

            if (n > 0) {
                w.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                w.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    private class Capped(val max: Int) : OutputStream() {
        val buf = ByteArrayOutputStream()

        override fun write(b: Int) {
            if (buf.size() < max) buf.write(b)
        }

        override fun write(b: ByteArray, off: Int, len: Int) {
            val room = max - buf.size()
            if (room > 0) buf.write(b, off, minOf(len, room))
        }
    }

    private fun runExec(
        s: Sess,
        cmd: String,
        stdin: String?,
        timeoutMs: Long
    ): JSObject {
        val ch = s.session.openChannel("exec") as ChannelExec
        val out = Capped(32 * 1024 * 1024)
        val err = Capped(4 * 1024 * 1024)

        ch.setCommand(cmd)
        ch.setOutputStream(out)
        ch.setErrStream(err)
        ch.setInputStream(
            ByteArrayInputStream((stdin ?: "").toByteArray())
        )
        ch.connect(15000)

        val deadline = System.currentTimeMillis() + timeoutMs

        try {
            while (!ch.isClosed) {
                if (
                    timeoutMs > 0 &&
                    System.currentTimeMillis() > deadline
                ) {
                    throw IllegalStateException(
                        "Tiempo de espera agotado"
                    )
                }

                Thread.sleep(20)
            }
        } finally {
            ch.disconnect()
        }

        val code = ch.exitStatus.let {
            if (it < 0) 128 else it
        }

        return JSObject()
            .put("code", code)
            .put("stdout", out.buf.toString("UTF-8"))
            .put("stderr", err.buf.toString("UTF-8"))
    }

    private fun openSftp(s: Sess): ChannelSftp {
        val c = s.session.openChannel("sftp") as ChannelSftp
        c.connect(15000)
        return c
    }

    private fun sharedSftp(s: Sess): ChannelSftp {
        s.sftp?.let {
            if (it.isConnected && !it.isClosed) return it
        }

        val c = openSftp(s)
        s.sftp = c
        return c
    }

    // ------------------------------------------------------------------
    // Conexión SSH

    @PluginMethod
    fun connect(call: PluginCall) = bg(call) {
        val host = call.data.getString("host")
        val port = call.data.optInt("port", 22)
        val user = call.data.getString("username")
        val password = str(call, "password")
        val key = str(call, "privateKey")
        val pass = str(call, "passphrase")
        val expected = str(call, "expectedFingerprint")

        fun fail(
            code: String,
            msg: String,
            fp: String? = null
        ) = call.resolve(
            JSObject()
                .put("ok", false)
                .put("code", code)
                .put("message", msg)
                .apply {
                    if (fp != null) put("fingerprint", fp)
                }
        )

        val jsch = JSch()

        if (key != null) {
            try {
                val kp = KeyPair.load(
                    jsch,
                    key.toByteArray(),
                    null
                )

                if (kp.isEncrypted && (pass == null || !kp.decrypt(pass))) {
                    kp.dispose()

                    return@bg fail(
                        "KEY_PASSPHRASE",
                        if (pass == null) {
                            "La clave privada está cifrada: indica su frase de contraseña"
                        } else {
                            "La frase de contraseña no abre la clave"
                        }
                    )
                }

                kp.dispose()

                jsch.addIdentity(
                    "arkpm",
                    key.toByteArray(),
                    null,
                    pass?.toByteArray()
                )
            } catch (e: JSchException) {
                return@bg fail(
                    "NETWORK",
                    "No se pudo leer la clave privada (${e.message}). " +
                        "Si es Ed25519 y falla, genera una RSA/ECDSA: ssh-keygen -t ecdsa"
                )
            }
        }

        var seen: String? = null
        var issue: String? = null

        jsch.hostKeyRepository = object : HostKeyRepository {

            override fun check(h: String?, k: ByteArray?): Int {
                val fp = fingerprint(k ?: ByteArray(0))
                seen = fp

                if (expected != null && expected == fp) {
                    return HostKeyRepository.OK
                }

                issue = if (expected == null) {
                    "HOSTKEY_UNKNOWN"
                } else {
                    "HOSTKEY_CHANGED"
                }

                return HostKeyRepository.NOT_INCLUDED
            }

            override fun add(hostkey: HostKey?, ui: UserInfo?) {}

            override fun remove(host: String?, type: String?) {}

            override fun remove(
                host: String?,
                type: String?,
                key: ByteArray?
            ) {}

            override fun getKnownHostsRepositoryID(): String = "arkpm"

            // ARREGLO: no devolver null, porque JSch intenta leer el tamaño
            // del arreglo durante la validación de la clave del servidor.
            override fun getHostKey(): Array<HostKey> = emptyArray()

            override fun getHostKey(
                host: String?,
                type: String?
            ): Array<HostKey> = emptyArray()
        }

        val session = jsch.getSession(user, host, port)

        if (password != null) {
            session.setPassword(password)
        }

        // La conexión se rechaza si la huella no coincide.
        session.setConfig("StrictHostKeyChecking", "yes")

        session.setConfig(
            "PreferredAuthentications",
            if (key != null) {
                "publickey"
            } else {
                "keyboard-interactive,password"
            }
        )

        session.setServerAliveInterval(15000)
        session.setServerAliveCountMax(4)

        if (password != null) {
            session.setUserInfo(object : UserInfo {
                override fun getPassphrase(): String? = null
                override fun getPassword(): String = password
                override fun promptPassword(m: String?) = true
                override fun promptPassphrase(m: String?) = false
                override fun promptYesNo(m: String?) = false
                override fun showMessage(m: String?) {}
            })
        }

        try {
            session.connect(15000)
        } catch (e: JSchException) {
            try {
                session.disconnect()
            } catch (_: Throwable) {
            }

            val m = e.message ?: ""

            return@bg when {
                issue != null -> fail(
                    issue!!,
                    if (issue == "HOSTKEY_CHANGED") {
                        "La huella del servidor cambió"
                    } else {
                        "Servidor desconocido"
                    },
                    seen
                )

                m.contains("Auth", true) ->
                    fail(
                        "AUTH_FAILED",
                        "Usuario o credenciales incorrectos"
                    )

                m.contains("refused", true) ->
                    fail(
                        "NETWORK",
                        "Conexión rechazada: ¿está activo el servidor SSH y es correcto el puerto?"
                    )

                m.contains("UnknownHost", true) ->
                    fail(
                        "NETWORK",
                        "No se encontró el servidor (revisa el nombre o la IP)"
                    )

                m.contains("timed out", true) ||
                    m.contains("timeout", true) ->
                    fail(
                        "NETWORK",
                        "El servidor no responde (tiempo agotado)"
                    )

                else -> fail("NETWORK", m)
            }
        }

        val id = UUID.randomUUID().toString()
        sessions[id] = Sess(id, session)

        call.resolve(
            JSObject()
                .put("ok", true)
                .put("sessionId", id)
                .put("fingerprint", seen)
        )
    }

    @PluginMethod
    fun disconnect(call: PluginCall) = bg(call) {
        sessions.remove(call.data.optString("sessionId"))?.let {
            try {
                it.session.disconnect()
            } catch (_: Throwable) {
            }
        }

        call.resolve()
    }

    // ------------------------------------------------------------------
    // Comandos remotos

    @PluginMethod
    fun exec(call: PluginCall) = bg(call) {
        val s = sess(call)

        call.resolve(
            runExec(
                s,
                call.data.getString("cmd")!!,
                call.data.optString("stdin", "").ifEmpty { null },
                call.data.optLong("timeoutMs", 60000)
            )
        )
    }

    /** Emite datos del stream agrupados cada ~60 ms para no saturar el puente. */
    private inner class Batcher(val streamId: String) {
        private val sb = StringBuilder()
        private var scheduled = false

        @Synchronized
        fun add(t: CharArray, n: Int) {
            sb.append(t, 0, n)

            if (sb.length > 64 * 1024) {
                flush()
            } else if (!scheduled) {
                scheduled = true
                sched.schedule({ flush() }, 60, TimeUnit.MILLISECONDS)
            }
        }

        @Synchronized
        fun flush() {
            scheduled = false

            if (sb.isEmpty()) return

            val d = sb.toString()
            sb.setLength(0)

            notifyListeners(
                "stream",
                JSObject()
                    .put("streamId", streamId)
                    .put("kind", "data")
                    .put("data", d)
            )
        }
    }

    @PluginMethod
    fun streamStart(call: PluginCall) = bg(call) {
        val s = sess(call)
        val pty = call.data.optBoolean("pty", false)
        val ch = s.session.openChannel("exec") as ChannelExec

        ch.setCommand(call.data.getString("cmd")!!)
        ch.setPty(pty)
        ch.setInputStream(null)

        val out = ch.inputStream
        val errIn = if (!pty) ch.extInputStream else null

        ch.connect(15000)

        val id = UUID.randomUUID().toString()
        streams[id] = ch

        val b = Batcher(id)

        fun pump(ins: InputStream) = Thread {
            try {
                val r = InputStreamReader(ins, Charsets.UTF_8)
                val buf = CharArray(8192)

                while (true) {
                    val n = r.read(buf)
                    if (n < 0) break
                    b.add(buf, n)
                }
            } catch (_: Throwable) {
                // Canal cerrado.
            }
        }.also {
            it.isDaemon = true
            it.start()
        }

        val t1 = pump(out)
        val t2 = errIn?.let { pump(it) }

        pool.execute {
            t1.join()
            t2?.join()

            try {
                while (!ch.isClosed) Thread.sleep(20)
            } catch (_: Throwable) {
            }

            b.flush()
            streams.remove(id)

            val code = ch.exitStatus

            notifyListeners(
                "stream",
                JSObject()
                    .put("streamId", id)
                    .put("kind", "close")
                    .apply {
                        if (code >= 0) {
                            put("code", code)
                        } else {
                            put("code", JSONObject.NULL)
                        }
                    }
            )

            try {
                ch.disconnect()
            } catch (_: Throwable) {
            }
        }

        call.resolve(JSObject().put("streamId", id))
    }

    @PluginMethod
    fun streamStop(call: PluginCall) = bg(call) {
        streams[call.data.optString("streamId")]?.let {
            try {
                it.disconnect()
            } catch (_: Throwable) {
            }
        }

        call.resolve()
    }

    // ------------------------------------------------------------------
    // SFTP: listado, metadatos y lectura/escritura

    @PluginMethod
    fun list(call: PluginCall) = bg(call) {
        val s = sess(call)
        val dir = call.data.getString("path")!!
        val base = if (dir.endsWith("/")) dir else "$dir/"
        val arr = JSArray()

        synchronized(s.lock) {
            val c = sharedSftp(s)

            @Suppress("UNCHECKED_CAST")
            for (e in c.ls(dir) as java.util.Vector<ChannelSftp.LsEntry>) {
                if (e.filename == "." || e.filename == "..") continue

                val a = e.attrs
                var isDir = a.isDir
                var size = a.size
                var broken = false

                if (a.isLink) {
                    try {
                        val t = c.stat(base + e.filename)
                        isDir = t.isDir
                        size = t.size
                    } catch (_: SftpException) {
                        broken = true
                    }
                }

                arr.put(
                    JSObject()
                        .put("name", e.filename)
                        .put("isDir", isDir)
                        .put("isLink", a.isLink)
                        .put("broken", broken)
                        .put("size", size)
                        .put("mtime", a.mTime.toLong() * 1000)
                        .put("mode", a.permissions and 4095)
                )
            }
        }

        call.resolve(JSObject().put("entries", arr))
    }

    @PluginMethod
    fun stat(call: PluginCall) = bg(call) {
        val s = sess(call)
        val r = JSObject()

        synchronized(s.lock) {
            try {
                val a = sharedSftp(s).stat(call.data.getString("path")!!)
                r.put("exists", true)
                    .put("isDir", a.isDir)
                    .put("size", a.size)
                    .put("mtime", a.mTime.toLong() * 1000)
            } catch (e: SftpException) {
                if (e.id == ChannelSftp.SSH_FX_NO_SUCH_FILE) {
                    r.put("exists", false)
                } else {
                    throw e
                }
            }
        }

        call.resolve(r)
    }

    @PluginMethod
    fun readFile(call: PluginCall) = bg(call) {
        val s = sess(call)
        val path = call.data.getString("path")!!
        val max = call.data.optLong("maxBytes", 1024 * 1024).toInt()
        val c = openSftp(s)

        try {
            val size = c.stat(path).size
            val out = ByteArrayOutputStream()

            if (size > 0) {
                c.get(path).use { ins ->
                    val buf = ByteArray(16 * 1024)

                    while (out.size() < max) {
                        val n = ins.read(
                            buf,
                            0,
                            minOf(buf.size, max - out.size())
                        )

                        if (n < 0) break
                        out.write(buf, 0, n)
                    }
                }
            }

            call.resolve(
                JSObject()
                    .put(
                        "data",
                        Base64.encodeToString(
                            out.toByteArray(),
                            Base64.NO_WRAP
                        )
                    )
                    .put("size", size)
                    .put("truncated", size > max)
            )
        } finally {
            c.disconnect()
        }
    }

    @PluginMethod
    fun writeFile(call: PluginCall) = bg(call) {
        val s = sess(call)
        val bytes = Base64.decode(
            call.data.getString("data")!!,
            Base64.DEFAULT
        )
        val c = openSftp(s)

        try {
            c.put(
                ByteArrayInputStream(bytes),
                call.data.getString("path")!!,
                ChannelSftp.OVERWRITE
            )
        } finally {
            c.disconnect()
        }

        call.resolve()
    }

    // ------------------------------------------------------------------
    // Transferencias

    private fun progress(
        jobId: String,
        loaded: Long,
        total: Long,
        current: String
    ) = notifyListeners(
        "progress",
        JSObject()
            .put("jobId", jobId)
            .put("loaded", loaded)
            .put("total", total)
            .put("current", current)
    )

    @PluginMethod
    fun uploadMany(call: PluginCall) = bg(call) {
        val s = sess(call)
        val jobId = call.data.getString("jobId")!!
        val arr = call.data.getJSONArray("items")

        class Item(
            val local: String,
            val remote: String,
            val size: Long
        )

        val items = (0 until arr.length()).map {
            val o = arr.getJSONObject(it)
            Item(
                o.getString("local"),
                o.getString("remote"),
                o.optLong("size", 0)
            )
        }

        val job = Job()
        jobs[jobId] = job
        keepAwake(true)

        try {
            val total = items.sumOf { it.size }
            val loaded = AtomicLong(0)
            var last = 0L

            fun report(current: String, force: Boolean = false) {
                val n = System.currentTimeMillis()

                if (force || n - last > 150) {
                    last = n
                    progress(jobId, loaded.get(), total, current)
                }
            }

            val dirs = items
                .map { it.remote.substringBeforeLast('/', "/") }
                .distinct()

            if (dirs.isNotEmpty()) {
                val r = runExec(
                    s,
                    "bash -c " + sq(
                        "while IFS= read -r d; do mkdir -p -- \"\$d\" || exit 1; done"
                    ),
                    dirs.joinToString("\n") + "\n",
                    120000
                )

                if (r.getInt("code") != 0) {
                    throw IllegalStateException(
                        "No se pudieron crear las carpetas remotas: " +
                            r.getString("stderr")
                    )
                }
            }

            val next = AtomicInteger(0)
            var failure: Throwable? = null
            val workers = minOf(3, items.size).coerceAtLeast(1)
            val done = CountDownLatch(workers)

            repeat(workers) {
                pool.execute {
                    var opened: ChannelSftp? = null

                    try {
                        val ch = openSftp(s)
                        opened = ch
                        job.channels.add(ch)

                        while (!job.cancelled && failure == null) {
                            val i = next.getAndIncrement()
                            if (i >= items.size) break

                            val item = items[i]

                            val ins = context.contentResolver
                                .openInputStream(Uri.parse(item.local))
                                ?: throw IllegalStateException(
                                    "No se pudo abrir ${item.local}"
                                )

                            var prev = 0L

                            ins.use { stream ->
                                ch.put(
                                    stream,
                                    item.remote,
                                    object : SftpProgressMonitor {
                                        override fun init(
                                            op: Int,
                                            src: String?,
                                            dst: String?,
                                            max: Long
                                        ) {}

                                        override fun count(n: Long): Boolean {
                                            loaded.addAndGet(n)
                                            prev += n
                                            report(item.remote)
                                            return !job.cancelled
                                        }

                                        override fun end() {}
                                    },
                                    ChannelSftp.OVERWRITE
                                )
                            }

                            if (item.size > prev) {
                                loaded.addAndGet(item.size - prev)
                            }
                        }
                    } catch (e: Throwable) {
                        if (failure == null) failure = e
                    } finally {
                        try {
                            opened?.disconnect()
                        } catch (_: Throwable) {
                        }

                        done.countDown()
                    }
                }
            }

            done.await()

            if (job.cancelled) {
                throw IllegalStateException("Cancelado")
            }

            failure?.let { throw it }
            report("", true)
            call.resolve()
        } finally {
            jobs.remove(jobId)
            keepAwake(false)
        }
    }

    @PluginMethod
    fun download(call: PluginCall) = bg(call) {
        val s = sess(call)
        val jobId = call.data.getString("jobId")!!
        val remote = call.data.getString("remote")!!
        val name = call.data.getString("name")!!

        val tree = DocumentFile.fromTreeUri(
            context,
            Uri.parse(call.data.getString("destDir")!!)
        ) ?: throw IllegalStateException(
            "La carpeta de destino ya no es accesible: elígela de nuevo"
        )

        if (!tree.canWrite()) {
            throw IllegalStateException(
                "No hay permiso de escritura en la carpeta de destino: elígela de nuevo"
            )
        }

        val job = Job()
        jobs[jobId] = job
        keepAwake(true)

        val c = openSftp(s)
        job.channels.add(c)

        var target: DocumentFile? = null

        try {
            val size = c.stat(remote).size
            val dot = name.indexOf('.')
            val stem = if (dot > 0) name.substring(0, dot) else name
            val ext = if (dot > 0) name.substring(dot) else ""

            var finalName = name
            var k = 1

            while (tree.findFile(finalName) != null) {
                finalName = "$stem (${k++})$ext"
            }

            val created = tree.createFile(
                "application/octet-stream",
                finalName
            ) ?: throw IllegalStateException(
                "No se pudo crear el archivo en la carpeta de destino"
            )

            target = created

            var last = 0L
            var loaded = 0L

            context.contentResolver
                .openOutputStream(created.uri, "w")!!
                .use { out ->
                    c.get(
                        remote,
                        out,
                        object : SftpProgressMonitor {
                            override fun init(
                                op: Int,
                                src: String?,
                                dst: String?,
                                max: Long
                            ) {}

                            override fun count(n: Long): Boolean {
                                loaded += n

                                val t = System.currentTimeMillis()

                                if (t - last > 150) {
                                    last = t
                                    progress(jobId, loaded, size, name)
                                }

                                return !job.cancelled
                            }

                            override fun end() {}
                        }
                    )
                }

            if (job.cancelled) {
                throw IllegalStateException("Cancelado")
            }

            progress(jobId, size, size, name)

            call.resolve(
                JSObject()
                    .put(
                        "path",
                        "${tree.name ?: ""}/${created.name ?: finalName}"
                    )
                    .put("size", size)
            )
        } catch (e: Throwable) {
            try {
                target?.delete()
            } catch (_: Throwable) {
            }

            throw if (job.cancelled) {
                IllegalStateException("Cancelado")
            } else {
                e
            }
        } finally {
            try {
                c.disconnect()
            } catch (_: Throwable) {
            }

            jobs.remove(jobId)
            keepAwake(false)
        }
    }

    @PluginMethod
    fun cancelJob(call: PluginCall) {
        jobs[call.data.optString("jobId")]?.let { j ->
            j.cancelled = true

            j.channels.forEach {
                try {
                    it.disconnect()
                } catch (_: Throwable) {
                }
            }
        }

        call.resolve()
    }

    // ------------------------------------------------------------------
    // Selectores de archivos (SAF)

    @PluginMethod
    fun pickFiles(call: PluginCall) {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"

            putExtra(
                Intent.EXTRA_ALLOW_MULTIPLE,
                call.data.optBoolean("multi", true)
            )

            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }

        startActivityForResult(call, i, "pickFilesResult")
    }

    @ActivityCallback
    private fun pickFilesResult(
        call: PluginCall?,
        result: ActivityResult
    ) {
        if (call == null) return

        val files = JSArray()

        if (result.resultCode == Activity.RESULT_OK) {
            val uris = ArrayList<Uri>()

            result.data?.clipData?.let { cd ->
                for (k in 0 until cd.itemCount) {
                    uris.add(cd.getItemAt(k).uri)
                }
            }

            if (uris.isEmpty()) {
                result.data?.data?.let { uris.add(it) }
            }

            for (u in uris) {
                try {
                    context.contentResolver.takePersistableUriPermission(
                        u,
                        Intent.FLAG_GRANT_READ_URI_PERMISSION
                    )
                } catch (_: Throwable) {
                }

                var name = u.lastPathSegment ?: "archivo"
                var size = 0L

                context.contentResolver.query(
                    u,
                    null,
                    null,
                    null,
                    null
                )?.use { q ->
                    if (q.moveToFirst()) {
                        q.getColumnIndex(OpenableColumns.DISPLAY_NAME).let {
                            if (it >= 0) name = q.getString(it)
                        }

                        q.getColumnIndex(OpenableColumns.SIZE).let {
                            if (it >= 0 && !q.isNull(it)) {
                                size = q.getLong(it)
                            }
                        }
                    }
                }

                files.put(
                    JSObject()
                        .put("ref", u.toString())
                        .put("name", name)
                        .put("size", size)
                )
            }
        }

        call.resolve(JSObject().put("files", files))
    }

    @PluginMethod
    fun pickSaveDir(call: PluginCall) {
        val i = Intent(Intent.ACTION_OPEN_DOCUMENT_TREE).apply {
            addFlags(
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION or
                    Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION
            )
        }

        startActivityForResult(call, i, "pickSaveDirResult")
    }

    @ActivityCallback
    private fun pickSaveDirResult(
        call: PluginCall?,
        result: ActivityResult
    ) {
        if (call == null) return

        val uri = if (result.resultCode == Activity.RESULT_OK) {
            result.data?.data
        } else {
            null
        }

        if (uri == null) {
            call.resolve(JSObject())
            return
        }

        try {
            context.contentResolver.takePersistableUriPermission(
                uri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION or
                    Intent.FLAG_GRANT_WRITE_URI_PERMISSION
            )
        } catch (_: Throwable) {
        }

        call.resolve(
            JSObject()
                .put("uri", uri.toString())
                .put(
                    "label",
                    DocumentFile.fromTreeUri(context, uri)?.name ?: uri.toString()
                )
        )
    }

    // ------------------------------------------------------------------
    // Secretos (AES-GCM con clave del Android Keystore)

    @PluginMethod
    fun secretSave(call: PluginCall) {
        try {
            SecretStore.save(
                context,
                call.data.getString("id")!!,
                call.data.getString("value")!!
            )

            call.resolve()
        } catch (e: Throwable) {
            call.reject(
                "No se pudo guardar de forma segura: ${e.message}"
            )
        }
    }

    @PluginMethod
    fun secretLoad(call: PluginCall) {
        val v = SecretStore.load(
            context,
            call.data.getString("id")!!
        )

        call.resolve(
            if (v == null) {
                JSObject()
            } else {
                JSObject().put("value", v)
            }
        )
    }

    @PluginMethod
    fun secretDelete(call: PluginCall) {
        SecretStore.delete(
            context,
            call.data.getString("id")!!
        )

        call.resolve()
    }

    // ------------------------------------------------------------------
    // Vigilante y notificaciones

    private fun notifState(): String {
        if (Build.VERSION.SDK_INT < 33) return "granted"

        return when (getPermissionState("notifications")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
    }

    @PluginMethod
    fun notifPermission(call: PluginCall) {
        call.resolve(
            JSObject().put("state", notifState())
        )
    }

    @PluginMethod
    fun requestNotifPermission(call: PluginCall) {
        if (notifState() == "granted") {
            call.resolve(JSObject().put("state", "granted"))
        } else {
            requestPermissionForAlias(
                "notifications",
                call,
                "notifPermResult"
            )
        }
    }

    @PermissionCallback
    private fun notifPermResult(call: PluginCall) {
        call.resolve(
            JSObject().put("state", notifState())
        )
    }

    /**
     * Guarda la configuración y deja el vigilante en el modo pedido:
     * servicio en primer plano (segundo plano) o dentro de la app.
     */
    @PluginMethod
    fun monitorConfigure(call: PluginCall) = bg(call) {
        val json = call.data.getString("config")!!

        MonitorEngine.configure(context, json)

        val o = JSONObject(json)
        val svc = Intent(context, MonitorService::class.java)

        if (o.optBoolean("enabled") && o.optBoolean("background")) {
            ContextCompat.startForegroundService(context, svc)
        } else {
            context.stopService(svc)
        }

        MonitorEngine.start(context)
        call.resolve()
    }

    @PluginMethod
    fun monitorStatus(call: PluginCall) {
        call.resolve(
            JSObject().put("servers", MonitorEngine.status())
        )
    }

    @PluginMethod
    fun monitorMute(call: PluginCall) {
        MonitorEngine.mute(
            call.data.getString("serverId")!!,
            call.data.getString("name")!!
        )

        call.resolve()
    }

    @PluginMethod
    fun notifyTest(call: PluginCall) {
        MonitorEngine.postTest(context)
        call.resolve()
    }

    @PluginMethod
    fun notifyBackground(call: PluginCall) {
        MonitorEngine.postBackgroundNotice(context)
        call.resolve()
    }

    /**
     * Abre la pantalla de Android para excluir a la app de la optimización
     * de batería (evita que detenga el servicio).
     */
    @PluginMethod
    fun openBatterySettings(call: PluginCall) {
        try {
            context.startActivity(
                Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            )

            call.resolve()
        } catch (e: Throwable) {
            call.reject("No se pudo abrir los ajustes de batería")
        }
    }
}