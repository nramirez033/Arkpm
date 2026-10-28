import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.ark.arkpm',
  appName: 'Arkpm',
  webDir: 'dist/app/browser',
  // La app solo habla SSH (por el plugin nativo): el WebView no hace llamadas HTTP, así que no hace falta tráfico en claro.
  server: { androidScheme: 'https' },
};

export default config;
