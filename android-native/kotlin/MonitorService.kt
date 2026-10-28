package com.ark.arkpm

import android.app.Service
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.ServiceCompat

/**
 * Servicio en primer plano que mantiene vivo el vigilante cuando Arkpm está en segundo plano o cerrada.
 * Android exige mostrar una notificación permanente mientras corre. START_STICKY: si el sistema lo mata, se reinicia
 * y reanuda con la configuración guardada.
 */
class MonitorService : Service() {
    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, MonitorEngine.SERVICE_NOTIF_ID, MonitorEngine.serviceNotification(this), type)
        if (!MonitorEngine.backgroundOn(this)) { stopSelf(); return START_NOT_STICKY }
        MonitorEngine.start(applicationContext)
        return START_STICKY
    }
}
