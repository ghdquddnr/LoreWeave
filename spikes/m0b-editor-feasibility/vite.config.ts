import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { loadCorpus } from './corpus/cases.ts';

// 코퍼스는 M0-A 챕터를 파일 시스템에서 읽으므로 개발 서버가 JSON으로 내려준다.
function corpusEndpoint(): Plugin {
  return {
    name: 'corpus-endpoint',
    configureServer(server) {
      server.middlewares.use('/corpus.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify(loadCorpus()));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), corpusEndpoint()],
  server: { port: 5173 },
});
