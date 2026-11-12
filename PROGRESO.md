# Arkpm — Progreso del proyecto

Estado al cierre de esta etapa. Angular 18 + Electron + Capacitor, administra apps de **PM2** (y ahora **nginx**) en servidores Ubuntu por **SSH/SFTP**, sin instalar nada en el servidor.
Versiones del repositorio (sin tocar): Android 1.0.8 · Escritorio 1.0.3 (`versions.json`).

> **Resumen honesto:** el proyecto **compila** (`ng build` correcto, bundle inicial 512 kB) y casi todo está probado de punta a punta contra un servidor Ubuntu real. Hay **tres cosas abiertas** al final de este documento: una prueba E2E que falla (`e2e-cambios.js`), la parte de **Android sin compilar ni probar en dispositivo**, y la administración de **nginx** que quedó **a medias de pulir/probar** (la parte principal funciona).

---

## 1. Qué hace hoy

### Servidores y conexión
- Alta/edición de servidores (contraseña o clave privada, con frase). Credenciales cifradas con el almacén del sistema (DPAPI / Android Keystore), solo si el usuario lo elige.
- **Huella del servidor (TOFU)**: se verifica *antes* de pedir o enviar la contraseña; si cambia, se avisa y se corta.
- Comandos en un `bash -l` que carga el PATH del usuario y **nvm**.
- Ficha del servidor: Ubuntu/kernel, tiempo activo, CPU (uso, núcleos, modelo), memoria, discos, virtualización/equipo, IPs (se renueva cada ~30 s).

### Apps de PM2
- Agregar una app **ya registrada** o **crear un servicio nuevo** (`pm2 start`: script Node, script de npm o comando; carpeta con explorador del servidor, argumentos, variables de entorno, instancias/cluster, límite de memoria, `pm2 save`).
- Pestañas de cada app (en este orden): **Estado · Archivos · Deploy · Backup · Terminal · Notas · Logs**.
  - **Estado**: estado en vivo, CPU/memoria/uptime/reinicios, instancias; iniciar/detener/reiniciar/recargar (solo iconos).
  - **Archivos**: explorador SFTP (ver/editar texto, subir, descargar, renombrar, borrar, carpetas comprimidas); descargar y eliminar solo con icono.
  - **Deploy**: ZIP/TAR.GZ, archivos sueltos o carpeta (escritorio) → copia previa → subida a carpeta temporal → rsync (reemplazar/sobrescribir, conservando `.env`, `uploads`…) → comandos posteriores → reinicio en PM2 → verificación; **volver a la copia previa** si falla.
  - **Backup**: árbol con casillas (todo menos lo desmarcado / solo lo marcado) + patrones; se comprime en el servidor y se descarga al dispositivo; copias en el servidor (descargar/restaurar/borrar).
  - **Terminal**: consola por comando en la carpeta de la app (el `cd` persiste), historial, atajos, detener, confirmación en comandos riesgosos. No interactiva (sin `nano`/`top`).
  - **Notas**: varias notas por app, búsqueda, guardado automático.
  - **Logs**: `tail -F` en vivo (salida/errores/ambos), filtro, pausa.

### Datos compartidos en el servidor (notas + configuración de Deploy/Backup)
- Se guardan en `<carpeta de la app>/.arkpm/` (`notes/<id>.json`, `config.json`): las ven **todos los usuarios SSH y todas las conexiones/IP**. La copia local es un espejo para trabajar sin conexión.
- Escritura atómica con **control de revisión**; conflictos de notas con diálogo (reemplazar / cargar la del servidor / guardar como nueva).
- Permisos abiertos (umask 000) para que otro usuario pueda editar. `.arkpm` nunca se borra con un deploy ni entra en los backups. La carpeta de destino de backups es del dispositivo y **no** se sube.
- Si el usuario no puede escribir en la carpeta de la app, se avisa y queda solo local; lo antiguo se sube solo la primera vez.

### Notificaciones y segundo plano
- Avisos cuando un servicio **se inicia, se detiene, falla/se reinicia solo** o **se pierde/vuelve la conexión**. Lo que hace el usuario desde la app no genera aviso (silenciado).
- Vigilante nativo: `electron/monitor.js` (escritorio) y `MonitorEngine.kt` + `MonitorService.kt` (Android, servicio en primer plano).
- **Escritorio**: bandeja del sistema; *Iniciar con Windows*, *Iniciar en segundo plano*, *Al minimizar pasar a segundo plano* (con aviso), *Pedir confirmación al cerrar*; cierre limpio (sin procesos ni sesiones SSH colgadas, con salida forzada a los 3 s).
- **Android**: confirmación al salir con Atrás; segundo plano con notificación permanente.

### Interfaz
- Fondo `rgb(22 23 23)`, grises neutros. Diseño adaptable: escritorio (≥1100 px), tableta, teléfono (una pantalla a la vez + barra inferior). Botones de acción solo con icono donde se pidió.

