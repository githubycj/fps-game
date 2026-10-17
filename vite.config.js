import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: true,          // 局域网可访问
    port: 4173, // 本机 517x 端口段被系统占用，改用 4173
    proxy: {
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
  },
});
