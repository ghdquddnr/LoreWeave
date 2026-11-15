// 개발 흐름 유지 확인: 실제 `electron-vite dev`(개발 서버 + `electron .`)로 띄운 앱은 여전히 개발 서버(http) renderer로 부팅한다.
// 배포 폴더 실행본이 상속된 ELECTRON_RENDERER_URL을 무시하는 production 시작 경계(package-win-smoke의 두 번째 검사)의 짝이다: 같은 main 분기가 두 실행 형태를 구분함을 실제 실행으로 관측한다.
// 격리 userData(별도 폴더)만 쓰고 원고 프로젝트는 열지 않는다(부팅 관측만). 이 검사가 띄운 프로세스 트리만 정리하며 사용자의 기존 앱·서버는 건드리지 않는다. 실제 외부 URL·AI·유료 호출 없음.
// 관측: 창의 실제 URL(CDP 대상 목록), 메인 프로세스의 process.defaultApp(V8 inspector의 Runtime.evaluate), 띄워진 electron.exe의 명령줄. 합성 Electron 자동화이며 수동 GUI가 아니다.

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { tempDir } from './launch.ts';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

async function until<T>(what: string, probe: () => Promise<T | null>, ms = 90_000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** 메인 프로세스의 inspector에서 식을 평가한다 (Node 내장 WebSocket) */
async function evaluateInMain(port: number, expression: string): Promise<unknown> {
  const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { webSocketDebuggerUrl: string }[];
  const ws = new WebSocket(targets[0]!.webSocketDebuggerUrl);
  await new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error('inspector 연결 실패'));
  });
  const result = await new Promise<unknown>((resolve) => {
    ws.onmessage = (event) => resolve(JSON.parse(String(event.data)));
    ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
  });
  ws.close();
  return (result as { result?: { result?: { value?: unknown } } }).result?.result?.value;
}

test('electron-vite dev: 개발 서버(http) renderer로 부팅하고 process.defaultApp이 true다 (개발 흐름 유지)', { timeout: 180_000 }, async () => {
  const userData = await tempDir('devboot-userdata');
  const debugPort = await freePort();
  const inspectPort = await freePort();
  const child = spawn(process.execPath, [join('node_modules', 'electron-vite', 'bin', 'electron-vite.js'), 'dev', '--', `--user-data-dir=${userData}`], {
    cwd: process.cwd(),
    env: { ...(process.env as Record<string, string>), REMOTE_DEBUGGING_PORT: String(debugPort), V8_INSPECTOR_PORT: String(inspectPort) },
    stdio: 'ignore',
  });
  try {
    // 창의 실제 URL: 개발 서버가 준비되어 창이 http로 열릴 때까지 기다린다 (임의 sleep이 아니라 대상 목록을 본다)
    const windowUrl = await until('개발 창의 URL', async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as { type: string; url: string }[];
      return targets.find((t) => t.type === 'page' && /^https?:\/\//.test(t.url))?.url ?? null;
    });
    const defaultApp = await until('main의 process.defaultApp', async () => {
      const value = await evaluateInMain(inspectPort, 'process.defaultApp');
      return value === undefined ? null : value;
    });
    const commandLine = execFileSync('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -like '*--remote-debugging-port=${debugPort}*' } | Select-Object -First 1).CommandLine`], { encoding: 'utf8' }).trim();
    console.error('DEV_BOOT_FACTS', JSON.stringify({ windowUrl, defaultApp, commandLine: commandLine.replace(/\\/g, '/') }));
    // 격리 확인: 실행된 electron 프로세스가 별도 userData 인자를 실제로 받았다 (전달 방식은 `electron-vite dev -- <인자>`; 환경변수 ELECTRON_CLI_ARGS는 전달되지 않음을 관측했다)
    const argv = (await evaluateInMain(inspectPort, 'process.argv')) as string[];
    assert.ok(argv.some((a) => a === `--user-data-dir=${userData}`), `별도 userData 인자를 받았다: ${JSON.stringify(argv)}`);
    assert.match(windowUrl, /^http:\/\/(localhost|127\.0\.0\.1):\d+\//, `창이 개발 서버(http)로 열렸다: ${windowUrl}`);
    assert.equal(defaultApp, true, '개발 흐름에서는 process.defaultApp이 true다');
    assert.match(commandLine, /electron\.exe"?\s+\./, 'electron . 형태(기본 앱 명시 실행)로 실행됐다');
    // renderer가 실제로 부팅했다: 환영 화면이 보인다 (CDP로 붙어 읽기만 한다)
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    try {
      const page = browser.contexts()[0]!.pages().find((p) => /^https?:\/\//.test(p.url()))!;
      await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
      assert.equal(page.url(), windowUrl);
    } finally {
      await browser.close(); // CDP 연결만 끊는다 (앱 프로세스는 아래에서 이 검사가 띄운 트리로 정리)
    }
  } finally {
    // 이 검사가 띄운 electron-vite 프로세스 트리만 끝낸다
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } catch {
      // 이미 끝났다
    }
  }
});
