// 열린 중복 id 화에 미저장 입력이 있을 때 [새 id 발급]을 누르면 선행 저장(flush)이 먼저 나간다. 그 저장이 실제 디스크 쓰기 실패(EPERM)로 끝나고
// 사용자가 "변경 버림" 확인을 거절하면: chapter:reissue-id 호출 0, 기존 id·본문의 디스크 바이트와 다른 화 불변, 입력 A 화면 보존, 거짓 "저장됨"·발급 성공 0.
// 오류를 풀고 명시적 Ctrl+S로 A+B를 원래 id에 저장한 뒤, 사용자의 새 [새 id 발급] 1회가 성공해 새 id와 A+B를 보존한다.
// (lock-boundaries의 충돌+버림 거절은 쓰기 실패가 아닌 외부 수정이 원인이고, save-failure-refusal은 일반 화 이동·창 닫기다 — 이 경계는 발급의 선행 저장 실패다.)
// 실제 앱(Electron + Playwright). 장벽·주입은 main의 디스크 호출이다: 002.md 임시 파일을 연 직후 선행 저장을 붙잡고, 풀기 전에 rename을 EPERM으로 만든다.
// reissue 처리기는 사전 거절하지 않는다(호출만 센다). 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 합성 자동화이며 수동 GUI·실제 OS IME가 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const dup = (title: string) => `${BOM}---\r\nid: same-id\r\ntitle: ${title}\r\n---\r\n${title} 본문\r\n`;
const ONE = dup('첫째');
const TWO = dup('둘째');
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';

interface G {
  armed: boolean;
  held: boolean;
  failRename: boolean;
  /** 002.md 저장의 임시 파일 열기·rename 수 */
  opens: number;
  renames: number;
  /** chapter:write / chapter:reissue-id IPC 수 (처리기는 그대로 실행한다) */
  writes: number;
  reissues: number;
  release?: () => void;
}
const hook = (app: ElectronApplication, target: string) =>
  app.evaluate(
    ({ ipcMain }, target) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { armed: false, held: false, failRename: false, opens: 0, renames: 0, writes: 0, reissues: 0 });
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
      const wrapWrite = map.get('chapter:write')!;
      map.set('chapter:write', (...args: unknown[]) => {
        g.writes += 1;
        return wrapWrite(...args);
      });
      const wrapReissue = map.get('chapter:reissue-id')!;
      map.set('chapter:reissue-id', (...args: unknown[]) => {
        g.reissues += 1;
        return wrapReissue(...args);
      });
    },
    target,
  );
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    return { held: g.held, opens: g.opens, renames: g.renames, writes: g.writes, reissues: g.reissues };
  });
const set = (app: ElectronApplication, key: 'armed' | 'failRename', value: boolean) =>
  app.evaluate((_e, [key, value]) => void ((globalThis as unknown as Record<string, boolean>)[key as string] = value as boolean), [key, value] as const);
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
const idOf = (text: string) => /id: (.+)\r?\n/.exec(text)?.[1];

