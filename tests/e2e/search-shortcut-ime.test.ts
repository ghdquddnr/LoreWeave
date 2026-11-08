// 한글 조합 중 전역 검색 단축키(Ctrl+Shift+F)는 검색창으로 포커스를 옮기지 않는다. 조합이 끝난 뒤의 일반 단축키는 기존대로 검색창을 선택·포커스한다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 조합은 CDP Input.imeSetComposition(Chromium 입력 경로)이고 단축키는 Playwright keyboard(실제 키 이벤트 경로)다.
// 단축키 keydown이 조합으로 전달됐는지(isComposing 또는 keyCode 229)를 페이지의 캡처 리스너로 직접 기록해 확인한다: 전달되지 않았다면 이 검사는 조합 중 단축키를 본 것이 아니다.
// main의 chapters:search·chapter:write 호출 수를 센다. 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 저장되는 경합을 없앤다(의도한 저장은 Ctrl+S로만).
// 합성 Electron/CDP이며 실제 OS IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { searches: number; writes: number } }).c);
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return { searchbox: el?.getAttribute('aria-label') === '원고 검색', inEditor: !!el?.closest?.('.ProseMirror'), start: el?.selectionStart ?? -1, end: el?.selectionEnd ?? -1 };
  });
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('조합 중 Ctrl+Shift+F는 검색창으로 포커스를 옮기지 않고 검색·저장도 만들지 않으며, 조합이 끝난 뒤 일반 단축키는 검색창을 선택한다', { timeout: 90_000 }, async () => {
  const dir = await tempDir('search-shortcut-ime');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('search-shortcut-ime-ud'));
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
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
      window.__keys = [];
      window.addEventListener('keydown', (e) => { if (e.shiftKey && e.key.toLowerCase() === 'f') window.__keys.push({ composing: e.isComposing, code: e.keyCode }); }, true);
    })()`);
    const cdp = await page.context().newCDPSession(page);

    // 검색창에 기존 검색어를 둔다 (포커스·선택 변화를 관측하기 위해). 검색은 시작하지 않는다
    await box(page).fill('알파');

    // 편집기에서 조합을 시작하고 (미저장 입력 + 조합 중 글자), 그 상태에서 전역 검색 단축키를 누른다
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    const before = await counts(app);
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    const keys = (await page.evaluate('window.__keys')) as { composing: boolean; code: number }[];
    assert.ok(keys.length >= 1 && keys.every((k) => k.composing || k.code === 229), `단축키 keydown이 조합으로 전달됐다: ${JSON.stringify(keys)}`);
    const during = await active(page);
    assert.equal(during.searchbox, false, '조합 중 단축키가 검색창으로 포커스를 옮기지 않았다');
    assert.equal(during.inEditor, true, '포커스는 편집기에 남아 있다');
    assert.equal(await box(page).inputValue(), '알파', '검색어는 그대로다');
    const afterShortcut = await counts(app);
    assert.equal(afterShortcut.searches, before.searches, '조합 중 단축키가 검색을 만들지 않았다');
    assert.equal(afterShortcut.writes, before.writes, '조합 중 단축키가 저장(flush)을 만들지 않았다 (관측 구간)');

    // 조합 확정: 글자는 편집기에 들어간다
    await page.keyboard.insertText('마');
    await page.locator('.ProseMirror').getByText('Alpha text X마', { exact: true }).waitFor();

    // 조합이 끝난 뒤 일반 단축키: 검색창으로 포커스가 가고 기존 검색어 전체가 선택된다 (기존 동작)
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    const after = await active(page);
    assert.equal(after.searchbox, true, '조합이 끝난 뒤 일반 단축키는 검색창으로 포커스를 옮긴다');
    assert.deepEqual([after.start, after.end], [0, 2], '기존 검색어가 선택된다 (select)');
    assert.equal((await counts(app)).searches, before.searches, '단축키만으로 검색은 시작되지 않는다');

    // 이후 정상 단축키: 편집기로 돌아가 Ctrl+S는 의도한 저장을 한다 (BOM·CRLF·frontmatter와 기존 글자 보존)
    await page.locator('.ProseMirror').getByText('Alpha text X마').click();
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal((await counts(app)).writes, before.writes + 1, '의도한 저장 한 건');
    assert.ok((await readFile(path, 'utf8')) === ONE.replace('Alpha text', 'Alpha text X마'), '저장된 원고는 BOM·CRLF·frontmatter와 기존 글자를 보존한다');
  } finally {
    await closeWindow(app);
  }
});
