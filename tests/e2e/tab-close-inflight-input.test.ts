// 현재 화 탭 닫기의 선행 저장(leave → flush) 동안에는 에디터가 잠긴다 (chooseFolder·lockedAction과 같은 lockEditor 깊이 계수).
// 닫기가 시작된 뒤 받으려던 입력 Y는 수락되지 않고(유실이 아니라 미수락), 잠그기 전에 받은 X만 원래 id·BOM·CRLF로 저장되며, 정상 저장 뒤에는 "변경 버림" 확인 없이 닫히고 이웃 탭이 열려 편집 가능하다.
// 저장이 실제 디스크 쓰기 실패로 끝나고 버림 확인을 거절하면 A 탭·미저장 X가 남고 편집 잠금이 풀려 추가 입력 Z를 받으며, 복구 저장·재열기에서 XZ가 정확히 남는다.
// (이전 정책에서는 닫는 중 받은 Y 때문에 정상 저장 뒤에도 버림 확인이 떴다: PR #208의 관측. 일반 저장 중 입력 수락 정책은 save-inflight-input이 그대로 본다.)
// 실제 앱(Electron + Playwright). 장벽·주입은 main의 디스크 호출이다: A/001.md 임시 파일을 연 직후 선행 저장을 붙잡고, 두 번째 경우에는 풀기 전에 rename을 EPERM으로 만든다.
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
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';
const files: Record<string, string> = { '001.md': A1, '002.md': B2, '003.md': C3 };
const withBody = (text: string) => A1.replace('A첫째 본문', `A첫째 본문${text}`);

interface G {
  armed: boolean;
  held: boolean;
  failRename: boolean;
  /** A/001.md 저장의 임시 파일 열기·rename 수 */
  opens: number;
  renames: number;
  /** IPC 진입 수 (처리기는 그대로 실행한다) */
  writes: number;
  creates: number;
  reissues: number;
  /** AI 진입(ai:analyze·ai:check) 수 */
  ais: number;
  release?: () => void;
}
const hook = (app: ElectronApplication, target: string) =>
  app.evaluate(
    ({ ipcMain }, target) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { armed: false, held: false, failRename: false, opens: 0, renames: 0, writes: 0, creates: 0, reissues: 0, ais: 0 });
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
    },
    target,
  );
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    return { held: g.held, opens: g.opens, renames: g.renames, writes: g.writes, creates: g.creates, reissues: g.reissues, ais: g.ais };
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
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const closeButton = (page: Page, title: string) => page.getByRole('button', { name: `탭 닫기: ${title}`, exact: true });
const statusSeen = (page: Page) => page.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen);

/** A(현재)와 이웃 B 탭을 연 앱. 확인 창은 거절만 한다 (수락 0). 정리 단계에서만 수락한다 */
async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', name), text);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  const dialogs = { phase: 'refuse' as 'refuse' | 'after' | 'cleanup', asked: [] as string[], unexpected: [] as string[] };
  page.on('dialog', (d) => {
    if (dialogs.phase === 'cleanup') return void d.accept();
    (dialogs.phase === 'refuse' ? dialogs.asked : dialogs.unexpected).push(d.message());
    void d.dismiss();
  });
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
  await list(page).getByRole('button', { name: 'B둘째' }).click();
  await editor(page).getByText('B둘째 본문', { exact: true }).waitFor();
  await list(page).getByRole('button', { name: 'A첫째' }).click();
  await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
  await closeButton(page, 'B둘째').waitFor();
  await hook(app, join(dir, 'chapters', '001.md'));
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  return { app, page, dir, read, dialogs };
}

/** 미저장 X를 확인하고 실제 탭 닫기 버튼으로 닫기를 시작해, 선행 저장을 디스크 경계에서 붙잡는다 */
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
  await closeButton(page, 'A첫째').click();
  await waitUntil('선행 저장을 붙잡지 못했다', async () => (await state(app)).held);
  return state(app);
}

