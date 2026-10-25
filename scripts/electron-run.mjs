// TypeScript 측정 스크립트를 Electron main 프로세스에서 실행한다 (M5-PLAN 2절).
// 앱에 저장된 API 키(safeStorage)는 Electron 안에서만 풀 수 있어서, tsx를 로더로 붙여 Electron으로 띄운다.
// 사용: pnpm ai-script <스크립트.ts> [인자…]

import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import electron from 'electron';

const [entry, ...args] = process.argv.slice(2);
if (!entry) {
  console.error('사용: pnpm ai-script <스크립트.ts> [인자…]');
  process.exit(1);
}

const child = spawn(electron, [resolve(entry), ...args], {
  stdio: 'inherit',
  env: { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, '--import tsx'].filter(Boolean).join(' ') },
});
child.on('exit', (code) => process.exit(code ?? 1));
