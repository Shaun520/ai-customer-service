import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // 显式用 IPv4 回环，避免 Windows 下 vite 绑定 ::1 报 EACCES
    host: '127.0.0.1',
    // 5173 落在 Windows TCP 保留端口区间(5141-5240)，无法绑定，改用 17573
    port: 17573,
    proxy: {
      '/v1': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
});