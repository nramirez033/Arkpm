package com.ark.arkpm

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Base64
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import com.jcraft.jsch.Session
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger

/**
 * Vigilante de servidores de Android. Misma lógica que electron/monitor.js: consulta `pm2 jlist` cada N segundos con
 * sesiones SSH propias y avisa de inicios, detenciones, errores y pérdidas de conexión. Lo ejecuta el plugin mientras la
 * app está abierta y [MonitorService] (servicio en primer plano) cuando está en segundo plano o cerrada.
 * La configuración se guarda en SharedPreferences para poder reanudar tras un reinicio del servicio.
 */
object MonitorEngine {
    private const val PREFS = "arkpm_monitor"
    const val CH_EVENTS = "arkpm_events"
    const val CH_SERVICE = "arkpm_service"
    const val SERVICE_NOTIF_ID = 4001

    private class AppState(val status: String, val restarts: Int)
    private class SrvState(val sig: String) {
        var session: Session? = null; var up = false; var wasDown = false
        var apps: Map<String, AppState>? = null
        var state = "pending"; var reason = ""; var authNotified = false
    }
    private class Ev(val kind: String, val name: String, val text: String)

    @Volatile private var cfg: JSONObject? = null
    @Volatile private var appCtx: Context? = null
    private val states = ConcurrentHashMap<String, SrvState>()
    private val mutes = ConcurrentHashMap<String, Long>()
    private val lastRestart = ConcurrentHashMap<String, Long>()
    private val counter = AtomicInteger(100)
    private var pool: ScheduledExecutorService? = null
    private var task: ScheduledFuture<*>? = null

    // ------------------------------------------------------------------ configuración y ciclo de vida
    private fun load(ctx: Context): JSONObject? = cfg ?: ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("cfg", null)?.let { try { JSONObject(it) } catch (_: Throwable) { null } }.also { cfg = it }

    fun configure(ctx: Context, json: String) {
        appCtx = ctx.applicationContext
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString("cfg", json).apply()
        val c = JSONObject(json); cfg = c
        val servers = c.optJSONArray("servers") ?: JSONArray()
        val ids = HashSet<String>()
        for (i in 0 until servers.length()) {
            val s = servers.getJSONObject(i); ids.add(s.getString("id"))
            val sig = listOf(s.optString("host"), s.optInt("port"), s.optString("username"), s.optString("auth"), s.optString("fingerprint")).joinToString("|")
            states[s.getString("id")]?.let { if (it.sig != sig) { drop(it); states.remove(s.getString("id")) } }
        }
        for (id in states.keys.toList()) if (id !in ids) { states.remove(id)?.let { drop(it) } }
    }

    fun backgroundOn(ctx: Context): Boolean = load(ctx)?.let { it.optBoolean("enabled") && it.optBoolean("background") } ?: false
    fun watchedCount(ctx: Context): Int { val a = load(ctx)?.optJSONArray("servers") ?: return 0; return (0 until a.length()).count { a.getJSONObject(it).optBoolean("notify") } }

    /** (Re)inicia el bucle de revisión según la configuración guardada; si está desactivado, lo detiene. */
    @Synchronized fun start(ctx: Context) {
        appCtx = ctx.applicationContext
        val c = load(ctx)
        stopTask()
        if (c == null || !c.optBoolean("enabled") || watchedCount(ctx) == 0) return
        ensureChannels(ctx)
        val every = c.optLong("interval", 30).coerceAtLeast(5)
        val p = Executors.newSingleThreadScheduledExecutor().also { pool = it }
        task = p.scheduleWithFixedDelay({ try { tick() } catch (_: Throwable) {} }, 1, every, TimeUnit.SECONDS)
    }

    @Synchronized fun stop() { stopTask(); for (s in states.values) drop(s); states.clear() }
    private fun stopTask() { task?.cancel(false); task = null; pool?.shutdownNow(); pool = null }
    private fun drop(s: SrvState) { try { s.session?.disconnect() } catch (_: Throwable) {}; s.session = null }

    fun mute(serverId: String, name: String) { mutes["$serverId|$name"] = System.currentTimeMillis() + 25000 }

    fun status(): JSONArray {
        val out = JSONArray()
        val servers = cfg?.optJSONArray("servers") ?: return out
        for (i in 0 until servers.length()) {
            val s = servers.getJSONObject(i); val st = states[s.getString("id")]
            out.put(JSONObject().put("id", s.getString("id")).put("state", if (!s.optBoolean("notify")) "off" else st?.state ?: "pending").put("reason", st?.reason ?: ""))
        }
        return out
    }

    // ------------------------------------------------------------------ revisión
    private fun tick() {
        val servers = cfg?.optJSONArray("servers") ?: return
        for (i in 0 until servers.length()) {
            val s = servers.getJSONObject(i)
            if (s.optBoolean("notify")) try { poll(s) } catch (_: Throwable) {}
        }
    }

