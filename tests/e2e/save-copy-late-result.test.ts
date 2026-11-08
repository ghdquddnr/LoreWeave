// 저장 실패 [본문 복사]의 대기 응답이 화를 옮긴 뒤 새 화의 복사 결과를 오염시키지 않는지 본다 (save-error-copy의 즉시 resolve/reject 대역이 직접 보지 못한 경계).
// 합성 A/B 원고·격리 userData. 저장 실패는 main의 chapter:write 처리기 대역(무료 IPC), 클립보드는 renderer의 navigator.clipboard.writeText 대역으로 호출별 명시 settle을 쓴다.
// 화를 떠날 때의 저장 실패 확인 창은 의도적으로 수락한다 (합성 입력만 버린다). 합성 Electron 검사이며 실제 OS 클립보드·수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.
// 자동 재시도(5초)가 계속 쓰기를 시도하므로 쓰기 호출 수는 판정하지 않는다. 판정하는 것은 복사 호출 수·안내·본문·디스크 바이트다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const A_FILE = `${envelope('a', 'AAA')}Alpha text\r\n`;
const B_FILE = `${envelope('b', 'BBB')}Beta text\r\n`;

interface Clip {
  auto: 'ok' | 'fail' | 'hold';
  calls: { text: string; settle(ok: boolean): void }[];
}
const editor = (page: Page) => page.locator('.ProseMirror');
const bar = (page: Page) => page.locator('footer.statusbar');
const copyButton = (page: Page) => bar(page).getByRole('button', { name: '본문 복사', exact: true });
const note = (page: Page) => bar(page).locator('.copy-note');
const setAuto = (page: Page, auto: Clip['auto']) => page.evaluate((a) => void ((window as unknown as { __clip: Clip }).__clip.auto = a), auto);
const texts = (page: Page) => page.evaluate(() => (window as unknown as { __clip: Clip }).__clip.calls.map((c) => c.text));
const settle = (page: Page, i: number, ok: boolean) => page.evaluate(([i, ok]) => (window as unknown as { __clip: Clip }).__clip.calls[i as number]!.settle(ok as boolean), [i, ok] as const);
/** settle 뒤 renderer의 마이크로태스크·React 렌더가 끝난 것으로 본다 */
const rendered = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  const a = join(dir, 'chapters', '001.md');
  const b = join(dir, 'chapters', '002.md');
  await writeFile(a, A_FILE);
  await writeFile(b, B_FILE);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await app.evaluate(({ ipcMain }) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers;
    handlers.set('chapter:write', async () => {
      throw Object.assign(new Error('EACCES: permission denied (synthetic)'), { code: 'EACCES' });
    });
  });
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'AAA').click();
  await editor(page).getByText('Alpha text').waitFor();
  await page.evaluate(`(() => {
    const clip = { auto: 'hold', calls: [] };
    window.__clip = clip;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (text) =>
        new Promise((resolve, reject) => {
          clip.calls.push({ text, settle: (ok) => (ok ? resolve() : reject(new Error('NotAllowedError (synthetic)'))) });
          if (clip.auto === 'ok') resolve();
          else if (clip.auto === 'fail') reject(new Error('NotAllowedError (synthetic)'));
        }),
    });
  })()`);
  return { app, page, a, b };
}

for (const late of [true, false]) {
  test(`A의 보류된 복사 응답이 화 이동 뒤 ${late ? '성공' : '실패'}로 늦게 와도 B의 복사 결과·본문·저장 실패 안내는 그대로다`, { timeout: 120_000 }, async () => {
    const { app, page, a, b } = await start(`scl-${late ? 'ok' : 'fail'}`);
    page.on('dialog', (d) => void d.accept()); // 저장 실패 중 화 이동의 '변경 버림' 확인: 합성 입력만 버린다
    try {
      // A: 저장 실패 → 복사 클릭 → 응답 보류
      await editor(page).getByText('Alpha text').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' A');
      await page.keyboard.press('Control+S');
      await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
      await copyButton(page).click();
      await note(page).getByText('복사하는 중').waitFor();
      assert.ok(((await texts(page)).length === 1) && (await texts(page))[0] === 'Alpha text A', 'A의 복사 본문');

      // A를 떠나 B를 연다 (확인 창 수락)
      await chapter(page, 'BBB').click();
      await editor(page).getByText('Beta text').waitFor({ timeout: 15_000 });
      assert.equal(await editor(page).getByText('Alpha text', { exact: false }).count(), 0, 'A 본문이 B에 보이지 않는다');
      assert.equal(await note(page).count(), 0, '이전 A의 복사 중 안내가 B에 남지 않는다');

      // B: 저장 실패 → 복사 → 먼저 확정(성공)
      await editor(page).getByText('Beta text').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' B');
      await page.keyboard.press('Control+S');
      await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
      await setAuto(page, 'ok');
      await copyButton(page).click();
      await note(page).getByText('본문 글자만 복사했습니다').waitFor();
      assert.equal((await texts(page)).length, 2);
      assert.ok((await texts(page))[1] === 'Beta text B', 'B의 복사 본문');
      const shown = await bar(page).innerText();

      // A의 오래된 응답을 풀고 처리가 끝나게 한다
      await settle(page, 0, late);
      await rendered(page);
      assert.ok((await bar(page).innerText()) === shown, 'A의 늦은 응답이 B의 상태줄(복사 결과·저장 실패 이유)을 바꾸지 않았다');
      assert.equal((await texts(page)).length, 2, '오래된 응답 때문에 추가 복사 요청이 생기지 않았다');
      assert.equal(await editor(page).getByText('Beta text B', { exact: true }).count(), 1, 'B 본문 유지');
      assert.ok(/저장 실패/.test(shown) && !/저장됨/.test(shown), 'B는 저장 실패 상태');
      assert.ok((await readFile(a, 'utf8')) === A_FILE, 'A 디스크 바이트 불변');
      assert.ok((await readFile(b, 'utf8')) === B_FILE, 'B 디스크 바이트 불변');
    } finally {
      await closeWindow(app);
    }
  });
}
