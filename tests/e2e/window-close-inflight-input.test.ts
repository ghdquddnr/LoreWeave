// 실제 창 닫기(BrowserWindow.close → beforeClose → App.closeAfterSave)의 선행 저장 동안에는 에디터가 잠긴다 (탭 닫기·폴더 전환과 같은 lockEditor 깊이 계수, 시도 번호별 소유).
// 닫는 중 받으려던 입력 Y는 수락되지 않고(유실이 아니라 미수락), 잠그기 전에 받은 X만 원래 id·BOM·CRLF로 저장되며, 정상 저장 뒤에는 폐기 확인·대기 안내 없이 실제로 닫힌다.
// 저장이 실제 디스크 쓰기 실패로 끝나고 native 폐기 확인을 거절하면 창·X·디스크가 남고 잠금이 풀려 추가 입력 Z를 받는다. main의 10초 timeout [닫기 취소] 뒤에는 저장 HOLD가 아직 풀리지 않았어도 편집이 돌아오며,
// 취소한 시도의 늦은 저장 완료는 창을 닫지 않고 새 입력을 저장 완료로 오인시키지 않고, 그 시도의 늦은 finally는 다음 닫기 시도의 잠금을 풀지 않는다.
// (PR #210은 잠금이 없던 이전 정책에서 닫는 중 받은 Y가 정상 저장 뒤에도 폐기 확인을 부르던 관측을 고정했다: 그 정책 변경을 이 검사가 대신한다. 일반 저장 중 입력 수락 정책은 save-inflight-input이 본다.)
// 폐기 확인·대기 안내는 main의 native dialog.showMessageBox 대역이다: 정상 닫기 판정에 launch.ts의 정리용 closeWindow(폐기 자동 수락)를 쓰지 않고, 거절 대역을 유지한 채 실제 창 닫기로 앱이 종료되는지 본다.
// 실제 앱(Electron + Playwright). 장벽·주입은 main의 디스크 호출이다: A/001.md 임시 파일을 연 직후 선행 저장을 붙잡고, 실패 경우에는 풀기 전에 rename을 EPERM으로 만든다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 합성 자동화이며 수동 GUI·실제 OS IME가 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
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
  /** IPC 진입 수 (처리기는 그대로 실행한다) */
  writes: number;
  creates: number;
  reissues: number;
  ais: number;
  /** native 폐기 확인 기록 (문구·버튼). 거절만 답한다 */
  discards: { message: string; buttons: string[] }[];
  /** 폐기 확인이 아닌 native 안내(저장 대기 등) 수: 기본은 계속 기다리기로 답하고, strictWait이면 [닫기 취소]로 답해 닫기를 막는다 */
  waits: number;
  strictWait: boolean;
  /** manualWait이면 저장 대기 안내를 테스트가 고른 선택으로만 닫는다 (resolvers에 쌓는다) */
  manualWait: boolean;
  waitResolvers: ((response: number) => void)[];
  release?: () => void;
}
const hook = (app: ElectronApplication, target: string) =>
  app.evaluate(
    ({ ipcMain, dialog }, target) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { armed: false, held: false, failRename: false, opens: 0, renames: 0, writes: 0, creates: 0, reissues: 0, ais: 0, discards: [], waits: 0, strictWait: false, manualWait: false, waitResolvers: [] });
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
      const prev = dialog.showMessageBox.bind(dialog) as (...a: unknown[]) => Promise<unknown>;
      dialog.showMessageBox = ((win: unknown, opts: { message: string; buttons?: string[] }) => {
        if (opts?.buttons?.includes('저장하지 않고 닫기')) {
          g.discards.push({ message: opts.message, buttons: opts.buttons });
          return Promise.resolve({ response: 1, checkboxChecked: false }); // [닫지 않기]: 폐기 거절
        }
        g.waits++;
        if (g.manualWait) return new Promise((resolve) => g.waitResolvers.push((response: number) => resolve({ response, checkboxChecked: false })));
        return Promise.resolve({ response: g.strictWait ? 1 : 0, checkboxChecked: false }); // 저장 대기 안내: 계속 기다리기 (strictWait이면 [닫기 취소]: 정상 닫기 판정에서 안내가 뜨면 닫기가 막혀 검사가 실패한다)
      }) as typeof dialog.showMessageBox;
      void prev;
    },
    target,
  );