    private const val ENV_INIT = "export NVM_DIR=\"\${NVM_DIR:-\$HOME/.nvm}\"; [ -s \"\$NVM_DIR/nvm.sh\" ] && . \"\$NVM_DIR/nvm.sh\" >/dev/null 2>&1; " +
        "export PATH=\"\$HOME/.local/bin:\$HOME/.npm-global/bin:/usr/local/bin:\$PATH\"; "

    private fun wrap(script: String, init: String): String {
        val full = ENV_INIT + (if (init.isNotBlank()) init.trim() + "\n" else "") + script
        return "bash -lc \"\$(printf %s " + Base64.encodeToString(full.toByteArray(Charsets.UTF_8), Base64.NO_WRAP) + " | base64 -d)\""
    }

    private fun parseJlist(out: String): JSONArray {
        for (l in out.lines().asReversed()) { val t = l.trim(); if (t == "[]" || t.startsWith("[{")) try { return JSONArray(t) } catch (_: Throwable) {} }
        throw IllegalStateException("PM2 no devolvió una lista válida")
    }

    private fun group(arr: JSONArray): Map<String, AppState> {
        val by = LinkedHashMap<String, MutableList<Pair<String, Int>>>()
        for (i in 0 until arr.length()) {
            val p = arr.getJSONObject(i); val e = p.optJSONObject("pm2_env")
            by.getOrPut(p.optString("name")) { mutableListOf() }.add(Pair(e?.optString("status") ?: "", e?.optInt("restart_time") ?: 0))
        }
        return by.mapValues { (_, ps) ->
            val on = ps.count { it.first == "online" }
            val st = when {
                on == ps.size -> "online"
                on > 0 -> "partial"
                ps.any { it.first == "errored" } -> "errored"
                ps.any { it.first == "launching" || it.first == "stopping" || it.first == "waiting restart" } -> "launching"
                else -> "stopped"
            }
            AppState(st, ps.sumOf { it.second })
        }
    }

    private fun diff(prev: Map<String, AppState>, next: Map<String, AppState>): Pair<Map<String, AppState>, List<Ev>> {
        val events = ArrayList<Ev>(); val merged = LinkedHashMap<String, AppState>()
        for ((name, n) in next) {
            val p = prev[name]
            if (n.status == "launching") { merged[name] = p ?: n; continue }
            merged[name] = n
            if (p == null) {
                if (n.status == "online") events.add(Ev("started", name, "«$name» apareció en PM2 y está en línea"))
                else if (n.status == "errored") events.add(Ev("errored", name, "«$name» terminó con error"))
                continue
            }
            if (p.status != "online" && n.status == "online") events.add(Ev("started", name, "«$name» se inició"))
            else if (p.status == "online" && n.status == "stopped") events.add(Ev("stopped", name, "«$name» se detuvo"))
            else if (p.status != "errored" && n.status == "errored") events.add(Ev("errored", name, "«$name» terminó con error"))
            else if (p.status == "online" && n.status == "partial") events.add(Ev("errored", name, "«$name» tiene instancias caídas"))
            else if (p.status == "online" && n.status == "online" && n.restarts > p.restarts) {
                val k = n.restarts - p.restarts
                events.add(Ev("restart", name, "«$name» se reinició inesperadamente" + if (k > 1) " ($k veces)" else ""))
            }
        }
        for (name in prev.keys) if (name !in next) events.add(Ev("stopped", name, "«$name» ya no está registrada en PM2"))
        return Pair(merged, events)
    }

