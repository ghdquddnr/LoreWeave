// A 프로젝트의 미저장 원고에서 [열기]로 B 폴더 전환을 시도하면 선행 저장(leave → flush)이 먼저 나간다. 그 저장이 실제 디스크 쓰기 실패(EPERM)로 끝나고
// 사용자가 "변경 버림" 확인을 거절하면: project:choose IPC·폴더 선택 창 호출 0, A의 입력·프로젝트 화면·디스크 보존, 편집/전환 잠금 해제.
// 오류를 풀고 저장한 뒤 새 [열기] 1회로 B로 전환하고, B 편집은 B에만, A 재열기에서는 X+Y가 남는다.
// (project-switch의 버림 거절은 외부 충돌이 원인, project-boundary의 취소·실패는 폴더 선택 이후 경계, reissue-save-failure-refusal은 발급 조작이다.)
// 실제 앱(Electron + Playwright). 장벽·주입은 main의 디스크 호출이다: A/001.md 임시 파일을 연 직후 선행 저장을 붙잡고, 풀기 전에 rename을 EPERM으로 만든다.
// project:choose 처리기는 사전 거절하지 않는다(진입만 센다). 합성 A/B(같은 화 파일명·다른 본문/BOM/CRLF/frontmatter)·격리 userData. 합성 자동화이며 수동 GUI·실제 OS IME가 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const A1 = `${BOM}---\r\nid: a-1\r\ntitle: A첫째\r\n---\r\nA첫째 본문\r\n`;
const A2 = `${BOM}---\r\nid: a-2\r\ntitle: A둘째\r\n---\r\nA둘째 본문\r\n`;
const B1 = '---\nid: b-1\ntitle: B첫째\n---\nB첫째 본문\n';
const B2 = '---\nid: b-2\ntitle: B둘째\n---\nB둘째 본문\n';
const CONFIRM = '저장되지 않은 변경이 있습니다. 그래도 계속할까요? (변경은 사라집니다)';

interface G {
  armed: boolean;
  held: boolean;
  failRename: boolean;
  /** A/001.md 저장의 임시 파일 열기·rename 수 */
  opens: number;
  renames: number;
  /** IPC 진입 수 (처리기는 그대로 실행한다) */
  writes: number;
  chooses: number;
  creates: number;
  reissues: number;
  /** 폴더 선택 창 호출 수 */
  dialogs: number;
  release?: () => void;
}
const hook = (app: ElectronApplication, target: string, next: string) =>
  app.evaluate(
    ({ ipcMain, dialog }, [target, next]) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { armed: false, held: false, failRename: false, opens: 0, renames: 0, writes: 0, chooses: 0, creates: 0, reissues: 0, dialogs: 0 });
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
        ['project:choose', 'chooses'],
        ['chapter:create', 'creates'],
        ['chapter:reissue-id', 'reissues'],
      ] as const) {
        const original = map.get(channel)!;
        map.set(channel, (...args: unknown[]) => {
          g[key] += 1;
          return original(...args);
        });
      }
      dialog.showOpenDialog = (async () => {
        g.dialogs += 1;
        return { canceled: false, filePaths: [next] };
      }) as typeof dialog.showOpenDialog;
    },
    [target, next],
  );
const state = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    return { held: g.held, opens: g.opens, renames: g.renames, writes: g.writes, chooses: g.chooses, creates: g.creates, reissues: g.reissues, dialogs: g.dialogs };
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
const openButton = (page: Page) => page.getByRole('button', { name: '열기', exact: true });
const statusSeen = (page: Page) => page.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen);

async function makeProject(prefix: string, files: Record<string, string>) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', name), text);
  return dir;
}