const state = (app: ElectronApplication) =>
  app.evaluate(({ BrowserWindow }) => {
    const g = globalThis as unknown as G;
    return {
      held: g.held,
      opens: g.opens,
      renames: g.renames,
      writes: g.writes,
      creates: g.creates,
      reissues: g.reissues,
      ais: g.ais,
      discards: g.discards,
      waits: g.waits,
      waitPending: g.waitResolvers.length,
      windows: BrowserWindow.getAllWindows().length,
    };
  });
const setManualWait = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).manualWait = true));
const setStrict = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).strictWait = true));
/** 대기 중인 저장 대기 안내 하나를 고른 선택으로 닫는다 (0: 계속 기다리기, 1: 닫기 취소) */
const answerWait = (app: ElectronApplication, response: number) => app.evaluate((_e, r) => void (globalThis as unknown as G).waitResolvers.shift()?.(r), response);
/** main의 정확히 10000ms 타이머만 300ms로 앞당긴다 (close-save-timeout과 같은 방식: 실제 timeout 경로가 발화한다) */
const shrinkTimeout = (app: ElectronApplication) =>
  app.evaluate(() => {
    const real = globalThis.setTimeout;
    globalThis.setTimeout = ((fn: () => void, delay?: number, ...rest: unknown[]) => real(fn, delay === 10000 ? 300 : delay, ...rest)) as unknown as typeof setTimeout;
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
const statusSeen = (page: Page) => page.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen);

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', name), text);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  const life = { appClosed: false };
  app.on('close', () => void (life.appClosed = true));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
  await hook(app, join(dir, 'chapters', '001.md'));
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  return { app, page, dir, read, life };
}

/** 미저장 X를 확인하고 실제 BrowserWindow.close로 창 닫기를 시작해, 선행 저장을 디스크 경계에서 붙잡는다 */
async function closeWithHeldSave(app: ElectronApplication, page: Page) {
  await arm(app);
  await editor(page).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' X');
  await editor(page).getByText('A첫째 본문 X', { exact: true }).waitFor();
  assert.equal((await state(app)).opens, 0, '닫기 전에는 저장이 시작되지 않았다 (X는 미저장)');
  assert.equal(await page.getByRole('status').getByText('저장됨', { exact: true }).count(), 0);
  await page.evaluate(() => {
    const w = window as unknown as { statusSeen: string[] };
    w.statusSeen = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="status"]')) w.statusSeen.push((el as HTMLElement).innerText);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
  await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]?.close());
  await waitUntil('선행 저장을 붙잡지 못했다', async () => (await state(app)).held);
  return state(app);
}

/** 붙잡힌 동안 실제 에디터 본문에 pointer click + 키로 Y를 시도하고, 수락 여부와 키 target을 관측한다 (DOM·PM transaction 조작 0) */
async function tryY(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { keyTargets: { key: string; tag: string; inEditor: boolean }[] };
    w.keyTargets = [];
    document.addEventListener(
      'keydown',
      (e) => {
        const t = e.target as HTMLElement;
        w.keyTargets.push({ key: e.key, tag: t.tagName, inEditor: !!t.closest?.('.ProseMirror') });
      },
      true,
    );
  });
  const box = (await editor(page).boundingBox())!;
  const pos = { x: Math.min(box.width / 2, 40), y: Math.min(box.height / 2, 12) };
  const clickTarget = await page.evaluate(({ x, y }) => {
    const el = document.elementFromPoint(x, y);
    return { tag: el?.tagName ?? null, inEditor: !!el?.closest('.ProseMirror') };
  }, { x: box.x + pos.x, y: box.y + pos.y });
  await editor(page).click({ position: pos });
  await page.keyboard.press('Control+End');
  await page.keyboard.type(' Y');
  const keyTargets = await page.evaluate(() => (window as unknown as { keyTargets: { key: string; tag: string; inEditor: boolean }[] }).keyTargets);
  const accepted = (await editor(page).getByText('A첫째 본문 X Y', { exact: true }).count()) === 1;
  const editable = await editor(page).getAttribute('contenteditable');
  const info = { clickTarget, accepted, editable, keys: keyTargets.length, keyTargetsInEditor: keyTargets.filter((k) => k.inEditor).length, keyTags: [...new Set(keyTargets.map((k) => k.tag))] };
  console.error('WINDOW_CLOSE_Y_ATTEMPT', JSON.stringify(info));
  assert.equal(clickTarget.inEditor, true, 'pointer click 지점은 실제 에디터 본문이다');
  assert.ok(keyTargets.length >= 3, '입력 시도 키가 실제로 전달됐다');
  return info;
}

