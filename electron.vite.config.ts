import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react()],
    // 글꼴은 작은 조각도 파일로 둔다: data: URL로 끼우면 CSP(default-src 'self')가 막고, CSP를 풀 이유가 없다
    build: { assetsInlineLimit: 0 },
  },
});
