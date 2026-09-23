import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// issue #61 P1：Vue SPA 过渡期挂载在 /app/（portal 后端 serveStatic 接入，见 portal/src/http.js）；
// P2 工作台迁移完成后会把 base 翻转到 / 并下线旧 index.html。
export default defineConfig({
  // hash 路由（createWebHashHistory）：服务端无需 history 回退；旧 index.html 的
  // #/session/<id> 深链已有 hash 先例（issue #55 B1）。
  base: '/app/',
  plugins: [vue(), tailwindcss()],
  build: {
    outDir: 'dist',
  },
  server: {
    port: 5173,
    proxy: {
      // 开发态 API 直通本机 portal（config.js 默认 PORT=8080；COOKIE_PROFILE=dev-http 时
      // cookie 不带 Secure，http://localhost:5173 下可完成两步登录联调）。
      '/api': 'http://127.0.0.1:8080',
    },
  },
  test: {
    environment: 'jsdom',
    include: ['src/**/*.spec.ts'],
  },
});
