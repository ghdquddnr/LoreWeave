// 저장이 실패한 채 사용자가 "변경 버림"을 거절하면(화 이동·창 닫기), 같은 화·같은 창·받아들인 입력 A+B가 그대로이고 디스크는 기존 바이트이며,
// 마지막 입력이 "저장됨"으로 보이지 않는다. 오류 주입을 풀고 명시적으로 저장하면 A+B가 정확한 바이트로 남고, 이동·종료·재실행 뒤에도 그대로다.
// (기존 save-race의 rename-fails는 오류와 화면 입력만 보고 닫기를 허용한다. 거절과 복구는 보지 않는다.)
// 실제 앱(Electron + Playwright). 장벽·주입은 main의 디스크 호출이다: 화 파일의 임시 파일을 연(open) 직후 첫 저장을 붙잡고, 풀기 전에 이름 바꾸기(rename)를 EPERM으로 만든다.
// 장벽은 호출 카운터로 수신·해제·다음 저장 시작을 구분한다. 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const TWO = '# Two\n\nBeta text\n';
const withText = (text: string) => ONE.replace('Alpha text', text);
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';

async function project(): Promise<string> {
  const dir = await tempDir('save-refusal');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const read = (dir: string, f = '001.md') => readFile(join(dir, 'chapters', f), 'utf8');
const tempFiles = async (dir: string) => (await readdir(join(dir, 'chapters'))).filter((f) => f.endsWith('.tmp'));

type G = { armed: boolean; holds: number; held: boolean; failRename: boolean; opens: number; renames: number; release?: () => void };
/** 화 파일(target)의 저장: 임시 파일을 연 직후 무장된 장벽이 붙잡고, failRename이 켜져 있으면 이름 바꾸기가 EPERM이다 */
async function installBarrier(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    const fsp = process.getBuiltinModule('fs/promises');
    g.armed = false;
    g.holds = 0;
    g.held = false;
    g.failRename = false;
    g.opens = 0;
    g.renames = 0;
    const open = fsp.open;
    fsp.open = (async (path: string, ...args: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (String(path).startsWith(`${target}.`) && String(path).endsWith('.tmp')) {
        g.opens++;
        if (g.armed) {
          g.armed = false;
          g.holds++;
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
        }
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
  }, target);
}
const counters = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { holds: g.holds, opens: g.opens, renames: g.renames, held: g.held }; });
const set = (app: ElectronApplication, key: 'armed' | 'failRename', value: boolean) =>
  app.evaluate((_e, [key, value]) => void ((globalThis as unknown as Record<string, boolean>)[key as string] = value as boolean), [key, value] as const);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 600 && !(await ok()); n++) await page.waitForTimeout(50);
  assert.equal(await ok(), true, what);
}
/** 상태 줄(role=status)의 글자가 바뀔 때마다 window.statusSeen에 쌓는다 */
const recordStatus = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { statusSeen: string[] };
    w.statusSeen = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="status"]')) w.statusSeen.push((el as HTMLElement).innerText);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
const statusSeen = (page: Page) => page.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen);
const currentChapter = (page: Page) => page.locator('.chapter.current').innerText();

async function start(userData: string, dir: string) {
  const { app, page } = await launch(userData);
  await installBarrier(app, join(dir, 'chapters', '001.md'));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('Alpha text').click();
  await page.keyboard.press('End');
  return { app, page };
}

