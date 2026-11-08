// 전역 Ctrl/Meta+K는 IME 소유 키(native isComposing:true 단독, keyCode 229 단독)를 가로채지 않는다: 팔레트가 열리지 않고 preventDefault도 하지 않으며 원고 포커스·선택·내용이 보존된다.
// IME가 끝난 뒤의 일반 Ctrl+K는 정상으로 열고(필터·실행·Escape 복귀) Ctrl+Shift+F의 기존 조합 보호도 그대로다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 App handler. 독립 사례는 합성 KeyboardEvent 경계이고(각각 isComposing 단독·keyCode 229 단독·Ctrl과 Meta), 일반 열기는 Playwright 실제 키다. 실제 OS IME·수동 GUI 확인이 아니다.
// chapters:search·chapter:write 진입 계수로 단축키만으로 검색·원고 쓰기 0을 본다(깨끗한 편집기; AI 실행 경로는 단축키로 열리지 않는다). 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { searches: number; writes: number } }).c);
const palettes = (page: Page) => page.locator('[role="dialog"][aria-label="명령 팔레트"]').count();
const focusState = (page: Page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    return { inEditor: !!document.activeElement?.closest('.ProseMirror'), text: document.querySelector('.ProseMirror')?.textContent ?? '', anchor: sel?.anchorOffset ?? -1, focus: sel?.focusOffset ?? -1 };
  });
/** window에 합성 keydown을 보내 App의 전역 handler가 받게 한다. 반환: defaultPrevented */
const fire = (page: Page, init: string) =>
  page.evaluate(`(() => { const k = new KeyboardEvent('keydown', { key: 'k', ${init}, bubbles: true, cancelable: true }); (document.activeElement ?? document.body).dispatchEvent(k); return k.defaultPrevented; })()`) as Promise<boolean>;

test('Ctrl/Meta+K의 IME 소유 키는 팔레트를 열지 않고 기본 동작을 막지 않으며, IME 밖의 일반 Ctrl+K는 정상으로 열린다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('palette-shortcut-ime');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('palette-shortcut-ime-ud'));
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { c: { searches: number; writes: number } };
      g.c = { searches: 0, writes: 0 };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      for (const [channel, key] of [['chapters:search', 'searches'], ['chapter:write', 'writes']] as const) {
        const original = handlers.get(channel)!;
        handlers.set(channel, async (...args: unknown[]) => {
          g.c[key]++;
          return original(...args);
        });
      }
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    const base = await counts(app);

    // 원고에 포커스와 선택을 둔다 (보존 여부를 관측)
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    const before = await focusState(page);
    assert.equal(before.inEditor, true);

    // 독립 사례: 각각 하나의 IME 신호만 (Ctrl과 Meta 모두)
    for (const mod of ['ctrlKey: true', 'metaKey: true']) {
      assert.equal(await fire(page, `${mod}, isComposing: true`), false, `${mod} + isComposing 단독: preventDefault하지 않는다`);
      assert.equal(await palettes(page), 0, `${mod} + isComposing 단독: 팔레트가 열리지 않았다`);
      assert.equal(await fire(page, `${mod}, keyCode: 229`), false, `${mod} + keyCode 229 단독: preventDefault하지 않는다`);
      assert.equal(await palettes(page), 0, `${mod} + keyCode 229 단독: 팔레트가 열리지 않았다`);
    }
    assert.deepEqual(await focusState(page), before, '원고 포커스·선택·내용이 그대로다');

    // 대조: IME 신호가 없는 합성 Ctrl+K는 기존대로 기본 동작을 막고 팔레트를 연다 (보호가 모든 Ctrl+K를 막지 않는다)
    assert.equal(await fire(page, 'ctrlKey: true'), true, '일반 Ctrl+K는 기본 동작을 막고');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor();
    // 열린 상태에서 Escape: 닫히고 원고 선택으로 복귀
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor({ state: 'detached' });
    await page.waitForFunction(() => !!document.activeElement?.closest('.ProseMirror'), undefined, { timeout: 5000 });
    assert.deepEqual(await focusState(page), before, 'Escape 뒤 원고 선택으로 돌아온다');

    // 일반 Playwright 실제 Ctrl+K: 열기·필터·Enter 실행(환경설정)·Escape
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor();
    await page.keyboard.type('환경');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '환경설정' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '환경설정' }).waitFor({ state: 'detached' });

    // Ctrl+Shift+F의 기존 조합 보호 유지: 조합 신호가 있으면 검색창으로 포커스를 옮기지 않는다
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.evaluate(`(() => { const k = new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, shiftKey: true, isComposing: true, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(k); })()`);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') === '원고 검색'), false, 'Ctrl+Shift+F 조합 보호가 유지된다');

    const end = await counts(app);
    assert.equal(end.searches, base.searches, '단축키만으로 검색 요청이 없었다 (진입 계수)');
    assert.equal(end.writes, base.writes, '저장 진입이 없었다 (진입 계수, 깨끗한 편집기)');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 BOM·CRLF·frontmatter와 기존 글자 그대로다');
  } finally {
    await closeWindow(app);
  }
});
