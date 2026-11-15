// 한글 조합이 진행 중인 상태에서 실제 창 닫기(BrowserWindow.close → closeAfterSave)를 요청하면, 새 편집 잠금(setEditable(false))이 걸리는 순간 조합이 어떻게 되는지와
// 그 뒤 입력 보존을 본다. 관측(첫 고유 로그 WINDOW_CLOSE_IME_*): 잠금과 함께 Chromium이 조합을 compositionend(조합 글자 데이터 포함)로 끝내고, 그 글자가 문서에 들어간 채 선행 저장(flush)이 쓴다.
// 정상 닫기: 조합 글자까지 원래 id·BOM·CRLF로 정확히 저장되고 폐기 확인·대기 안내 없이 실제로 닫히며 새 앱 재열기에서 보인다.
// 쓰기 실패(EPERM) + native 폐기 거절: 창·확정된 본문이 남고 디스크는 원래대로이며, 잠금이 풀린 뒤 실제 한국어 조합을 다시 확정하고 후속 입력·복구 저장·실제 닫기·재열기까지 Buffer가 일치한다.
// 조합은 CDP Input.imeSetComposition/insertText(실제 Chromium 입력 경로)이다: DOM contenteditable 강제 변경·PM transaction으로 조합을 흉내 내지 않고, 이미 잠긴 에디터에 조합을 새로 주입하지도 않는다.
// 이것은 실제 OS IME·수동 GUI 검증이 아니다 (OS IME는 조합 취소/재개 방식이 다를 수 있다). 자동저장/재시도의 조합 보호는 autosave-ime가 본다. 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { CDPSession, ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const chapter = (id: string, title: string) => `${BOM}---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${title} 본문\r\n`;
const A1 = chapter('a-1', 'A첫째');
const B2 = chapter('b-2', 'B둘째');
const C3 = chapter('c-3', 'C셋째');
const files: Record<string, string> = { '001.md': A1, '002.md': B2, '003.md': C3 };
const withBody = (suffix: string) => A1.replace('A첫째 본문', `A첫째 본문${suffix}`);
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';
const DISCARD_BUTTONS = ['저장하지 않고 닫기', '닫지 않기'];

interface G {
  armed: boolean;
  held: boolean;
  failRename: boolean;
  opens: number;
  renames: number;
  writes: number;
  creates: number;
  reissues: number;
  ais: number;
  discards: { message: string; buttons: string[] }[];
  waits: number;
  release?: () => void;
}
const hook = (app: ElectronApplication, target: string) =>
  app.evaluate(
    ({ ipcMain, dialog }, target) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { armed: false, held: false, failRename: false, opens: 0, renames: 0, writes: 0, creates: 0, reissues: 0, ais: 0, discards: [], waits: 0 });
      // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다
      const fsp = process.getBuiltinModule('fs/promises');
      const open = fsp.open;
      fsp.open = (async (path: string, ...args: unknown[]) => {
        const handle = await (open as (...a: unknown[]) => Promise<unknown>)(path, ...args);
        if (String(path).startsWith(`${target}.`) && String(path).endsWith('.tmp')) {
          g.opens++;
          if (g.armed) {
            g.armed = false;
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
        return (rename as (...a: unknown[]) => Promise<unknown>)(from, to);
      }) as typeof fsp.rename;
      const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      for (const [channel, key] of [
        ['chapter:write', 'writes'],
        ['chapter:create', 'creates'],
        ['chapter:reissue-id', 'reissues'],
        ['ai:analyze', 'ais'],
        ['ai:check', 'ais'],
      ] as const) {
        const original = map.get(channel)!;
        map.set(channel, (...args: unknown[]) => {
          g[key] += 1;
          return original(...args);
        });
      }
      // native 안내 대역: 폐기 확인은 기록하고 [닫지 않기](거절), 저장 대기 안내도 [닫기 취소]로 답한다 (뜨면 닫히지 못해 검사가 실패한다: 자동 수락 0)
      dialog.showMessageBox = ((_win: unknown, opts: { message: string; buttons?: string[] }) => {
        if (opts?.buttons?.includes('저장하지 않고 닫기')) g.discards.push({ message: opts.message, buttons: opts.buttons });
        else g.waits++;
        return Promise.resolve({ response: 1, checkboxChecked: false });
      }) as typeof dialog.showMessageBox;
    },
    target,
  );