for (const how of ['move', 'close'] as const) {
  test(`저장 실패 중 ${how === 'move' ? '화 이동' : '창 닫기'}의 변경 버림을 거절하면 A+B와 디스크가 안전하고, 오류를 풀고 저장하면 A+B 바이트가 ${how === 'move' ? '이동 뒤' : '종료·재실행 뒤'}에도 남는다`, { timeout: 120_000 }, async () => {
    const dir = await project();
    const userData = await tempDir('save-refusal-userdata');
    const first = await start(userData, dir);
    let app = first.app;
    const page = first.page;
    const dialogs: string[] = [];
    const onDialog = (d: import('playwright').Dialog) => {
      dialogs.push(d.message());
      void d.dismiss(); // 변경 버림을 거절한다
    };
    try {
      // 1) 저장 A를 붙잡고, 그동안 입력 B를 받아들인다
      await set(app, 'armed', true);
      await page.keyboard.type(' A');
      await page.keyboard.press('Control+S');
      await waitUntil(page, '첫 저장을 붙잡지 못했다', async () => (await counters(app)).held);
      assert.equal((await counters(app)).holds, 1);
      await page.keyboard.type(' B');
      assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1);
      // 2) 이름 바꾸기를 실패시키고 A를 풀어, 저장 오류를 만든다 (이 뒤로 화면의 모든 상태 변화를 기록한다)
      await recordStatus(page);
      await set(app, 'failRename', true);
      page.on('dialog', onDialog);
      await release(app);
      await page.getByRole('status').getByText('EPERM', { exact: false }).waitFor({ timeout: 30_000 });
      assert.ok((await counters(app)).renames >= 1, '이름 바꾸기 실패가 주입되지 않았다');
      assert.equal(await read(dir), ONE, '실패한 저장은 디스크를 바꾸지 않는다');
      // 3) 오류가 계속되는 동안 이동/닫기를 시도하고, 확인 창에서 거절한다
      const asked = dialogs.length;
      if (how === 'move') await chapter(page, 'Two').click();
      else await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]?.close());
      await waitUntil(page, '변경 버림 확인 창이 뜨지 않았다', async () => dialogs.length > asked);
      assert.equal(dialogs[asked], CONFIRM);
      // 거절의 처리가 끝날 때까지 renderer를 한 번 다녀온다
      await page.evaluate(() => window.loreweave.chapters.list(1));
      assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1, '거절했는데 창이 닫혔다');
      assert.equal(await currentChapter(page), 'One', '거절했는데 화가 바뀌었다');
      assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, '수락한 입력 A+B가 화면에 남아야 한다');
      assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
      assert.equal(await read(dir), ONE, '거절 뒤에도 디스크는 기존 바이트다');
      assert.deepEqual(await tempFiles(dir), []);
      assert.deepEqual((await statusSeen(page)).filter((t) => t.includes('저장됨')), [], '저장이 실패하는 동안 "저장됨"이 보이면 안 된다');
      // 4) 오류 주입을 풀고 명시적으로 저장한다
      page.off('dialog', onDialog);
      const settled = dialogs.length;
      const before = await counters(app);
      await set(app, 'failRename', false);
      await page.keyboard.press('Control+S');
      await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 30_000 });
      assert.ok((await counters(app)).renames > before.renames, '복구 뒤 저장이 이름 바꾸기까지 가지 않았다');
      assert.equal(await read(dir), withText('Alpha text A B'));
      assert.equal(await read(dir, '002.md'), TWO);
      assert.deepEqual(await tempFiles(dir), []);
      if (how === 'move') {
        await chapter(page, 'Two').click();
        await editor(page).getByText('Beta text').waitFor();
        assert.equal(dialogs.length, settled, '복구 뒤 이동에는 확인 창이 없어야 한다');
        await closeWindow(app);
      } else {
        await closeWindow(app); // 확인 창 없이 닫힌다 (닫힘이 끝나야 이 줄을 지난다)
        assert.equal(dialogs.length, settled, '복구 뒤 닫기에는 확인 창이 없어야 한다');
      }
      // 5) 다시 실행해서 다시 열어도 A+B가 바이트로 남아 있다
      const second = await launch(userData);
      app = second.app;
      await chapter(second.page, 'One').click();
      await editor(second.page).getByText('Alpha text A B', { exact: true }).waitFor();
      assert.equal(await read(dir), withText('Alpha text A B'));
      assert.equal(await read(dir, '002.md'), TWO);
    } finally {
      await set(app, 'failRename', false).catch(() => {});
      await release(app).catch(() => {});
      await closeWindow(app).catch(() => {});
    }
  });
}
