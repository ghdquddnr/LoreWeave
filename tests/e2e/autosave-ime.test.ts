// 원고의 IME 조합 중에는 자동저장 타이머가 미확정 조합 글자를 디스크에 쓰지 않는다. 조합이 확정·취소된 뒤에는 추가 입력 없이 기존 정책으로 자동 저장되고, 이전 조합이 이후 자동저장을 막지 않는다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 App/편집기. 조합은 CDP Input.imeSetComposition/insertText(실제 Chromium 입력 경로)이며 실제 OS IME·수동 GUI 확인이 아니다.
// 자동저장 타이머는 가로채 막지 않는다(실제 1500ms 타이머가 그대로 돈다). 대신 renderer의 setTimeout을 감싸 delay 1500 콜백이 실제로 실행된 횟수만 기록해, 임의 sleep 없이 "타이머가 조합 중에 이미 발화했다"를 관측한다.
// main의 chapter:write 진입 계수와 디스크 내용으로 저장 여부를 본다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const writes = async (app: ElectronApplication) => (await app.evaluate(() => (globalThis as unknown as { c: { writes: number } }).c)).writes;
const fired = (page: Page) => page.evaluate('window.__fired') as Promise<number>;
/** 한정된 횟수까지 조건을 기다린다 (무한 대기·임의 sleep 아님) */
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 150; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

test('조합 중 자동저장 타이머는 미확정 글자를 쓰지 않고, 확정·취소 뒤에는 추가 입력 없이 자동 저장되며 다음 조합 주기에도 같다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('autosave-ime');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('autosave-ime-ud'));
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { c: { writes: number } };
      g.c = { writes: 0 };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('chapter:write')!;
      handlers.set('chapter:write', async (...args: unknown[]) => {
        g.c.writes++;
        return original(...args);
      });
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    // 자동저장 타이머(delay 1500)의 실제 발화만 센다 (막지 않는다)
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.__fired = 0;
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? real(() => { window.__fired++; fn(); }, delay, ...rest) : real(fn, delay, ...rest));
    })()`);
    const cdp = await page.context().newCDPSession(page);
    const base = await writes(app);

    // 주기 1: 입력 뒤 조합을 시작하고 타이머가 조합 중에 발화하게 둔다
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    const firedBefore = await fired(page);
    await until('조합 중 타이머 발화', async () => (await fired(page)) > firedBefore);
    assert.equal(await writes(app), base, '조합 중 발화한 자동저장 타이머가 저장(chapter:write)을 시작하지 않았다');
    assert.ok((await readFile(path, 'utf8')) === ONE, '조합 중에는 디스크가 그대로다');

    // 확정: 추가 입력 없이 자동 저장된다 (조합 글자 포함)
    await page.keyboard.insertText('감');
    await until('확정 뒤 자동 저장', async () => (await writes(app)) === base + 1);
    assert.ok((await readFile(path, 'utf8')) === ONE.replace('Alpha text', 'Alpha text X감'), '확정 뒤 자동 저장: BOM·CRLF·frontmatter와 기존 글자 보존');

    // 주기 2 (이전 조합이 이후 자동저장을 막지 않는다): 입력 → 조합 → 타이머 발화(저장 없음) → 취소 → 추가 입력 없이 자동 저장, 취소된 글자는 남지 않는다
    await page.keyboard.type(' Y');
    await cdp.send('Input.imeSetComposition', { text: '값', selectionStart: 1, selectionEnd: 1 });
    const firedBefore2 = await fired(page);
    await until('두 번째 조합 중 타이머 발화', async () => (await fired(page)) > firedBefore2);
    assert.equal(await writes(app), base + 1, '두 번째 조합 중에도 저장하지 않았다');
    assert.ok((await readFile(path, 'utf8')).includes('값') === false, '조합 중 글자가 디스크에 없다');
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); // 조합 취소
    await until('취소 뒤 자동 저장', async () => (await writes(app)) === base + 2);
    const saved = await readFile(path, 'utf8');
    assert.ok(saved === ONE.replace('Alpha text', 'Alpha text X감 Y'), `취소된 글자는 남지 않고 BOM·CRLF·frontmatter·기존 글자가 보존된다: ${JSON.stringify(saved)}`);
  } finally {
    await closeWindow(app);
  }
});
