// 저장 실패 또는 conflict 결과가 renderer에 늦게 도착하는 동안, 그보다 먼저 도착한 더 최신 watcher 충돌 안내가 오래된 결과에 덮이지 않는지 본다.
// (late-save-response는 성공 응답을 본다. 여기는 실패 응답과 conflict 응답이다.)
// 장벽은 main 안에 있다: fs 장벽(화 파일의 임시 파일을 연 직후 / 이름 바꾸기 EPERM 주입)과 IPC 장벽(chapter:write 처리기가 끝난 뒤 결과 전달만).
// 호출·반환 카운터로 수신·해제·renderer 처리를 구분한다. 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const X1 = '# One\n\nfirst external\n';
const X2 = '# One\n\nsecond external\n';
const withText = (text: string) => ONE.replace('Alpha text', text);
const CHANGED = /다른 프로그램에서 바뀌었습니다/;
const DELETED = /지워졌거나 이름이 바뀌었습니다/;

async function project(): Promise<string> {
  const dir = await tempDir('late-result');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const alert = (page: Page) => page.getByRole('alert');

type G = {
  fsArmed: boolean; fsHeld: boolean; fsRelease?: () => void; failRename: boolean; renames: number;
  ipcArmed: boolean; ipcHeld: boolean; ipcRelease?: () => void; calls: number; returned: number; outcome: string[];
};
/** target(화 파일)의 저장: fs 장벽(임시 파일을 연 직후 붙잡기, 이름 바꾸기 EPERM)과 IPC 장벽(chapter:write 처리기가 끝난 뒤 결과 전달을 붙잡기) */
async function installBarriers(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { fsArmed: false, fsHeld: false, failRename: false, renames: 0, ipcArmed: false, ipcHeld: false, calls: 0, returned: 0, outcome: [] });
    const fsp = process.getBuiltinModule('fs/promises');
    const open = fsp.open;
    fsp.open = (async (path: string, ...args: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (g.fsArmed && String(path).startsWith(`${target}.`) && String(path).endsWith('.tmp')) {
        g.fsArmed = false;
        g.fsHeld = true;
        await new Promise<void>((resolve) => (g.fsRelease = resolve));
        g.fsHeld = false;
      }
      return handle;
    }) as typeof fsp.open;
    const rename = fsp.rename;
    fsp.rename = (async (from: string, to: string) => {
      if (String(from).startsWith(`${target}.`) && String(from).endsWith('.tmp')) {
        g.renames++;
        if (g.failRename) throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
      }
      return rename(from, to);
    }) as typeof fsp.rename;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.calls++;
      const r = await Promise.resolve()
        .then(() => original(...args))
        .then(
          (v) => ({ v }),
          (e: unknown) => ({ e }),
        );
      g.outcome.push('e' in r ? 'error' : String((r.v as { status: string }).status));
      if (g.ipcArmed) {
        g.ipcArmed = false;
        g.ipcHeld = true;
        await new Promise<void>((resolve) => (g.ipcRelease = resolve));
        g.ipcHeld = false;
      }
      g.returned++;
      if ('e' in r) throw r.e;
      return r.v;
    });
  }, target);
}
const flag = (app: ElectronApplication, key: 'fsArmed' | 'failRename' | 'ipcArmed') =>
  app.evaluate((_e, key) => void ((globalThis as unknown as Record<string, boolean>)[key] = true), key);
