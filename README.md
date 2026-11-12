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

## Nginx (administración del servidor)

Al elegir un servidor: pestaña **Nginx** (escritorio/tableta: junto a *Información*; teléfono: cuarta pestaña del servidor).

* **Estado y control**: versión, activo/detenido; iniciar, detener, reiniciar, recargar y probar la configuración (`nginx -t`). Antes de recargar/reiniciar se prueba la configuración para no tumbar el servicio con un error.
* **Dominios y sitios**: lee `/etc/nginx` (nginx.conf, `sites-available`/`sites-enabled`, `conf.d`) y muestra por archivo sus bloques `server`: dominios (clic para copiar), tipo (proxy / sitio estático / redirección) y destino, puertos, HTTPS con **días para el vencimiento del certificado**, y si redirige a HTTPS. Búsqueda por dominio.
* **Editar**: editor de cualquier archivo (incluido `nginx.conf`). Guardar hace copia de seguridad en `/etc/nginx/arkpm-backups`, instala el archivo, ejecuta `nginx -t` y, **si falla, restaura automáticamente la versión anterior** y muestra el error de nginx. «Guardar y recargar» aplica el cambio.
* **Sitio nuevo**: asistente (proxy a una app de PM2 con WebSocket, sitio estático o SPA, redirección) que valida dominios y destinos, crea el archivo, el enlace en `sites-enabled` y recarga. Opcional: certificado gratuito con **certbot** (Let's Encrypt).
* **Habilitar / deshabilitar / eliminar** sitios (con copia previa y reversión si algo falla) y **logs** de errores y accesos.
* **Permisos**: leer no necesita privilegios. Para cambiar algo hace falta **root o sudo**: si el sudo del usuario pide contraseña se pregunta una vez y se recuerda **solo en memoria** mientras la app está abierta (viaja por la entrada estándar, nunca en la línea de comandos). Sin sudo, la pantalla queda en solo lectura.
* Detecta si el servidor no tiene IPv6 para no generar `listen [::]:80` (que nginx rechazaría).

## Datos compartidos en el servidor (notas y configuración)

Las **notas** y la **configuración de Deploy y Backup** se guardan en el servidor, en `<carpeta de la app>/.arkpm/` (`notes/<id>.json` y `config.json`): así las ven todos los usuarios SSH y todas las conexiones (otro dispositivo, otra IP) que puedan entrar a la carpeta de la app. La copia local es un espejo para verlas sin conexión.

* Escritura atómica con control de revisión: si dos personas editan a la vez se detecta el conflicto (en las notas se ofrece reemplazar, cargar la del servidor o guardar como nota nueva).
* Los archivos se crean con permisos abiertos para que otro usuario pueda editarlos; no pongas secretos en las notas.
* La carpeta de destino de los backups es del dispositivo y no se sube. `.arkpm` nunca se borra con un deploy ni entra en los backups.
* Si el usuario no puede escribir en la carpeta de la app, la pestaña lo avisa y se guarda solo en este dispositivo. Las notas y configuraciones anteriores se suben solas la primera vez.
* Los demás usuarios necesitan acceso (lectura y escritura) a la carpeta de la app y a su carpeta `.arkpm`.

## Terminal y Notas (dentro de cada app)

* **Terminal**: consola para escribir comandos que se ejecutan en la carpeta de la app (como el usuario SSH del perfil, con el PATH y nvm cargados: `npm`, `node`, `pm2`, `git`…). El `cd` se mantiene entre comandos, hay historial (↑/↓, se guarda por app), atajos de comandos frecuentes, **Detener** / Ctrl+C para cortar un comando largo y Ctrl+L para limpiar. Los comandos delicados (`rm -rf`, `shutdown`, `dd`…) piden confirmación. No es una shell interactiva: programas que esperan teclado (`nano`, `top`, `vim`) no funcionan (usa p. ej. `top -bn1`); la entrada estándar va vacía para que nada se cuelgue.
* **Notas**: varias notas por app, con búsqueda, guardado automático y copia. Se guardan por **servidor (host:puerto) + servicio de PM2**, no por usuario SSH ni por perfil: las ven y editan todos los usuarios/perfiles que abran esa app en ese servidor, y cada nota muestra quién la editó por última vez. Se guardan en el servidor (ver «Datos compartidos en el servidor»).
* Orden de pestañas: Estado · Archivos · Deploy · Backup · Terminal · Notas · Logs.

## Configuración que se conserva

La configuración de **Deploy** (modo, archivos que se conservan, comandos posteriores…) y de **Backup** (qué incluir/excluir, carpeta de destino…) se guarda **por servidor (host:puerto) + servicio de PM2**, no por usuario SSH ni por perfil. Se mantiene si cambias el usuario, editas el servidor, quitas la app de la lista y la vuelves a agregar, o creas otro perfil para el mismo servidor (la hereda).

## Inicio y ventana (escritorio)

En ⚙ → *Inicio y ventana*: **Iniciar con Windows** (solo versión instalada/portable), **Iniciar en segundo plano** (al abrir no se muestra la ventana; queda en la bandeja y una notificación lo avisa) **Al minimizar, pasar a segundo plano** (oculta la ventana y avisa con una notificación) y **Pedir confirmación al cerrar**. Las opciones se guardan en `data/desktop.json`.

**Cierre limpio**: al salir de verdad (Salir de Arkpm, `app.quit()`, Salir de la bandeja o señal de terminación) se detienen el vigilante y sus sesiones SSH, se cierran las sesiones de la interfaz, se retira el icono de la bandeja y, si algo impidiera terminar, se fuerza la salida a los 3 s. `scripts/test-cierre-procesos.js` comprueba en Linux que no queda ningún proceso de la app ni sesiones SSH abiertas en el servidor.

**Confirmación al cerrar**: al cerrar la ventana pregunta «¿Cerrar Arkpm?» (Cerrar / Cancelar). Con el segundo plano activo ofrece *Pasar a segundo plano / Salir de Arkpm / Cancelar*. Incluye «No volver a preguntar» y se reactiva desde los ajustes. En Android, el botón Atrás en la pantalla principal pregunta «¿Salir de Arkpm?» (también desactivable en ⚙ → Al salir).

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
ARKPM_TEST_USER2=otro ARKPM_TEST_PASS2=Otro1234 node scripts/test-remote-scripts.js  # (con un segundo usuario SSH comprueba los datos compartidos entre usuarios)
USER_A=… PASS_A=… USER_B=… PASS_B=… USER_C=… PASS_C=… node scripts/test-nginx.js   # nginx real: sudo con/sin contraseña y sin sudo
xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/e2e-nginx.js            # pantalla de nginx completa
ARKPM_PHASE=1|2 xvfb-run … scripts/e2e-compartido.js   # datos compartidos: fase 1, borrar data/, fase 2 (otro dispositivo)
xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/e2e-terminal-notas.js       # pestañas Terminal y Notas (escritorio y teléfono)
xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/e2e-cambios.js              # iconos, pestañas, configuración persistente y opciones de escritorio
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
