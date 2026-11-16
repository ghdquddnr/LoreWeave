// 새 화 생성의 실제 파일 쓰기가 일부 바이트를 쓴 뒤 ENOSPC로 거절돼도: 실패가 화면에 전달되고, 기존 001 원고·sentinel이 유지되며, 에디터 잠금이 풀려 계속 편집·저장되고, 주입 해제만으로는 재생성하지 않으며, 새 명시 [+ 새 화]만 002를 정상 생성하는지 본다.
// 기존 action-lock 실패 검사는 실제 생성 성공 뒤 응답만 거절하므로 이 실제 부분 쓰기 실패·정리 경로를 다루지 않는다.
// 실제 renderer [+ 새 화] → 실제 chapter:create handler → 실제 createChapter를 끝까지 호출한다. handler/제품 결과 대역 없음: handler는 호출 횟수와 반환값 관찰만 하고 원래 handler를 그대로 부른다.
// 실패 주입(합성): 앱 main 안에서 fs/promises.open을 이 테스트의 정확한 새 화 경로(002.md) + wx 호출에만 한정해 그 실제 FileHandle 인스턴스의 writeFile만 앞 절반 바이트를 실제 기록한 뒤 합성 ENOSPC로 거절한다.
// 신원 stat·원래 close·신원 일치 rm은 실제로 수행·성공한다. 원함수는 hook 전에 보존, prototype 전역 패치 없음. 감싼 함수는 이 테스트의 독점 앱 프로세스 안에만 있으며 finally에서 앱을 닫아 함께 사라진다. 실제 디스크 고갈·ACL 시험이 아니다.
// 격리: tests/e2e/isolated-launch.ts(hooks/main-isolated-userdata-entry.cjs): 매 실행 독점 새 빈 userData·main 전 증거 확인. 독점 합성 BOM/CRLF/frontmatter/한글 001과 sentinel만 쓴다. 합성 Electron 자동화이며 수동 GUI/실 IME가 아니다.
// 한계: "주입 해제만으로 재생성 없음"은 임의 대기가 아니라 유한 대기(700ms) 전후의 계수·목록·디스크 관측이다. 기존 비격리 action-lock 검사는 실행하지 않았다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { launchIsolated } from './isolated-launch.ts';
import { closeWindow, stubFolderDialog, tempDir } from './launch.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const ORIGINAL = Buffer.from('﻿---\r\nid: syn-1\r\ntitle: 첫 화\r\n---\r\n처음 본문입니다.\r\n한글 둘째 줄\r\n', 'utf8');
const SENTINEL = Buffer.from('합성 sentinel: 무관한 파일\n', 'utf8');

type R = {
  fail: boolean;
  creates: number;
  opens: number;
  writes: number;
  enospc: number;
  syncs: number;
  closes: number;
  rms: number;
  partialB64: string | null;
  fullB64: string | null;
  createdFile: string | null;
  createdText: string | null;
  createdHash: string | null;
};

async function inject(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, file) => {
    const r: R = ((globalThis as unknown as { __r?: R }).__r = { fail: true, creates: 0, opens: 0, writes: 0, enospc: 0, syncs: 0, closes: 0, rms: 0, partialB64: null, fullB64: null, createdFile: null, createdText: null, createdHash: null });
    const handles: { fd: number }[] = [];
    (globalThis as unknown as { __handles: { fd: number }[] }).__handles = handles;
    const nodeFs = process.getBuiltinModule('fs');
    const fsp = process.getBuiltinModule('fs/promises');
    const realOpen = fsp.open;
    const realRm = fsp.rm;
    (fsp as { open: unknown }).open = async (p: unknown, flags?: unknown, ...rest: unknown[]) => {
      const handle = await (realOpen as (...a: unknown[]) => Promise<import('node:fs/promises').FileHandle>)(p, flags, ...rest);
      if (String(p) !== file || flags !== 'wx') return handle; // 정확 새 화 경로의 wx만 감싼다
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
        r.fullB64 = full.toString('base64');
        r.partialB64 = nodeFs.readFileSync(file).toString('base64');
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
    (fsp as { rm: unknown }).rm = async (p: unknown, ...rest: unknown[]) => {
      if (String(p) === file) r.rms++;
      return (realRm as (...a: unknown[]) => Promise<void>)(p, ...rest);
    };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:create')!;
    handlers.set('chapter:create', async (...args: unknown[]) => {
      r.creates++;
      const result = (await original(...args)) as { file: string; text: string; hash: string };
      r.createdFile = result.file; // 반환값을 관찰만 한다 (대역·변경 없음)
      r.createdText = result.text;
      r.createdHash = result.hash;
      return result;
    });
  }, target);
}
const state = (app: ElectronApplication) => app.evaluate(() => ({ ...(globalThis as unknown as { __r: R }).__r }));
const fdsClosed = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { __handles: { fd: number }[] }).__handles.every((h) => h.fd === -1));
const setFail = (app: ElectronApplication, fail: boolean) => app.evaluate((_e, v) => void ((globalThis as unknown as { __r: R }).__r.fail = v), fail);
const newChapter = (page: Page) => page.getByRole('button', { name: '+ 새 화', exact: true });
const chapterList = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const footerError = (page: Page) => page.locator('footer .error');
const files = async (dir: string) => (await readdir(join(dir, 'chapters'))).sort();

