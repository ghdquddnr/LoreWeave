// 열린 화가 외부에서 바뀌어 다시 읽혔을 때 탐색기·열린 탭·상태줄의 제목도 실제로 읽은 원고와 맞춰지는지 본다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData. 제목은 읽기 성공 때만 chapterInfo 규칙(frontmatter title → 첫 # 제목 → 파일명)으로 바뀐다.
// main의 chapter:read/chapter:write를 무료 대역(호출 수·요청별 장벽·실패)으로 감싼다. 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 저장되는 경합을 없앤다 (제품 코드·주기는 바꾸지 않는다).
// 원고는 이 테스트가 쓴 바이트 그대로여야 하고 앱의 제목 동기화는 chapter:write를 만들지 않는다. 합성 Electron 검사이며 수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음.
// 관측 범위: 읽기 장벽에 붙잡힌 낡은 응답이 화를 옮긴 뒤 제목을 덮지 않는 것은 장벽 해제 뒤 두 프레임 렌더 barrier까지의 관측이다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (title: string | null, body: string) => `﻿---\r\nid: one\r\n${title === null ? '' : `title: ${title}\r\n`}---\r\n${body}\r\n`;
const TWO = '﻿---\r\nid: two\r\ntitle: TWO\r\n---\r\nBeta text\r\n';

