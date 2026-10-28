# Arkpm — administrador de apps PM2 por SSH

App **Angular 18 + Electron + Capacitor** (mismo stack que Arkloudy) para administrar desde Windows 11, un móvil Android o una tableta Android las apps que corren con **PM2** en un servidor **Ubuntu**.
No hay que instalar nada en el servidor: se conecta por **SSH/SFTP** con usuario y contraseña o clave privada.

| Función | Cómo |
|---|---|
| Información del servidor | Al elegir un servidor: Ubuntu y kernel, tiempo activo, CPU (uso, núcleos, modelo), memoria, discos usados/libres, virtualización/equipo e IPs. Se renueva sola cada ~30 s |
| Agregar apps | Eliges entre los procesos que PM2 ya tiene registrados (`pm2 jlist`) **o creas un servicio nuevo** (`pm2 start`): script Node, script de npm o comando; carpeta (con explorador del servidor), argumentos, variables de entorno, instancias/cluster, límite de memoria y `pm2 save` |
| Notificaciones | Aviso del sistema cuando un servicio **se inicia**, **se detiene**, **falla / se reinicia solo**, o **se pierde la conexión** (y cuando vuelve). Lo que haces tú desde la app no genera aviso |
| Segundo plano | Opcional. Escritorio: al cerrar la ventana queda en la bandeja y sigue vigilando. Android: servicio en primer plano con notificación permanente. En ambos te avisa cuando pasa a segundo plano |
| Estado actual | En línea / detenida / con error, CPU, memoria, tiempo activa, reinicios, instancias (cluster), rutas, versión de Node. Se actualiza solo cada 6 s |
| Logs | `tail -F` en vivo de salida / errores / ambos, filtro, pausa, seguimiento automático, copiar, vaciar (`pm2 flush`) |
| Iniciar · Detener · Reiniciar | también Recargar (cluster) y `pm2 save`; Detener y Eliminar piden confirmación |
| Explorador de archivos | SFTP: navegar, ver y **editar** texto, subir, descargar (carpetas como `.tar.gz`), renombrar, borrar, nueva carpeta |
| Deploy | Subes un ZIP/TAR.GZ, archivos sueltos o (escritorio) una carpeta → copia previa → sube a una carpeta temporal → aplica (reemplazar o sobrescribir, conservando `.env`, `uploads`…) → comandos posteriores (`npm ci`…) → reinicia en PM2 → comprueba que quedó en línea. Si algo falla, botón **Volver a la copia previa** |
| Backup | Árbol con casillas (**todo menos lo que desmarques** o **solo lo que marques**) + patrones (`node_modules`, `*.log`). Se comprime en el servidor y se descarga a una carpeta de tu dispositivo. Opcional: dejar copia en el servidor, descargar/restaurar/borrar copias |

## Interfaz adaptable

* **Escritorio (≥ 1100 px)**: barra lateral (servidores + apps) y panel de detalle con pestañas. En Windows 11 se usan los botones nativos de la ventana (con diseños de ajuste).
* **Tableta (720–1099 px)**: igual, con lateral más angosto; objetivos táctiles de 46 px.
* **Teléfono (< 720 px)**: una pantalla a la vez (Servidores → Apps → Detalle), pestañas abajo y hojas inferiores para los diálogos. El botón *Atrás* de Android navega hacia atrás.

## Notificaciones y segundo plano

Ajustes (icono ⚙ de la lista de servidores): activar avisos, elegir qué eventos, cada cuánto revisar (15 s – 5 min), qué servidores vigilar y activar el **segundo plano**.

* **Un vigilante por plataforma, misma lógica**: `electron/monitor.js` (proceso principal de Electron) y `MonitorEngine.kt` (Android). Cada uno abre sus propias sesiones SSH, consulta `pm2 jlist` y compara con la lectura anterior (la primera lectura es solo línea base).
* **Escritorio**: con «segundo plano» activo, cerrar la ventana la oculta y deja el icono en la bandeja (clic = abrir; clic derecho → *Salir* para dejar de vigilar). Hacer clic en una notificación abre ese servidor/servicio.
* **Android**: un servicio en primer plano (`MonitorService`) mantiene el vigilante con la app cerrada y muestra su notificación permanente (lo exige Android). Conviene excluir a Arkpm de la optimización de batería (hay un botón en los ajustes). Las notificaciones piden el permiso de Android 13+.
* Para vigilar un servidor hay que haberlo conectado una vez (huella verificada) y **guardar su contraseña/clave en el dispositivo** (el vigilante la lee del almacén cifrado: DPAPI / Keystore).
* Un servicio que se reinicia en bucle avisa como mucho una vez cada 5 minutos.
* Si no activas el segundo plano, los avisos funcionan solo con la app abierta.

## Cómo se conecta (seguridad)