test('폴더 전환의 선행 저장이 쓰기 실패로 끝나고 버림을 거절하면: project:choose·폴더 창 0, A 입력·디스크 보존, 잠금 해제, 이후 저장과 새 [열기] 1회로 B 전환', { timeout: 150_000 }, async () => {
  const A = await makeProject('cfsr-A', { '001.md': A1, '002.md': A2 });
  const B = await makeProject('cfsr-B', { '001.md': B1, '002.md': B2 });
  const read = (dir: string, f: string) => readFile(join(dir, 'chapters', f));
  const { app, page } = await launch(await tempDir('cfsr-ud'));
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
    await stubFolderDialog(app, A);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).getByText('A첫째 본문', { exact: true }).waitFor();
    await hook(app, join(A, 'chapters', '001.md'), B);

    // 1) 입력 X가 미저장임을 확인하고(자동저장 1.5초 전), [열기]를 누른다. 붙잡힌 저장이 클릭의 선행 flush인지는 전환 잠금(열기 비활성·편집 불가)으로 구분한다
    await set(app, 'armed', true);
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' X');
    await editor(page).getByText('A첫째 본문 X', { exact: true }).waitFor();
    const before = await state(app);
    assert.equal(before.opens, 0, '[열기]를 누르기 전에는 저장이 시작되지 않았다 (입력 X는 미저장)');
    assert.equal(await page.getByRole('status').getByText('저장됨', { exact: true }).count(), 0, '입력 X는 저장됨으로 보이지 않는다');
    await openButton(page).click();
    await waitUntil('선행 저장을 붙잡지 못했다', async () => (await state(app)).held);
    const held = await state(app);
    console.error('CHOOSE_SAVE_BARRIER', JSON.stringify(held));
    assert.equal(held.opens, 1);
    assert.equal(held.writes, 1, '선행 flush의 chapter:write 1회');
    assert.equal(held.chooses, 0, '저장이 끝나기 전에는 project:choose 진입이 없다');
    assert.equal(held.dialogs, 0, '저장이 끝나기 전에는 폴더 창이 없다');
    assert.equal(await editor(page).getAttribute('contenteditable'), 'false', '붙잡힌 동안 편집 잠금');
    assert.equal(await openButton(page).isDisabled(), true, '붙잡힌 동안 전환 버튼 잠금');

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
    await waitUntil('편집 잠금이 풀리지 않았다', async () => (await editor(page).getAttribute('contenteditable')) === 'true');
    await waitUntil('전환 버튼이 돌아오지 않았다', async () => !(await openButton(page).isDisabled()));
    const refused = await state(app);
    assert.ok(refused.renames >= 1, 'rename 실패가 주입되지 않았다');
    assert.equal(refused.chooses, 0, '거절 뒤 project:choose 0');
    assert.equal(refused.dialogs, 0, '거절 뒤 폴더 창 0');
    assert.equal(refused.creates + refused.reissues, 0, '불필요한 create/reissue 0');
    assert.equal(asked.length, 1, '확인 창은 한 번');
    for (const [dir, f, text] of [[A, '001.md', A1], [A, '002.md', A2], [B, '001.md', B1], [B, '002.md', B2]] as const) {
      assert.deepEqual(await read(dir, f), Buffer.from(text), `${f} 디스크 바이트 불변`);
    }
    assert.equal(await editor(page).getByText('A첫째 본문 X', { exact: true }).count(), 1, '입력 X는 A 화면에 남는다');
    assert.equal(await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'A첫째' }).count(), 1, '프로젝트는 A 그대로');
    assert.deepEqual((await readdir(join(A, 'chapters'))).filter((f) => f.endsWith('.tmp')), []);
    await page.getByRole('status').getByText('저장 실패', { exact: false }).waitFor({ timeout: 10_000 });

    // 3) 잠금이 풀려 추가 입력 Y를 받는다. 오류가 계속되는 동안 "저장됨"은 보이지 않는다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Y');
    await editor(page).getByText('A첫째 본문 X Y', { exact: true }).waitFor();
    assert.deepEqual((await statusSeen(page)).filter((t) => t.includes('저장됨')), [], '쓰기가 실패하는 동안 "저장됨"이 보이면 안 된다');
    assert.equal((await state(app)).chooses, 0);
    assert.deepEqual(await read(A, '001.md'), Buffer.from(A1), '추가 입력 뒤에도 디스크 불변');

    // 4) 오류를 풀고 저장한다 (Ctrl+S를 눌렀지만 5초 자동 재시도와 구분하지 못한다: 명시 저장 단독 성공이라고 말하지 않는다)
    phase = 'after';
    await set(app, 'failRename', false);
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 30_000 });
    const AXY = A1.replace('A첫째 본문', 'A첫째 본문 X Y');
    assert.deepEqual(await read(A, '001.md'), Buffer.from(AXY), 'X+Y가 A의 원래 id·BOM·CRLF로 저장됐다');
    assert.equal((await state(app)).chooses, 0, '저장 복구만으로 전환이 나가지 않는다');
    const aFiles = await readdir(join(A, 'chapters'));

    // 5) 사용자의 새 [열기] 1회로 B 전환
    await app.evaluate(({ dialog }, next) => {
      const g = globalThis as unknown as G;
      dialog.showOpenDialog = (async () => {
        g.dialogs += 1;
        return { canceled: false, filePaths: [next] };
      }) as typeof dialog.showOpenDialog;
    }, B);
    await openButton(page).click();
    await editor(page).getByText('B첫째 본문', { exact: true }).waitFor({ timeout: 15_000 });
    const switched = await state(app);
    assert.equal(switched.chooses, 1, 'project:choose 총 1회');
    assert.equal(switched.dialogs, 1, '폴더 창 총 1회');
    assert.deepEqual(await read(A, '001.md'), Buffer.from(AXY), '전환 뒤 A 불변');

    // 6) B 편집·저장은 B에만
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' Z');
    await page.keyboard.press('Control+s');
    await waitUntil('B 저장이 되지 않았다', async () => (await read(B, '001.md')).toString('utf8').includes('B첫째 본문 Z'));
    assert.deepEqual(await read(B, '001.md'), Buffer.from(B1.replace('B첫째 본문', 'B첫째 본문 Z')), 'B만 바뀌었다 (LF·BOM 없음 유지)');
    assert.deepEqual(await read(B, '002.md'), Buffer.from(B2));
    assert.deepEqual(await read(A, '001.md'), Buffer.from(AXY), 'B 저장이 A를 바꾸지 않는다');
    assert.deepEqual(await read(A, '002.md'), Buffer.from(A2));

    // 7) A를 다시 열면 X+Y가 보존돼 있고 파일 목록은 그대로다
    await app.evaluate(({ dialog }, next) => {
      const g = globalThis as unknown as G;
      dialog.showOpenDialog = (async () => {
        g.dialogs += 1;
        return { canceled: false, filePaths: [next] };
      }) as typeof dialog.showOpenDialog;
    }, A);
    await waitUntil('B 저장 상태가 정리되지 않았다', async () => (await page.getByRole('status').getByText('저장됨', { exact: true }).count()) > 0);
    await openButton(page).click();
    await editor(page).getByText('A첫째 본문 X Y', { exact: true }).waitFor({ timeout: 15_000 });
    assert.deepEqual(await readdir(join(A, 'chapters')), aFiles, 'A 파일 목록 불변');
    assert.equal((await state(app)).chooses, 2);
    assert.equal((await state(app)).creates + (await state(app)).reissues, 0);
    assert.deepEqual(unexpected, [], '복구 뒤 예상하지 않은 확인 창이 없다');
  } catch (e) {
    phase = 'cleanup';
    throw e;
  } finally {
    await closeWindow(app);
  }
});
