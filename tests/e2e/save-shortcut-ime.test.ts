// 전역 Ctrl/Meta+S는 IME 소유 keydown(native isComposing:true 단독, keyCode 229 단독)이면 명시적 저장(flush)을 하지 않고 preventDefault도 하지 않는다.
// 조합이 확정된 뒤의 일반 Ctrl+S는 기존 경로로 저장하며 BOM·CRLF·frontmatter와 기존 글자를 보존한다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 App handler. 독립 사례는 합성 KeyboardEvent 경계(Ctrl/Meta × isComposing 단독/229 단독)이고, CDP Input.imeSetComposition + Playwright 실제 키도 함께 본다(keydown의 isComposing 전달 여부를 캡처 리스너로 기록).
// 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 자동 저장 경합을 없앤다(제품 상태기계 복제 없음). chapter:write 진입 계수로 명시적 flush 0을 본다. 합성 Electron/CDP이며 실제 OS IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { searches: number; writes: number } }).c);
const state = (page: Page) =>
  page.evaluate(() => {
    const sel = window.getSelection();
    return { inEditor: !!document.activeElement?.closest('.ProseMirror'), text: document.querySelector('.ProseMirror')?.textContent ?? '', anchor: sel?.anchorOffset ?? -1, focus: sel?.focusOffset ?? -1 };
  });
/** 활성 요소에 합성 keydown을 보내 App의 전역 handler가 받게 한다. 반환: defaultPrevented (모든 버블링이 끝난 뒤의 값) */
const fire = (page: Page, init: string) =>
  page.evaluate(`(() => { const k = new KeyboardEvent('keydown', { key: 's', ${init}, bubbles: true, cancelable: true }); document.activeElement.dispatchEvent(k); return k.defaultPrevented; })()`) as Promise<boolean>;

test('Ctrl/Meta+S의 IME 소유 keydown은 저장(flush)을 하지 않고 기본 동작을 막지 않으며, 조합 확정 뒤 일반 Ctrl+S는 정상 저장한다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('save-shortcut-ime');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('save-shortcut-ime-ud'));
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
      window.__saveKeys = [];
      window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 's' && (e.ctrlKey || e.metaKey) && !e.__synthetic) window.__saveKeys.push({ composing: e.isComposing, code: e.keyCode }); }, true);
    })()`);
    const cdp = await page.context().newCDPSession(page);
    const base = await counts(app);

    // 미저장 입력을 둔다 (명시적 flush가 있으면 디스크에 쓰일 상태)
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    const before = await state(page);
    assert.ok(before.text.includes('Alpha text X') && before.inEditor);

    // 독립 합성 경계: Ctrl/Meta × (isComposing 단독, keyCode 229 단독). 어느 것도 저장·기본 동작 차단을 일으키지 않는다
    for (const mod of ['ctrlKey: true', 'metaKey: true']) {
      for (const sig of ['isComposing: true', 'keyCode: 229']) {
        assert.equal(await fire(page, `${mod}, ${sig}`), false, `${mod} + ${sig}: preventDefault하지 않는다`);
        assert.equal((await counts(app)).writes, base.writes, `${mod} + ${sig}: 명시적 저장(flush) 진입 0`);
      }
    }
    assert.deepEqual(await state(page), before, '포커스·선택·미저장 본문이 그대로다');
    assert.ok((await readFile(path, 'utf8')) === ONE, '디스크 원고는 그대로다');

    // CDP 조합 + 실제 Playwright Ctrl+S: keydown이 조합으로 전달됐는지 기록하고, 저장하지 않는다
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    await page.keyboard.press('Control+S');
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    const keys = (await page.evaluate('window.__saveKeys')) as { composing: boolean; code: number }[];
    assert.ok(keys.length >= 1 && keys.every((k) => k.composing || k.code === 229), `Ctrl+S keydown이 조합으로 전달됐다: ${JSON.stringify(keys)}`);
    assert.equal((await counts(app)).writes, base.writes, '조합 중 Ctrl+S는 명시적 저장을 만들지 않았다 (관측 구간)');
    assert.ok((await readFile(path, 'utf8')) === ONE, '조합 중에는 디스크에 쓰이지 않았다');

    // 조합 확정 뒤 일반 Ctrl+S: 기존 경로로 저장, BOM·CRLF·frontmatter와 기존 글자 보존
    await page.keyboard.insertText('감');
    await page.locator('.ProseMirror').getByText('Alpha text X감', { exact: true }).waitFor();
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal((await counts(app)).writes, base.writes + 1, '조합 확정 뒤 일반 Ctrl+S는 저장 한 건');
    assert.ok((await readFile(path, 'utf8')) === ONE.replace('Alpha text', 'Alpha text X감'), '저장된 원고는 BOM·CRLF·frontmatter와 기존 글자를 보존한다');
    assert.equal((await counts(app)).searches, base.searches, '검색 요청 0');
  } finally {
    await closeWindow(app);
  }
});
