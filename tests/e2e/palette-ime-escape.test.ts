// 명령 팔레트: 한글 조합 취소용 Escape는 팔레트를 닫지 않고 필터·선택·원고를 지우지 않으며, compositionend 뒤의 일반 Escape는 정상 닫힘(원고 선택 복귀)이다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 조합 구간은 (a) CDP Input.imeSetComposition + Playwright 실제 키, (b) 합성 composition/KeyboardEvent(isComposing:true) 이벤트 경계 두 가지다.
// 합성 Electron이며 실제 OS IME·수동 GUI 확인이 아니다. chapters:search·chapter:write 진입 계수로 검색·원고 쓰기 0을 본다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '\uFEFF---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { searches: number; writes: number } }).c);
const palettes = (page: Page) => page.locator('[role="dialog"][aria-label="명령 팔레트"]').count();
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const filter = (page: Page) => page.getByRole('combobox', { name: '명령 검색' });

test('팔레트의 조합 취소 Escape는 팔레트를 닫지 않고, 조합이 끝난 뒤 일반 Escape는 닫으며 원고 선택으로 돌아온다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('palette-ime-escape');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('palette-ime-escape-ud'));
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
    const cdp = await page.context().newCDPSession(page);

    // (a) CDP 조합 + 실제 Playwright Escape
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor();
    await page.keyboard.type('환경');
    await page.evaluate(`(() => { window.__esc = []; window.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.__esc.push({ composing: e.isComposing, code: e.keyCode, prevented: false }); }, true); })()`);
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    await page.keyboard.press('Escape');
    await settled(page);
    const esc = (await page.evaluate('window.__esc')) as { composing: boolean; code: number }[];
    assert.ok(esc.length >= 1 && esc.every((k) => k.composing || k.code === 229), `Escape keydown이 조합으로 전달됐다: ${JSON.stringify(esc)}`);
    assert.equal(await palettes(page), 1, '조합 중 Escape가 팔레트를 닫지 않았다 (CDP 조합)');
    const kept = await filter(page).inputValue();
    assert.ok(kept.startsWith('환경'), `필터 입력이 지워지지 않았다 (조합 글자는 표시될 수 있다): ${kept}`);
    await page.keyboard.insertText('감'); // 조합 확정
    const typed = await filter(page).inputValue();
    assert.ok(typed.startsWith('환경'));

    // (b) 합성 composition/KeyboardEvent 이벤트 경계
    await page.evaluate(`(() => {
      const el = document.querySelector('input[aria-label="명령 검색"]');
      el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      const k = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true });
      el.dispatchEvent(k);
      window.__prevented = k.defaultPrevented;
    })()`);
    assert.equal(await palettes(page), 1, '합성 isComposing:true Escape가 팔레트를 닫지 않았다');
    assert.equal(await page.evaluate('window.__prevented'), false, 'IME의 기본 동작(조합 취소)을 막지 않는다');
    assert.equal(await filter(page).inputValue(), typed, '필터 입력이 그대로다');
    // compositionstart~end 구간 안의 isComposing 없는 Escape도 팔레트를 닫지 않는다
    await page.evaluate(`document.querySelector('input[aria-label="명령 검색"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))`);
    assert.equal(await palettes(page), 1, 'compositionstart~end 구간의 Escape가 팔레트를 닫지 않았다');
    // 조합 중 Enter는 여전히 실행하지 않는다 (기존 보호)
    await page.evaluate(`document.querySelector('input[aria-label="명령 검색"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true }))`);
    assert.equal(await palettes(page), 1, '조합 중 Enter는 실행하지 않는다');

    // compositionend 뒤 일반 Escape: 정상 닫힘, 원고 선택·내용 복귀
    await page.evaluate(`document.querySelector('input[aria-label="명령 검색"]').dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }))`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => !!document.activeElement?.closest('.ProseMirror')), true, '닫으면 원고로 포커스가 돌아온다');

    // 조합 뒤 일반 Enter는 실행한다 (기존 동작): 다시 열어 '환경' 입력 후 Enter → 환경설정
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor();
    await page.keyboard.type('환경');
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '환경설정' }).waitFor();
    await page.keyboard.press('Escape');

    const end = await counts(app);
    assert.equal(end.searches, base.searches, '조합 Escape만으로 검색 요청이 없었다 (진입 계수)');
    assert.equal(end.writes, base.writes, '저장 진입이 없었다 (진입 계수, 깨끗한 편집기)');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 BOM·CRLF·frontmatter와 기존 글자 그대로다');
  } finally {
    await closeWindow(app);
  }
});
