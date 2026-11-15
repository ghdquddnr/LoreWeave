// 패키지 실행본(이름이 바뀐 LoreWeave.exe 포함)을 *제품 main 실행 전에* 멈추는 시작 장벽 도우미 (테스트 전용; 이 파일은 테스트가 아니다).
// 방식: 실행파일을 `--inspect-brk`로 띄우면 앱의 main 스크립트(제품 main)가 실행되기 전 첫 줄에서 멈춘다. 그 지점에서 inspector의 Debugger.evaluateOnCallFrame으로
//   실제 app.getPath('userData')와 process.argv를 읽어 기대한 합성 임시 경로와 같을 때만 재개(resume)한다. 다르면 재개하지 않고 이 테스트가 띄운 프로세스 트리만 끝낸다 → 제품 main이 시작되지 않는다.
//   (NODE_OPTIONS=--require 방식은 이름이 바뀐 실행파일에서 적용되지 않음을 관측해 쓰지 않는다. 실패 로그: package-win-branded-smoke 첫 실행.)
// 보장 범위: 제품 main 실행 경계까지다. Electron/Chromium 자체의 초기화(프로필 파일 생성 등)는 이 장벽보다 먼저 일어나며 막지 못한다. --user-data-dir 없는 실행은 만들지 않는다.
// 통과하면 같은 지점에서 main 쪽 도구(`globalThis.__lw`=electron 모듈, 외부 요청 기록)를 설치한 뒤 재개하고, UI는 CDP(--remote-debugging-port)로 Playwright가 붙는다.

import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { chromium, type Browser, type Page } from 'playwright';

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