/**
 * 정상 복구 뒤의 닫기 판정: launch.ts의 정리용 closeWindow(폐기 확인을 자동 수락한다)를 쓰지 않는다.
 * 거절 전용 native 대역을 그대로 둔 채 실제 BrowserWindow.close를 요청하고, 제한된 시간 안에 앱이 종료되는지로 판정한다.
 * 이 닫기에서 폐기 확인이 뜨면 대역이 거절하고(저장 대기 안내는 strictWait로 [닫기 취소]) 창이 남아 한도 뒤 검사가 실패한다 — 자동 폐기 수락으로 통과하지 않는다.
 * 앱이 종료되면 main을 읽을 수 없으므로 "추가 확인 0"은 앱이 종료됐다는 사실(확인이 떴다면 거절되어 닫히지 못했을 것)로 입증한다.
 */
async function closeWithoutAsking(app: ElectronApplication, life: { appClosed: boolean }) {
  const before = await state(app);
  await app.evaluate(() => void ((globalThis as unknown as G).strictWait = true));
  if (process.env.LW_FORCE_UNSAVED_CLOSE) {
    // 감도 확인용 대역 (환경변수 LW_FORCE_UNSAVED_CLOSE=1일 때만 켜지고 평소에는 꺼져 있다. 켜면 이 검사가 실패해야 한다): renderer의 저장 완료 답을 "저장하지 못한 변경" 알림으로 바꿔 추가 폐기 확인 경로를 강제한다
    await app.evaluate(({ ipcMain }) => {
      ipcMain.removeAllListeners('app:reply-close');
      ipcMain.on('app:reply-close', (e, _proceed: boolean, attempt: number) => {
        console.error('FORCED_UNSAVED_CLOSE', attempt);
        ipcMain.emit('app:close-unsaved', e, attempt);
      });
    });
  }
  void app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close()).catch(() => undefined); // 앱이 종료되면 응답이 끊긴다
  const deadline = Date.now() + 20_000;
  while (!life.appClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!life.appClosed) {
    const after = await state(app).catch(() => null);
    console.error('WINDOW_CLEAN_CLOSE_STUCK', JSON.stringify({ before: { discards: before.discards.length, waits: before.waits }, after: after && { discards: after.discards.length, waits: after.waits, windows: after.windows } }));
  }
  assert.equal(life.appClosed, true, '정상 복구 뒤 실제 창 닫기로 앱이 종료되어야 한다 (추가 폐기 확인·저장 대기 안내가 뜨면 거절되어 닫히지 못한다)');
}

/** 새 격리 앱으로 같은 폴더를 열어, 디스크 Buffer와 에디터 본문을 확인한다 */
async function reopen(dir: string, expectedBody: string, expectedDisk: string) {
  const { app, page } = await launch(await tempDir('wcii-reopen-ud'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).getByText(expectedBody, { exact: true }).waitFor();
    assert.deepEqual(await readFile(join(dir, 'chapters', '001.md')), Buffer.from(expectedDisk), '새 앱 재열기 뒤에도 디스크는 정확한 바이트다');
  } finally {
    await closeWindow(app);
  }
}

/** 이미 시작한 창 닫기가 끝나 앱이 종료되기를 기다린다 (한도 20초). 폐기 확인·대기 안내가 뜨면 대역이 거절·취소하므로 창이 남아 실패한다 */
async function awaitClosed(app: ElectronApplication, life: { appClosed: boolean }) {
  const deadline = Date.now() + 20_000;
  while (!life.appClosed && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!life.appClosed) console.error('WINDOW_CLOSE_STUCK', JSON.stringify(await state(app).catch(() => null)));
  assert.equal(life.appClosed, true, '실제 창 닫기로 앱이 종료되어야 한다 (폐기 확인·대기 안내는 거절·취소되므로 뜨면 닫히지 못한다)');
}

