// 환경설정: 입력(API 키 입력란)의 조합 취소용 Escape는 대화상자를 닫지 않고 입력 초안을 지우지 않으며 IME 기본 동작을 막지 않는다. compositionend 뒤 일반 Escape는 닫고 연 버튼으로 포커스가 돌아온다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 조합 구간은 합성 composition/KeyboardEvent(isComposing:true, keyCode 229) 이벤트 경계이고 CDP 조합 + Playwright 실제 키도 함께 본다.
// 입력 초안은 가짜 값이며 저장하지 않는다(setKey·연결 확인을 실행하지 않는다). 합성 Electron이며 실제 OS IME·수동 GUI 확인이 아니다.
// ai:set-key·ai:delete-key·chapters:search·chapter:write 진입 계수로 키 저장·삭제·검색·원고 쓰기 0을 본다(초기 상태 조회는 계수 대상이 아니다). 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const DRAFT = 'synthetic-draft-no-key';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: Record<string, number> }).c);
const dialogs = (page: Page) => page.locator('[role="dialog"][aria-label="환경설정"]').count();
const run = (page: Page, code: string) => page.evaluate(`(() => { const el = document.querySelector('input[type="password"]'); ${code} })()`);

test('설정의 조합 취소 Escape는 대화상자를 닫지 않고 초안을 보존하며, 조합이 끝난 뒤 일반 Escape는 닫고 포커스가 돌아온다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('settings-ime-escape');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('settings-ime-escape-ud'));
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { c: Record<string, number> };
      g.c = { searches: 0, writes: 0, setKey: 0, deleteKey: 0 };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      for (const [channel, key] of [['chapters:search', 'searches'], ['chapter:write', 'writes'], ['ai:set-key', 'setKey'], ['ai:delete-key', 'deleteKey']] as const) {
        const original = handlers.get(channel);
        if (!original) throw new Error(`채널 없음: ${channel}`);
        handlers.set(channel, async (...args: unknown[]) => {
          g.c[key]!++;
          return original(...args);
        });
      }
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    const base = await counts(app);

    const opener = page.getByRole('button', { name: '설정', exact: true });
    await opener.focus();
    await opener.click();
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.waitFor();
    const key = settings.locator('input[type="password"]');
    await key.fill(DRAFT);
    await key.focus();

    // (b) 합성 이벤트 경계: isComposing:true 단독
    await run(page, `el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));`);
    await run(page, `const k = new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true, cancelable: true }); el.dispatchEvent(k); window.__p1 = k.defaultPrevented;`);
    assert.equal(await dialogs(page), 1, 'isComposing:true Escape가 대화상자를 닫지 않았다');
    assert.equal(await page.evaluate('window.__p1'), false, 'IME 기본 동작(조합 취소)을 막지 않는다');
    // compositionstart~end 구간의 isComposing 없는 Escape
    await run(page, `el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));`);
    assert.equal(await dialogs(page), 1, '조합 구간의 Escape가 대화상자를 닫지 않았다');
    assert.equal(await key.inputValue(), DRAFT, '입력 초안이 그대로다');
    await run(page, `el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));`);
    // keyCode 229 단독 (조합 구간 밖)
    await run(page, `const k = new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true }); el.dispatchEvent(k);`);
    assert.equal(await dialogs(page), 1, 'keyCode 229 Escape가 대화상자를 닫지 않았다');
    assert.equal(await key.inputValue(), DRAFT);

    // (a) CDP 조합 + 실제 Playwright Escape
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    await page.keyboard.press('Escape');
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
    assert.equal(await dialogs(page), 1, 'CDP 조합 중 실제 Escape가 대화상자를 닫지 않았다');
    assert.ok((await key.inputValue()).startsWith(DRAFT), '입력 초안이 지워지지 않았다 (조합 글자는 표시될 수 있다)');
    await page.keyboard.insertText('감'); // 조합 확정 (이후 일반 상태)

    // 조합이 끝난 뒤 일반 Escape: 정상 닫힘, 연 버튼으로 포커스 복귀 (이전 조합 이력이 막지 않는다)
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent), '설정', '닫으면 연 버튼으로 돌아온다');

    const end = await counts(app);
    for (const k of ['searches', 'writes', 'setKey', 'deleteKey']) assert.equal(end[k], base[k], `${k} 진입 0 (조합 Escape만으로)`);
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 BOM·CRLF·frontmatter와 기존 글자 그대로다');
  } finally {
    await closeWindow(app);
  }
});