const state = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as G;
    return { held: g.held, opens: g.opens, renames: g.renames, writes: g.writes, creates: g.creates, reissues: g.reissues, ais: g.ais, discards: g.discards, waits: g.waits, windows: BrowserWindow.getAllWindows().length };
  });
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const setFail = (app: ElectronApplication, on: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as G).failRename = v), on);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
async function waitUntil(what: string, ok: () => Promise<boolean>) {
  const deadline = Date.now() + 30_000;
  while (!(await ok())) {
    if (Date.now() > deadline) throw new Error(`시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const editor = (page: Page) => page.locator('.ProseMirror');
const events = (page: Page) => page.evaluate('window.ev') as Promise<string[]>;

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', name), text);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  const life = { appClosed: false };
  app.on('close', () => void (life.appClosed = true));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'A첫째' }).click();
  await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
  await hook(app, join(dir, 'chapters', '001.md'));
  // 조합·입력 이벤트 순서와 그 시점의 contenteditable·본문을 기록한다 (문자열 스크립트: 이름 도우미가 page에 없다)
  await page.evaluate(`(() => {
    window.ev = [];
    const rec = (e) => {
      const root = document.querySelector('.ProseMirror');
      const d = e.data !== undefined && e.data !== null ? '(' + e.data + ')' : '';
      const it = e.inputType ? '[' + e.inputType + ']' : '';
      window.ev.push(e.type + d + it + ' editable=' + (root && root.getAttribute('contenteditable')) + ' text=' + JSON.stringify(root && root.textContent));
    };
    for (const t of ['compositionstart', 'compositionupdate', 'compositionend', 'beforeinput', 'input']) document.addEventListener(t, rec, true);
  })()`);
  const cdp = await page.context().newCDPSession(page);
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  return { app, page, dir, read, life, cdp };
}

/** 확정된 기준 입력 X를 저장까지 마친 뒤 한국어 조합 '감'을 시작하고(조합 유지), 실제 BrowserWindow.close로 닫기를 시작해 선행 저장을 붙잡는다 */
async function closeDuringComposition(app: ElectronApplication, page: Page, cdp: CDPSession, read: (f: string) => Promise<Buffer>) {
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' X');
  await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
  assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')), '확정된 기준 입력 X가 저장됐다');
  await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
  const before = await events(page);
  assert.ok(before.some((e) => e.startsWith('compositionstart')) && !before.some((e) => e.startsWith('compositionend')), '조합이 진행 중이다 (compositionstart만 있고 compositionend 없음)');
  assert.equal(await editor(page).innerText(), 'A첫째 본문 X감', '잠금 직전 화면에 조합 글자가 보인다');
  assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
  await arm(app);
  await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]?.close());
  await waitUntil('선행 저장을 붙잡지 못했다', async () => (await state(app)).held);
  return state(app);
}

async function reopen(dir: string, expectedBody: string, expectedDisk: string) {
  const { app, page } = await launch(await tempDir('wcime-reopen-ud'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'A첫째' }).click();
    await editor(page).getByText(expectedBody, { exact: true }).waitFor();
    assert.deepEqual(await readFile(join(dir, 'chapters', '001.md')), Buffer.from(expectedDisk), '새 앱 재열기 뒤에도 디스크는 정확한 바이트다');
  } finally {
    await closeWindow(app);
  }
}

/** 정상 복구 뒤의 닫기: 정리용 closeWindow(폐기 자동 수락)를 쓰지 않고, 거절 대역을 유지한 채 실제 창 닫기로 앱이 종료되는지 본다 */
async function closeWithoutAsking(app: ElectronApplication, life: { appClosed: boolean }) {
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined);
  const deadline = Date.now() + 20_000;
  while (!life.appClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.equal(life.appClosed, true, '실제 창 닫기로 앱이 종료되어야 한다 (폐기 확인·대기 안내는 거절·취소되므로 뜨면 닫히지 못한다)');
}

test('조합 중 창 닫기: 잠금과 함께 조합이 확정되고 그 글자까지 정확히 저장되며, 폐기 확인·대기 안내 없이 실제로 닫히고 새 앱 재열기에서 보인다', { timeout: 150_000 }, async () => {
  const { app, page, dir, read, life, cdp } = await start('wcime-ok');
  try {
    const held = await closeDuringComposition(app, page, cdp, read);
    const ev = await events(page);
    const editable = await editor(page).getAttribute('contenteditable');
    const text = await editor(page).innerText();
    console.error('WINDOW_CLOSE_IME_BARRIER', JSON.stringify({ ...held, discards: held.discards.length, contenteditable: editable, text, endEvents: ev.filter((e) => e.startsWith('compositionend')) }));
    assert.equal(held.writes, 2, '기준 X의 자동 저장 1회 + 창 닫기의 선행 flush 1회');
    assert.equal(held.windows, 1, '저장 중에는 창이 그대로다');
    assert.equal(held.discards.length + held.waits, 0, '붙잡힌 동안 native 안내 0');
    assert.equal(held.creates + held.reissues + held.ais, 0, '불필요한 create/reissue/AI 진입 0');
    assert.equal(editable, 'false', '닫기의 저장 동안 편집 잠금');
    // 잠금과 함께 Chromium이 조합을 끝냈다: compositionend가 정확히 한 번, 조합 글자 데이터를 싣고 온다 (OS IME는 다를 수 있다)
    const ends = ev.filter((e) => e.startsWith('compositionend'));
    assert.equal(ends.length, 1, '조합은 compositionend로 한 번 끝났다');
    assert.ok(ends[0]!.startsWith('compositionend(감)'), `compositionend가 조합 글자를 싣는다: ${ends[0]}`);
    assert.equal(text, 'A첫째 본문 X감', '조합 글자가 화면에 그대로 남는다 (취소·삭제되지 않았다)');
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')), '붙잡힌 동안 디스크는 아직 기준 X다');
    for (const f of ['002.md', '003.md']) assert.deepEqual(await read(f), Buffer.from(files[f]!), `${f} 불변`);

    // 저장을 풀면 폐기 확인·대기 안내 없이 닫힌다
    await release(app);
    await waitUntil('창이 닫히지 않았다', async () => life.appClosed);
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X감')), '조합 글자까지 원래 id·BOM·CRLF로 정확히 저장됐다');
    for (const f of ['002.md', '003.md']) assert.deepEqual(await read(f), Buffer.from(files[f]!), `${f} 불변`);
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변, 임시 파일 0');
    await reopen(dir, 'A첫째 본문 X감', withBody(' X감'));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('조합 중 창 닫기의 저장이 쓰기 실패로 끝나고 폐기를 거절하면: 창·확정된 본문 보존, 디스크 그대로, 잠금 해제 뒤 실제 조합 확정·후속 입력·복구 저장·닫기·재열기 Buffer 일치', { timeout: 150_000 }, async () => {
  const { app, page, dir, read, life, cdp } = await start('wcime-fail');
  try {
    const held = await closeDuringComposition(app, page, cdp, read);
    assert.equal(held.writes, 2);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '붙잡힌 동안 편집 잠금');
    await setFail(app, true);
    await release(app);
    await waitUntil('native 폐기 확인이 뜨지 않았다', async () => (await state(app)).discards.length >= 1);
    const asked = await state(app);
    console.error('WINDOW_CLOSE_IME_FAIL_DECISION', JSON.stringify({ discards: asked.discards, waits: asked.waits, windows: asked.windows, renames: asked.renames }));
    assert.deepEqual(asked.discards, [{ message: CONFIRM, buttons: DISCARD_BUTTONS }], 'native 폐기 확인 1회 (거절만 답했다)');
    assert.ok(asked.renames >= 1, 'rename 실패가 주입되지 않았다');
    assert.equal(asked.creates + asked.reissues + asked.ais, 0, '불필요한 create/reissue/AI 진입 0');
    assert.equal(asked.windows, 1, '폐기를 거절했으므로 창이 남는다');
    assert.equal(life.appClosed, false);
    await waitUntil('편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    assert.equal(await editor(page).innerText(), 'A첫째 본문 X감', '확정된 조합 글자가 화면에 남는다');
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')), '실패한 저장은 디스크를 바꾸지 않는다 (기준 X 그대로)');
    for (const f of ['002.md', '003.md']) assert.deepEqual(await read(f), Buffer.from(files[f]!), `${f} 불변`);

    // 잠금이 풀린 뒤 실제 한국어 조합을 새로 시작해 확정하고 후속 입력을 받는다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await cdp.send('Input.imeSetComposition', { text: '값', selectionStart: 1, selectionEnd: 1 });
    assert.equal(await editor(page).innerText(), 'A첫째 본문 X감값', '잠금 해제 뒤 새 조합이 화면에 보인다');
    await page.keyboard.insertText('값'); // 조합 확정
    await page.keyboard.type(' Z');
    await editor(page).getByText('A첫째 본문 X감값 Z', { exact: true }).waitFor();
    // 실패 해제 후 저장 (Ctrl+S와 자동 재시도를 구분하지 못한다)
    await setFail(app, false);
    await page.keyboard.press('Control+s');
    await waitUntil('최종 본문이 저장되지 않았다', async () => (await read('001.md')).toString('utf8') === withBody(' X감값 Z'));
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X감값 Z')), '최종 본문이 원래 id·BOM·CRLF로 정확히 저장됐다');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal((await state(app)).discards.length, 1, '복구 뒤 추가 폐기 확인 0 (닫기 전)');
    await closeWithoutAsking(app, life);
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X감값 Z')));
    for (const f of ['002.md', '003.md']) assert.deepEqual(await read(f), Buffer.from(files[f]!), `${f} 불변`);
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변, 임시 파일 0');
    await reopen(dir, 'A첫째 본문 X감값 Z', withBody(' X감값 Z'));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