* **Huella del servidor (TOFU)**: la primera vez se muestra la huella SHA256 y se pide confirmarla; si después cambia, se avisa y se corta **antes de enviar la contraseña**.
* Las contraseñas/claves se guardan **cifradas** con el almacén del sistema (DPAPI en Windows, Android Keystore) y solo si lo eliges; nunca en la base de datos.
* Los comandos remotos se arman con comillas seguras y se ejecutan en un `bash -l` (carga el PATH del usuario y **nvm**, que una sesión SSH normal no carga).
* Borrar tiene protecciones (no permite `/`, carpetas de primer nivel ni el home).

## Requisitos del servidor

Ubuntu con `sshd`, **PM2** del usuario con el que entras, y `tar` (siempre está). Recomendado `rsync` (`sudo apt install rsync`; sin él el deploy copia sin borrar sobrantes) y `unzip` (si falta se usa `python3`).
Si PM2 corre con otro usuario o no está en el PATH: *Editar servidor → Ajustes avanzados* (`sudo -u deploy pm2`, `source ~/.nvm/nvm.sh`…).

## Puesta en marcha

```bash
npm install
npm run electron           # compila Angular y abre la app de escritorio
npm run dist               # .exe portable para Windows 11 en release/electron (datos en ./data junto al .exe)
```

Android (Android Studio + JDK 17+):

```bash
npm run cap:add:android
bash scripts/install-android-native.sh    # copia el plugin Kotlin (SSH), manifest y gradle
npm run cap:sync
npm run cap:open:android                  # o: npm run apk   (APK de depuración en ./release)
```
Íconos del lanzador: `npx capacitor-assets generate --android` (usa `resources/icon.png`). Detalles en `android-native/ANDROID.md`.

## Estructura

```
electron/ssh.js        SSH/SFTP del escritorio (ssh2): conexión, exec, streams, subida/descarga con progreso
electron/monitor.js    vigilante de servidores + avisos (también con la ventana oculta)
electron/main.js       ventana, IPC, secretos (safeStorage), SQLite
android-native/kotlin  mismo contrato en Android (JSch): ArkpmSshPlugin.kt · MonitorEngine.kt · MonitorService.kt
src/app/transport*.ts  interfaz común + las dos implementaciones (Electron / Capacitor)
src/app/remote.ts      scripts de shell: backup (tar), deploy (rsync), restaurar, PM2  ← lógica única para ambas plataformas
src/app/*-tab.component.ts   Estado · Logs · Archivos · Deploy · Backup
```

## Pruebas incluidas

Se ejecutaron contra un `sshd` + PM2 reales (Ubuntu):

```bash
ARKPM_TEST_PORT=22 ARKPM_TEST_USER=usuario ARKPM_TEST_PASS=clave npm run test:ssh      # capa SSH: huella, exec, logs, SFTP, subida/descarga, cancelar
ARKPM_TEST_PORT=22 ARKPM_TEST_USER=usuario ARKPM_TEST_PASS=clave ARKPM_TEST_APP=miapp node scripts/test-remote-scripts.js   # backup, deploy, restaurar, PM2
ARKPM_TEST_PORT=22 ARKPM_TEST_USER=usuario ARKPM_TEST_PASS=clave ARKPM_TEST_APP=miapp node scripts/test-monitor.js   # vigilante: avisos de inicio/detención/reinicio, silenciado y pérdida de conexión
xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/e2e-electron.js            # app completa con capturas (Linux)
```
> Esos tests escriben en la carpeta de la app indicada: úsalos con una app de prueba.

## Notas y límites

* **Android**: el plugin Kotlin, el vigilante (`MonitorEngine`) y el servicio siguen el mismo contrato y la misma lógica que el escritorio, pero **no se pudieron compilar ni probar en un dispositivo en este entorno** (no hay Android SDK). Es la parte a probar primero; ver `android-native/ANDROID.md`.
* Android reinicia el servicio si lo mata, pero algunos fabricantes (Xiaomi, Huawei, Samsung…) son agresivos con la batería: hay que permitir la ejecución en segundo plano. Tras reiniciar el teléfono hay que abrir Arkpm una vez para reanudar la vigilancia.
* En Linux sin entorno de escritorio las notificaciones de Electron pueden no estar disponibles (en Windows 11 funcionan con las notificaciones del sistema).
* En Android el deploy admite **ZIP/TAR.GZ y archivos sueltos**; subir una carpeta entera es solo de escritorio.
* Android puede congelar la app en segundo plano: durante subidas/descargas se mantiene la pantalla encendida, pero conviene no cambiar de app en transferencias largas.
* Claves **Ed25519** en Android dependen de BouncyCastle; si fallan, usa una ECDSA/RSA (`ssh-keygen -t ecdsa`).
* Los backups son `.tar.gz` (se abren en Windows 11 y con 7-Zip).