const debug = (m: string) => {
  if (process.env['LW_BARRIER_DEBUG']) console.error(`BARRIER_STAGE ${m}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const killTree = (pid: number | undefined) => {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // 이미 끝났다
  }
};

class Inspector {
  private id = 0;
  private readonly pending = new Map<number, (d: { result?: unknown; error?: { message: string } }) => void>();
  readonly events: { method: string; params: Record<string, unknown> }[] = [];
  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (m) => {
      const d = JSON.parse(String(m.data)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message: string } };
      if (d.id !== undefined && this.pending.has(d.id)) this.pending.get(d.id)!(d);
      else if (d.method) this.events.push({ method: d.method, params: d.params ?? {} });
    };
  }
  static async connect(port: number): Promise<Inspector> {
    let url = '';
    for (let i = 0; i < 150 && !url; i += 1) {
      try {
        const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { webSocketDebuggerUrl: string }[];
        url = targets[0]?.webSocketDebuggerUrl ?? '';
      } catch {
        await sleep(200);
      }
    }
    if (!url) throw new Error('inspector에 연결하지 못했다');
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('inspector WebSocket 오류'));
    });
    return new Inspector(ws);
  }
  send(method: string, params: Record<string, unknown> = {}): Promise<{ result?: unknown; error?: { message: string } }> {
    return new Promise((resolve) => {
      this.id += 1;
      this.pending.set(this.id, resolve);
      this.ws.send(JSON.stringify({ id: this.id, method, params }));
    });
  }
  async waitPaused(): Promise<string> {
    for (let i = 0; i < 300; i += 1) {
      const e = this.events.find((x) => x.method === 'Debugger.paused');
      if (e) return (e.params['callFrames'] as { callFrameId: string }[])[0]!.callFrameId;
      await sleep(100);
    }
    throw new Error('main 첫 줄 정지(Debugger.paused)를 기다리다 시간 초과');
  }
  close(): void {
    this.ws.close();
  }
}

export interface BarrierFacts {
  userData: string;
  argv: string[];
  name: string;
  isPackaged: boolean;
  defaultApp: boolean | null;
}

export interface BarrierRefused {
  refused: true;
  facts: BarrierFacts;
  reason: string;
  pageTargetsAtRefusal: number | null;
}

export interface BarrierApp {
  refused: false;
  facts: BarrierFacts;
  /** 장벽 단계 기록: 제품 main보다 먼저 일어난 일 */
  phases: string[];
  page: Page;
  /** main 프로세스에서 식을 평가한다 (globalThis.__lw = electron 모듈) */
  evalMain(expression: string): Promise<unknown>;
  netLog(): Promise<string[]>;
  aiCalls(): Promise<number>;
  stubFolderDialog(dir: string): Promise<void>;
  /** 앱을 정상 종료(app.quit)하고 확인한다. 한도 안에 끝나지 않으면 이 앱의 프로세스 트리만 강제 종료하고 그 사실을 돌려준다 */
  close(): Promise<{ graceful: boolean }>;
}

const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();

const FACTS_EXPR = "JSON.stringify({ userData: require('electron').app.getPath('userData'), argv: process.argv.slice(1), name: require('electron').app.getName(), isPackaged: require('electron').app.isPackaged, defaultApp: process.defaultApp ?? null })";

// 이 식은 main의 첫 줄에서 실행된다: 도구를 설치하고 whenReady 전에 요청 기록을 등록한다 (제품이 창을 만들기 전에 실행된다)
const INSTALL_EXPR = `(() => {
  globalThis.__lw = require('electron');
  globalThis.__net = [];
  globalThis.__ai = 0;
  const http = process.getBuiltinModule('http');
  const https = process.getBuiltinModule('https');
  for (const mod of [http, https]) {
    const original = mod.request;
    mod.request = (...args) => {
      globalThis.__net.push('node:' + String(typeof args[0] === 'string' ? args[0] : (args[0] && (args[0].href || args[0].host))));
      return original(...args);
    };
  }
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => { globalThis.__net.push('fetch:' + String(input)); return realFetch(input, init); };
  globalThis.__lw.app.whenReady().then(() => {
    globalThis.__lw.session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (!/^(file|devtools|chrome-extension|data|blob):/i.test(details.url)) globalThis.__net.push('session:' + details.url);
      callback({});
    });
  });
  return true;
})()`;

/**
 * 실행파일을 제품 main 실행 전에 멈추고 실제 userData·argv를 확인한 뒤 통과할 때만 재개한다.
 * userDataArg는 --user-data-dir로 줄 값, expectedUserData는 장벽이 기대하는 값이다 (둘 다 이 테스트가 만든 합성 임시 경로여야 한다; 음성 검사는 둘을 다르게 준다).
 */
export async function launchBarriered(exe: string, userDataArg: string, expectedUserData: string, env: Record<string, string> = {}): Promise<BarrierRefused | BarrierApp> {
  const debugPort = await freePort();
  const inspectPort = await freePort();
  const childEnv = { ...(process.env as Record<string, string>), ...env };
  if (!('ELECTRON_RENDERER_URL' in env)) delete childEnv['ELECTRON_RENDERER_URL'];
  const child: ChildProcess = spawn(exe, [`--user-data-dir=${userDataArg}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', `--remote-debugging-port=${debugPort}`, `--inspect-brk=${inspectPort}`], { cwd: tmpdir(), env: childEnv, stdio: 'ignore' });
  const exited = new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
  let inspector: Inspector | null = null;
  try {
    inspector = await Inspector.connect(inspectPort);
    debug('inspector-connected');
    await inspector.send('Debugger.enable');
    await inspector.send('Runtime.runIfWaitingForDebugger');
    const frame = await inspector.waitPaused();
    debug('paused');
    const evaluated = await inspector.send('Debugger.evaluateOnCallFrame', { callFrameId: frame, expression: FACTS_EXPR, returnByValue: true });
    const raw = (evaluated.result as { result?: { value?: string } } | undefined)?.result?.value;
    if (!raw) throw new Error(`장벽이 실제 userData를 읽지 못했다: ${JSON.stringify(evaluated)}`);
    const facts = JSON.parse(raw) as BarrierFacts;
    const argvOk = facts.argv.some((a) => a === `--user-data-dir=${expectedUserData}`);
    if (!argvOk || norm(facts.userData) !== norm(expectedUserData)) {
      // 재개하지 않는다: 제품 main은 실행되지 않는다. 이 테스트가 띄운 프로세스 트리만 끝낸다
      let pageTargetsAtRefusal: number | null = null;
      try {
        pageTargetsAtRefusal = ((await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json()) as { type: string }[]).filter((t) => t.type === 'page').length;
      } catch {
        pageTargetsAtRefusal = null;
      }
      inspector.close();
      killTree(child.pid);
      await exited;
      return { refused: true, facts, reason: argvOk ? 'userData 불일치' : 'argv 불일치', pageTargetsAtRefusal };
    }
    const phases = ['paused-before-product-main', 'userData-and-argv-verified'];
    const installed = await inspector.send('Debugger.evaluateOnCallFrame', { callFrameId: frame, expression: INSTALL_EXPR, returnByValue: true });
    if ((installed.result as { result?: { value?: boolean } } | undefined)?.result?.value !== true) throw new Error(`장벽의 도구 설치 실패: ${JSON.stringify(installed)}`);
    phases.push('tools-installed');
    await inspector.send('Debugger.resume');
    phases.push('resumed');
    debug('resumed');
    const insp = inspector;
    const evalMain = async (expression: string): Promise<unknown> => {
      const r = await insp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      const res = r.result as { result?: { value?: unknown }; exceptionDetails?: { text: string } } | undefined;
      if (res?.exceptionDetails) throw new Error(`main 평가 실패: ${res.exceptionDetails.text} ${expression.slice(0, 80)}`);
      return res?.result?.value;
    };
    // 재개 직후에는 DevTools 포트가 아직 열리지 않았을 수 있다: 열릴 때까지 기다린다 (앱이 먼저 끝나면 실패)
    let listening = false;
    for (let i = 0; i < 300 && !listening; i += 1) {
      try {
        listening = (await fetch(`http://127.0.0.1:${debugPort}/json/version`)).ok;
      } catch {
        if (child.exitCode !== null) throw new Error(`앱이 DevTools 포트가 열리기 전에 종료했다 (exit ${child.exitCode})`);
        await sleep(200);
      }
    }
    if (!listening) throw new Error('DevTools 포트가 열리지 않았다');
    debug('devtools-listening');
    const browser: Browser = await chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
    debug('cdp-connected');
    let page: Page | undefined;
    for (let i = 0; i < 300 && !page; i += 1) {
      page = browser.contexts()[0]?.pages().find((p) => /^file:/.test(p.url()) || p.url() !== 'about:blank');
      if (!page) await sleep(200);
    }
    debug(`page ${page ? page.url() : 'none'}`);
    if (!page) throw new Error('제품 창을 찾지 못했다');
    await page.waitForLoadState('domcontentloaded');
    await evalMain("(() => { const map = globalThis.__lw.ipcMain._invokeHandlers; for (const channel of ['ai:analyze', 'ai:check', 'ai:run-check']) { const original = map.get(channel); if (original) map.set(channel, (...args) => { globalThis.__ai += 1; return original(...args); }); } return true; })()");
    const handle: BarrierApp = {
      refused: false,
      facts,
      phases,
      page,
      evalMain,
      netLog: async () => (await evalMain('globalThis.__net')) as string[],
      aiCalls: async () => (await evalMain('globalThis.__ai')) as number,
      stubFolderDialog: async (dir) => {
        await evalMain(`globalThis.__lw.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [${JSON.stringify(dir)}] }); true`);
      },
      close: async () => {
        // 정리용: 닫을 때 저장하지 못한 변경이 있어 main이 폐기 확인을 띄우면 [저장하지 않고 닫기]로 답한다 (launch.ts closeWindow와 같은 정리 전용 대역). 그다음 창을 닫는다 (renderer가 저장을 마치고 답할 때까지 기다린다)
        try {
          await evalMain("(() => { const d = globalThis.__lw.dialog; if (!d.__lwCleanupDiscard) { d.__lwCleanupDiscard = true; const prev = d.showMessageBox.bind(d); d.showMessageBox = (win, opts) => (opts && opts.buttons && opts.buttons.includes('저장하지 않고 닫기') ? Promise.resolve({ response: 0, checkboxChecked: false }) : prev(win, opts)); } return true; })()");
          await evalMain('(globalThis.__lw.BrowserWindow.getAllWindows()[0]?.close(), true)');
        } catch {
          // 이미 종료 중일 수 있다
        }
        // 종료가 시작되면 inspector 연결이 남아 있는 main이 끝나지 않는 것을 관측했다: 창닫기 요청을 보낸 뒤 연결을 먼저 닫고 종료를 기다린다
        await sleep(500);
        insp.close();
        const first = await Promise.race([exited.then(() => 'exited'), sleep(20_000).then(() => 'timeout')]);
        await browser.close().catch(() => undefined);
        if (first === 'exited') return { graceful: true };
        killTree(child.pid); // 이 앱의 프로세스 트리만
        await exited;
        return { graceful: false };
      },
    };
    return handle;
  } catch (e) {
    inspector?.close();
    killTree(child.pid);
    throw e;
  }
}
