// 명령 팔레트: 목록이 실제로 넘치는(overflow) 창 크기에서 ArrowUp/Down(첫·끝 순환 포함)으로 고른 항목과 필터로 바뀐 선택이 목록의 보이는 영역 안에 있고,
// 입력란(combobox) 포커스·페이지 스크롤은 그대로이며, Enter는 보이는 선택 명령만 실행하고 Escape는 원고 선택으로 돌아온다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 App. 창은 900x650으로 줄여 실제 overflow(clientHeight < scrollHeight)를 만든다. Playwright 실제 키. 수동 GUI·실제 OS 입력 확인이 아니다.
// chapter:write 진입 계수와 디스크 바이트로 팔레트 이동·Escape가 원고를 쓰지 않음을 본다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const writes = async (app: ElectronApplication) => (await app.evaluate(() => (globalThis as unknown as { c: { writes: number } }).c)).writes;
const palette = (page: Page) =>
  page.evaluate(() => {
    const ul = document.getElementById('palette-list') as HTMLElement;
    const input = document.querySelector('input[aria-label="명령 검색"]') as HTMLInputElement;
    const id = input.getAttribute('aria-activedescendant');
    const li = id ? document.getElementById(id) : null;
    const u = ul.getBoundingClientRect();
    const r = li?.getBoundingClientRect();
    return {
      overflow: ul.clientHeight < ul.scrollHeight,
      scrollTop: ul.scrollTop,
      active: id,
      label: li?.querySelector('.palette-label')?.textContent ?? null,
      disabled: li?.getAttribute('aria-disabled') === 'true',
      visible: !!r && r.top >= u.top - 0.5 && r.bottom <= u.bottom + 0.5,
      inputFocused: document.activeElement === input,
      pageScroll: (document.scrollingElement?.scrollTop ?? 0) + window.scrollY,
      inputValue: input.value,
    };
  });

test('팔레트의 키보드 선택은 넘치는 목록에서도 보이는 영역 안에 있고, Enter·Escape 의미는 그대로다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('palette-keyboard-scroll');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('palette-keyboard-scroll-ud'));
  try {
    await app.evaluate(({ ipcMain, BrowserWindow }) => {
      const g = globalThis as unknown as { c: { writes: number } };
      g.c = { writes: 0 };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('chapter:write')!;
      handlers.set('chapter:write', async (...args: unknown[]) => {
        g.c.writes++;
        return original(...args);
      });
      BrowserWindow.getAllWindows()[0]!.setSize(900, 650);
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    const base = await writes(app);
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');

    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor();
    const first = await palette(page);
    assert.equal(first.overflow, true, `이 창 크기에서 목록이 실제로 넘친다: ${JSON.stringify(first)}`);
    assert.equal(first.visible, true, '처음 선택은 보인다');
    const count = await page.locator('#palette-list li[role="option"]:not([aria-disabled="true"])').count();
    assert.ok(count >= 3);

    // 끝 순환: 첫 항목에서 ArrowUp → 마지막 enabled 항목이 보인다
    await page.keyboard.press('ArrowUp');
    const last = await palette(page);
    assert.equal(last.disabled, false, 'disabled 항목은 건너뛴다');
    assert.equal(last.visible, true, `끝으로 순환한 선택이 목록 안에 보인다: ${JSON.stringify(last)}`);
    assert.ok(last.scrollTop > 0, '목록이 스크롤됐다');
    assert.equal(last.inputFocused, true, 'combobox 포커스 유지');
    assert.equal(last.pageScroll, 0, '페이지 전체가 튀지 않았다');

    // 첫 순환: ArrowDown → 첫 항목이 보이고 위로 돌아온다
    await page.keyboard.press('ArrowDown');
    const wrapped = await palette(page);
    assert.equal(wrapped.visible, true);
    assert.equal(wrapped.scrollTop, 0, '첫 항목으로 순환하면 목록 맨 위로 돌아온다');
    assert.equal(wrapped.label, first.label);

    // 한 칸씩 끝까지 내려가며 매번 보인다
    for (let i = 1; i < count; i += 1) {
      await page.keyboard.press('ArrowDown');
      const s = await palette(page);
      assert.equal(s.visible, true, `${i}번째 ArrowDown 선택(${s.label})이 보인다`);
      assert.equal(s.disabled, false);
    }
    // 다시 위로 한 칸씩 (ArrowUp)
    for (let i = 0; i < count - 1; i += 1) {
      await page.keyboard.press('ArrowUp');
      assert.equal((await palette(page)).visible, true, `ArrowUp ${i + 1}번째 선택이 보인다`);
    }

    // 필터: 스크롤을 내린 뒤 필터를 바꾸면 새 선택이 보인다
    await page.keyboard.press('ArrowUp'); // 끝으로
    assert.ok((await palette(page)).scrollTop > 0);
    await page.keyboard.type('테마');
    const filtered = await palette(page);
    assert.equal(filtered.inputValue, '테마', '입력이 유지된다');
    assert.equal(filtered.visible, true, `필터 뒤 선택이 보인다: ${JSON.stringify(filtered)}`);
    assert.equal(filtered.inputFocused, true);

    // Enter: 보이는 선택 명령만 실행하고 팔레트가 닫힌다 (테마 명령은 설정 저장이며 원고를 쓰지 않는다)
    await page.keyboard.press('Enter');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor({ state: 'detached' });
    // 테마 명령이 연 대화상자(있으면)는 취소로 닫는다: 기존 경로가 실행됐음의 관측이며 원고와 무관하다
    await page.locator('[role="dialog"][aria-modal="true"]').first().waitFor({ timeout: 5000 });
    await page.keyboard.press('Escape');
    await page.locator('[role="dialog"][aria-modal="true"]').first().waitFor({ state: 'detached', timeout: 5000 });

    // Escape: 다시 열어 끝으로 이동한 뒤 취소하면 원고 선택으로 돌아온다
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor();
    await page.keyboard.press('ArrowUp');
    assert.equal((await palette(page)).visible, true);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '명령 팔레트' }).waitFor({ state: 'detached' });
    await page.waitForFunction(() => !!document.activeElement?.closest('.ProseMirror'), undefined, { timeout: 5000 });

    assert.equal(await writes(app), base, '팔레트 이동·Escape·테마 명령은 원고를 쓰지 않았다 (진입 계수)');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트(BOM·CRLF·frontmatter)는 그대로다');
  } finally {
    await closeWindow(app);
  }
});
