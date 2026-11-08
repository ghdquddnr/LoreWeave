// [다시 저장]의 성공 응답을 기다리는 동안 추가한 글(B)이 미저장으로 남고, 후속 저장으로만 저장되는지 본다 (save-error-retry는 보류 중 추가 입력 뒤 "실패"만 봤다).
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. main의 chapter:write 처리기를 무료 대역으로 감싼다: 호출 수를 세고, 장벽(hold)이 걸려 있으면 release까지 붙잡고, mode에 따라 실패(EACCES 대역)시키거나 원래 처리기로 넘긴다.
// 명시 클릭과 자동 타이머를 구별하기 위해 renderer의 setTimeout을 이 검사 안에서만 가로챈다: 지연이 1500ms(자동 저장)·5000ms(자동 재시도)인 호출은 예약하지 않고 {delay, fn}으로 기록만 한다.
// 그래서 쓰기 요청의 원인은 (1) Ctrl+S (2) [다시 저장] 클릭 (3) 기록된 자동 저장 타이머를 검사가 직접 실행한 것, 셋뿐이다. 제품의 타이머 주기·코드는 바꾸지 않는다.
// 관측 한계: 지연이 우연히 1500/5000인 다른 타이머도 함께 가로채지고(이 경로에서는 확인하지 않음), 가로챈 뒤의 영구 부재는 주장하지 않는다. 상태줄 관측은 MutationObserver가 본 변화에 한한다.
// 합성 Electron 검사이며 수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 출력하지 않고 동등 여부(boolean)만 판정한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const withText = (text: string) => ONE.replace('Alpha text', text);

type G = { calls: number; hold: boolean; held: boolean; release?: () => void; mode: 'fail' | 'pass' };
type W = { __timers: { delay: number; fn: () => void; ran: boolean }[]; __seen: string[] };
const editor = (page: Page) => page.locator('.ProseMirror');
const bar = (page: Page) => page.locator('footer.statusbar');
const retryButton = (page: Page) => bar(page).getByRole('button', { name: /^(다시 저장|저장하는 중…)$/ });
const calls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).calls);
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).held);
const arm = (app: ElectronApplication, mode: G['mode']) =>
  app.evaluate((_e, mode) => {
    const g = globalThis as unknown as G;
    g.mode = mode;
    g.hold = true;
  }, mode);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const renderedFrames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
/** 가로챈 타이머: 지연별 개수와 실행된 수 */
const timers = (page: Page, delay: number) =>
  page.evaluate((d) => {
    const t = (window as unknown as W).__timers.filter((x) => x.delay === d);
    return { total: t.length, ran: t.filter((x) => x.ran).length };
  }, delay);
/** 가장 최근에 가로챈 지연 d의 타이머 하나를 지금 실행한다 (제품 코드가 예약한 그 콜백) */
const runLatestTimer = (page: Page, delay: number) =>
  page.evaluate((d) => {
    const t = (window as unknown as W).__timers.filter((x) => x.delay === d && !x.ran);
    const last = t[t.length - 1];
    if (!last) return false;
    last.ran = true;
    last.fn();
    return true;
  }, delay);
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 600 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

