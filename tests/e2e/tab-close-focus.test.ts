// 열린 화 탭을 키보드로 닫은 뒤 포커스가 BODY로 사라지지 않는다: 비활성 탭 닫기 → 현재 탭 버튼, 활성 탭 닫기 → 이웃 탭(또는 편집기), 마지막 탭 → 화 목록.
// 닫기를 거절하면(저장 실패 + 확인 취소) 탭·본문·포커스(닫기 버튼)가 그대로이고, 저장 응답을 기다리는 사이 사용자가 검색창으로 옮긴 포커스는 뒤늦은 복구가 빼앗지 않는다.
// 합성 원고(BOM + CRLF + frontmatter 세 화)·격리 userData·실제 App 키보드 조작(Playwright 실제 키). chapter:read·chapter:write·ai:analyze 진입 계수로 포커스 복구가 다른 화를 열거나 저장·AI를 새로 실행하지 않음을 본다.
// 합성 Electron이며 수동 GUI·실제 OS 입력 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const chapter = (id: string, title: string, body: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${body}\r\n`;
const FILES: Record<string, string> = {
  '001.md': chapter('one', 'One', 'Alpha one'),
  '002.md': chapter('two', 'Two', 'Beta two'),
  '003.md': chapter('three', 'Three', 'Gamma three'),
};

interface Counters {
  reads: number;
  writes: number;
  analyzes: number;
  failWrites: boolean;
  holdWrite: boolean;
  releaseGate: (() => void) | null;
}
const counts = (app: ElectronApplication) => app.evaluate(() => { const c = (globalThis as unknown as { c: Counters }).c; return { reads: c.reads, writes: c.writes, analyzes: c.analyzes }; });
const nav = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const tabNames = (page: Page) => page.evaluate(() => Array.from(document.querySelectorAll('.tabs [role="tab"]')).map((t) => t.textContent));
const selectedTab = (page: Page) => page.evaluate(() => document.querySelector('.tabs [role="tab"][aria-selected="true"]')?.textContent ?? null);
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return {
      body: !el || el === document.body,
      connected: !!el?.isConnected,
      tab: el?.getAttribute('role') === 'tab' ? el.textContent : null,
      closeLabel: el?.classList.contains('tab-close') ? el.getAttribute('aria-label') : null,
      inEditor: !!el?.closest('.ProseMirror'),
      inList: !!el?.closest('nav[aria-label="화 목록"]'),
      searchbox: el?.getAttribute('aria-label') === '원고 검색',
    };
  });
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function start() {
  const dir = await tempDir('tab-close-focus');
  await mkdir(join(dir, 'chapters'));
  for (const [name, text] of Object.entries(FILES)) await writeFile(join(dir, 'chapters', name), text);
  const { app, page } = await launch(await tempDir('tab-close-focus-ud'));
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { c: Counters };
    g.c = { reads: 0, writes: 0, analyzes: 0, failWrites: false, holdWrite: false, releaseGate: null };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    for (const channel of ['chapter:read', 'ai:analyze', 'chapter:write']) {
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        if (channel === 'chapter:read') g.c.reads++;
        if (channel === 'ai:analyze') g.c.analyzes++;
        if (channel === 'chapter:write') {
          g.c.writes++;
          if (g.c.holdWrite) {
            g.c.holdWrite = false;
            await new Promise<void>((resolve) => (g.c.releaseGate = resolve));
          }
          if (g.c.failWrites) throw new Error('EPERM: synthetic write failure');
        }
        return original(...args);
      });
    }
  });
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await nav(page).getByRole('button', { name: 'One' }).waitFor();
  return { app, page, dir };
}
async function openTab(page: Page, title: string, text: string) {
  await nav(page).getByRole('button', { name: title }).click();
  await page.locator('.ProseMirror').getByText(text).waitFor();
}