test('발급의 선행 저장이 쓰기 실패로 끝나고 버림을 거절하면: 발급 IPC 0, 디스크·입력 보존, 잠금 해제, 이후 명시적 저장과 새 발급 1회가 성공한다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('rsfr');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const read = (f: string) => readFile(join(dir, 'chapters', f));
  const { app, page } = await launch(await tempDir('rsfr-ud'));
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
    await editor(page).waitFor();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/).waitFor();
    await hook(app, join(dir, 'chapters', '002.md'));

    // 1) 입력 A가 미저장임을 확인하고(자동저장 1.5초 전), 발급을 누른다. 붙잡힌 저장이 클릭의 선행 flush인지는 잠금(편집 불가)으로 구분한다
    await set(app, 'armed', true);
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' A');
    await editor(page).getByText('둘째 본문 A', { exact: true }).waitFor();
    const before = await state(app);
    assert.equal(before.opens, 0, '발급을 누르기 전에는 저장이 시작되지 않았다 (입력 A는 미저장)');
    assert.equal(await page.getByRole('status').getByText('저장됨', { exact: true }).count(), 0, '입력 A는 저장됨으로 보이지 않는다');
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await waitUntil('선행 저장을 붙잡지 못했다', async () => (await state(app)).held);
    const held = await state(app);
    console.error('REISSUE_SAVE_BARRIER', JSON.stringify(held));
    assert.equal(held.opens, 1);
    assert.equal(held.writes, 1, '선행 flush의 chapter:write 1회');
    assert.equal(held.reissues, 0, '저장이 끝나기 전에는 발급 IPC가 없다');
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '붙잡힌 저장은 발급 조작이 건 잠금 아래의 선행 flush다 (자동저장이 아니다)');

    // 2) rename을 EPERM으로 만들고 풀어 저장을 실패시킨다. 이 뒤 화면 상태 변화를 기록한다
    await page.evaluate(() => {
      const w = window as unknown as { statusSeen: string[] };
      w.statusSeen = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[role="status"]')) w.statusSeen.push((el as HTMLElement).innerText);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    });
    await set(app, 'failRename', true);
    await release(app);
    await waitUntil('버림 확인 창이 뜨지 않았다', async () => asked.length >= 1);
    assert.equal(asked[0], CONFIRM, '같은 의도의 버림 확인이다 (거절한다)');
    await waitUntil('조작이 끝나 편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    const refused = await state(app);
    assert.ok(refused.renames >= 1, 'rename 실패가 주입되지 않았다');
    assert.equal(refused.reissues, 0, '거절 뒤 발급 IPC 0');
    assert.deepEqual(await read('002.md'), Buffer.from(TWO), '기존 id·본문의 디스크 바이트 보존');
    assert.deepEqual(await read('001.md'), Buffer.from(ONE), '다른 화 불변');
    assert.equal(asked.length, 1, '확인 창은 한 번');
    assert.equal(await editor(page).getByText('둘째 본문 A', { exact: true }).count(), 1, '입력 A는 화면에 남는다');
    assert.deepEqual((await readdir(join(dir, 'chapters'))).filter((f) => f.endsWith('.tmp')), []);
    await page.getByRole('status').getByText('저장 실패', { exact: false }).waitFor({ timeout: 10_000 });
    assert.equal(await page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/).count(), 1, '발급 성공으로 보이지 않는다 (중복 안내 유지)');

    // 3) 잠금이 풀려 추가 입력 B를 받는다. 오류가 계속되는 동안 "저장됨"은 보이지 않고 발급은 나가지 않는다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' B');
    await editor(page).getByText('둘째 본문 A B', { exact: true }).waitFor();
    assert.deepEqual((await statusSeen(page)).filter((t) => t.includes('저장됨')), [], '쓰기가 실패하는 동안 "저장됨"이 보이면 안 된다');
    assert.equal((await state(app)).reissues, 0);
    assert.deepEqual(await read('002.md'), Buffer.from(TWO), '추가 입력 뒤에도 디스크 불변');

    // 4) 오류를 풀고 명시적 Ctrl+S로 A+B를 원래 id에 저장한다 (5초 자동 재시도와 구분하지 못하는 한계: 먼저 저장한 쪽이 어느 쪽인지는 이 테스트가 보지 않는다)
    phase = 'after';
    await set(app, 'failRename', false);
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 30_000 });
    const AB = TWO.replace('둘째 본문', '둘째 본문 A B');
    assert.deepEqual(await read('002.md'), Buffer.from(AB), 'A+B가 원래 id·BOM·CRLF로 저장됐다');
    assert.equal((await state(app)).reissues, 0, '저장 복구만으로 발급이 나가지 않는다');
    const files = await readdir(join(dir, 'chapters'));

    // 5) 사용자의 새 발급 1회: 새 id, A+B·BOM·CRLF 보존, 후속 편집·저장
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/).waitFor({ state: 'detached', timeout: 15_000 });
    await editor(page).getByText('둘째 본문 A B', { exact: true }).waitFor();
    const issued = (await read('002.md')).toString('utf8');
    const newId = idOf(issued)!;
    assert.notEqual(newId, 'same-id');
    assert.equal(issued, AB.replace('same-id', newId), 'id만 바뀌고 A+B·BOM·CRLF·title은 그대로');
    assert.deepEqual(await read('001.md'), Buffer.from(ONE), '다른 화 불변');
    assert.equal((await state(app)).reissues, 1, '발급 총 1회');
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' C');
    await page.keyboard.press('Control+s');
    await waitUntil('후속 저장이 되지 않았다', async () => (await read('002.md')).toString('utf8').includes('A B C'));
    assert.equal(idOf((await read('002.md')).toString('utf8')), newId, '후속 저장도 새 id 유지');
    assert.deepEqual(await readdir(join(dir, 'chapters')), files, '화 파일 수·이름 불변');
    assert.deepEqual(unexpected, [], '복구 뒤 예상하지 않은 확인 창이 없다');
    assert.equal((await state(app)).reissues, 1);
  } catch (e) {
    phase = 'cleanup';
    throw e;
  } finally {
    await closeWindow(app);
  }
});