interface Hooks {
  reads: number;
  writes: number;
  readMode: 'ok' | 'fail' | 'hold';
  readHeld: boolean;
  readRelease?: () => void;
}
const hooks = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: Hooks }).h);
const setRead = (app: ElectronApplication, mode: Hooks['readMode']) => app.evaluate((_e, mode) => void ((globalThis as unknown as { h: Hooks }).h.readMode = mode), mode);
const releaseRead = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { h: Hooks }).h.readRelease?.());
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));
async function until(app: ElectronApplication, what: string, ok: (h: Hooks) => boolean) {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const h = await hooks(app);
    if (ok(h)) return h;
    if (Date.now() > deadline) throw new Error(`장벽 대기 시간 초과: ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}
const nav = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title, exact: true });
const tab = (page: Page, title: string) => page.getByRole('tab', { name: title, exact: true });
const statusTitle = (page: Page) => page.locator('footer.statusbar > span').first();
/** 탐색기·열린 탭·상태줄이 같은 제목을 보인다 */
async function titleIs(page: Page, title: string) {
  await nav(page, title).waitFor({ timeout: 10_000 });
  await tab(page, title).waitFor({ timeout: 10_000 });
  await page.waitForFunction((t) => document.querySelector('footer.statusbar > span')?.textContent === t, title, { timeout: 10_000 });
}
async function titleStays(page: Page, title: string, label: string) {
  assert.equal(await nav(page, title).count(), 1, `탐색기: ${label}`);
  assert.equal(await tab(page, title).count(), 1, `탭: ${label}`);
  assert.equal(await statusTitle(page).innerText(), title, `상태줄: ${label}`);
}

test('외부에서 현재 화의 제목이 바뀌어 다시 읽히면 탐색기·탭·상태줄이 읽은 원고의 제목으로 맞춰지고, 읽기 실패·낡은 응답·미저장 충돌에서는 미리 바꾸지 않는다', { timeout: 150_000 }, async () => {
  const dir = await tempDir('external-title');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, doc('OLD', 'Alpha text'));
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  const { app, page } = await launch(await tempDir('external-title-ud'));
  page.on('dialog', (d) => void d.accept()); // [디스크 내용 불러오기]·정리용 확인 (판정에 쓰지 않는다)
  try {
    // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 main에는 없다
    await app.evaluate(
      ({ ipcMain }, code) => new Function('ipcMain', code)(ipcMain),
      `
      const h = { reads: 0, writes: 0, readMode: 'ok', readHeld: false };
      globalThis.h = h;
      const handlers = ipcMain._invokeHandlers;
      const read = handlers.get('chapter:read');
      handlers.set('chapter:read', async (...args) => {
        h.reads++;
        if (h.readMode === 'fail') throw new Error('SYNTHETIC_READ_FAIL');
        if (h.readMode === 'hold') {
          h.readMode = 'ok';
          h.readHeld = true;
          await new Promise((resolve) => (h.readRelease = resolve));
          h.readHeld = false;
        }
        return read(...args);
      });
      const write = handlers.get('chapter:write');
      handlers.set('chapter:write', async (...args) => {
        h.writes++;
        return write(...args);
      });
    `,
    );
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await nav(page, 'OLD').click();
    await page.locator('.ProseMirror').getByText('Alpha text').waitFor();
    await titleIs(page, 'OLD');
    await page.evaluate(`(() => {
      const w = window;
      const real = w.setTimeout.bind(w);
      w.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);

    // 1) 깨끗한 화의 외부 title 변경: 본문이 다시 읽히고 제목 세 곳이 함께 새 제목이 된다
    const second = doc('NEW', 'Alpha changed');
    await writeFile(path, second);
    await page.locator('.ProseMirror').getByText('Alpha changed').waitFor({ timeout: 15_000 });
    await titleIs(page, 'NEW');
    assert.equal(await nav(page, 'OLD').count(), 0, '옛 제목이 남지 않는다');

    // 2) frontmatter title을 지우면 같은 규칙으로 첫 # 제목이 쓰인다
    const third = doc(null, '# 첫제목\r\n\r\nAlpha heading');
    await writeFile(path, third);
    await page.locator('.ProseMirror').getByText('Alpha heading').waitFor({ timeout: 15_000 });
    await titleIs(page, '첫제목');

    // 3) 읽기 실패: 제목을 미리 바꾸지 않고, [다시 시도]가 성공하면 그때 바뀐다
    await setRead(app, 'fail');
    const fourth = doc('THIRD', 'Alpha third');
    await writeFile(path, fourth);
    await page.getByText('이 화를 열 수 없습니다', { exact: false }).waitFor({ timeout: 15_000 });
    await titleStays(page, '첫제목', '읽기 실패 중에는 제목을 바꾸지 않는다');
    await setRead(app, 'ok');
    await page.getByRole('button', { name: '다시 시도' }).click();
    await page.locator('.ProseMirror').getByText('Alpha third').waitFor({ timeout: 15_000 });
    await titleIs(page, 'THIRD');

    // 4) 낡은 응답: 재읽기를 장벽에 붙잡은 채 다른 화로 옮기면, 풀려도 이전 응답이 제목을 덮지 않는다
    await setRead(app, 'hold');
    await writeFile(path, doc('FOURTH', 'Alpha fourth'));
    await until(app, '재읽기가 장벽에 붙잡히지 않았다', (h) => h.readHeld);
    await titleStays(page, 'THIRD', '재읽기 응답 전에는 제목을 바꾸지 않는다');
    await nav(page, 'TWO').click();
    await page.locator('.ProseMirror').getByText('Beta text').waitFor();
    await releaseRead(app);
    await until(app, '붙잡힌 읽기가 풀리지 않았다', (h) => !h.readHeld);
    await settled(page);
    assert.equal(await nav(page, 'FOURTH').count(), 0, '낡은 응답이 화를 옮긴 뒤 제목을 덮지 않았다 (관측 범위 안)');
    assert.equal(await nav(page, 'THIRD').count(), 1);
    // 다시 열면 그 읽기가 성공하므로 그때의 디스크 제목이 된다
    await nav(page, 'THIRD').click();
    await page.locator('.ProseMirror').getByText('Alpha fourth').waitFor();
    await titleIs(page, 'FOURTH');

    // 5) 미저장 수정 + 외부 변경: 자동 재읽기·본문 폐기·제목 갱신 없음. [디스크 내용 불러오기]로 읽은 뒤에야 새 제목이 된다
    await page.locator('.ProseMirror').getByText('Alpha fourth').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' MINE');
    const readsBefore = (await hooks(app)).reads;
    const fifth = doc('FIFTH', 'Alpha fifth');
    await writeFile(path, fifth);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    await settled(page);
    await titleStays(page, 'FOURTH', '충돌 중에는 디스크 제목을 읽은 척 바꾸지 않는다');
    assert.equal(await page.locator('.ProseMirror').getByText('Alpha fourth MINE', { exact: true }).count(), 1, '미저장 본문 보존');
    assert.equal((await hooks(app)).reads, readsBefore, '충돌 중에는 자동으로 다시 읽지 않았다');
    await page.getByRole('button', { name: '디스크 내용 불러오기 (내 수정은 버림)' }).click();
    await page.locator('.ProseMirror').getByText('Alpha fifth').waitFor({ timeout: 15_000 });
    await titleIs(page, 'FIFTH');

    // 앱의 제목 동기화는 저장을 만들지 않았고, 원고는 마지막으로 이 테스트가 쓴 바이트 그대로다
    assert.equal((await hooks(app)).writes, 0, '제목 동기화·재읽기가 chapter:write를 만들지 않았다');
    assert.ok((await readFile(path, 'utf8')) === fifth, '원고 바이트는 외부에서 쓴 그대로');
  } finally {
    await releaseRead(app).catch(() => undefined);
    await closeWindow(app);
  }
});