test('새 화 생성이 부분 기록 ENOSPC로 실패하면 오류가 보이고 기존 001·sentinel이 유지되며 에디터 잠금이 풀려 계속 편집·저장되고, 해제만으로 재생성하지 않으며, 새 명시 [+ 새 화]만 002를 정상 생성한다', { timeout: 120_000 }, async () => {
  const { app, page } = await launchIsolated('ncpw');
  try {
    const dir = await tempDir('ncpw-proj');
    await mkdir(join(dir, 'chapters'));
    await writeFile(join(dir, 'chapters', '001.md'), ORIGINAL);
    await writeFile(join(dir, 'chapters', 'sentinel.txt'), SENTINEL);
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.locator('.ProseMirror').getByText('처음 본문입니다.', { exact: false }).waitFor();
    const target = join(dir, 'chapters', '002.md');
    await inject(app, target);
    const orig001 = sha(await readFile(join(dir, 'chapters', '001.md')));
    // 실제 UI [+ 새 화] → 실제 chapter:create → 실제 createChapter (부분 기록 ENOSPC)
    await newChapter(page).click();
    await footerError(page).waitFor({ timeout: 15_000 });
    const text = await footerError(page).innerText();
    assert.match(text, /저장 공간이 부족합니다/, `ENOSPC를 사용자 말로 안내한다: ${text}`);
    assert.doesNotMatch(text, /만들어졌|만들었/, '생성 성공으로 오인시키지 않는다');
    assert.equal(await footerError(page).getByRole('button', { name: '기술 상세' }).count(), 1, '기술 상세는 접혀 있다');
    // 실제 실패·정리 성공 관측
    const failed = await state(app);
    assert.deepEqual({ creates: failed.creates, opens: failed.opens, writes: failed.writes, enospc: failed.enospc, syncs: failed.syncs, closes: failed.closes, rms: failed.rms }, { creates: 1, opens: 1, writes: 1, enospc: 1, syncs: 0, closes: 1, rms: 1 }, 'create·open·write(ENOSPC)·close·정리 rm 각 1, sync 0');
    assert.equal(await fdsClosed(app), true, '실제 handle 누수 0');
    assert.ok(failed.partialB64 && failed.fullB64, '부분 기록이 있었다');
    const partial = Buffer.from(failed.partialB64!, 'base64');
    const full = Buffer.from(failed.fullB64!, 'base64');
    assert.ok(partial.length > 0 && partial.length < full.length, `부분 기록(${partial.length})이 0보다 크고 전체(${full.length})보다 짧았다`);
    assert.deepEqual(full.subarray(0, partial.length), partial, '부분 바이트는 의도한 내용의 앞부분이다');
    // 디스크: 002·tmp 잔류 0, 001·sentinel 불변
    assert.deepEqual(await files(dir), ['001.md', 'sentinel.txt'], '불완전한 002.md 잔류 0');
    assert.equal(sha(await readFile(join(dir, 'chapters', '001.md'))), orig001, '기존 001 Buffer 불변');
    assert.deepEqual(await readFile(join(dir, 'chapters', '001.md')), ORIGINAL);
    assert.deepEqual(await readFile(join(dir, 'chapters', 'sentinel.txt')), SENTINEL, 'sentinel 불변');
    // UI: 기존 001 선택·본문 유지, 새 화 성공 없음, 에디터 잠금 해제, 버튼 재활성
    assert.equal(await chapterList(page).getByRole('button').count(), 1, '목록에 새 화가 없다');
    assert.equal(await chapterList(page).locator('[aria-current="page"]').count(), 1);
    assert.match(await page.locator('.ProseMirror').innerText(), /처음 본문입니다\./, '기존 001 본문이 그대로 보인다');
    await page.locator('.ProseMirror[contenteditable="true"]').waitFor({ timeout: 10_000 });
    assert.equal(await newChapter(page).isEnabled(), true, '[+ 새 화]가 다시 활성이다');
    // 계속 편집·명시 저장: 기존 001에 입력이 들어가고 저장된다
    await page.locator('.ProseMirror').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.type('추가입력');
    await page.locator('.ProseMirror').getByText('추가입력').waitFor();
    await page.keyboard.press('Control+S');
    let saved = ORIGINAL;
    for (let n = 0; n < 200; n++) {
      saved = await readFile(join(dir, 'chapters', '001.md'));
      if (saved.includes(Buffer.from('추가입력', 'utf8'))) break;
      await page.waitForTimeout(25);
    }
    const savedText = saved.toString('utf8');
    assert.ok(savedText.startsWith('﻿---\r\nid: syn-1\r\ntitle: 첫 화\r\n---\r\n'), `BOM/CRLF/frontmatter 보존: ${JSON.stringify(savedText)}`);
    assert.ok(savedText.includes('처음 본문입니다.') && savedText.includes('한글 둘째 줄') && savedText.includes('추가입력'), `원문과 새 입력 모두 있다: ${JSON.stringify(savedText)}`);
    assert.equal(savedText.replace('추가입력', ''), ORIGINAL.toString('utf8'), '새 입력만 더해졌고 나머지 바이트(BOM/CRLF/frontmatter)는 그대로다');
    assert.deepEqual(await files(dir), ['001.md', 'sentinel.txt'], '저장은 002를 만들지 않는다');
    // 주입 해제만으로는 재생성하지 않는다 (유한 대기 전후 계수·목록·디스크)
    await setFail(app, false);
    const before = await state(app);
    await page.waitForTimeout(700);
    const after = await state(app);
    assert.deepEqual({ creates: after.creates, opens: after.opens, writes: after.writes, rms: after.rms }, { creates: before.creates, opens: before.opens, writes: before.writes, rms: before.rms }, '해제 뒤 유한 대기 동안 create·open·write·rm 증가 0');
    assert.deepEqual(await files(dir), ['001.md', 'sentinel.txt'], '해제만으로 002가 생기지 않았다');
    assert.equal(await chapterList(page).getByRole('button').count(), 1);
    // 새 명시 [+ 새 화]만 002를 정상 생성한다
    await newChapter(page).click();
    await chapterList(page).getByRole('button').nth(1).waitFor({ timeout: 15_000 });
    const done = await state(app);
    assert.deepEqual({ creates: done.creates, opens: done.opens }, { creates: 2, opens: 2 }, '새 명시 생성으로 create·open이 한 번씩 늘었다');
    assert.deepEqual(await files(dir), ['001.md', '002.md', 'sentinel.txt']);
    const bytes002 = await readFile(target);
    assert.equal(done.createdFile, '002.md');
    assert.equal(done.createdText, bytes002.toString('utf8'), '반환 text가 실제 완전한 파일과 같다');
    assert.equal(done.createdHash, sha(bytes002), '반환 hash가 실제 Buffer 해시와 같다');
    assert.equal(await chapterList(page).getByRole('button').count(), 2, '목록에 두 화');
    assert.equal(await chapterList(page).locator('[aria-current="page"]').count(), 1);
    assert.match(await chapterList(page).locator('[aria-current="page"]').innerText(), /2/, '새 화가 열려 있다');
    assert.equal(sha(await readFile(join(dir, 'chapters', '001.md'))), sha(Buffer.from(savedText, 'utf8')), '001은 직전 저장 그대로');
    assert.deepEqual(await readFile(join(dir, 'chapters', 'sentinel.txt')), SENTINEL, 'sentinel 유지');
  } finally {
    await closeWindow(app);
  }
});