test('[다시 저장]이 성공을 기다리는 동안 추가한 글은 미저장으로 남고, A만 디스크에 간 뒤 후속 저장으로만 A+B가 저장되며 그 사이 저장됨이 보이지 않는다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('save-retry-inflight');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('save-retry-inflight-ud'));
  page.on('dialog', (d) => void d.accept()); // 정리용으로만: 판정에 쓰지 않는다
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as G;
      Object.assign(g, { calls: 0, hold: false, held: false, mode: 'fail' });
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('chapter:write')!;
      handlers.set('chapter:write', async (...args: unknown[]) => {
        g.calls++;
        if (g.hold) {
          g.hold = false;
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
        }
        if (g.mode === 'fail') throw Object.assign(new Error('EACCES: permission denied (synthetic)'), { code: 'EACCES' });
        return original(...args);
      });
    });
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
    await editor(page).getByText('Alpha text').waitFor();
    const original = await readFile(path);

    // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 renderer에는 없다
    await page.evaluate(`(() => {
      const w = window;
      w.__timers = [];
      w.__seen = [];
      const real = w.setTimeout.bind(w);
      w.setTimeout = (fn, delay, ...rest) => {
        if (delay === 1500 || delay === 5000) {
          w.__timers.push({ delay, fn, ran: false });
          return 0;
        }
        return real(fn, delay, ...rest);
      };
      new MutationObserver(() => {
        const bar = document.querySelector('footer.statusbar');
        if (bar) w.__seen.push(bar.innerText);
      }).observe(document.body, { subtree: true, childList: true, characterData: true });
    })()`);

    // 1) 최초 저장 실패 (Ctrl+S). 자동 타이머는 가로채졌다
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
    await retryButton(page).waitFor();
    assert.ok((await timers(page, 1500)).total >= 1 && (await timers(page, 5000)).total >= 1, '자동 저장·자동 재시도 타이머가 가로채졌다');
    assert.deepEqual([(await timers(page, 1500)).ran, (await timers(page, 5000)).ran], [0, 0], '가로챈 타이머는 아직 하나도 실행하지 않았다');
    assert.equal(await calls(app), 1, '지금까지 쓰기 요청은 Ctrl+S 한 건');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, '실패 중 디스크 원본 바이트 그대로');

    // 2) [다시 저장] 클릭: A 저장 응답을 장벽에 보류. 진행 표시를 확인하고 그 사이 B를 입력한다
    await arm(app, 'pass');
    await retryButton(page).click();
    await waitUntil(page, 'A 재시도가 장벽에 붙잡히지 않았다', () => held(app));
    assert.equal(await calls(app), 2, '쓰기 요청은 명시 클릭의 한 건이 더해져 두 건 (타이머는 하나도 실행되지 않았다)');
    await bar(page).getByRole('button', { name: '저장하는 중…' }).waitFor();
    await editor(page).getByText('Alpha text A', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' B');
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, '보류 중 입력한 A+B가 화면에 있다');
    assert.ok(Buffer.compare(await readFile(path), original) === 0, 'A 응답 전 디스크는 그대로');

    // 3) A만 성공시킨다: 원래 처리기가 디스크에 A를 쓴다. 이 순간부터 B 저장이 끝날 때까지 상태줄을 기록한다
    const seenFrom = await page.evaluate(() => (window as unknown as W).__seen.length);
    await release(app);
    await waitUntil(page, '후속 저장 타이머가 예약되지 않았다', async () => (await timers(page, 1500)).total >= 2);
    await renderedFrames(page);
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A'), '디스크에는 A만 (BOM·CRLF·frontmatter 보존)');
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, '에디터는 A+B');
    assert.equal(await calls(app), 2, 'A 성공만으로 후속 쓰기가 시작되지 않았다 (자동 저장 타이머는 아직 실행 전)');
    const afterA = await bar(page).innerText();
    assert.ok(!/저장됨/.test(afterA), 'A 성공 뒤에도 최종 저장됨이 아니다');
    assert.equal(await bar(page).getByRole('button', { name: '저장하는 중…' }).count(), 0, '끝난 [저장하는 중…] 버튼이 남지 않았다');

    // 4) 제품이 예약한 후속 저장(자동 저장 타이머)을 직접 실행하고, B 쓰기를 별도 장벽으로 붙잡는다
    await arm(app, 'pass');
    assert.equal(await runLatestTimer(page, 1500), true, '예약된 후속 저장 타이머를 실행했다');
    await waitUntil(page, 'B 후속 쓰기가 장벽에 붙잡히지 않았다', () => held(app));
    assert.equal(await calls(app), 3, '후속 쓰기는 타이머 실행의 한 건');
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A'), 'B 응답 전 디스크는 A만');
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, 'B 저장 중에도 에디터는 A+B');
    assert.ok(!/저장됨/.test(await bar(page).innerText()), 'B 저장 중에는 저장됨이 아니다');
    assert.equal(await retryButton(page).count(), 0, '후속 저장 중에는 [다시 저장]·[저장하는 중…] 버튼이 없다');

    // 5) B를 해제: 원래 처리기로 A+B가 envelope과 함께 저장되고 저장됨이 된다
    await renderedFrames(page);
    const seenBeforeB = (await page.evaluate(() => (window as unknown as W).__seen.slice())) as string[];
    await release(app);
    await bar(page).getByText('저장됨', { exact: true }).waitFor({ timeout: 30_000 });
    assert.ok((await readFile(path, 'utf8')) === withText('Alpha text A B'), '최종 디스크는 A+B (BOM·CRLF·frontmatter 보존)');
    assert.equal(await retryButton(page).count(), 0, '저장되면 재시도 버튼이 없다');
    // A 응답 직전부터 B 해제 직전까지 MutationObserver가 본 상태줄에 저장됨이 한 번도 없다
    const window_ = seenBeforeB.slice(seenFrom);
    assert.ok(window_.length > 0, 'A 응답 뒤 상태줄 변화가 관측됐다');
    assert.deepEqual(
      window_.filter((t) => /저장됨/.test(t)),
      [],
      'A 응답부터 B 완료 전까지 저장됨 오표시가 없다',
    );
    assert.equal(await calls(app), 3, '쓰기 요청은 Ctrl+S·클릭·후속 타이머 세 건뿐 (관측 범위 안)');
    assert.equal(await held(app), false, '보류된 요청이 남지 않았다');
  } finally {
    await release(app).catch(() => undefined); // 어떤 경우에도 보류 요청을 남기지 않는다
    await closeWindow(app);
  }
});
