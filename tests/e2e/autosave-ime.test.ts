// 원고의 IME 조합 중에는 자동저장 타이머가 미확정 조합 글자를 디스크에 쓰지 않는다. 조합이 확정·취소된 뒤에는 추가 입력 없이 기존 정책으로 자동 저장되고, 이전 조합이 이후 자동저장을 막지 않는다.
// 두 검사: (1) 1500ms 자동저장 타이머, (2) 저장 실패 뒤 5000ms 재시도 타이머가 조합 중에 발화하는 경우.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 App/편집기. 조합은 CDP Input.imeSetComposition/insertText(실제 Chromium 입력 경로)이며 실제 OS IME·수동 GUI 확인이 아니다.
// 타이머는 가로채 막거나 줄이지 않는다(실제 1500·5000ms가 그대로 돈다). renderer의 setTimeout을 감싸 delay별 콜백이 실제로 실행된 횟수만 기록해, 임의 sleep 없이 "어떤 타이머가 조합 중에 발화했다"를 관측한다.
// main의 chapter:write는 진입 계수(entered: 호출 직전)와 완료 계수(done: 원래 핸들러가 성공으로 끝난 뒤)를 따로 센다. "조합 중 0"은 진입 계수로, 디스크 비교는 완료 계수(원자 쓰기 끝)를 기다린 뒤에 한다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';

interface Counters {
  entered: number;
  done: number;
  failed: number;
  /** 다음 chapter:write 한 번을 붙잡았다가 gate가 풀리면 실패시킨다 */
  holdNext: boolean;
  gate: (() => void) | null;
  releaseGate: (() => void) | null;
}
const count = (app: ElectronApplication) => app.evaluate(() => { const c = (globalThis as unknown as { c: Counters }).c; return { entered: c.entered, done: c.done, failed: c.failed }; });
const timers = (page: Page) => page.evaluate('({ f1500: window.__fired[1500], f5000: window.__fired[5000], starts: window.__comp.starts, ends: window.__comp.ends })') as Promise<{ f1500: number; f5000: number; starts: number; ends: number }>;
/** 한정된 횟수까지 조건을 기다린다 (무한 대기·임의 sleep 아님) */
async function until(label: string, ok: () => Promise<boolean>) {
  for (let i = 0; i < 150; i += 1) {
    if (await ok()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`시간 안에 ${label} 상태가 되지 않았다`);
}

async function open(name: string) {
  const dir = await tempDir(name);
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir(`${name}-ud`));
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { c: Counters };
    g.c = { entered: 0, done: 0, failed: 0, holdNext: false, gate: null, releaseGate: null };
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      g.c.entered++;
      if (g.c.holdNext) {
        g.c.holdNext = false;
        await new Promise<void>((resolve) => (g.c.releaseGate = resolve)); // 풀릴 때까지 붙잡고, 원래 쓰기는 하지 않은 채 실패시킨다
        g.c.failed++;
        throw new Error('EPERM: synthetic write failure');
      }
      const result = await original(...args);
      g.c.done++;
      return result;
    });
  });
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
  await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
  // 타이머(delay 1500·5000)의 실제 발화와 조합 시작/끝 이벤트만 센다 (막거나 줄이지 않는다)
  await page.evaluate(`(() => {
    const real = window.setTimeout.bind(window);
    window.__fired = { 1500: 0, 5000: 0 };
    window.__comp = { starts: 0, ends: 0 };
    window.setTimeout = (fn, delay, ...rest) => (delay === 1500 || delay === 5000 ? real(() => { window.__fired[delay]++; fn(); }, delay, ...rest) : real(fn, delay, ...rest));
    window.addEventListener('compositionstart', () => window.__comp.starts++, true);
    window.addEventListener('compositionend', () => window.__comp.ends++, true);
  })()`);
  const cdp = await page.context().newCDPSession(page);
  return { app, page, path, cdp };
}

