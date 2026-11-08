// 모달(환경설정·명령 팔레트·AI 실행 확인)이 열려 있는 동안 전역 검색 단축키 Ctrl+Shift+F는 뒤쪽 검색창으로 포커스를 옮기지 않는다. 모달을 닫은 뒤의 일반 단축키는 기존대로 검색창을 선택한다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·가짜 OpenAI 서버(무료, 요청 수만 센다). 단축키는 Playwright 실제 키 이벤트 경로이고 합성 KeyboardEvent가 아니다. 실제 OS IME·수동 GUI 확인이 아니다.
// main의 chapters:search·chapter:write 호출 수를 센다(진입 계수). 편집기는 깨끗하게 두므로 단축키 구간의 변화 0만 본다(전체 쓰기 0을 주장하지 않는다). 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { startFakeOpenAi, type FakeOpenAi } from './fake-openai.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
let fake: FakeOpenAi;
before(async () => {
  fake = await startFakeOpenAi(() => ({ summary: '요약', entities: [], facts: [] }));
});
after(async () => {
  await fake.close();
});

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { searches: number; writes: number } }).c);
const box = (page: Page) => page.getByRole('searchbox', { name: '원고 검색' });
const active = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return {
      searchbox: el?.getAttribute('aria-label') === '원고 검색',
      inModal: !!el?.closest?.('[role="dialog"][aria-modal="true"]'),
      start: el?.selectionStart ?? -1,
      end: el?.selectionEnd ?? -1,
      value: el?.value ?? '',
    };
  });
const modals = (page: Page) => page.locator('[role="dialog"][aria-modal="true"]').count();
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('모달이 열려 있는 동안 Ctrl+Shift+F는 검색창으로 포커스를 옮기지 않고, 닫은 뒤에는 기존대로 검색창을 선택한다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('search-shortcut-modal');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('search-shortcut-modal-ud'), { OPENAI_BASE_URL: fake.baseUrl });
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
    await page.evaluate(() => window.loreweave.ai.setKey('sk-search-shortcut-modal'));
    await box(page).fill('알파'); // 포커스·선택 변화를 관측할 기존 검색어 (검색은 시작하지 않는다)
    const base = await counts(app);
    const requestsBase = fake.requests.length;

    // 1) 환경설정: 단축키가 포커스를 검색창으로 옮기지 않고 모달이 남으며, Tab이 모달 안에 머물고, Escape로 닫힌다
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.waitFor();
    const before1 = await active(page);
    assert.equal(before1.inModal, true, '열린 모달 안에 포커스가 있다');
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    const during1 = await active(page);
    assert.equal(during1.searchbox, false, '환경설정이 열린 동안 단축키가 검색창으로 포커스를 옮기지 않았다');
    assert.equal(during1.inModal, true, '포커스는 모달 안에 남아 있다');
    assert.equal(await modals(page), 1, '모달은 그대로 열려 있다');
    await page.keyboard.press('Tab');
    assert.equal((await active(page)).inModal, true, '단축키 뒤에도 Tab이 모달 안에 머문다');
    // (Shift+Tab이 설정 모달 밖으로 새는 기존 동작은 이 검사의 범위가 아니다: 이 변경 전과 같다)
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
    assert.equal(await modals(page), 0, 'Escape로 정상 닫힌다');

    // 2) 닫은 뒤 일반 단축키: 검색창으로 포커스가 가고 기존 검색어가 선택된다
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    const after1 = await active(page);
    assert.equal(after1.searchbox, true, '모달을 닫은 뒤 단축키는 검색창으로 포커스를 옮긴다');
    assert.deepEqual([after1.start, after1.end], [0, 2], '기존 검색어가 선택된다');
    await page.locator('.ProseMirror').getByText('Alpha text').click();

    // 3) 명령 팔레트: 필터 입력 내용이 보존되고 포커스가 팔레트 입력에 남으며, Escape로 닫힌다
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: '명령 팔레트' });
    await palette.waitFor();
    await page.keyboard.type('환경');
    const typed = await active(page);
    assert.equal(typed.value, '환경', '팔레트 필터 입력');
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    const during2 = await active(page);
    assert.equal(during2.searchbox, false, '팔레트가 열린 동안 단축키가 검색창으로 포커스를 옮기지 않았다');
    assert.equal(during2.inModal, true);
    assert.equal(during2.value, '환경', '필터 입력 내용이 보존된다');
    assert.equal(await modals(page), 1);
    await page.keyboard.press('Escape');
    await palette.waitFor({ state: 'detached' });

    // 4) AI 실행 확인: 단축키가 포커스를 옮기지 않고, 동의·AI 실행(가짜 서버 요청)이 없으며, 취소로 닫힌다
    await page.getByRole('button', { name: '이 화 분석', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'AI 실행 확인' });
    await confirm.waitFor();
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    const during3 = await active(page);
    assert.equal(during3.searchbox, false, 'AI 실행 확인이 열린 동안 단축키가 검색창으로 포커스를 옮기지 않았다');
    assert.equal(during3.inModal, true);
    assert.equal(fake.requests.length, requestsBase, '단축키만으로 AI 요청이 나가지 않았다');
    await confirm.getByRole('button', { name: '취소' }).click();
    await confirm.waitFor({ state: 'detached' });
    assert.equal(fake.requests.length, requestsBase, '취소 뒤에도 AI 요청 0');

    // 모달이 모두 닫힌 뒤 일반 단축키는 다시 검색창을 선택한다
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('Control+Shift+F');
    await settled(page);
    assert.equal((await active(page)).searchbox, true, '모든 모달을 닫은 뒤 단축키는 기존대로 동작한다');

    // 단축키 구간에서 검색 요청·저장(flush) 진입이 없었고, 원고는 그대로다
    const end = await counts(app);
    assert.equal(end.searches, base.searches, '단축키만으로 검색 요청이 없었다 (진입 계수)');
    assert.equal(end.writes, base.writes, '단축키 구간에 저장 진입이 없었다 (진입 계수, 깨끗한 편집기)');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트는 BOM·CRLF·frontmatter와 기존 글자 그대로다');
  } finally {
    await closeWindow(app);
  }
});
