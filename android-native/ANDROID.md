# Android (móvil y tableta)

1. `npm run cap:add:android` (crea `android/`).
2. `bash scripts/install-android-native.sh` — copia a `android/`:
   * `ArkpmSshPlugin.kt` y `MainActivity.kt` (paquete `com.ark.arkpm`),
   * `app/build.gradle` con **JSch (mwiede 0.2.21)**, **BouncyCastle 1.78.1** y **documentfile**,
   * `AndroidManifest.xml` (solo `INTERNET` y `ACCESS_NETWORK_STATE`; sin orientación fija → móvil, tableta, plegables y multiventana).
3. `npm run cap:sync` y abrir con `npm run cap:open:android`, o `npm run apk`.

## Notificaciones y segundo plano

* `MonitorEngine.kt` revisa `pm2 jlist` de cada servidor vigilado (sesiones propias, credenciales del Keystore vía `SecretStore.kt`, huella fijada) y publica los avisos en el canal «Avisos de servidores».
* `MonitorService.kt` es un servicio en primer plano (`foregroundServiceType="specialUse"`, permiso `FOREGROUND_SERVICE_SPECIAL_USE`) que lo mantiene vivo con la app cerrada; `START_STICKY` lo reanuda con la configuración guardada en `SharedPreferences`.
* Permisos nuevos en el manifest: `POST_NOTIFICATIONS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_SPECIAL_USE`. El icono de las notificaciones es `res/drawable/ic_stat_pm2.xml`.
* `specialUse` es apto para instalar el APK por tu cuenta; si algún día publicas en Google Play habrá que justificarlo en la declaración de servicios en primer plano.

## Qué probar primero (no se pudo ejecutar en este entorno)

* Conectar con contraseña y con clave RSA/ECDSA; confirmar el diálogo de huella.
* Logs en vivo y reconexión al volver del segundo plano.
* Ajustes ⚙ → activar avisos (permiso de Android) → *Enviar notificación de prueba*; activar *segundo plano*, cerrar la app desde recientes, detener un servicio por SSH desde otro equipo y comprobar que llega el aviso.
* Selector de archivos (ZIP) → deploy; selector de carpeta de descargas → backup.
* Si Gradle no encuentra `com.github.mwiede:jsch:0.2.21`, sube/baja la versión en `android/app/build.gradle` (existe en Maven Central).

## Cómo funciona

El plugin `ArkpmSsh` expone lo mismo que `electron/ssh.js`: `connect`, `exec`, `streamStart/Stop`, `list`, `stat`, `readFile`, `writeFile`, `uploadMany`, `download`, `cancelJob`, `pickFiles`, `pickSaveDir`, `secretSave/Load/Delete` y los eventos `stream`, `progress`, `closed`.
La huella del servidor se verifica con un `HostKeyRepository` propio: si no coincide con la guardada, JSch corta antes de autenticar.
Las credenciales se cifran con AES-GCM usando una clave del Android Keystore.
