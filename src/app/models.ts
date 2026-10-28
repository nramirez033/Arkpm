export type AuthType = 'password' | 'key';

/** Servidor Ubuntu al que se conecta por SSH. Las credenciales NO viven aquí: van al almacén seguro del dispositivo. */
export interface ServerProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth: AuthType;
  /** Guardar la contraseña / clave en el almacén seguro de este dispositivo. */
  remember: boolean;
  /** Comando de PM2 (p. ej. «pm2» o «sudo -u deploy pm2»). */
  pm2Cmd: string;
  /** Líneas de shell que se ejecutan antes de cada comando (p. ej. «source ~/.nvm/nvm.sh»). */
  shellInit: string;
  createdAt: number;
}

export interface Secret { password?: string; privateKey?: string; passphrase?: string; }

export type DeployMode = 'sync' | 'merge';
export type Pm2After = 'restart' | 'reload' | 'none';

export interface DeployConfig {
  /** sync: la carpeta del servidor queda igual que lo subido (borra lo que sobra). merge: solo agrega y sobrescribe. */
  mode: DeployMode;
  /** Reglas de archivos del servidor que no se borran ni se pisan (.env, uploads, node_modules…). */
  preserve: string[];
  /** Reglas de archivos locales que no se suben (al subir una carpeta). */
  ignoreLocal: string[];
  backupFirst: boolean;
  /** Un comando por línea, se ejecutan en la carpeta de la app tras copiar los archivos. */
  postCommands: string;
  after: Pm2After;
  updateEnv: boolean;
  /** Si el ZIP trae una sola carpeta raíz, usar su contenido. */
  flatten: boolean;
}

export interface BackupConfig {
  mode: 'all-except' | 'only';
  /** Reglas de exclusión (rutas ancladas «/ruta» o patrones «*.log», «node_modules»). */
  excludes: string[];
  /** Rutas ancladas incluidas cuando mode = 'only'. */
  includes: string[];
  /** Carpeta del dispositivo donde se guardan (ruta en escritorio, URI en Android). */
  saveDir: string;
  saveDirLabel: string;
  /** Dejar también una copia en el servidor (~/.arkpm/backups). */
  keepOnServer: boolean;
  /** Cuántas copias del servidor conservar por app. */
  keepCount: number;
}

export interface AppConfig { deploy: DeployConfig; backup: BackupConfig; }

/** App de PM2 que el usuario agregó a la lista de un servidor. */
export interface TrackedApp {
  id: string;
  profileId: string;
  pm2Name: string;
  label: string;
  /** Carpeta en el servidor; vacío = la que informa PM2 (pm_cwd). */
  dir: string;
  config: AppConfig;
  createdAt: number;
}

export type Pm2Status = 'online' | 'stopped' | 'errored' | 'launching' | 'stopping' | 'one-launch-status' | 'unknown';

export interface Pm2Proc {
  pmId: number;
  name: string;
  status: Pm2Status;
  cpu: number;
  memory: number;
  /** Instante de inicio (ms epoch); 0 si está detenida. */
  startedAt: number;
  restarts: number;
  unstable: number;
  pid: number;
  mode: string;
  script: string;
  args: string;
  cwd: string;
  outLog: string;
  errLog: string;
  interpreter: string;
  nodeVersion: string;
  namespace: string;
}

/** Todas las instancias de un mismo nombre (modo cluster) agrupadas. */
export interface Pm2Group {
  name: string;
  procs: Pm2Proc[];
  status: 'online' | 'partial' | 'stopped' | 'errored' | 'launching';
  cpu: number;
  memory: number;
  restarts: number;
  startedAt: number;
  cwd: string;
  outLog: string;
  errLog: string;
}

export interface RemoteEntry {
  name: string;
  isDir: boolean;
  isLink: boolean;
  broken: boolean;
  size: number;
  mtime: number;
  mode: number;
}

export interface BackupRecord {
  id: string;
  appId: string;
  name: string;
  size: number;
  createdAt: number;
  /** Dónde quedó en el dispositivo (ruta o URI). */
  location: string;
  note: string;
}

export interface DeployRecord {
  id: string;
  appId: string;
  at: number;
  source: string;
  ok: boolean;
  backup: string;
  summary: string;
}

export const DEFAULT_CONFIG = (): AppConfig => ({
  deploy: {
    mode: 'sync',
    preserve: ['.env', 'node_modules', 'uploads', 'logs', '*.sqlite', '*.db'],
    ignoreLocal: ['.git', 'node_modules', '.DS_Store', 'Thumbs.db'],
    backupFirst: true,
    postCommands: '',
    after: 'restart',
    updateEnv: false,
    flatten: true,
  },
  backup: { mode: 'all-except', excludes: ['node_modules', '*.log'], includes: [], saveDir: '', saveDirLabel: '', keepOnServer: false, keepCount: 5 },
});

export const uid = () => (crypto as any).randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36);
