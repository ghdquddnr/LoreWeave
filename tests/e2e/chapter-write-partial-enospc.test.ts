// 기존 001 원고 저장의 임시 파일에 일부 바이트가 실제로 쓰인 뒤 ENOSPC가 나도: 실패가 화면에 보이고(저장됨으로 오인 표시 0), 디스크 원본과 미저장 최신 입력이 보존되며, 계속 편집할 수 있고, 주입을 풀고 명시 저장하면 최신 본문이 정확한 바이트로 저장되는지 본다.
// 기존 save-error-retry는 chapter:write IPC EACCES 대역, save-failure-refusal은 rename EPERM이다. 이 검사는 실제 atomicWrite의 부분 write 실패가 실제 chapter:write를 거쳐 화면에 닿는 경계를 본다.
// 실제 renderer 편집·Ctrl+S → 실제 chapter:write handler → 실제 writeChapter/atomicWrite. handler는 호출 횟수 관찰만 하고 원래 handler를 그대로 부른다(성공·실패 대역 없음).
// 실패 주입(합성): 앱 main 안에서 fs/promises.open을 "001.md + '.' + UUID + '.tmp'" 이고 wx인 호출에만 한정해 그 실제 FileHandle 인스턴스의 writeFile만 앞 절반을 실제로 기록한 뒤 합성 ENOSPC로 거절한다.
// sync·close·tmp rm·rename은 원함수로 통과시키고 횟수만 센다. 원함수는 hook 전에 보존, prototype 전역 패치 없음. 감싼 함수는 이 테스트의 독점 앱 프로세스 안에만 있으며 finally에서 앱을 닫아 함께 사라진다. 실제 디스크 고갈·ACL 시험이 아니다.
// 타이머: ChapterEditor의 1.5초 자동 저장·5초 자동 재시도는 그대로 두며 "해제만으로 영구 재시도 없음"을 요구하지 않는다. 주입이 켜진 동안의 자동·명시 재시도는 실제로 실패하고, 단언은 계수의 하한과 "정착된 상태(열린 handle 모두 닫힘·tmp 없음)"에서 한다.
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인. 독점 합성 BOM/CRLF/frontmatter/한글 001·002와 sentinel만 쓴다. 합성 Electron 자동화이며 수동 GUI/실 IME가 아니다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow, stubFolderDialog, tempDir } from './launch.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n한글 둘째 줄\r\n';
const TWO = '# Two\r\n\r\nBeta 본문\r\n';
const SENTINEL = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');
const withText = (text: string) => ONE.replace('Alpha text', text);

type R = { fail: boolean; writeCalls: number; opens: number; writes: number; enospc: number; syncs: number; closes: number; renames: number; tmpRms: number; partials: { partial: string; full: string }[] };

async function inject(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const r: R = ((globalThis as unknown as { __r?: R }).__r = { fail: true, writeCalls: 0, opens: 0, writes: 0, enospc: 0, syncs: 0, closes: 0, renames: 0, tmpRms: 0, partials: [] });
    const handles: { fd: number }[] = [];
    (globalThis as unknown as { __handles: { fd: number }[] }).__handles = handles;
    const nodeFs = process.getBuiltinModule('fs');
    const fsp = process.getBuiltinModule('fs/promises');
    const realOpen = fsp.open;
    const realRename = fsp.rename;
    const realRm = fsp.rm;
    (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
      const handle = await (realOpen as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(p, flags, ...rest);
      if (!(String(p).startsWith(`${file}.`) && String(p).endsWith('.tmp')) || flags !== 'wx') return handle; // 정확 001.md의 tmp wx만 감싼다
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
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      r.writeCalls++; // 관찰만 한다
      return original(...args);
    });
  }, target);
}
const state = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { __r: R }).__r }));
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __r: R }).__r.fail = v), fail);
const fdsClosed = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __handles: { fd: number }[] }).__handles.every((h) => h.fd === -1));

const editor = (page: Page) => page.locator('.ProseMirror');
const bar = (page: Page) => page.locator('footer.statusbar');
const retryButton = (page: Page) => bar(page).getByRole('button', { name: /^(다시 저장|저장하는 중…)$/ });
const tmpFiles = async (dir: string) => (await readdir(join(dir, 'chapters'))).filter((f) => f.endsWith('.tmp'));
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 600 && !(await ok()); n++) await page.waitForTimeout(50);
  assert.equal(await ok(), true, what);
}
/** 정착: 열린 tmp handle이 모두 닫혔고 tmp 파일이 없다 (진행 중인 재시도가 없는 순간) */
const settledNow = (app: ElectronApplication, dir: string) => async () => (await fdsClosed(app)) && (await tmpFiles(dir)).length === 0;

