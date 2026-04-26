import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const backendPort = env.SENTINEL_BACKEND_PORT ?? '3101';

  return {
    plugins: [react()],
    server: {
      // Apache(stn.kinphw.test) → Vite로 reverse proxy되는 Host 헤더 허용
      host: true,
      allowedHosts: ['stn.kinphw.test', 'localhost', '127.0.0.1'],
      // HMR WebSocket이 Apache TLS(443)를 거쳐 들어오도록 클라이언트에 알림
      hmr: {
        host: 'stn.kinphw.test',
        protocol: 'wss',
        clientPort: 443,
      },
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
        '/auth': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});