test('조합 중 자동저장 타이머는 미확정 글자를 쓰지 않고, 확정·취소 뒤에는 추가 입력 없이 자동 저장되며 다음 조합 주기에도 같다', { timeout: 120_000 }, async () => {
  const { app, page, path, cdp } = await open('autosave-ime');
  try {
    const base = await count(app);

    // 주기 1: 입력 뒤 조합을 시작하고 타이머가 조합 중에 발화하게 둔다
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' X');
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    const t0 = await timers(page);
    assert.ok(t0.starts >= 1 && t0.ends === 0, `조합이 유지 중이다: ${JSON.stringify(t0)}`);
    await until('조합 중 타이머 발화', async () => (await timers(page)).f1500 > t0.f1500);
    const mid = await timers(page);
    assert.ok(mid.ends === 0, '타이머 발화 시점에도 조합이 끝나지 않았다');
    assert.equal((await count(app)).entered, base.entered, '조합 중 발화한 자동저장 타이머가 저장(chapter:write)을 시작하지 않았다');
    assert.ok((await readFile(path, 'utf8')) === ONE, '조합 중에는 디스크가 그대로다');

    // 확정: 추가 입력 없이 자동 저장된다 (조합 글자 포함). 디스크는 쓰기 완료 뒤에 본다
    await page.keyboard.insertText('감');
    await until('확정 뒤 자동 저장 완료', async () => (await count(app)).done === base.done + 1);
    assert.ok((await readFile(path, 'utf8')) === ONE.replace('Alpha text', 'Alpha text X감'), '확정 뒤 자동 저장: BOM·CRLF·frontmatter와 기존 글자 보존');

    // 주기 2 (이전 조합이 이후 자동저장을 막지 않는다): 입력 → 조합 → 타이머 발화(저장 없음) → 취소 → 추가 입력 없이 자동 저장, 취소된 글자는 남지 않는다
    await page.keyboard.type(' Y');
    await cdp.send('Input.imeSetComposition', { text: '값', selectionStart: 1, selectionEnd: 1 });
    const t1 = await timers(page);
    await until('두 번째 조합 중 타이머 발화', async () => (await timers(page)).f1500 > t1.f1500);
    assert.equal((await count(app)).entered, base.entered + 1, '두 번째 조합 중에도 저장하지 않았다');
    assert.ok((await readFile(path, 'utf8')).includes('값') === false, '조합 중 글자가 디스크에 없다');
    await cdp.send('Input.imeSetComposition', { text: '', selectionStart: 0, selectionEnd: 0 }); // 조합 취소
    await until('취소 뒤 자동 저장 완료', async () => (await count(app)).done === base.done + 2);
    const saved = await readFile(path, 'utf8');
    assert.ok(saved === ONE.replace('Alpha text', 'Alpha text X감 Y'), `취소된 글자는 남지 않고 BOM·CRLF·frontmatter·기존 글자가 보존된다: ${JSON.stringify(saved)}`);
  } finally {
    await closeWindow(app);
  }
});

test('저장 실패 뒤 5000ms 재시도 타이머가 조합 중에 발화해도 새 쓰기를 시작하지 않고, 조합이 끝나면 추가 입력 없이 자동 저장이 재개된다', { timeout: 120_000 }, async () => {
  const { app, page, path, cdp } = await open('autosave-ime-retry');
  try {
    const base = await count(app);

    // 조합 전에 시작한 저장: 입력 → 1500ms 자동저장이 chapter:write에 진입하면 붙잡아 둔다 (이 쓰기는 조합 전에 시작됐다)
    await page.locator('.ProseMirror').getByText('Alpha text').click();
    await page.keyboard.press('End');
    await app.evaluate(() => { (globalThis as unknown as { c: Counters }).c.holdNext = true; });
    await page.keyboard.type(' X');
    await until('조합 전 저장 진입', async () => (await count(app)).entered === base.entered + 1);
    assert.equal((await timers(page)).starts, 0, '이 쓰기는 조합 시작 전에 진입했다');

    // 그 쓰기가 붙잡힌 채 조합을 시작한 뒤 실패시킨다: 실패 응답이 5000ms 재시도를 예약하고 (조합 입력의 1500ms 타이머를 치환한다)
    await cdp.send('Input.imeSetComposition', { text: '감', selectionStart: 1, selectionEnd: 1 });
    const t0 = await timers(page);
    assert.ok(t0.starts >= 1 && t0.ends === 0, `조합이 유지 중이다: ${JSON.stringify(t0)}`);
    await app.evaluate(() => (globalThis as unknown as { c: Counters }).c.releaseGate!());
    await until('조합 전 시작한 쓰기의 실패 응답', async () => (await count(app)).failed === 1);

    // 조합을 유지한 채 5000ms 재시도 타이머가 실제로 발화하는 것을 관측한다 (1500ms 타이머가 아니다)
    const after = await timers(page);
    await until('조합 중 5000ms 재시도 타이머 발화', async () => (await timers(page)).f5000 > after.f5000);
    const fire = await timers(page);
    assert.equal(fire.ends, 0, '재시도 타이머 발화 시점에도 조합이 끝나지 않았다');
    assert.ok(fire.f5000 > after.f5000, '발화한 것은 5000ms 재시도 타이머다');
    const during = await count(app);
    assert.equal(during.entered, base.entered + 1, '조합 중 재시도 타이머가 새 쓰기를 시작하지 않았다 (진입은 조합 전의 실패한 한 건뿐)');
    assert.equal(during.done, base.done, '완료된 쓰기가 없다');
    assert.ok((await readFile(path, 'utf8')) === ONE, '조합 중에는 디스크 바이트가 그대로다');

    // 확정: 추가 키 입력 없이 자동 저장이 재개된다 (실패 뒤 재시도 정책)
    await page.keyboard.insertText('감');
    await until('확정 뒤 자동 저장 완료', async () => (await count(app)).done === base.done + 1);
    assert.equal((await count(app)).entered, base.entered + 2, '확정 뒤 새 쓰기는 정확히 한 건');
    assert.ok((await readFile(path, 'utf8')) === ONE.replace('Alpha text', 'Alpha text X감'), '확정 뒤 저장: BOM·CRLF·frontmatter와 기존 글자 보존');
  } finally {
    await closeWindow(app);
  }
});