test('창 닫기의 선행 저장 동안 편집이 잠겨 Y는 수락되지 않고, 잠그기 전의 X만 정확히 저장되며, 폐기 확인·대기 안내 없이 실제로 닫히고 새 앱 재열기에서 X가 있다', { timeout: 180_000 }, async () => {
  const { app, page, dir, read, life } = await start('wcls-ok');
  try {
    const held = await closeWithHeldSave(app, page);
    const editable = await editor(page).getAttribute('contenteditable');
    console.error('WINDOW_CLOSE_LOCK_BARRIER', JSON.stringify({ ...held, discards: held.discards.length, contenteditable: editable }));
    assert.equal(held.opens, 1);
    assert.equal(held.writes, 1, '창 닫기의 선행 flush chapter:write 1회');
    assert.equal(editable, 'false', '닫기의 저장 동안 편집 잠금 (자동저장이 아니라 닫기 조작이 건 잠금)');
    assert.equal(held.windows, 1, '저장 중에는 창이 그대로다');
    assert.equal(held.discards.length + held.waits, 0, '붙잡힌 동안 native 안내 0');
    assert.equal(held.creates + held.reissues + held.ais, 0, '불필요한 create/reissue/AI 진입 0 (붙잡힌 시점)');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), '저장이 디스크에 닿기 전이다');
    assert.deepEqual(await read('002.md'), Buffer.from(B2));
    assert.deepEqual(await read('003.md'), Buffer.from(C3));
    // 실제 본문 click + 키로 Y 시도: 수락되지 않는다 (유실이 아니라 미수락). 키 target이 본문이 아니면 그 한계는 로그(keyTags)와 PR 본문에 있다
    const y = await tryY(page);
    assert.equal(y.accepted, false, 'Y는 수락되지 않았다');
    assert.equal(y.editable, 'false');
    assert.equal(await editor(page).getByText('A첫째 본문 X', { exact: true }).count(), 1, '잠그기 전에 받은 X는 그대로다');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), 'Y 시도 뒤에도 첫 저장은 아직 디스크에 닿지 않았다');

    // 저장을 풀면 폐기 확인·대기 안내 없이 닫힌다 (거절·취소 대역이 걸려 있다: 뜨면 닫히지 못해 실패한다). 앱이 종료되면 main을 읽을 수 없으므로 풀기 직전에 한 번 더 본다
    const beforeRelease = await state(app);
    assert.equal(beforeRelease.creates + beforeRelease.reissues + beforeRelease.ais, 0, '불필요한 create/reissue/AI 진입 0 (풀기 직전)');
    await setStrict(app);
    await release(app);
    await awaitClosed(app, life);
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')), 'X만 원래 id·BOM·CRLF로 정확히 저장됐다');
    assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 B 불변');
    assert.deepEqual(await read('003.md'), Buffer.from(C3), '다른 화 불변');
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');
    await reopen(dir, 'A첫째 본문 X', withBody(' X'));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('창 닫기의 선행 저장이 쓰기 실패로 끝나고 폐기를 거절하면: 창·X·디스크 보존, 편집 잠금 해제, 추가 입력 Z 수락, 복구 저장·실제 닫기·새 앱 재열기에서 XZ가 정확히 남는다', { timeout: 180_000 }, async () => {
  const { app, page, dir, read, life } = await start('wcls-fail');
  try {
    const held = await closeWithHeldSave(app, page);
    assert.equal(held.writes, 1);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '붙잡힌 동안 편집 잠금');
    await setFail(app, true);
    await release(app);
    await waitUntil('native 폐기 확인이 뜨지 않았다', async () => (await state(app)).discards.length >= 1);
    const asked = await state(app);
    console.error('WINDOW_CLOSE_FAIL_DECISION', JSON.stringify({ discards: asked.discards, waits: asked.waits, windows: asked.windows, renames: asked.renames }));
    assert.deepEqual(asked.discards, [{ message: CONFIRM, buttons: DISCARD_BUTTONS }], 'native 폐기 확인 1회 (거절만 답했다)');
    assert.ok(asked.renames >= 1, 'rename 실패가 주입되지 않았다');
    assert.equal(asked.creates + asked.reissues + asked.ais, 0, '불필요한 create/reissue/AI 진입 0');
    assert.equal(asked.windows, 1, '폐기를 거절했으므로 창이 남는다');
    assert.equal(life.appClosed, false);
    await waitUntil('편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    assert.deepEqual((await statusSeen(page)).filter((t) => t.includes('저장됨')), [], '실패한 저장이 "저장됨"으로 보이면 안 된다');
    assert.equal(await editor(page).getByText('A첫째 본문 X', { exact: true }).count(), 1, 'X는 화면에 남는다');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), '실패한 저장은 디스크를 바꾸지 않는다');
    assert.deepEqual(await read('002.md'), Buffer.from(B2));
    assert.deepEqual(await read('003.md'), Buffer.from(C3));
    // 실제 입력 Z 수락
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Z');
    await editor(page).getByText('A첫째 본문 X Z', { exact: true }).waitFor();
    // 실패 해제 후 저장 (Ctrl+S와 5초 자동 재시도를 구분하지 못한다)
    await setFail(app, false);
    await page.keyboard.press('Control+s');
    await waitUntil('XZ가 저장되지 않았다', async () => (await read('001.md')).toString('utf8') === withBody(' X Z'));
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X Z')), 'XZ가 원래 id·BOM·CRLF로 정확히 저장됐다');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal((await state(app)).discards.length, 1, '복구 뒤 추가 폐기 확인 0 (닫기 전)');
    await closeWithoutAsking(app, life);
    await reopen(dir, 'A첫째 본문 X Z', withBody(' X Z'));
    assert.deepEqual(await read('002.md'), Buffer.from(B2));
    assert.deepEqual(await read('003.md'), Buffer.from(C3));
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('실제 timeout: [계속 기다리기] 동안은 잠금이 유지되고, [닫기 취소] 뒤에는 저장 HOLD가 풀리지 않아도 편집이 돌아오며, 늦은 저장 완료는 창을 닫지 않고 새 입력을 저장 완료로 보이지 않는다', { timeout: 180_000 }, async () => {
  const { app, page, dir, read, life } = await start('wcls-timeout');
  try {
    await shrinkTimeout(app);
    await setManualWait(app);
    const held = await closeWithHeldSave(app, page);
    assert.equal(held.writes, 1);
    await waitUntil('저장 대기 안내가 뜨지 않았다', async () => (await state(app)).waitPending >= 1);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '안내가 떠 있는 동안 잠금');
    // [계속 기다리기]: 같은 시도를 이어 간다. 저장이 아직 붙잡혀 있으니 잠금이 유지된다
    await answerWait(app, 0);
    await waitUntil('다시 묻지 않았다', async () => (await state(app)).waits >= 2 && (await state(app)).waitPending >= 1);
    assert.equal((await state(app)).held, true);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '[계속 기다리기] 동안 잠금 유지');
    // [닫기 취소]: 저장 HOLD를 풀지 않은 채 편집이 돌아온다
    await answerWait(app, 1);
    await waitUntil('[닫기 취소] 뒤에도 편집이 돌아오지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    const cancelled = await state(app);
    console.error('WINDOW_CLOSE_CANCEL_BARRIER', JSON.stringify({ held: cancelled.held, windows: cancelled.windows, waits: cancelled.waits, writes: cancelled.writes }));
    assert.equal(cancelled.held, true, '저장은 아직 붙잡혀 있다 (HOLD를 풀기 전에 편집이 돌아왔다)');
    assert.equal(cancelled.windows, 1);
    // 취소 뒤 실제 입력 Z 수락
    await page.evaluate(() => {
      const w = window as unknown as { statusSeen: string[] };
      w.statusSeen = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[role="status"]')) w.statusSeen.push((el as HTMLElement).innerText);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Z');
    await editor(page).getByText('A첫째 본문 X Z', { exact: true }).waitFor();
    // 늦은 저장 완료(X): 창을 닫지 않고, 새 입력 Z를 저장 완료로 보이지 않으며, 폐기 확인도 만들지 않는다 (취소한 시도의 늦은 응답은 main이 무시한다)
    await release(app);
    await waitUntil('X가 저장되지 않았다', async () => (await read('001.md')).toString('utf8') === withBody(' X'));
    assert.deepEqual((await statusSeen(page)).filter((t) => t.includes('저장됨')), [], '늦은 저장 완료가 Z까지 저장됐다고 보이면 안 된다');
    const late = await state(app);
    assert.equal(late.windows, 1, '늦은 저장 완료가 창을 닫지 않았다');
    assert.equal(late.discards.length, 0, '취소한 시도의 늦은 응답은 폐기 확인을 만들지 않는다');
    assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
    assert.equal(await editor(page).getByText('A첫째 본문 X Z', { exact: true }).count(), 1);
    // 후속 저장: Z까지 정확히 보존
    await page.keyboard.press('Control+s');
    await waitUntil('XZ가 저장되지 않았다', async () => (await read('001.md')).toString('utf8') === withBody(' X Z'));
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X Z')));
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    const preClose = await state(app);
    assert.equal(preClose.creates + preClose.reissues + preClose.ais, 0, '불필요한 create/reissue/AI 진입 0 (닫기 전)');
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');
    await setStrict(app);
    await closeWithoutAsking(app, life);
    await reopen(dir, 'A첫째 본문 X Z', withBody(' X Z'));
    assert.deepEqual(await read('002.md'), Buffer.from(B2));
    assert.deepEqual(await read('003.md'), Buffer.from(C3));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('겹침: 취소한 시도의 저장이 아직 붙잡힌 채 새 닫기 시도가 시작돼도, 옛 시도의 늦은 finally가 새 시도의 잠금을 풀지 않고, 새 시도의 저장이 끝나면 닫힌다', { timeout: 180_000 }, async () => {
  const { app, page, dir, read, life } = await start('wcls-overlap');
  try {
    await shrinkTimeout(app);
    await setManualWait(app);
    await closeWithHeldSave(app, page);
    await waitUntil('저장 대기 안내가 뜨지 않았다', async () => (await state(app)).waitPending >= 1);
    await answerWait(app, 1); // [닫기 취소]: 시도 1 끝
    await waitUntil('편집이 돌아오지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Z');
    await editor(page).getByText('A첫째 본문 X Z', { exact: true }).waitFor();
    // 새 닫기 시도 2: 저장 HOLD는 그대로(시도 1의 flush가 아직 끝나지 않았다). 시도 2의 재저장도 붙잡아 둔다
    await arm(app);
    await app.evaluate(({ BrowserWindow }) => void BrowserWindow.getAllWindows()[0]?.close());
    await waitUntil('새 시도가 편집을 잠그지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'false');
    // 시도 1의 저장을 풀면: 시도 1의 flush가 끝나(늦은 finally) 시도 2의 재저장(XZ)이 붙잡힌다. 그동안 새 시도의 잠금은 유지돼야 한다
    await setStrict(app);
    await release(app);
    await waitUntil('시도 2의 재저장이 붙잡히지 않았다', async () => {
      const s = await state(app);
      return s.held && s.opens >= 2;
    });
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '옛 시도의 늦은 finally가 새 시도의 잠금을 풀지 않았다');
    assert.equal((await state(app)).windows, 1);
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')), '재저장 전에는 시도 1의 X만 디스크에 있다');
    const preClose = await state(app);
    assert.equal(preClose.creates + preClose.reissues + preClose.ais, 0, '불필요한 create/reissue/AI 진입 0 (닫기 전)');
    // 시도 2의 재저장이 붙잡힌 지금은 진행 중인 임시 파일이 있다 (정상): 그것만 빼고 화 파일은 그대로이고, 닫힌 뒤에는 임시 파일도 남지 않는다
    assert.deepEqual((await readdir(join(dir, 'chapters'))).filter((f) => !f.endsWith('.tmp')), Object.keys(files), '화 파일 수·이름 불변 (진행 중 임시 파일 제외)');
    await release(app);
    await awaitClosed(app, life);
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '닫힌 뒤 화 파일 수·이름 불변, 임시 파일 0');
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X Z')), '새 시도의 저장이 XZ를 정확히 남겼다');
    await reopen(dir, 'A첫째 본문 X Z', withBody(' X Z'));
    assert.deepEqual(await read('002.md'), Buffer.from(B2));
    assert.deepEqual(await read('003.md'), Buffer.from(C3));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