test('기존 001 저장의 tmp 부분 기록 ENOSPC가 화면에 실패로 보이고 디스크 원본·미저장 최신 입력이 보존되며 계속 편집되고, 주입을 풀고 명시 저장하면 최신 본문이 정확한 바이트로 저장된다', { timeout: 150_000 }, async () => {
  const { app, page } = await launchIsolated('cwpe');
  try {
    const dir = await tempDir('cwpe-proj');
    await mkdir(join(dir, 'chapters'));
    const path001 = join(dir, 'chapters', '001.md');
    await writeFile(path001, ONE);
    await writeFile(join(dir, 'chapters', '002.md'), TWO);
    await writeFile(join(dir, 'chapters', 'sentinel.txt'), SENTINEL);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await editor(page).getByText('Alpha text').waitFor();
    await inject(app, path001);
    const original = await readFile(path001);
    const orig002 = await readFile(join(dir, 'chapters', '002.md'));

    // 1) 편집 + 명시 Ctrl+S → 실제 chapter:write → 부분 기록 ENOSPC
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
    await retryButton(page).waitFor();
    assert.ok(!/저장됨/.test(await bar(page).innerText()), '실패가 저장됨으로 오인 표시되지 않는다');
    // 실패 중 추가 입력도 보존된다
    await page.keyboard.type(' B');
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 }); // 1.5초 자동 저장이 (주입이 켜진 채) 다시 실패해야 실패 안내가 돌아온다
    await retryButton(page).waitFor();
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, '미저장 최신 입력(A, B)이 에디터에 그대로 있다');
    await waitUntil(page, '진행 중인 재시도가 끝나 정착한다', settledNow(app, dir));
    const failed = await state(app);
    assert.ok(failed.enospc >= 2, `실제 부분 쓰기 실패가 최소 두 번(명시 저장 + 자동 재시도) 있었다: ${failed.enospc}`);
    assert.equal(failed.writeCalls >= failed.enospc, true, '모든 실패는 실제 chapter:write를 거쳤다');
    assert.deepEqual({ syncs: failed.syncs, renames: failed.renames }, { syncs: 0, renames: 0 }, '부분 기록이 실패하면 sync·rename에 이르지 않는다');
    assert.equal(failed.opens, failed.closes, '열린 tmp handle마다 실제 close가 있었다');
    assert.equal(failed.tmpRms, failed.enospc, '실패마다 tmp 정리 rm이 있었다');
    assert.equal(await fdsClosed(app), true, '실제 handle 누수 0');
    for (const { partial, full } of failed.partials) {
      const p = Buffer.from(partial, 'base64');
      const f = Buffer.from(full, 'base64');
      assert.ok(p.length > 0 && p.length < f.length, `부분 기록(${p.length})이 0보다 크고 전체(${f.length})보다 짧았다`);
      assert.deepEqual(f.subarray(0, p.length), p, '부분 바이트는 의도한 내용의 앞부분이다');
    }
    // 디스크: 원본 보존·tmp 잔류 0
    assert.deepEqual(await readFile(path001), original, '001 디스크 원본 Buffer 그대로');
    assert.equal(sha(await readFile(path001)), sha(Buffer.from(ONE, 'utf8')), '001 원본 hash 그대로 (기대 원문과 대조)');
    assert.deepEqual(await tmpFiles(dir), [], '불완전한 tmp 잔류 0');
    // 계속 편집 가능: 실패 뒤에도 에디터가 편집 가능하다
    await page.keyboard.type(' C');
    await editor(page).getByText('Alpha text A B C', { exact: true }).waitFor();
    assert.equal(await editor(page).getAttribute('contenteditable'), 'true');

    // 2) 주입을 풀고 명시 저장(Ctrl+S): 최신 본문이 정확한 바이트로 저장된다 (자동 재시도가 먼저 성공해도 최종 상태는 같다)
    await setFail(app, false);
    await page.keyboard.press('Control+S');
    await bar(page).getByText('저장됨', { exact: true }).waitFor({ timeout: 30_000 });
    await waitUntil(page, '정착한다', settledNow(app, dir));
    const expected = withText('Alpha text A B C');
    assert.equal((await readFile(path001)).toString('utf8'), expected, '최신 본문이 BOM·CRLF·frontmatter와 함께 저장됐다');
    assert.equal(sha(await readFile(path001)), sha(Buffer.from(expected, 'utf8')), '저장된 hash = 기대 원문 hash');
    const done = await state(app);
    assert.ok(done.renames >= 1 && done.syncs >= 1, `실제 sync·rename 성공이 있었다 (sync ${done.syncs}, rename ${done.renames})`);
    assert.equal(done.enospc, failed.enospc, '해제 뒤 부분 쓰기 실패는 더 없었다');
    assert.equal(await retryButton(page).count(), 0, '저장되면 [다시 저장]이 사라진다');
    assert.deepEqual(await tmpFiles(dir), [], 'tmp 잔류 0');
    assert.deepEqual(await readFile(join(dir, 'chapters', '002.md')), orig002, '002 불변');
    assert.deepEqual(await readFile(join(dir, 'chapters', 'sentinel.txt')), SENTINEL, 'sentinel 불변');
    assert.deepEqual((await readdir(join(dir, 'chapters'))).sort(), ['001.md', '002.md', 'sentinel.txt']);
    assert.equal(await fdsClosed(app), true, '실제 handle 누수 0');
  } finally {
    await closeWindow(app);
  }
});
