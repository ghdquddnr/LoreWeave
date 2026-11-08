// 환경설정 모달의 Tab 순환: 실제 Tab 정지점의 처음에서 Shift+Tab이 마지막 사용 가능한 요소로, 마지막에서 Tab이 처음으로 돌며 모달 밖으로 새지 않는다.
// 라디오 그룹은 선택된 하나만 Tab 정지점이라, 선택된 테마가 DOM의 첫 라디오와 다른 경우도 함께 본다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 설정 모달·Playwright 실제 키 이벤트(합성 KeyboardEvent 아님). 합성 Electron이며 실제 OS IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.
// 단순 Tab/Shift+Tab만으로 검색·원고 쓰기 진입이 없음을 chapters:search·chapter:write 진입 계수로 본다. 의도한 외관 저장(테마 선택)은 원고 저장이 아니라 설정 저장이다. API 키 입력은 합성 초안 값만 쓰고 저장하지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { searches: number; writes: number } }).c);
/** 포커스된 요소의 식별 (모달 안 요소의 DOM 순번)과 모달 안 여부 */
const where = (page: Page) =>
  page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-modal="true"]');
    const el = document.activeElement as HTMLElement | null;
    const all = dlg ? Array.from(dlg.querySelectorAll('*')) : [];
    return { inModal: !!dlg && !!el && dlg.contains(el), index: el ? all.indexOf(el) : -1, label: el?.getAttribute('aria-label') ?? el?.getAttribute('value') ?? el?.textContent?.slice(0, 16) ?? el?.tagName ?? '', tag: el?.tagName ?? '' };
  });

/** 모달에 처음 들어온 자리에서 Tab으로 한 바퀴 돌며 실제 정지점 순서를 기록한다 (모두 모달 안이어야 한다) */
async function walkStops(page: Page): Promise<number[]> {
  await page.evaluate(() => (document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement).focus()); // 대화상자 자체에서 시작해야 순환 구간의 처음이 진짜 처음이다
  const order: number[] = [];
  for (let i = 0; i < 80; i += 1) {
    await page.keyboard.press('Tab');
    const w = await where(page);
    assert.equal(w.inModal, true, `Tab ${i + 1}번째가 모달 안에 머문다 (${w.label})`);
    if (order.includes(w.index)) return order.slice(order.indexOf(w.index)); // 한 바퀴: 순환 구간
    order.push(w.index);
  }
  throw new Error('80번 안에 Tab 순환이 닫히지 않았다');
}

async function assertCycle(page: Page, label: string) {
  const cycle = await walkStops(page); // Tab 정지점의 순환 순서 (처음 → … → 마지막)
  assert.ok(cycle.length >= 3, `${label}: 정지점이 여러 개다`);
  const first = cycle[0]!;
  const last = cycle[cycle.length - 1]!;
  // 처음에서 Shift+Tab → 마지막
  await focusIndex(page, first);
  await page.keyboard.press('Shift+Tab');
  const back = await where(page);
  assert.equal(back.inModal, true, `${label}: 처음에서 Shift+Tab이 모달 밖으로 새지 않는다`);
  assert.equal(back.index, last, `${label}: 처음에서 Shift+Tab은 마지막 사용 가능한 요소로 순환한다`);
  // 마지막에서 Tab → 처음
  await page.keyboard.press('Tab');
  const fwd = await where(page);
  assert.equal(fwd.inModal, true, `${label}: 마지막에서 Tab이 모달 밖으로 새지 않는다`);
  assert.equal(fwd.index, first, `${label}: 마지막에서 Tab은 처음 요소로 순환한다`);
  // 모달에서 처음 들어온 자리(대화상자 자체)에서의 Shift+Tab도 마지막으로 돈다
  await page.evaluate(() => (document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement).focus());
  await page.keyboard.press('Shift+Tab');
  const fromDialog = await where(page);
  assert.equal(fromDialog.inModal, true, `${label}: 대화상자 자체에서 Shift+Tab이 모달 밖으로 새지 않는다`);
  assert.equal(fromDialog.index, last, `${label}: 대화상자 자체에서 Shift+Tab은 마지막 요소로 간다`);
  await page.evaluate(() => (document.querySelector('[role="dialog"][aria-modal="true"]') as HTMLElement).focus());
}
async function focusIndex(page: Page, index: number) {
  await page.evaluate((i) => {
    const dlg = document.querySelector('[role="dialog"][aria-modal="true"]')!;
    (Array.from(dlg.querySelectorAll('*'))[i] as HTMLElement).focus();
  }, index);
}

test('환경설정 모달: Shift+Tab이 마지막 요소로, 마지막의 Tab이 처음으로 순환하고(기본·DOM 첫 라디오와 다른 테마), 입력 내용·원고·Escape 복귀가 보존된다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('settings-reverse-tab');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('settings-reverse-tab-ud'));
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

    // 열기: 연 요소(활동 막대의 설정)에서 열고, 모달이 포커스를 받는다
    const opener = page.getByRole('button', { name: '설정', exact: true });
    await opener.focus();
    await opener.click();
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.waitFor();
    assert.equal((await where(page)).inModal, true);

    // 기본 선택 테마: 한 바퀴 순환
    await assertCycle(page, '기본 테마');

    // DOM의 첫 라디오가 아닌 테마(마지막 카드)를 고른다: 실제 Tab 진입점이 첫 라디오가 아니게 된다
    const themeRadios = settings.locator('input[name="theme"]');
    const total = await themeRadios.count();
    assert.ok(total >= 2);
    const checkedBefore = await settings.locator('input[name="theme"]:checked').evaluate((el) => (el.parentElement?.parentElement ? Array.from(el.closest('fieldset')!.querySelectorAll('input[name="theme"]')).indexOf(el) : -1));
    await themeRadios.nth(total - 1).check();
    await page.waitForFunction((n) => Array.from(document.querySelectorAll('input[name="theme"]'))[n]?.matches(':checked'), total - 1);
    assert.notEqual(total - 1, 0);
    assert.notEqual(checkedBefore, total - 1, '이전과 다른 라디오를 골랐다');
    await assertCycle(page, 'DOM 첫 라디오와 다른 테마');

    // 라디오 방향키로도 선택이 바뀐다 (기존 의미 유지)
    await themeRadios.nth(total - 1).focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction((n) => Array.from(document.querySelectorAll('input[name="theme"]'))[n]?.matches(':checked'), total - 2);

    // 합성 API 키 초안은 순환 뒤에도 그대로다 (저장하지 않는다)
    const keyInput = settings.locator('input[type="password"], input[type="text"]').first();
    if ((await keyInput.count()) > 0) {
      await keyInput.fill('sk-synthetic-draft');
      await assertCycle(page, '키 초안 입력 뒤');
      assert.equal(await keyInput.inputValue(), 'sk-synthetic-draft', '입력 초안이 보존된다');
    }

    // Escape: 정상 닫힘, 연 요소로 포커스 복귀
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent), '설정', '닫으면 연 요소로 돌아온다');

    // 단순 Tab 순환만으로 검색·원고 쓰기가 없었고 원고는 그대로다
    const end = await counts(app);
    assert.equal(end.searches, base.searches, 'Tab 순환만으로 검색 요청이 없었다 (진입 계수)');
    assert.equal(end.writes, base.writes, 'Tab 순환만으로 원고 저장 진입이 없었다 (진입 계수, 깨끗한 편집기; 외관 저장은 설정 저장이다)');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 BOM·CRLF·frontmatter와 기존 글자 그대로다');
  } finally {
    await closeWindow(app);
  }
});
