import react from '@vitejs/plugin-react';
import type { Connect } from 'vite';
import { defineConfig, type Plugin } from 'vite';
import { loadCorpus, perfText } from './corpus/cases.ts';

// 코퍼스와 성능 원고는 M0-A 챕터를 파일 시스템에서 읽으므로 서버가 내려준다 (개발·미리보기 서버 모두).
const corpusMiddleware: Connect.NextHandleFunction = (req, res, next) => {
  const send = (body: string, type: string) => {
    res.setHeader('Content-Type', `${type}; charset=utf-8`);
    res.end(body);
  };
  if (req.url === '/corpus.json') return send(JSON.stringify(loadCorpus()), 'application/json');
  const perf = /^\/perf\/(\d+)\.md$/.exec(req.url ?? '');
  if (perf) return send(perfText(Number(perf[1])), 'text/markdown');
  next();
};

function corpusEndpoint(): Plugin {
  return {
    name: 'corpus-endpoint',
    configureServer: (server) => void server.middlewares.use(corpusMiddleware),
    configurePreviewServer: (server) => void server.middlewares.use(corpusMiddleware),
  };
}

export default defineConfig({
  plugins: [react(), corpusEndpoint()],
  server: { port: 5173 },
  preview: { port: 4173 },
  build: { chunkSizeWarningLimit: 2000, rolldownOptions: { input: { index: 'index.html', perf: 'perf.html' } } },
});