    private fun poll(sv: JSONObject) {
        val ctx = appCtx ?: return
        val id = sv.getString("id")
        val sig = listOf(sv.optString("host"), sv.optInt("port"), sv.optString("username"), sv.optString("auth"), sv.optString("fingerprint")).joinToString("|")
        val st = states.getOrPut(id) { SrvState(sig) }
        try {
            if (st.session?.isConnected != true) {
                st.session = null
                val fp = sv.optString("fingerprint")
                if (fp.isEmpty()) { st.state = "skipped"; st.reason = "Servidor sin verificar: conéctate una vez desde la app"; return }
                val sec = SecretStore.load(ctx, id)?.let { try { JSONObject(it) } catch (_: Throwable) { null } }
                val isPass = sv.optString("auth") == "password"
                val pass = sec?.optString("password", "")?.ifEmpty { null }
                val key = sec?.optString("privateKey", "")?.ifEmpty { null }
                if (if (isPass) pass == null else key == null) {
                    st.state = "skipped"; st.reason = if (isPass) "Guarda la contraseña en este dispositivo para vigilar este servidor" else "Falta la clave privada guardada"; return
                }
                try {
                    st.session = SshUtil.connect(sv.getString("host"), sv.optInt("port", 22), sv.getString("username"), if (isPass) pass else null, if (isPass) null else key, sec?.optString("passphrase", "")?.ifEmpty { null }, fp)
                    st.authNotified = false
                } catch (f: SshUtil.Fail) {
                    if (f.code != "NETWORK") {
                        st.state = "skipped"; st.reason = f.message ?: f.code
                        if (!st.authNotified) { st.authNotified = true; emit(sv, "connection", "", "No se pudo iniciar sesión: ${f.message}") }
                        return
                    }
                    throw f
                }
            }
            val (_, out) = SshUtil.exec(st.session!!, wrap((sv.optString("pm2Cmd").ifBlank { "pm2" }) + " jlist", sv.optString("shellInit")), 25000)
            val arr = try { parseJlist(out) } catch (e: IllegalStateException) { st.state = "error"; st.reason = e.message ?: ""; return }
            if (!st.up) { st.up = true; if (st.wasDown) { st.wasDown = false; emit(sv, "connection", "", "Conexión restablecida") } }
            val next = group(arr)
            val prev = st.apps
            if (prev != null) { val (merged, events) = diff(prev, next); st.apps = merged; for (e in events) emit(sv, e.kind, e.name, e.text) } else st.apps = next
            st.state = "up"; st.reason = ""
        } catch (e: Throwable) {
            drop(st)
            if (st.up) { st.up = false; st.wasDown = true; emit(sv, "connection", "", "Se perdió la conexión con el servidor") }
            st.state = "down"; st.reason = e.message ?: "Sin conexión"
        }
    }

    // ------------------------------------------------------------------ avisos
    private fun emit(sv: JSONObject, kind: String, name: String, text: String) {
        val ctx = appCtx ?: return
        val key = if (kind == "restart") "errored" else kind
        if (cfg?.optJSONObject("events")?.optBoolean(key, true) == false) return
        val id = sv.getString("id")
        if (name.isNotEmpty()) { val until = mutes["$id|$name"]; if (until != null && until > System.currentTimeMillis()) return }
        if (kind == "restart") {   // un bucle de reinicios avisaría en cada revisión: como mucho una vez cada 5 minutos
            val k = "$id|$name"; val last = lastRestart[k] ?: 0L
            if (System.currentTimeMillis() - last < 5 * 60 * 1000) return
            lastRestart[k] = System.currentTimeMillis()
        }
        post(ctx, if (name.isNotEmpty()) "${sv.optString("name")} · $name" else sv.optString("name"), text)
    }

    fun ensureChannels(ctx: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = ctx.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(CH_EVENTS, "Avisos de servidores", NotificationManager.IMPORTANCE_HIGH).apply { description = "Servicios que se inician, se detienen o fallan, y pérdidas de conexión" })
        nm.createNotificationChannel(NotificationChannel(CH_SERVICE, "Vigilancia en segundo plano", NotificationManager.IMPORTANCE_LOW).apply { description = "Notificación permanente mientras Arkpm vigila tus servidores" })
    }

    private fun openApp(ctx: Context): PendingIntent {
        val i = (ctx.packageManager.getLaunchIntentForPackage(ctx.packageName) ?: Intent()).apply { flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP }
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    private fun canNotify(ctx: Context) = Build.VERSION.SDK_INT < 33 || ContextCompat.checkSelfPermission(ctx, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    fun post(ctx: Context, title: String, body: String) {
        if (!canNotify(ctx)) return
        ensureChannels(ctx)
        val n = NotificationCompat.Builder(ctx, CH_EVENTS).setSmallIcon(R.drawable.ic_stat_pm2).setContentTitle(title).setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body)).setAutoCancel(true).setContentIntent(openApp(ctx)).setPriority(NotificationCompat.PRIORITY_HIGH).build()
        ctx.getSystemService(NotificationManager::class.java).notify(counter.incrementAndGet(), n)
    }

    fun postTest(ctx: Context) = post(ctx, "Arkpm", "Así se verán los avisos de tus servidores.")

    /** «La app pasó a segundo plano»: aviso normal (la notificación permanente del servicio es otra). */
    fun postBackgroundNotice(ctx: Context) = post(ctx, "Arkpm sigue en segundo plano", "Vigilando ${watchedCount(ctx)} servidor(es). Toca para abrir la app.")

    fun serviceNotification(ctx: Context): Notification {
        ensureChannels(ctx)
        return NotificationCompat.Builder(ctx, CH_SERVICE).setSmallIcon(R.drawable.ic_stat_pm2).setContentTitle("Arkpm está vigilando tus servidores")
            .setContentText("Segundo plano activo · ${watchedCount(ctx)} servidor(es)").setOngoing(true).setOnlyAlertOnce(true)
            .setContentIntent(openApp(ctx)).setPriority(NotificationCompat.PRIORITY_LOW).build()
    }
}
