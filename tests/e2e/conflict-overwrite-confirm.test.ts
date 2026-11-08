// 외부 수정 충돌의 [내 것으로 덮어쓰기]: 디스크의 외부 수정이 지금 화면의 내용으로 대체되므로 먼저 확인을 받는다. 취소하면 쓰기 0·본문·undo·충돌 안내·디스크 바이트가 그대로이고,
// 수락하면 확인 대상 해시로 기존 저장 경로를 한 번 실행한다. 확인하는 사이 디스크가 또 바뀌었다면 해시 검사가 막아 새 바이트를 덮지 않고 충돌로 남는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 충돌 UI. main의 chapter:write를 호출 기록 대역(인자의 expectedHash와 결과 status를 기록, 원래 처리기로 통과)으로 감싼다. 확인(window.confirm)은 Playwright dialog 이벤트로 제어하는 합성 검사다.
// 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 저장되는 경합을 없앤다. 실제 OS IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (body: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${body}\r\n`;
const MESSAGE = '디스크의 외부 수정이 사라지고 지금 화면의 내용으로 저장됩니다. 계속할까요?';

interface Writes {
  calls: { expected: string | null; status: string }[];
}
const writes = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { w: Writes }).w.calls);
const editor = (page: Page) => page.locator('.ProseMirror');
const overwriteButton = (page: Page) => page.getByRole('button', { name: '내 것으로 덮어쓰기' });
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('내 것으로 덮어쓰기: 확인을 먼저 받고, 취소하면 쓰기 0이며, 수락하면 확인 대상 해시로 한 번 쓰고, 확인 중 다시 바뀐 디스크는 덮지 않고 충돌로 남는다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('conflict-overwrite-confirm');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, doc('Alpha text'));
  const { app, page } = await launch(await tempDir('conflict-overwrite-confirm-ud'));
  const asked: string[] = [];
  /** 확인 응답: 'cancel' | 'accept' | 'accept-after-external' (확인이 떠 있는 동안 디스크가 또 바뀐다) */
  let mode: 'cancel' | 'accept' | 'accept-after-external' = 'cancel';
  const external2 = doc('Alpha from disk, second');
  page.on('dialog', (d) => {
    asked.push(d.message());
    void (async () => {
      if (mode === 'cancel') return void (await d.dismiss());
      if (mode === 'accept-after-external') await writeFile(path, external2); // 확인이 떠 있는 동안 디스크가 또 바뀐다
      await d.accept();
    })();
  });
  try {
    // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 main에는 없다
    await app.evaluate(
      ({ ipcMain }, code) => new Function('ipcMain', code)(ipcMain),
      `
      const g = globalThis;
      g.w = { calls: [] };
      const handlers = ipcMain._invokeHandlers;
      const original = handlers.get('chapter:write');
      handlers.set('chapter:write', async (...args) => {
        const result = await original(...args);
        g.w.calls.push({ expected: args[3], status: result && result.status });
        return result;
      });
    `,
    );
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await editor(page).getByText('Alpha text').waitFor();
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);

    // 미저장 수정 + 외부 변경 → 충돌
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' MINE');
    const external1 = doc('Alpha from disk');
    await writeFile(path, external1);
    await overwriteButton(page).waitFor({ timeout: 15_000 });

    // 1) 확인 취소: 쓰기 0, 본문·undo·충돌 안내·디스크 그대로, 계속 비교할 수 있다
    await overwriteButton(page).click();
    await settled(page);
    assert.deepEqual(asked, [MESSAGE], '덮어쓰기 확인을 먼저 받았다');
    assert.equal((await writes(app)).length, 0, '취소하면 저장 요청이 없다');
    assert.equal(await editor(page).getByText('Alpha text MINE', { exact: true }).count(), 1, '취소하면 현재 본문이 그대로다');
    assert.equal(await overwriteButton(page).count(), 1, '충돌 안내가 그대로다');
    assert.ok((await readFile(path, 'utf8')) === external1, '디스크 바이트는 그대로다');
    await page.getByRole('button', { name: '차이 보기' }).click();
    await page.getByRole('region', { name: '내 화면과 디스크의 차이' }).waitFor();
    await page.getByRole('button', { name: '차이 닫기' }).click();
    await editor(page).getByText('Alpha text MINE').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Z');
    await settled(page);
    assert.equal(await editor(page).getByText('Alpha text MINE', { exact: true }).count(), 0, 'undo 기록이 유지된다');
    await page.keyboard.press('Control+Shift+Z');
    await editor(page).getByText('Alpha text MINE', { exact: true }).waitFor();

    // 2) 확인 중 디스크가 또 바뀐 채 수락: 기존 해시 검사가 막아 새 바이트를 덮지 않고 충돌로 남는다
    mode = 'accept-after-external';
    await overwriteButton(page).click();
    await until(async () => (await writes(app)).length === 1, '쓰기 시도가 기록되지 않았다');
    const stale = (await writes(app))[0]!;
    assert.equal(stale.status, 'conflict', '확인 대상 이후 바뀐 디스크는 해시 검사에서 충돌이다');
    await overwriteButton(page).waitFor({ timeout: 15_000 });
    assert.ok((await readFile(path, 'utf8')) === external2, '새 외부 바이트를 조용히 덮지 않았다');
    assert.equal(await editor(page).getByText('Alpha text MINE', { exact: true }).count(), 1, '내 본문은 화면에 남아 있다');

    // 3) 수락(디스크가 그대로): 기존 해시 쓰기 경로를 한 번 실행해 내 본문을 저장한다
    mode = 'accept';
    const before = (await writes(app)).length;
    await overwriteButton(page).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    const calls = await writes(app);
    assert.equal(calls.length, before + 1, '수락하면 저장 요청이 정확히 한 번이다');
    assert.equal(calls[calls.length - 1]!.status, 'saved');
    assert.notEqual(calls[calls.length - 1]!.expected, stale.expected, '확인 대상 해시는 그 시점에 알려진 새 디스크의 해시다 (강제 쓰기·무조건 허용이 아니다)');
    assert.ok((await readFile(path, 'utf8')) === doc('Alpha text MINE'), '내 본문이 BOM·CRLF·frontmatter와 함께 저장됐다');
    assert.equal(asked.length, 3, '매번 확인은 한 번씩만 물었다');
  } finally {
    mode = 'accept';
    await closeWindow(app);
  }
});

async function until(ok: () => Promise<boolean>, what: string) {
  for (let n = 0; n < 600 && !(await ok()); n++) await new Promise((r) => setTimeout(r, 25));
  assert.equal(await ok(), true, what);
}
