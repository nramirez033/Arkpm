package com.ark.arkpm

import android.util.Base64
import com.jcraft.jsch.ChannelExec
import com.jcraft.jsch.HostKey
import com.jcraft.jsch.HostKeyRepository
import com.jcraft.jsch.JSch
import com.jcraft.jsch.JSchException
import com.jcraft.jsch.KeyPair
import com.jcraft.jsch.Session
import com.jcraft.jsch.UserInfo
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.MessageDigest

/** Conexión SSH simple para el vigilante en segundo plano (la del plugin tiene más detalle porque habla con la interfaz). */
object SshUtil {
    class Fail(val code: String, message: String) : Exception(message)

    fun fingerprint(blob: ByteArray) = "SHA256:" + Base64.encodeToString(MessageDigest.getInstance("SHA-256").digest(blob), Base64.NO_PADDING or Base64.NO_WRAP)

    /** Abre la sesión comprobando la huella fijada ANTES de autenticar. Lanza [Fail] con el mismo código que usa la interfaz. */
    fun connect(host: String, port: Int, user: String, password: String?, privateKey: String?, passphrase: String?, expectedFp: String): Session {
        val jsch = JSch()
        if (!privateKey.isNullOrBlank()) {
            try {
                val kp = KeyPair.load(jsch, privateKey.toByteArray(), null)
                if (kp.isEncrypted && (passphrase == null || !kp.decrypt(passphrase))) { kp.dispose(); throw Fail("KEY_PASSPHRASE", "La clave privada necesita su frase de contraseña") }
                kp.dispose()
                jsch.addIdentity("arkpm", privateKey.toByteArray(), null, passphrase?.toByteArray())
            } catch (e: JSchException) { throw Fail("NETWORK", "No se pudo leer la clave privada") }
        }
        var issue: String? = null
        jsch.hostKeyRepository = object : HostKeyRepository {
            override fun check(h: String?, k: ByteArray?): Int {
                if (fingerprint(k ?: ByteArray(0)) == expectedFp) return HostKeyRepository.OK
                issue = "HOSTKEY_CHANGED"; return HostKeyRepository.NOT_INCLUDED
            }
            override fun add(hostkey: HostKey?, ui: UserInfo?) {}
            override fun remove(host: String?, type: String?) {}
            override fun remove(host: String?, type: String?, key: ByteArray?) {}
            override fun getKnownHostsRepositoryID(): String = "arkpm"
            override fun getHostKey(): Array<HostKey>? = null
            override fun getHostKey(host: String?, type: String?): Array<HostKey>? = null
        }
        val s = jsch.getSession(user, host, port)
        if (password != null) s.setPassword(password)
        s.setConfig("StrictHostKeyChecking", "yes")
        s.setConfig("PreferredAuthentications", if (!privateKey.isNullOrBlank()) "publickey" else "keyboard-interactive,password")
        s.setServerAliveInterval(15000); s.setServerAliveCountMax(4)
        try { s.connect(15000) } catch (e: JSchException) {
            try { s.disconnect() } catch (_: Throwable) {}
            val m = e.message ?: ""
            throw when {
                issue != null -> Fail("HOSTKEY_CHANGED", "La huella del servidor cambió")
                m.contains("Auth", true) -> Fail("AUTH_FAILED", "Usuario o credenciales incorrectos")
                else -> Fail("NETWORK", m)
            }
        }
        return s
    }

    /** Ejecuta un comando y devuelve (código de salida, salida estándar). */
    fun exec(session: Session, cmd: String, timeoutMs: Long): Pair<Int, String> {
        val ch = session.openChannel("exec") as ChannelExec
        val out = ByteArrayOutputStream()
        ch.setCommand(cmd); ch.setOutputStream(out); ch.setErrStream(ByteArrayOutputStream())
        ch.setInputStream(ByteArrayInputStream(ByteArray(0)))
        ch.connect(15000)
        val deadline = System.currentTimeMillis() + timeoutMs
        try {
            while (!ch.isClosed) {
                if (System.currentTimeMillis() > deadline) throw Fail("NETWORK", "Tiempo de espera agotado")
                Thread.sleep(20)
            }
        } finally { ch.disconnect() }
        return Pair(ch.exitStatus, out.toString("UTF-8"))
    }
}
