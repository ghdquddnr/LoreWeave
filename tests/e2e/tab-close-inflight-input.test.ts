// 현재 탭 닫기가 시작한 선행 저장(leave → flush)을 실제 디스크 쓰기 경계에서 붙잡은 동안 에디터가 추가 입력 Y를 받아들이면,
// 닫기 완료 또는 변경 버림 거절 뒤에도 그 입력이 유실되지 않는다. closeTab은 chooseFolder/lockedAction과 달리 편집 잠금이 없으므로 Y는 실제로 수락되는지부터 관측한다.
// 첫 저장(X)의 응답은 "XY를 저장했다"로 보이지 않고, 사용자 동의 없이 탭·입력을 버리지 않는다. 버림 확인이 뜨면 거절만 한다(자동 수락 0).
// (save-inflight-input은 일반 저장·Ctrl+S·화 이동, tab-close-focus는 닫기 거절·대기 중 포커스 이동이다 — 닫기 시작 뒤 새로 받아들인 입력은 다루지 않는다.)
// 실제 앱(Electron + Playwright). 장벽은 main의 디스크 호출이다: A/001.md 임시 파일을 연 직후 첫 저장을 붙잡는다(실패 주입 없음: first-save 성공 경계).
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

interface G {
  armed: boolean;
  held: boolean;
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
      Object.assign(g, { armed: false, held: false, opens: 0, renames: 0, writes: 0, creates: 0, reissues: 0, ais: 0 });
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
        if (String(from).startsWith(`${target}.`) && String(from).endsWith('.tmp')) g.renames++;
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

test('닫기가 시작한 선행 저장을 붙잡은 동안 받아들인 입력 Y: 첫 저장 응답이 XY 저장으로 보이지 않고, 거절하면 탭·XY가 남으며, 이후 저장·닫기·다시 열기에서 유실이 없다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('tcii');
  await mkdir(join(dir, 'chapters'));
  const files: Record<string, string> = { '001.md': A1, '002.md': B2, '003.md': C3 };
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', name), text);
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  const { app, page } = await launch(await tempDir('tcii-ud'));
  // 확인 창은 거절만 한다 (수락 0). 실패한 테스트의 정리 단계에서만 수락한다
  let phase: 'refuse' | 'after' | 'cleanup' = 'refuse';
  const asked: string[] = [];
  const unexpected: string[] = [];
  page.on('dialog', (d) => {
    if (phase === 'cleanup') return void d.accept();
    (phase === 'refuse' ? asked : unexpected).push(d.message());
    void d.dismiss();
  });
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
    // 탭 준비: A(현재)와 이웃 B
    await list(page).getByRole('button', { name: 'B둘째' }).click();
    await editor(page).getByText('B둘째 본문', { exact: true }).waitFor();
    await list(page).getByRole('button', { name: 'A첫째' }).click();
    await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
    await closeButton(page, 'B둘째').waitFor();
    await hook(app, join(dir, 'chapters', '001.md'));

    // 1) A의 미저장 X 확인 → 실제 탭 닫기 버튼으로 닫기 시작 → 첫 저장을 디스크 경계에서 붙잡는다
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
    await waitUntil('첫 저장을 붙잡지 못했다', async () => (await state(app)).held);
    const held = await state(app);
    const editable = await editor(page).getAttribute('contenteditable');
    console.error('TAB_CLOSE_BARRIER', JSON.stringify({ ...held, contenteditable: editable, tabA: await closeButton(page, 'A첫째').count(), tabB: await closeButton(page, 'B둘째').count() }));
    assert.equal(held.opens, 1);
    // 이 쓰기의 주인이 닫기의 flush인지는 직접 관측하지 않는다 (편집 잠금이 없다). 근거는 코드 읽기+관측: 자동저장·창 blur(window)가 먼저 쓰기를 쥐고 있었다면 leave()가 그 저장에 합류해 XY를 다시 저장하고 묻지 않고 닫혔을 것이다(ChapterEditor.save). 아래 확인 창과 디스크 X가 그 반대를 보인다.
    assert.equal(held.writes, 1, '붙잡힌 동안 chapter:write는 한 번');
    assert.equal(await closeButton(page, 'A첫째').count(), 1, '저장 중에는 탭이 그대로다');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), '저장이 디스크에 닿기 전이다');

    // 2) 붙잡힌 동안 추가 입력 Y를 실제 에디터로 시도하고, 실제로 수락됐는지 관측한다
    //    (수락되지 않았다면 유실이 아니라 미수락이다. 어느 쪽인지 화면 텍스트로 구별한다)
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Y');
    const accepted = (await editor(page).getByText('A첫째 본문 X Y', { exact: true }).count()) === 1;
    console.error('TAB_CLOSE_Y_ACCEPTED', JSON.stringify({ accepted, contenteditable: await editor(page).getAttribute('contenteditable') }));
    assert.equal(accepted, true, 'closeTab에는 편집 잠금이 없어 Y가 수락된다 (미수락이면 이 검사의 전제가 달라진다: 원시 로그로 보고)');
    assert.deepEqual(await read('001.md'), Buffer.from(A1), 'Y를 받아들여도 첫 저장은 아직 디스크에 닿지 않았다');

    // 3) 첫 저장(X)을 푼다. 그 응답은 XY 저장으로 보이면 안 되고, 앱은 탭·입력을 동의 없이 버리지 않는다
    await release(app);
    await waitUntil('닫기 처리가 끝나지 않았다', async () => asked.length >= 1 || (await closeButton(page, 'A첫째').count()) === 0);
    const seenAtDecision = await page.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen);
    const closedWithoutAsking = asked.length === 0;
    console.error('TAB_CLOSE_DECISION', JSON.stringify({ asked, closedWithoutAsking, ...(await state(app)) }));
    if (closedWithoutAsking) {
      // 앱이 최신 XY를 끝까지 저장하고 닫는 안전 정책이면 허용: 그 경우 디스크에 XY가 있어야 한다
      assert.match((await read('001.md')).toString('utf8'), /A첫째 본문 X Y\r\n$/, '묻지 않고 닫았다면 XY가 디스크에 있어야 한다');
    } else {
      assert.equal(asked.length, 1, '확인 창은 한 번');
      assert.equal(asked[0], CONFIRM, '같은 의도의 버림 확인이다 (거절한다)');
      assert.deepEqual(seenAtDecision.filter((t) => t.includes('저장됨')), [], '첫 저장(X)의 응답이 XY의 저장 완료로 보이면 안 된다');
      // 거절 뒤: 탭·XY·편집 가능·이웃/다른 화 불변
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
      assert.equal(await closeButton(page, 'A첫째').count(), 1, '거절했으므로 A 탭이 남는다');
      assert.equal(await closeButton(page, 'B둘째').count(), 1, 'B 탭도 그대로다');
      assert.equal(await editor(page).getByText('A첫째 본문 X Y', { exact: true }).count(), 1, '수락한 입력 XY가 화면에 남는다');
      assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
      const mid = (await read('001.md')).toString('utf8');
      console.error('TAB_CLOSE_DISK_AFTER_REFUSE', JSON.stringify(mid));
      assert.ok(mid === A1.replace('A첫째 본문', 'A첫째 본문 X') || mid === A1.replace('A첫째 본문', 'A첫째 본문 X Y'), '디스크에는 첫 저장 X(또는 이미 이어 저장된 XY)만 있다');
      assert.deepEqual(await read('002.md'), Buffer.from(B2), '이웃 B 불변');
      assert.deepEqual(await read('003.md'), Buffer.from(C3), '다른 화 불변');

      // 4) 거절 뒤 추가 입력 Z를 받고, 명시적 Ctrl+S로 저장한다 (자동저장이 먼저 저장했는지는 구분하지 못한다)
      phase = 'after';
      await editor(page).click();
      await page.keyboard.press('Control+End');
      await page.keyboard.type(' Z');
      await editor(page).getByText('A첫째 본문 X Y Z', { exact: true }).waitFor();
      await page.keyboard.press('Control+s');
      await waitUntil('XYZ가 저장되지 않았다', async () => (await read('001.md')).toString('utf8') === A1.replace('A첫째 본문', 'A첫째 본문 X Y Z'));
      assert.deepEqual(await read('001.md'), Buffer.from(A1.replace('A첫째 본문', 'A첫째 본문 X Y Z')), 'XYZ가 원래 id·BOM·CRLF로 정확히 저장됐다');
      await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });

      // 5) 정상 경로로 닫기: 묻지 않고 닫히며 이웃 B가 열리고, 다시 열면 XYZ가 남아 있다
      await closeButton(page, 'A첫째').click();
      await closeButton(page, 'A첫째').waitFor({ state: 'detached', timeout: 15_000 });
      await editor(page).getByText('B둘째 본문', { exact: true }).waitFor();
      await list(page).getByRole('button', { name: 'A첫째' }).click();
      await editor(page).getByText('A첫째 본문 X Y Z', { exact: true }).waitFor();
    }
    for (const [name, text] of Object.entries(files)) {
      if (name === '001.md') continue;
      assert.deepEqual(await read(name), Buffer.from(text), `${name} 불변`);
    }
    assert.deepEqual(await readdir(join(dir, 'chapters')), Object.keys(files), '화 파일 수·이름 불변');
    const end = await state(app);
    assert.equal(end.creates + end.reissues + end.ais, 0, '불필요한 create/reissue/AI 진입 0');
    assert.deepEqual(unexpected, [], '예상하지 않은 확인 창이 없다');
  } catch (e) {
    phase = 'cleanup';
    throw e;
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
