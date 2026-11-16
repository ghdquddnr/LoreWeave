// 열린 중복 id 화의 [새 id 발급] 자체에서 실제 atomicWrite의 부분 write ENOSPC가 나면: 기존 id·원고 바이트·화면·편집 가능성이 보존되고, 주입 해제만으로는 재발급하지 않으며, 새 명시 클릭 한 번으로만 정상 발급되는지 본다.
// 기존 reissue-save-failure-refusal은 발급 클릭의 선행 flush(chapter:write)의 rename EPERM, reissue-list-failure의 발급 실패는 chapter:reissue-id IPC 사전 거절이다. 이 검사는 실제 reissueChapterId가 id를 쓰려는 쓰기 자체의 실패를 본다.
// 초기에 미저장 입력이 없어 발급 클릭에는 선행 flush가 없다(chapter:write 0으로 단언). 실제 renderer [새 id 발급] → 실제 chapter:reissue-id handler → 실제 reissueChapterId/atomicWrite. handler는 호출 횟수 관찰만 하고 원래 handler를 그대로 부른다(성공·실패 대역 없음).
// 실패 주입(합성): 앱 main 안에서 fs/promises.open을 "002.md + '.' + UUID + '.tmp'" 이고 wx인 호출에만 한정해 그 실제 FileHandle 인스턴스의 writeFile만 앞 절반을 실제로 기록한 뒤 합성 ENOSPC로 거절한다. sync·close·tmp rm·rename은 원함수 통과·계수. prototype 전역 패치 없음, 앱 종료로 정리. 실제 디스크 고갈·ACL 시험이 아니다.
// 자동 저장과 발급을 혼동하지 않도록: 실패 뒤 편집 단계에서는 renderer 시계를 멈춰(Playwright clock) 자동 저장 타이머가 끼어들 수 없게 하고, chapter:write와 chapter:reissue-id를 따로 센다. 임의 긴 sleep으로 명시 실행을 추정하지 않는다(해제 뒤 400ms는 시계와 무관한 유한 관측).
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인. 독점 합성 BOM/CRLF/frontmatter/한글 중복 id 001·002와 sentinel만 쓴다. 합성 Electron 자동화이며 수동 GUI/실 IME가 아니다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow, stubFolderDialog, tempDir } from './launch.ts';

const BOM = '﻿';
const dup = (title: string, body = `${title} 본문`) => `${BOM}---\r\nid: same-id\r\ntitle: ${title}\r\n---\r\n${body}\r\n`;
const ONE = dup('첫째');
const TWO = dup('둘째');
const SENTINEL = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');

type R = { fail: boolean; reissues: number; writeCalls: number; opens: number; writes: number; enospc: number; syncs: number; closes: number; renames: number; tmpRms: number; partials: { partial: string; full: string }[] };

async function inject(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const r: R = ((globalThis as unknown as { __r?: R }).__r = { fail: true, reissues: 0, writeCalls: 0, opens: 0, writes: 0, enospc: 0, syncs: 0, closes: 0, renames: 0, tmpRms: 0, partials: [] });
    const handles: { fd: number }[] = [];
    (globalThis as unknown as { __handles: { fd: number }[] }).__handles = handles;
    const nodeFs = process.getBuiltinModule('fs');
    const fsp = process.getBuiltinModule('fs/promises');
    const realOpen = fsp.open;
    const realRename = fsp.rename;
    const realRm = fsp.rm;
    (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
      const handle = await (realOpen as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(p, flags, ...rest);
      if (!(String(p).startsWith(`${file}.`) && String(p).endsWith('.tmp')) || flags !== 'wx') return handle; // 정확 002.md의 tmp wx만 감싼다
      r.opens++;
      handles.push(handle);
      const origWrite = handle.writeFile;
      const origSync = handle.sync;
      const origClose = handle.close;
      (handle as unknown as { writeFile: unknown }).writeFile = async (data: unknown, ...a: unknown[]) => {
        r.writes++;
        if (!r.fail) return (origWrite as (...x: unknown[]) => Promise<void>).call(handle, data, ...a);
        const full = Buffer.from(data as Uint8Array);
        await (origWrite as (...x: unknown[]) => Promise<void>).call(handle, full.subarray(0, Math.floor(full.length / 2)), ...a); // 앞부분만 실제로 기록한다
        r.partials.push({ full: full.toString('base64'), partial: nodeFs.readFileSync(String(p)).toString('base64') });
        r.enospc++;
        throw Object.assign(new Error('합성 ENOSPC (writeFile, 일부 기록 뒤)'), { code: 'ENOSPC' });
      };
      (handle as unknown as { sync: unknown }).sync = async () => {
        r.syncs++;
        return origSync.call(handle);
      };
      (handle as unknown as { close: unknown }).close = async () => {
        r.closes++;
        return origClose.call(handle);
      };
      return handle;
    };
    (fsp as { rename: unknown }).rename = async (from: unknown, to: unknown) => {
      if (String(to) === file) r.renames++;
      return (realRename as (...a: unknown[]) => Promise<void>)(from, to);
    };
    (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
      if (String(p).startsWith(`${file}.`) && String(p).endsWith('.tmp')) r.tmpRms++;
      return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const reissue = handlers.get('chapter:reissue-id')!;
    handlers.set('chapter:reissue-id', async (...args: unknown[]) => {
      r.reissues++; // 관찰만 한다
      return reissue(...args);
    });
    const write = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      r.writeCalls++; // 관찰만 한다
      return write(...args);
    });
  }, target);
}
const state = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { __r: R }).__r }));
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __r: R }).__r.fail = v), fail);
const fdsClosed = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __handles: { fd: number }[] }).__handles.every((h) => h.fd === -1));