test('닫기의 선행 저장 동안 편집이 잠겨 Y는 수락되지 않고, 잠그기 전의 X만 정확히 저장되며, 묻지 않고 닫혀 이웃 B가 편집 가능하고 A를 다시 열면 X가 있다', { timeout: 150_000 }, async () => {
  const { app, page, dir, read, dialogs } = await start('tcls-ok');
  try {
    const held = await closeWithHeldSave(app, page);
    const editable = await editor(page).getAttribute('contenteditable');
    console.error('TAB_CLOSE_LOCK_BARRIER', JSON.stringify({ ...held, contenteditable: editable }));
    assert.equal(held.opens, 1);
    assert.equal(held.writes, 1, '붙잡힌 동안 chapter:write는 한 번');
    assert.equal(editable, 'false', '닫기의 저장 동안 편집 잠금 (자동저장이 아니라 닫기 조작이 건 잠금)');
    assert.equal(await closeButton(page, 'A첫째').count(), 1, '저장 중에는 탭이 그대로다');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), '저장이 디스크에 닿기 전이다');
    // 붙잡힌 동안 추가 입력 Y를 실제 에디터로 시도: 수락되지 않는다 (유실이 아니라 미수락: 화면에 들어오지 않았다)
    // 입력 시도 경로: (1) 잠긴 실제 본문에 사용자처럼 pointer click (DOM의 contenteditable·PM transaction은 건드리지 않는다) → (2) 키 입력.
    // 키 이벤트의 실제 target과 click 지점의 요소를 따로 기록한다: 잠금 때문에 본문이 focus를 못 받으면 키는 다른 요소(닫기 버튼 등)로 갈 수 있다 — 그 경우 "Y 미수락"의 범위는 click이 본문을 향했다는 증거 + 본문에 글자가 들어오지 않았다는 관측으로 한정된다
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
    const point = { x: box.x + Math.min(box.width / 2, 40), y: box.y + Math.min(box.height / 2, 12) };
    const clickTarget = await page.evaluate(({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      return { tag: el?.tagName ?? null, inEditor: !!el?.closest('.ProseMirror') };
    }, point);
    await editor(page).click({ position: { x: Math.min(box.width / 2, 40), y: Math.min(box.height / 2, 12) } });
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Y');
    const keyTargets = await page.evaluate(() => (window as unknown as { keyTargets: { key: string; tag: string; inEditor: boolean }[] }).keyTargets);
    const after = await page.evaluate(() => {
      const a = document.activeElement as HTMLElement | null;
      return { tag: a?.tagName ?? null, inEditor: !!a?.closest('.ProseMirror'), editable: document.querySelector('.ProseMirror')?.getAttribute('contenteditable') };
    });
    console.error('TAB_CLOSE_Y_ATTEMPT', JSON.stringify({ clickTarget, active: after, keys: keyTargets.length, keyTargetsInEditor: keyTargets.filter((k) => k.inEditor).length, keyTags: [...new Set(keyTargets.map((k) => k.tag))] }));
    assert.equal(clickTarget.inEditor, true, 'pointer click 지점은 실제 에디터 본문이다');
    assert.equal(after.editable, 'false', 'click·입력 시도 뒤에도 에디터는 잠겨 있다');
    assert.ok(keyTargets.length >= 3, '입력 시도 키가 실제로 전달됐다');
    assert.equal(await editor(page).getByText('A첫째 본문 X Y', { exact: true }).count(), 0, 'Y는 수락되지 않았다');
    assert.equal(await editor(page).getByText('A첫째 본문 X', { exact: true }).count(), 1, '잠그기 전에 받은 X는 그대로다');

    await release(app);
    await closeButton(page, 'A첫째').waitFor({ state: 'detached', timeout: 15_000 });
    await editor(page).getByText('B둘째 본문', { exact: true }).waitFor();
    assert.deepEqual(dialogs.asked, [], '정상 저장 뒤 변경 버림 확인이 뜨지 않는다');
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')), 'X만 원래 id·BOM·CRLF로 정확히 저장됐다');
    // 이웃 B는 편집 가능하다 (잠금이 새 에디터에 남지 않는다)
    await waitUntil('이웃 B 편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    assert.deepEqual(await read('002.md'), Buffer.from(B2), 'B를 편집하기 전에 B 디스크는 원래 그대로다');
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' B편집');
    await editor(page).getByText('B둘째 본문 B편집', { exact: true }).waitFor();
    // 잠금 중 Y가 들어오지 않았던 것과 대조: 해제 뒤 B에는 실제 입력이 수락됐다
    // A를 다시 열면 X가 있고(화 이동의 저장이 B 편집을 B에만 쓴다), 다른 화는 불변이다
    await list(page).getByRole('button', { name: 'A첫째' }).click();
    await editor(page).getByText('A첫째 본문 X', { exact: true }).waitFor();
    assert.deepEqual(await read('002.md'), Buffer.from(B2.replace('B둘째 본문', 'B둘째 본문 B편집')), 'B에는 의도한 편집만 저장됐다');
    assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')));
    assert.deepEqual(await read('003.md'), Buffer.from(C3), '다른 화 불변');
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');
    const end = await state(app);
    assert.equal(end.creates + end.reissues + end.ais, 0, '불필요한 create/reissue/AI 진입 0');
    assert.deepEqual(dialogs.unexpected, [], '예상하지 않은 확인 창이 없다');
  } catch (e) {
    dialogs.phase = 'cleanup';
    throw e;
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('닫기의 선행 저장이 쓰기 실패로 끝나고 버림을 거절하면: A 탭·미저장 X 보존, 편집 잠금 해제, 추가 입력 Z 수락, 복구 저장과 닫기·재열기에서 XZ가 정확히 남는다', { timeout: 150_000 }, async () => {
  const { app, page, dir, read, dialogs } = await start('tcls-fail');
  try {
    const held = await closeWithHeldSave(app, page);
    assert.equal(held.writes, 1);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '붙잡힌 동안 편집 잠금');
    await setFail(app, true);
    await release(app);
    await waitUntil('버림 확인 창이 뜨지 않았다', async () => dialogs.asked.length >= 1);
    assert.equal(dialogs.asked[0], CONFIRM, '같은 의도의 버림 확인이다 (거절한다)');
    await waitUntil('편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    assert.equal(dialogs.asked.length, 1, '확인 창은 한 번');
    assert.equal(await closeButton(page, 'A첫째').count(), 1, '거절했으므로 A 탭이 남는다');
    assert.equal(await closeButton(page, 'B둘째').count(), 1, 'B 탭도 그대로다');
    assert.equal(await editor(page).getByText('A첫째 본문 X', { exact: true }).count(), 1, '미저장 X는 화면에 남는다');
    assert.deepEqual((await statusSeen(page)).filter((t) => t.includes('저장됨')), [], '실패한 저장이 "저장됨"으로 보이면 안 된다');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), '실패한 저장은 디스크를 바꾸지 않는다');
    assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 B 불변');
    assert.deepEqual(await read('003.md'), Buffer.from(C3), '다른 화 불변');
    // 잠금이 풀려 추가 입력 Z를 받는다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Z');
    await editor(page).getByText('A첫째 본문 X Z', { exact: true }).waitFor();
    // 오류를 풀고 저장한다 (Ctrl+S와 5초 자동 재시도를 구분하지 못한다: 명시 저장 단독 성공을 주장하지 않는다)
    dialogs.phase = 'after';
    await setFail(app, false);
    await page.keyboard.press('Control+s');
    await waitUntil('XZ가 저장되지 않았다', async () => (await read('001.md')).toString('utf8') === withBody(' X Z'));
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X Z')), 'XZ가 원래 id·BOM·CRLF로 정확히 저장됐다');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    // 정상 닫기 → 이웃 B가 열리고 다시 열면 XZ
    await closeButton(page, 'A첫째').click();
    await closeButton(page, 'A첫째').waitFor({ state: 'detached', timeout: 15_000 });
    await editor(page).getByText('B둘째 본문', { exact: true }).waitFor();
    await waitUntil('이웃 B 편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    await list(page).getByRole('button', { name: 'A첫째' }).click();
    await editor(page).getByText('A첫째 본문 X Z', { exact: true }).waitFor();
    assert.deepEqual(await read('002.md'), Buffer.from(B2));
    assert.deepEqual(await read('003.md'), Buffer.from(C3));
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');
    const end = await state(app);
    assert.equal(end.creates + end.reissues + end.ais, 0, '불필요한 create/reissue/AI 진입 0');
    assert.deepEqual(dialogs.unexpected, [], '복구 뒤 예상하지 않은 확인 창이 없다');
  } catch (e) {
    dialogs.phase = 'cleanup';
    throw e;
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('닫기 저장이 붙잡힌 동안 [열기]가 겹쳐도(폴더 선택 취소): 잠금 깊이가 정확히 돌아와 이웃 B가 영구 잠기지 않고, X는 한 번 저장되며 묻지 않는다', { timeout: 150_000 }, async () => {
  const { app, page, read, dialogs } = await start('tcls-overlap');
  try {
    await closeWithHeldSave(app, page);
    // 폴더 선택 창은 취소로 답한다 (project:choose 처리기는 진입해 창을 열고 null로 돌아온다: 새 프로젝트는 열리지 않는다). 창 호출 수(pickCalls)로 겹침이 실제 실행됐음을 본다
    await app.evaluate(({ dialog }) => {
      (globalThis as unknown as { pickCalls: number }).pickCalls = 0;
      dialog.showOpenDialog = (async () => {
        (globalThis as unknown as { pickCalls: number }).pickCalls += 1;
        return { canceled: true, filePaths: [] };
      }) as typeof dialog.showOpenDialog;
    });
    await page.getByRole('button', { name: '열기', exact: true }).click();
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '겹친 동안에도 잠겨 있다');
    await release(app);
    await closeButton(page, 'A첫째').waitFor({ state: 'detached', timeout: 15_000 });
    await editor(page).getByText('B둘째 본문', { exact: true }).waitFor();
    await waitUntil('겹친 조작이 끝나지 않았다', async () => !(await page.getByRole('button', { name: '열기', exact: true }).isDisabled()));
    await waitUntil('이웃 B가 영구 잠겼다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    const end = await state(app);
    assert.equal(await app.evaluate(() => (globalThis as unknown as { pickCalls: number }).pickCalls), 1, '겹친 [열기]가 실제로 실행되어 폴더 창을 한 번 열었다 (취소)');
    assert.equal(end.writes, 1, 'X 저장은 한 번 (겹친 조작이 다시 쓰지 않는다)');
    assert.equal(end.creates + end.reissues + end.ais, 0);
    assert.deepEqual(dialogs.asked, [], '묻지 않는다');
    assert.deepEqual(await read('001.md'), Buffer.from(withBody(' X')));
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' B편집');
    await editor(page).getByText('B둘째 본문 B편집', { exact: true }).waitFor();
  } catch (e) {
    dialogs.phase = 'cleanup';
    throw e;
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
