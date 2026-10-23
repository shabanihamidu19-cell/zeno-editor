import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.zeno.editor',
  appName: 'Zeno Editor',
  webDir: 'www',
  server: {
    androidScheme: 'https'
  },
  android: {
    allowMixedContent: true
  },
  plugins: {
    Filesystem: {
      // permissions handled in manifest
    }
  }
};

export default config;
