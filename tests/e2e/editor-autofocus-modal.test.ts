// 늦게 준비된 화 편집기(onCreate의 한 프레임 시작 포커스)가 열린 모달(환경설정)의 키보드 포커스를 빼앗지 않는다.
// main의 chapter:read를 호출 장벽으로 붙잡은 채 화를 열고, 읽는 중에 환경설정을 열어 닫기 버튼에 포커스를 둔 뒤 읽기를 풀어 편집기가 표시되고 두 rAF가 지난 뒤의 포커스를 본다.
// 모달이 없을 때의 정상 시작 포커스, 모달이 먼저 닫힌 뒤 읽기가 끝나는 경우, 검색창 보호(기존 계약)도 함께 본다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. chapter:write·ai:analyze 진입 계수 0과 원고 바이트 보존. Playwright 실제 키. 수동 GUI·실제 OS 입력 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

interface Hooks {
  reads: number;
  writes: number;
  analyzes: number;
  hold: boolean;
  release: (() => void) | null;
}
const hooks = (app: ElectronApplication) => app.evaluate(() => { const h = (globalThis as unknown as { h: Hooks }).h; return { reads: h.reads, writes: h.writes, analyzes: h.analyzes }; });
const nav = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(() => r())))));
const focus = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return { body: !el || el === document.body, inDialog: !!el?.closest('[role="dialog"]'), inEditor: !!el?.closest('.ProseMirror'), searchbox: el?.getAttribute('aria-label') === '원고 검색', label: el?.getAttribute('aria-label') ?? el?.textContent?.slice(0, 20) ?? '' };
  });
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 100; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function start(name: string) {
  const dir = await tempDir(name);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir(`${name}-ud`));
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { h: Hooks };
    g.h = { reads: 0, writes: 0, analyzes: 0, hold: false, release: null };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    for (const channel of ['chapter:read', 'chapter:write', 'ai:analyze']) {
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        if (channel === 'chapter:write') g.h.writes++;
        if (channel === 'ai:analyze') g.h.analyzes++;
        if (channel === 'chapter:read') {
          g.h.reads++;
          if (g.h.hold) {
            g.h.hold = false;
            await new Promise<void>((resolve) => (g.h.release = resolve));
          }
        }
        return original(...args);
      });
    }
  });
  // 편집기가 포커스를 받은 횟수 (시작 포커스가 실제로 실행됐는지 본다. 이후 다른 곳이 포커스를 되가져가도 기록은 남는다)
  await page.evaluate(`(() => { window.__ed = 0; document.addEventListener('focusin', (e) => { if (e.target.closest && e.target.closest('.ProseMirror')) window.__ed++; }, true); })()`);
  await stubFolderDialog(app, dir);
  const openProject = async () => {
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await nav(page).getByRole('button', { name: 'One' }).waitFor();
  };
  return { app, page, path, openProject };
}
const holdNextRead = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as { h: Hooks }).h.hold = true));
const releaseRead = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: Hooks }).h.release!());
const edFocus = (page: Page) => page.evaluate('window.__ed') as Promise<number>;

test('늦게 준비된 편집기는 열린 설정 모달의 포커스를 빼앗지 않고, Tab·Escape·opener 복귀가 그대로다', { timeout: 120_000 }, async () => {
  const { app, page, path, openProject } = await start('editor-autofocus-modal');
  try {
    await holdNextRead(app); // 프로젝트를 열면 첫 화를 자동으로 여는 읽기를 붙잡는다
    await openProject();
    await until('붙잡은 읽기', async () => (await hooks(app)).reads === 1);
    // 읽는 중에 환경설정을 열고 닫기 버튼에 포커스를 둔다
    const opener = page.getByRole('button', { name: '설정', exact: true });
    await opener.focus();
    await opener.click();
    const settings = page.getByRole('dialog', { name: '환경설정' });
    await settings.waitFor();
    await settings.getByRole('button', { name: '닫기', exact: true }).focus();
    await releaseRead(app);
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    await frames(page);
    await frames(page);
    const f = await focus(page);
    assert.equal(await edFocus(page), 0, '편집기가 모달이 열린 동안 한 번도 포커스를 받지 않았다');
    assert.equal(f.inDialog, true, `편집기가 표시된 뒤에도 모달 안에 포커스가 남아 있다: ${JSON.stringify(f)}`);
    assert.equal(f.label, '닫기', '사용자가 둔 닫기 버튼 그대로다');
    // 실제 Tab은 모달 안에서 돌고 Escape는 닫고 연 버튼으로 돌아온다
    await page.keyboard.press('Tab');
    assert.equal((await focus(page)).inDialog, true);
    await page.keyboard.press('Shift+Tab');
    assert.equal((await focus(page)).inDialog, true);
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
    assert.equal((await focus(page)).label, '설정', '닫으면 연 버튼으로 돌아온다');
    const end = await hooks(app);
    assert.equal(end.writes, 0, '저장 진입 0');
    assert.equal(end.analyzes, 0, 'AI 실행 0');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 바이트(BOM·CRLF·frontmatter) 불변');
  } finally {
    await closeWindow(app);
  }
});

test('모달이 없으면 편집기가 시작 포커스를 받고, 모달이 먼저 닫힌 뒤 읽기가 끝나도 받으며, 검색창 포커스는 빼앗지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, openProject } = await start('editor-autofocus-plain');
  try {
    // 모달 없음: 프로젝트를 열어 자동으로 열린 화의 편집기가 시작 포커스를 받는다
    await openProject();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    await until('편집기 시작 포커스', async () => (await edFocus(page)) >= 1);

    // 모달이 먼저 닫힌 뒤 읽기가 끝난다: 편집기가 시작 포커스를 받는다
    await page.getByRole('button', { name: '탭 닫기: One', exact: true }).click();
    await page.locator('.ProseMirror').waitFor({ state: 'detached' });
    const before = await edFocus(page);
    const base = (await hooks(app)).reads;
    await holdNextRead(app);
    await nav(page).getByRole('button', { name: 'One' }).click();
    await until('붙잡은 읽기', async () => (await hooks(app)).reads === base + 1);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('dialog', { name: '환경설정' }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '환경설정' }).waitFor({ state: 'detached' });
    await releaseRead(app);
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    await until('모달이 닫힌 뒤 편집기 시작 포커스', async () => (await edFocus(page)) > before);

    // 검색창에 포커스가 있으면 빼앗지 않는다 (기존 계약)
    await page.getByRole('button', { name: '탭 닫기: One', exact: true }).click();
    await page.locator('.ProseMirror').waitFor({ state: 'detached' });
    const before2 = await edFocus(page);
    const base2 = (await hooks(app)).reads;
    await holdNextRead(app);
    await nav(page).getByRole('button', { name: 'One' }).click();
    await until('두 번째 붙잡은 읽기', async () => (await hooks(app)).reads === base2 + 1);
    await page.getByRole('searchbox', { name: '원고 검색' }).focus();
    await releaseRead(app);
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    await frames(page);
    assert.equal((await focus(page)).searchbox, true, '검색창 포커스는 그대로다');
    assert.equal(await edFocus(page), before2, '편집기는 검색창 포커스를 빼앗지 않았다');
  } finally {
    await closeWindow(app);
  }
});
