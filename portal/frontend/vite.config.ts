import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import tailwindcss from '@tailwindcss/vite';

// issue #61 P2 翻转：Vue SPA 已挂在 /（portal 后端 serveStatic 把 / 与 /assets/* 映射到
// staticDir/app/ 注入目录，见 portal/src/http.js）。
export default defineConfig({
  // hash 路由（createWebHashHistory）：服务端无需 history 回退；旧 index.html 的
  // #/session/<id> 深链已有 hash 先例（issue #55 B1）。
  base: '/',
  // issue #528 / 契约 `10` 篇 §1：宏枚举的单一真源在 `portal/shared/`（后端不能 import 前端，
  // 所以不能放 `src/lib/`）。前端用 `@shared/*` 别名指过去，**不许抄一份枚举字面量**
  // （防漂移：portal/test/macro-kinds-single-source.test.js）。
  // 用 URL 而非 `node:path`：本文件的 tsconfig `types` 只有 `vite/client`，没有 @types/node。
  resolve: {
    alias: {
      '@shared': new URL('../shared/', import.meta.url).pathname,
    },
  },
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