const releaseFs = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).fsRelease?.());
const releaseIpc = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).ipcRelease?.());
const counters = (app: ElectronApplication) =>
  app.evaluate(() => { const g = globalThis as unknown as G; return { fsHeld: g.fsHeld, ipcHeld: g.ipcHeld, calls: g.calls, returned: g.returned, renames: g.renames, outcome: [...g.outcome] }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 600 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
/** 상태 줄과 충돌 안내의 글자가 바뀔 때마다 window.seen에 쌓는다 */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    new MutationObserver(() => {
      w.seen.push([...document.querySelectorAll('[role="status"], [role="alert"]')].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ')).join(' | '));
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
/** 결과가 renderer에 반환되고 처리될 때까지 */
async function waitProcessed(page: Page, app: ElectronApplication, returned: number) {
  await waitUntil(page, '결과가 반환되지 않았다', async () => (await counters(app)).returned === returned);
  await page.evaluate(() => window.loreweave.chapters.list(1));
}

async function start() {
  const dir = await project();
  const { app, page } = await launch(await tempDir('late-result-userdata'));
  const path = join(dir, 'chapters', '001.md');
  await installBarriers(app, path);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('Alpha text').click();
  await page.keyboard.press('End');
  return { app, page, path };
}

test('늦게 도착한 저장 실패(EPERM)가 그보다 먼저 도착한 바깥 변경 충돌 안내를 지우지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await flag(app, 'failRename');
    await flag(app, 'ipcArmed');
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    // 이름 바꾸기가 (재시도 끝에) 실패한 결과가 main에서 나왔고 전달만 붙잡혀 있다
    await waitUntil(page, '저장 결과를 붙잡지 못했다', async () => (await counters(app)).ipcHeld);
    assert.deepEqual((await counters(app)).outcome, ['error']);
    assert.equal(await readFile(path, 'utf8'), ONE, '실패한 저장은 디스크를 바꾸지 않는다');
    await record(page);
    await writeFile(path, X1);
    await alert(page).getByText(CHANGED).waitFor({ timeout: 10_000 });
    assert.equal((await counters(app)).returned, 0, '실패 결과는 아직 renderer에 가지 않았다');
    await releaseIpc(app);
    await waitProcessed(page, app, 1);
    assert.equal(await alert(page).count(), 1, '늦은 저장 실패가 더 최신 충돌 안내를 지웠다');
    assert.equal(await readFile(path, 'utf8'), X1);
    assert.equal(await editor(page).getByText('Alpha text A', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    // 사용자가 덮어쓰기를 고르면 바깥 변경 뒤 해시로 저장된다 (주입을 풀어 저장 가능하게)
    await app.evaluate(() => void ((globalThis as unknown as G).failRename = false));
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), withText('Alpha text A'));
  } finally {
    await releaseIpc(app).catch(() => {});
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('늦게 도착한 conflict 결과가 그보다 먼저 도착한 더 최신 바깥 삭제 안내를 덮지 않고, 바깥 새 변경을 최신 해시 재확인 없이 덮어쓰지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await flag(app, 'fsArmed');
    await flag(app, 'ipcArmed');
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await waitUntil(page, '저장을 임시 파일 단계에서 붙잡지 못했다', async () => (await counters(app)).fsHeld);
    // 1) 쓰기 전에 바깥이 바꾼다: 곧 main의 저장 결과는 conflict가 된다. 실제 watcher 충돌이 도착한다
    await writeFile(path, X1);
    await alert(page).getByText(CHANGED).waitFor({ timeout: 10_000 });
    await releaseFs(app);
    await waitUntil(page, 'conflict 결과를 붙잡지 못했다', async () => (await counters(app)).ipcHeld);
    assert.deepEqual((await counters(app)).outcome, ['conflict']);
    assert.equal(await readFile(path, 'utf8'), X1, '바깥 바이트가 남았다');
    // 2) conflict 결과가 붙잡힌 동안 바깥이 파일을 지운다: 더 최신 watcher 충돌(삭제)이 도착한다
    await record(page);
    await rm(path);
    await alert(page).getByText(DELETED).waitFor({ timeout: 10_000 });
    assert.equal((await counters(app)).returned, 0, 'conflict 결과는 아직 renderer에 가지 않았다');
    // 3) 오래된 conflict 결과를 푼다
    await releaseIpc(app);
    await waitProcessed(page, app, 1);
    assert.equal(await alert(page).getByText(DELETED).count(), 1, '늦은 conflict 결과가 더 최신 삭제 안내를 덮었다');
    assert.equal(await alert(page).getByText(CHANGED).count(), 0);
    await assert.rejects(readFile(path), /ENOENT/);
    assert.equal(await editor(page).getByText('Alpha text A', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    // 4) 바깥이 다시 새 내용으로 만든다: 사용자가 '다시 만들기'를 눌러도, 지금 디스크의 해시를 다시 확인하므로 바깥 새 내용을 덮지 않는다
    await writeFile(path, X2);
    await page.getByRole('button', { name: '내 것으로 다시 만들기' }).click();
    await alert(page).getByText(CHANGED).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), X2, '최신 바깥 변경이 사용자의 오래된 선택에 덮였다');
    // 5) 이제 최신 안내에서 덮어쓰기를 고르면 그 뒤에 저장된다
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), withText('Alpha text A'));
  } finally {
    await releaseFs(app).catch(() => {});
    await releaseIpc(app).catch(() => {});
    // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