test('키보드로 닫은 탭의 포커스 복구: 비활성·활성·마지막 탭', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start();
  try {
    await openTab(page, 'One', 'Alpha one');
    await openTab(page, 'Two', 'Beta two');
    await openTab(page, 'Three', 'Gamma three');
    assert.deepEqual(await tabNames(page), ['One', 'Two', 'Three']);
    const base = await counts(app);

    // 비활성 탭 닫기 (Three 활성): 활성 탭이 유지되고 포커스는 현재 탭 버튼으로
    await page.getByRole('button', { name: '탭 닫기: One', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until('One 탭 제거', async () => !(await tabNames(page)).includes('One'));
    await until('포커스 복구', async () => !(await focused(page)).body);
    const a = await focused(page);
    assert.equal(a.connected, true, '제거된 요소에 포커스가 남지 않았다');
    assert.equal(a.tab, 'Three', '비활성 탭을 닫으면 현재(활성) 탭 버튼으로 포커스가 돌아온다');
    assert.equal(await selectedTab(page), 'Three', '활성 탭이 유지됐다');
    await page.locator('.ProseMirror').getByText('Gamma three').waitFor();

    // 활성 탭 닫기 (Three, 이웃은 왼쪽 Two): 기존 이웃 선택 그대로, 포커스는 BODY가 아니다
    await page.getByRole('button', { name: '탭 닫기: Three', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until('Three 탭 제거', async () => !(await tabNames(page)).includes('Three'));
    await page.locator('.ProseMirror').getByText('Beta two').waitFor();
    await until('활성 탭 닫은 뒤 포커스', async () => !(await focused(page)).body);
    const b = await focused(page);
    assert.equal(b.connected, true);
    assert.ok(b.tab === 'Two' || b.inEditor, `이웃 탭 버튼 또는 편집기로 포커스가 있다: ${JSON.stringify(b)}`);
    assert.equal(await selectedTab(page), 'Two', '기존 이웃 선택(왼쪽)과 같다');
    // 이웃 편집기의 시작 포커스는 본문이 보인 뒤 한 프레임 늦게 실행된다(onCreate의 rAF). 그 시작 포커스가 끝나기를 기다린 뒤 다음 단계를 한다:
    // 기다리지 않고 닫기 버튼에 포커스를 두면 그 직후 늦게 실행된 시작 포커스가 편집기로 가져가 이어지는 Enter가 편집기로 들어가 닫기가 유실된다 (원시 로그 probe-run-4)
    await until('이웃 편집기의 시작 포커스', async () => (await focused(page)).inEditor);

    // 마지막 탭 닫기: 실제 남은 화 목록으로
    await page.getByRole('button', { name: '탭 닫기: Two', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until('마지막 탭 제거', async () => (await tabNames(page)).length === 0);
    await until('마지막 탭 닫은 뒤 포커스', async () => !(await focused(page)).body);
    const c = await focused(page);
    assert.equal(c.connected, true);
    assert.equal(c.inList, true, `마지막 탭을 닫으면 화 목록의 컨트롤로 포커스가 간다: ${JSON.stringify(c)}`);

    // 포커스 복구가 다른 화를 열거나 저장·AI를 새로 실행하지 않았다 (읽기는 Two로 이동한 한 번뿐)
    const end = await counts(app);
    assert.equal(end.writes, base.writes, '저장 진입 0');
    assert.equal(end.analyzes, base.analyzes, 'AI 실행 0');
    assert.equal(end.reads, base.reads + 1, '화 읽기는 활성 탭 닫기로 Two를 연 한 번뿐이다 (포커스 복구가 다른 화를 열지 않았다)');
    for (const [name, text] of Object.entries(FILES)) assert.ok((await readFile(join(dir, 'chapters', name), 'utf8')) === text, `${name} 바이트(BOM·CRLF·frontmatter) 불변`);
  } finally {
    await closeWindow(app);
  }
});

test('닫기를 거절하면 탭·본문·포커스가 그대로이고, 저장 응답을 기다리는 사이 옮긴 포커스는 뒤늦은 복구가 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page } = await start();
  try {
    await openTab(page, 'One', 'Alpha one');
    await openTab(page, 'Two', 'Beta two');

    // 거절: 저장 실패 + 확인 취소 → 탭 유지, 본문 유지, 포커스는 살아있는 닫기 버튼
    await page.locator('.ProseMirror').getByText('Beta two').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Z');
    await app.evaluate(() => { (globalThis as unknown as { c: Counters }).c.failWrites = true; });
    page.once('dialog', (d) => void d.dismiss());
    await page.getByRole('button', { name: '탭 닫기: Two', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until('저장 시도', async () => (await counts(app)).writes >= 1);
    await until('거절 처리', async () => (await focused(page)).closeLabel === '탭 닫기: Two');
    assert.deepEqual(await tabNames(page), ['One', 'Two'], '거절하면 탭이 그대로다');
    assert.equal(await selectedTab(page), 'Two');
    assert.ok((await page.locator('.ProseMirror').textContent())?.includes('Beta two Z'), '미저장 본문이 그대로다');
    const rejected = await focused(page);
    assert.equal(rejected.closeLabel, '탭 닫기: Two', '포커스가 살아있는 닫기 버튼에 남아 있다');
    assert.equal(rejected.connected, true);

    // 지연 응답 중 포커스 이동: 저장을 붙잡은 채 닫기 → 검색창으로 포커스를 옮김 → 저장 성공 → 탭 제거 뒤에도 포커스는 검색창
    await app.evaluate(() => { const c = (globalThis as unknown as { c: Counters }).c; c.failWrites = false; c.holdWrite = true; });
    const before = (await counts(app)).writes;
    await page.getByRole('button', { name: '탭 닫기: Two', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until('붙잡은 저장 진입', async () => (await counts(app)).writes === before + 1);
    await page.getByRole('searchbox', { name: '원고 검색' }).focus();
    await app.evaluate(() => (globalThis as unknown as { c: Counters }).c.releaseGate!());
    await until('Two 탭 제거', async () => !(await tabNames(page)).includes('Two'));
    await page.locator('.ProseMirror').getByText('Alpha one').waitFor();
    const late = await focused(page);
    assert.equal(late.searchbox, true, `뒤늦은 복구가 사용자가 옮긴 포커스(검색창)를 빼앗지 않았다: ${JSON.stringify(late)}`);
  } finally {
    await closeWindow(app);
  }
});

test('저장 응답을 기다리는 사이 사용자가 남은 탭으로 옮긴 포커스는 이웃 편집기가 만들어진 뒤에도 유지되고, 이후 탭 탐색·일반 화 열기 포커스는 정상이다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start();
  try {
    await openTab(page, 'One', 'Alpha one');
    await openTab(page, 'Two', 'Beta two');
    await page.locator('.ProseMirror').getByText('Beta two').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' Z');
    await app.evaluate(() => { (globalThis as unknown as { c: Counters }).c.holdWrite = true; });
    const before = (await counts(app)).writes;
    await page.getByRole('button', { name: '탭 닫기: Two', exact: true }).focus();
    await page.keyboard.press('Enter');
    await until('붙잡은 저장 진입', async () => (await counts(app)).writes === before + 1);
    // 해제 전: 사용자가 남은 One 탭 버튼에 실제로 포커스를 둔다
    await page.getByRole('tab', { name: 'One', exact: true }).focus();
    assert.equal((await focused(page)).tab, 'One', '해제 전 One 탭에 포커스가 있다');
    await app.evaluate(() => (globalThis as unknown as { c: Counters }).c.releaseGate!());
    await until('Two 탭 제거', async () => !(await tabNames(page)).includes('Two'));
    await page.locator('.ProseMirror').getByText('Alpha one').waitFor();
    // 새 편집기 onCreate가 예약한 한 프레임 포커스까지 지난 뒤에도 One 탭이 유지된다
    await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
    const kept = await focused(page);
    assert.equal(kept.tab, 'One', `이웃 편집기가 만들어진 뒤에도 사용자가 고른 One 탭에 포커스가 남아 있다: ${JSON.stringify(kept)}`);
    assert.equal(await selectedTab(page), 'One');
    assert.ok((await readFile(join(dir, 'chapters', '002.md'), 'utf8')).includes('Beta two Z'), '닫기 전 저장된 본문이 디스크에 있다');

    // 선택한 탭에서 키보드가 계속 동작한다 (Enter로 One 유지·ArrowRight는 탭 사이 이동 없음(탭 하나))
    await page.keyboard.press('Enter');
    await page.locator('.ProseMirror').getByText('Alpha one').waitFor();
    assert.equal(await selectedTab(page), 'One');

    // 일반 화 열기(탐색기)의 편집기 포커스는 그대로다 (한 번용 표시가 남아 막지 않는다)
    await nav(page).getByRole('button', { name: 'Three' }).click();
    await page.locator('.ProseMirror').getByText('Gamma three').waitFor();
    await until('편집기 포커스', async () => (await focused(page)).inEditor);
  } finally {
    await closeWindow(app);
  }
});