const editor = (page: Page) => page.locator('.ProseMirror');
const footerError = (page: Page) => page.locator('footer .error');
const dupWarning = (page: Page) => page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/);
const reissueButton = (page: Page) => page.getByRole('button', { name: '새 id 발급' });
const tmpFiles = async (dir: string) => (await readdir(join(dir, 'chapters'))).filter((f) => f.endsWith('.tmp'));
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 600 && !(await ok()); n++) await page.waitForTimeout(50);
  assert.equal(await ok(), true, what);
}

test('[새 id 발급]의 id 쓰기가 부분 기록 ENOSPC로 실패하면 오류가 보이고 기존 id·원고·화면·편집 가능성이 보존되며, 해제만으로 재발급하지 않고, 새 명시 클릭 한 번으로만 정상 발급된다', { timeout: 150_000 }, async () => {
  const { app, page } = await launchIsolated('rpw');
  try {
    const dir = await tempDir('rpw-proj');
    await mkdir(join(dir, 'chapters'));
    const path002 = join(dir, 'chapters', '002.md');
    await writeFile(join(dir, 'chapters', '001.md'), ONE);
    await writeFile(path002, TWO);
    await writeFile(join(dir, 'chapters', 'sentinel.txt'), SENTINEL);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await dupWarning(page).waitFor();
    await inject(app, path002);
    const orig001 = await readFile(join(dir, 'chapters', '001.md'));
    const orig002 = await readFile(path002);
    // 시계를 멈춘다: 이후 자동 저장·자동 재시도 타이머는 만들어져도 만료하지 않는다 (발급과 자동 저장을 혼동하지 않는다)
    const t0 = Date.now();
    await page.clock.install({ time: t0 });
    await page.clock.pauseAt(t0 + 1000);

    // 1) 미저장 입력 없이 [새 id 발급] → 실제 chapter:reissue-id → 실제 reissueChapterId/atomicWrite (부분 기록 ENOSPC)
    await reissueButton(page).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    await waitUntil(page, '실패가 정착한다 (열린 handle 모두 닫힘·tmp 없음)', async () => (await fdsClosed(app)) && (await tmpFiles(dir)).length === 0);
    const failed = await state(app);
    assert.deepEqual({ reissues: failed.reissues, writeCalls: failed.writeCalls }, { reissues: 1, writeCalls: 0 }, '발급 IPC 1건이 실제 처리기에 들어갔고, 선행 flush(chapter:write)는 없었다');
    assert.deepEqual({ opens: failed.opens, writes: failed.writes, enospc: failed.enospc, syncs: failed.syncs, closes: failed.closes, renames: failed.renames, tmpRms: failed.tmpRms }, { opens: 1, writes: 1, enospc: 1, syncs: 0, closes: 1, renames: 0, tmpRms: 1 }, 'tmp open·write(ENOSPC)·close·정리 rm 각 1, sync 0, rename 0');
    assert.equal(await fdsClosed(app), true, '실제 handle 누수 0');
    const { partial, full } = failed.partials[0]!;
    const p = Buffer.from(partial, 'base64');
    const f = Buffer.from(full, 'base64');
    assert.ok(p.length > 0 && p.length < f.length, `부분 기록(${p.length})이 0보다 크고 전체(${f.length})보다 짧았다`);
    assert.deepEqual(f.subarray(0, p.length), p, '부분 바이트는 의도한 내용의 앞부분이다');
    assert.ok(!f.toString('utf8').includes('same-id'), '의도한 쓰기에는 새 id가 들어 있었다 (기존 id가 아니다)');
    // 화면: 실패 안내, 거짓 성공·목록 복구 안내 없음, 중복 경고 유지
    const text = await footerError(page).innerText();
    assert.match(text, /저장 공간이 부족합니다/, `ENOSPC를 사용자 말로 안내한다: ${text}`);
    assert.doesNotMatch(text, /발급했|발급됐|바꿨|바뀌었/, '발급 성공으로 오인시키지 않는다');
    assert.equal(await page.getByRole('button', { name: '목록 다시 읽기' }).count(), 0, '목록 복구 안내가 없다 (발급 자체가 실패했다)');
    assert.equal(await dupWarning(page).count(), 1, '중복 id 경고 유지');
    assert.equal(await reissueButton(page).count(), 1, '[새 id 발급]이 다시 눌릴 수 있다');
    assert.equal(await page.getByRole('navigation', { name: '화 목록' }).locator('[aria-current="page"]').count(), 1);
    assert.match(await page.getByRole('navigation', { name: '화 목록' }).locator('[aria-current="page"]').innerText(), /둘째/, '002가 계속 선택돼 있다');
    assert.match(await editor(page).innerText(), /둘째 본문/, '본문이 그대로 보인다');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 10_000 }); // 편집 잠금 해제
    // 디스크: 기존 id·원고 보존, tmp 없음, 다른 파일 불변
    assert.deepEqual(await readFile(path002), orig002, '002 디스크 바이트 불변 (기존 id)');
    assert.equal((await readFile(path002, 'utf8')).includes('id: same-id\r\n'), true);
    assert.deepEqual(await readFile(join(dir, 'chapters', '001.md')), orig001, '001 불변');
    assert.deepEqual(await readFile(join(dir, 'chapters', 'sentinel.txt')), SENTINEL, 'sentinel 불변');
    assert.deepEqual(await tmpFiles(dir), [], '불완전한 tmp 잔류 0');

    // 2) 실패 뒤 계속 편집: 입력은 받는다. 시계가 멈춰 있어 자동 저장이 끼어들지 않고, 입력만으로 발급 IPC·저장 요청이 없다
    await editor(page).click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type(' A');
    await editor(page).getByText('둘째 본문 A', { exact: true }).waitFor();
    assert.deepEqual({ reissues: (await state(app)).reissues, writeCalls: (await state(app)).writeCalls, opens: (await state(app)).opens }, { reissues: 1, writeCalls: 0, opens: 1 }, '입력만으로는 발급·저장 요청이 없다');

    // 3) 주입 해제만으로는 재발급하지 않는다 (해제 전후 계수·디스크·경고, 실제 시간 400ms는 시계와 무관한 유한 관측)
    const s0 = await state(app);
    await setFail(app, false);
    await page.waitForTimeout(400);
    const s1 = await state(app);
    assert.deepEqual({ reissues: s1.reissues, writeCalls: s1.writeCalls, opens: s1.opens, syncs: s1.syncs, renames: s1.renames }, { reissues: s0.reissues, writeCalls: s0.writeCalls, opens: s0.opens, syncs: s0.syncs, renames: s0.renames }, '해제만으로는 발급 IPC·저장·rename이 늘지 않는다');
    assert.deepEqual(await readFile(path002), orig002, '해제 뒤에도 디스크는 원본 그대로다');
    assert.equal(await dupWarning(page).count(), 1, '해제만으로 경고가 사라지지 않는다');

    // 4) 새 명시 클릭 한 번: 클릭의 선행 flush(미저장 입력 A, chapter:write 1건)가 옛 id로 저장된 뒤 chapter:reissue-id 1건이 새 id를 쓴다
    await reissueButton(page).click();
    await waitUntil(page, '명시 클릭이 새 발급 IPC를 일으켰다', async () => (await state(app)).reissues === s0.reissues + 1);
    await dupWarning(page).waitFor({ state: 'detached', timeout: 30_000 });
    await waitUntil(page, '정착한다', async () => (await fdsClosed(app)) && (await tmpFiles(dir)).length === 0);
    const done = await state(app);
    assert.deepEqual({ reissues: done.reissues, writeCalls: done.writeCalls, opens: done.opens, syncs: done.syncs, renames: done.renames, enospc: done.enospc }, { reissues: 2, writeCalls: 1, opens: 3, syncs: 2, renames: 2, enospc: 1 }, '명시 클릭 한 번 = 선행 flush 1건 + 발급 1건의 실제 sync·rename 성공, 부분 쓰기 실패는 더 없다');
    const after = await readFile(path002, 'utf8');
    const newId = /id: (.+)\r\n/.exec(after)?.[1];
    assert.ok(newId && newId !== 'same-id' && /^[0-9a-f-]{36}$/.test(newId), `기존 id가 새 id로 바뀌었다: ${newId}`);
    assert.equal(after, `${BOM}---\r\nid: ${newId}\r\ntitle: 둘째\r\n---\r\n둘째 본문 A\r\n`, 'BOM·CRLF·frontmatter·본문(입력 A 포함)이 그대로고 id만 바뀌었다');
    assert.deepEqual(await readFile(join(dir, 'chapters', '001.md')), orig001, '001은 여전히 기존 id (불변)');
    assert.deepEqual(await readFile(join(dir, 'chapters', 'sentinel.txt')), SENTINEL, 'sentinel 불변');
    assert.deepEqual((await readdir(join(dir, 'chapters'))).sort(), ['001.md', '002.md', 'sentinel.txt']);
    assert.equal(await dupWarning(page).count(), 0, '중복 id 경고가 해소됐다');
    assert.match(await editor(page).innerText(), /둘째 본문 A/, '다시 연 화면에 본문이 그대로다');
    assert.equal(await fdsClosed(app), true, '실제 handle 누수 0');
  } finally {
    await closeWindow(app);
  }
});
