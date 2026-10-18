import { defineConfig } from 'vite';

export default defineConfig({
  // 依赖预构建缓存放到项目内（C 盘空间紧张，避免写到系统临时目录导致 ENOSPC）
  cacheDir: '.vite-cache',
  // 开发模式也强制预构建 three 及其 addons：否则浏览器首次 import 时会现场转换
  // 数十个 addon 模块，表现为"游戏开始几秒后突然卡一下"。
  optimizeDeps: {
    include: [
      'three',
      'three/addons/renderers/CSS2DRenderer.js',
      'three/addons/postprocessing/EffectComposer.js',
      'three/addons/postprocessing/RenderPass.js',
      'three/addons/postprocessing/ShaderPass.js',
      'three/addons/postprocessing/OutputPass.js',
      'three/addons/postprocessing/UnrealBloomPass.js',
      'three/addons/utils/BufferGeometryUtils.js',
      'three/addons/geometries/RoundedBoxGeometry.js',
    ],
    force: false,
  },
  server: {
    host: true,          // 局域网可访问
    port: 4173, // 本机 517x 端口段被系统占用，改用 4173
    // 开发期预热：首次打开页面就把入口与关键模块编译好，避免游戏中触发按需编译
    warmup: {
      clientFiles: [
        './src/main.js',
        './src/world.js',
        './src/world/*.js',
        './src/models/*.js',
        './src/player.js',
        './src/scope.js',
        './src/effects.js',
        './src/hud.js',
        './src/audio.js',
        './src/net.js',
        './shared/*.js',
      ],
    },
    proxy: {
      '/ws': {
        target: 'ws://localhost:3001',
        ws: true,
        // 玩家关闭标签/刷新页面时，浏览器会直接断开 TCP，
        // Vite 代理默认会把 ECONNRESET 打印成 "ws proxy socket error"。
        // 这里把已断开的连接静默处理（属于正常现象），其余真实错误照常上报。
        configure: (proxy) => {
          proxy.on('error', (err, _req, socket) => {
            const code = err && err.code;
            if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ECONNABORTED') return;
            // 其余错误：尝试优雅关闭，避免代理挂掉
            try { if (socket && socket.writable) socket.end(); } catch { /* ignore */ }
          });
          proxy.on('proxyReqWs', (_proxyReq, _req, socket) => {
            // 浏览器已关闭的 socket 不再写数据
            socket.on('error', () => { /* 忽略已断开连接的写入错误 */ });
          });
        },
      },
    },
  },
  build: {
    target: 'es2020',
    chunkSizeWarningLimit: 1600,
  },
});
