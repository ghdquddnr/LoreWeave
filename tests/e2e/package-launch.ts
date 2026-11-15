// 패키지 실행본 e2e가 공유하는 도우미 (package-win-smoke / package-win-branded-smoke). 이 파일은 테스트가 아니다.
import { tmpdir } from 'node:os';
import { _electron, type ElectronApplication, type Page } from 'playwright';

export const BOM = '﻿';
export const chapter = (id: string, title: string, body: string) => `${BOM}---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${body}\r\n`;
export const ONE = chapter('pk-1', '첫째 화', '포장 검사 본문 하나');
export const TWO = chapter('pk-2', '둘째 화', '포장 검사 이웃 본문');
/** 실행본을 그 실행파일(electron.exe 또는 LoreWeave.exe)로 직접 띄운다 (앱 경로 인자 없음, cwd는 저장소 밖) */
export async function launchPackaged(exe: string, userData: string, inheritedEnv: Record<string, string> = {}): Promise<{ app: ElectronApplication; page: Page }> {
  const env = { ...(process.env as Record<string, string>) };
  delete env['ELECTRON_RENDERER_URL']; // 기본: 개발 서버 변수 없음 (상속 시나리오는 아래 별도 검사가 inheritedEnv로 설정한다)
  Object.assign(env, inheritedEnv);
  const app = await _electron.launch({
    executablePath: exe,
    args: [`--user-data-dir=${userData}`, '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1'],
    cwd: tmpdir(),
    env,
  });
  await app.evaluate(() => {
    // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다. 설치 시점 이후의 외부 요청을 기록한다
    const g = globalThis as unknown as { net: string[]; ai: number };
    g.net = [];
    g.ai = 0;
    const http = process.getBuiltinModule('http');
    const https = process.getBuiltinModule('https');
    for (const mod of [http, https]) {
      const original = mod.request;
      (mod as unknown as { request: unknown }).request = (...args: unknown[]) => {
        g.net.push(`node:${String(typeof args[0] === 'string' ? args[0] : (args[0] as { href?: string; host?: string })?.href ?? (args[0] as { host?: string })?.host)}`);
        return (original as (...a: unknown[]) => unknown)(...args);
      };
    }
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: unknown) => {
      g.net.push(`fetch:${String(input)}`);
      return realFetch(input as string, init as RequestInit);
    }) as typeof fetch;
  });
  await app.evaluate(({ ipcMain, session }) => {
    const g = globalThis as unknown as { net: string[]; ai: number };
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    for (const channel of ['ai:analyze', 'ai:check', 'ai:run-check']) {
      const original = map.get(channel);
      if (original)
        map.set(channel, (...args: unknown[]) => {
          g.ai += 1;
          return original(...args);
        });
    }
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (!/^(file|devtools|chrome-extension|data|blob):/i.test(details.url)) g.net.push(`session:${details.url}`);
      callback({});
    });
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page };
}

export const netLog = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { net: string[]; ai: number }).net);
export const aiCalls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { ai: number }).ai);
export const editor = (page: Page) => page.locator('.ProseMirror');
export const chapterButton = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