### Nginx (esta etapa, ver §4)
- Pestaña **Nginx** en el servidor: estado/control, dominios y sitios, edición con rollback, sitio nuevo, habilitar/deshabilitar/eliminar, logs, vencimiento de certificados, certbot opcional.

---

## 2. Arquitectura

| Capa | Dónde | Notas |
|---|---|---|
| SSH/SFTP escritorio | `electron/ssh.js` (ssh2) | conexión, exec, streams con pty, SFTP, subida/descarga con progreso y cancelación |
| SSH/SFTP Android | `android-native/kotlin/ArkpmSshPlugin.kt` (JSch mwiede 0.2.21) | mismo contrato que escritorio |
| Contrato común | `src/app/transport.ts` + `electron-transport.ts` / `capacitor-transport.ts` | la lógica (PM2, deploy, backup, nginx…) está en TypeScript y es **única** |
| Scripts de shell | `src/app/remote.ts`, `src/app/nginx.ts` | funciones puras, probadas contra sshd/nginx reales |
| Estado | `workspace.service.ts`, `store.service.ts` (SQLite como documentos JSON; localStorage de respaldo) | |
| Datos compartidos | `shared-data.service.ts` + `workspace.service.ts` (sincroniza cada ~24 s) | |
| Vigilante | `electron/monitor.js`, `MonitorEngine.kt` | misma lógica de eventos (`diffApps`) |

Decisiones relevantes: sin agente en el servidor; configuración y notas por **servidor (host:puerto) + servicio**, no por usuario/perfil; el código de salida de `bash -l` no es fiable en algunos servidores, así que los scripts se deciden por lo que imprimen (`OK`/`CONFLICT`/`TEST_OK`…).

---

## 3. Pruebas (última pasada)

Todas contra un `sshd` + PM2 + nginx reales en Linux (Electron con `xvfb`).

| Suite | Qué cubre | Resultado |
|---|---|---|
| `test-ssh-layer.js` | huella, exec, logs con pty, SFTP, subida/descarga, cancelar | ✅ |
| `test-remote-scripts.js` (+`ARKPM_TEST_USER2`) | backup, deploy, restaurar, PM2, terminal, servicios nuevos, ficha del servidor, **datos compartidos entre dos usuarios** | ✅ |
| `test-monitor.js` | avisos de inicio/detención/reinicio, silenciado, pérdida y recuperación de conexión | ✅ |
| `test-cierre-procesos.js` | tras cerrar no queda ningún proceso ni sesión SSH (3 caminos de salida) | ✅ |
| `test-nginx.js` | nginx real: sondeo, sudo con/sin contraseña y sin sudo, crear/editar/rollback/deshabilitar/eliminar, control del servicio, vencimiento de certificados, logs | ✅ |
| `e2e-nginx.js` | pantalla de nginx completa con sudo que pide contraseña | ✅ |
| `e2e-terminal-notas.js` | Terminal, Notas, teléfono | ✅ |
| `e2e-compartido.js` (fase 1 y 2) | otro dispositivo (sin datos locales), otro usuario edita, conflicto, borrado | ✅ |
| `e2e-cierre.js` | confirmación al cerrar | ✅ (pasada anterior) |
| `e2e-electron.js` | recorrido general con capturas | ✅ (pasada anterior) |
| **`e2e-cambios.js`** | iconos, orden de pestañas, configuración al cambiar usuario, opciones de escritorio | ❌ **falla en las dos últimas ejecuciones** (ver §5) |

---

## 4. Nginx — qué está hecho y qué no

**Hecho y probado (lógica y UI):**
- Sondeo (instalado, versión, activo, systemd, sudo = root/sin contraseña/con contraseña/sin sudo, certbot, IPv6).
- Lectura de `/etc/nginx` (nginx.conf, `sites-available/enabled`, `conf.d` incl. `.disabled`) **sin privilegios**; analizador propio de la sintaxis (server_name, listen, ssl, proxy_pass/upstream, root, return…).
- Control: iniciar/detener/reiniciar/recargar (systemctl → service → binario) y `nginx -t`; se prueba antes de recargar/reiniciar.
- Editar archivos (incluido `nginx.conf`): copia en `/etc/nginx/arkpm-backups`, instala, `nginx -t`, **revierte solo si falla**.
- Sitio nuevo (proxy con WebSocket / estático / SPA / redirección), validación de dominios y destinos (sin inyección), habilitar, deshabilitar, eliminar (con copia previa).
- Contraseña de sudo: se pide una vez, **solo en memoria**, por la entrada estándar.
- Vencimiento de certificados (`openssl x509`), logs de errores/accesos.

**No hecho / no probado:**
- **certbot real** (emitir certificado): solo se probó la validación de entradas; el sandbox no tiene salida a Let's Encrypt.
- Restaurar desde la interfaz las copias de `arkpm-backups` (las copias se crean, pero no hay pantalla para elegirlas).
- Probado solo con la distribución de **Debian/Ubuntu**; la variante `conf.d` y `systemctl` real (el sandbox no tiene systemd) solo por los respaldos del script.
- No se revisó con capturas el diseño del teléfono para la pestaña Nginx (está cableada como 4.ª pestaña del servidor).
- No se probó en dispositivo Android.
- Sin gestión de `upstream`, `location` avanzadas, límites, caché, ni plantillas más allá de las tres básicas.

---

## 5. Abierto / riesgos conocidos

1. **`e2e-cambios.js` falla** desde la última ronda: tras escribir la contraseña y pulsar *Conectar* el diálogo se queda y la conexión no avanza (ocurre en la primera conexión de la prueba). Las demás pruebas E2E que usan el mismo flujo de conexión **sí pasan**, por lo que podría ser un problema del propio guion; **no está confirmado** y no se llegó a la causa. Conviene revisarlo antes de dar por buena la versión. (Cambios recientes que podrían intervenir: modificación de `dialog-host.component.ts` para el diálogo de sudo y el nuevo selector de pestañas del servidor.)
2. **Android sin compilar ni probar**: `ArkpmSshPlugin.kt`, `SshUtil.kt`, `MonitorEngine.kt`, `MonitorService.kt`, `SecretStore.kt`, permisos del manifest. No hay Android SDK en el entorno de desarrollo.
3. **`SshUtil.kt` conserva `getHostKey(...) = null`** (se respetó tu indicación de no aplicar el cambio). Es el mismo patrón que provocaba el `NullPointerException` en `Session.checkHost`; el vigilante en segundo plano usa `SshUtil`, así que **podría fallar igual** al verificar la huella. El parche (`emptyArray()`) ya lo aplicaste tú en `ArkpmSshPlugin.kt`.
4. La carpeta `electron/` no venía en tu zip: se incluye mi versión. Si tienes una propia, fusiona `main.js` y `preload.js`.
5. Los datos compartidos requieren que los demás usuarios tengan acceso de lectura/escritura a la carpeta de la app; no pongas secretos en las notas (los archivos son legibles/escribibles por todos).
6. Las notas viven en `.arkpm` dentro de la app: aparecerá en `git status` si la carpeta es un repositorio (conviene añadirla a `.gitignore`).
7. Android puede detener el servicio en segundo plano según el fabricante (hay un botón a los ajustes de batería); tras reiniciar el teléfono hay que abrir Arkpm una vez.

---

## 6. Cómo compilar y probar

```bash
npm install
npm run build              # compila Angular (dist/app/browser, ya incluido en este zip)
npm run electron           # escritorio
npm run dist               # .exe portable (Windows 11)
# Android: npm run cap:add:android → bash scripts/install-android-native.sh → npm run cap:sync → npm run apk
```

Pruebas (necesitan un servidor SSH de prueba; **escriben en la carpeta de la app indicada**):

```bash
ARKPM_TEST_PORT=22 ARKPM_TEST_USER=u ARKPM_TEST_PASS=p npm run test:ssh
ARKPM_TEST_PORT=22 ARKPM_TEST_USER=u ARKPM_TEST_PASS=p ARKPM_TEST_APP=miapp node scripts/test-remote-scripts.js
npm run test:monitor     # igual que arriba + ARKPM_TEST_APP
npm run test:salida      # Linux + xvfb
USER_A=… PASS_A=… USER_B=… PASS_B=… USER_C=… PASS_C=… npm run test:nginx
xvfb-run -a node_modules/.bin/electron --no-sandbox scripts/e2e-*.js
```

---

## 7. Cronología resumida

1. **Base**: app Angular + Electron + Capacitor sobre SSH/SFTP; PM2 (estado, logs, acciones), explorador, deploy y backup.
2. Ficha del servidor, servicios nuevos de PM2, fondo `rgb(22 23 23)`.
3. Notificaciones + segundo plano (vigilante en Electron y Android).
4. Ajustes sobre tu versión: iconos sin texto, Logs al final, configuración por servidor+servicio, opciones de inicio/minimizado de escritorio.
5. Confirmación al cerrar y verificación de cierre limpio.
6. Pestañas **Terminal** y **Notas**.
7. Notas y configuración **en el servidor** (`.arkpm`).
8. **Nginx** (§4) — detenido aquí a petición.

## 8. Archivos nuevos principales de esta etapa

`src/app/nginx.ts`, `nginx.service.ts`, `nginx.component.ts` · `shared-data.service.ts`, `shared-status.component.ts` · `terminal-tab.component.ts`, `notes-tab.component.ts` · `electron/monitor.js` · `android-native/kotlin/{MonitorEngine,MonitorService,SecretStore,SshUtil}.kt` · `scripts/test-nginx.js`, `e2e-nginx.js`, `e2e-compartido.js`, `e2e-terminal-notas.js`, `e2e-cierre.js`, `test-cierre-procesos.js`.
