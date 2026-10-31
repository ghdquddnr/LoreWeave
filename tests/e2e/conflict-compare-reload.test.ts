// 충돌 비교의 [다시 비교]는 읽는 동안 대기를 알리고, 이전 비교를 최신 확인으로 오해하게 두지 않으며, 가장 최근 요청의 결과만 반영한다.
// 비교는 읽기 전용이다: 디스크 바이트·미저장 본문·충돌 상태는 그대로다. 합성 원고·격리 userData. main의 chapter:read(002.md)를 호출별 장벽(성공/거절/붙잡기)으로 감싼다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const TWO = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B')}`;
const OUTSIDE = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME BY_DISK', '', 'KEEP_B', 'DISK_LINE')}`;

interface Hooks {
  auto: 'ok' | 'hold';
  calls: [() => void, (e: Error) => void][];
  held: number;
}
const hook = (app: ElectronApplication) =>
  app.evaluate(({ ipcMain }) => {
    const map = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => unknown> })._invokeHandlers;
    const g = globalThis as unknown as { hooks: Hooks };
    g.hooks = { auto: 'ok', calls: [], held: 0 };
    const read = map.get('chapter:read')!;
    ipcMain.removeHandler('chapter:read');
    ipcMain.handle('chapter:read', async (...args: unknown[]) => {
      const h = g.hooks;
      if (!String(args[1]).endsWith('002.md') || h.auto === 'ok') return read(...args);
      h.held += 1;
      // 이 함수는 앱 안에서 실행된다: 이름이 붙는 함수 값을 만들지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없다)
      await new Promise<void>((resolve, reject) => h.calls.push([resolve, reject]));
      return read(...args);
    });
  });
const setAuto = (app: ElectronApplication, auto: Hooks['auto']) => app.evaluate((_e, a) => void ((globalThis as unknown as { hooks: Hooks }).hooks.auto = a), auto);
const heldCount = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { hooks: Hooks }).hooks.held);
const settle = (app: ElectronApplication, i: number, ok: boolean) => app.evaluate((_e, a) => void ((globalThis as unknown as { hooks: Hooks }).hooks.calls[a.i]![a.ok ? 0 : 1](new Error('EACCES: permission denied (synthetic read)'))), { i, ok });
const untilHeld = async (app: ElectronApplication, n: number) => {
  const deadline = Date.now() + 15_000;
  while ((await heldCount(app)) < n) {
    if (Date.now() > deadline) throw new Error(`읽기 요청 ${n}개 대기 시간 초과`);
    await new Promise((r) => setTimeout(r, 25));
  }
};
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

const editor = (page: Page) => page.locator('.ProseMirror');
const compare = (page: Page) => page.getByRole('region', { name: '내 화면과 디스크의 차이' });
const reloadButton = (page: Page) => compare(page).getByRole('button', { name: '다시 비교' }).first();
const reading = (page: Page) => compare(page).getByText(/디스크 내용을 (다시 )?읽는 중/);
const stats = (page: Page) => compare(page).getByText(/내 화면에만 \d+줄 · 디스크에만 \d+줄/);

async function start(prefix: string) {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), `${envelope('one', 'ONE')}${lines('ONLY_LINE')}`);
  const two = join(dir, 'chapters', '002.md');
  await writeFile(two, TWO);
  const { app, page } = await launch(await tempDir(`${prefix}-ud`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'TWO' }).click();
  await editor(page).getByText('CHANGE_ME', { exact: true }).waitFor();
  await editor(page).getByText('KEEP_A', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' MINE');
  await writeFile(two, OUTSIDE);
  await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
  await hook(app);
  await page.getByRole('button', { name: '차이 보기' }).click();
  await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
  return { app, page, two };
}
async function assertReadOnly(page: Page, two: string) {
  assert.equal(await readFile(two, 'utf8'), OUTSIDE, '디스크 바이트 그대로');
  assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 1, '충돌 상태 유지');
  assert.match(await editor(page).innerText(), /KEEP_A MINE/, '미저장 본문 유지');
}

test('[다시 비교] 대기 중에는 읽는 중임과 이전 비교임을 알리고, 성공하면 새 결과로 대기가 풀린다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start('ccr2-ok');
  try {
    assert.ok(await stats(page).count(), '최초 비교 통계');
    await setAuto(app, 'hold');
    await reloadButton(page).click();
    await untilHeld(app, 1);
    await reading(page).first().waitFor();
    assert.match(await compare(page).innerText(), /이전 내용/, '대기 중에는 보이는 비교가 이전 내용임을 알린다');
    await assertReadOnly(page, two);
    await settle(app, 0, true);
    await reading(page).waitFor({ state: 'detached' });
    assert.ok(await stats(page).count(), '새 결과의 통계');
    assert.doesNotMatch(await compare(page).innerText(), /이전 내용/, '완료하면 이전 내용 표시가 사라진다');
    await assertReadOnly(page, two);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('[다시 비교]가 실패하면 이전 비교를 최신인 것처럼 두지 않고 오류를 보이며, 재시도 중에는 이전 오류를 완료 오류처럼 두지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, two } = await start('ccr2-fail');
  try {
    await setAuto(app, 'hold');
    await reloadButton(page).click();
    await untilHeld(app, 1);
    await settle(app, 0, false);
    const alert = compare(page).getByRole('alert');
    await alert.waitFor({ timeout: 10_000 });
    assert.equal(await compare(page).locator('.diff li').count(), 0, '실패하면 이전 비교 줄을 최신 결과처럼 남기지 않는다');
    // 오류에서 재시도: 읽는 동안 이전 오류가 이번 결과처럼 남지 않는다
    await alert.getByRole('button', { name: '다시 비교' }).click();
    await untilHeld(app, 2);
    await reading(page).first().waitFor();
    assert.equal(await compare(page).getByRole('alert').count(), 0, '재시도 중에는 이전 오류를 가린다');
    await settle(app, 1, false);
    await compare(page).getByRole('alert').waitFor();
    await compare(page).getByRole('alert').getByRole('button', { name: '다시 비교' }).click();
    await untilHeld(app, 3);
    await settle(app, 2, true);
    await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
    assert.equal(await compare(page).getByRole('alert').count(), 0);
    await assertReadOnly(page, two);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('겹친 다시 비교는 가장 최근 요청의 결과만 반영하고, 비교를 닫은 뒤의 늦은 응답은 다시 연 비교를 오염하지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, two } = await start('ccr2-overlap');
  try {
    await setAuto(app, 'hold');
    await reloadButton(page).click(); // 0번 (오래된 요청)
    await untilHeld(app, 1);
    await reloadButton(page).click(); // 1번 (최신 요청)
    await untilHeld(app, 2);
    await settle(app, 1, true);
    await reading(page).waitFor({ state: 'detached' });
    assert.ok(await stats(page).count());
    // 오래된 요청이 뒤늦게 실패해도 최신 결과(성공)를 오류로 바꾸지 않는다
    await settle(app, 0, false);
    await frames(page);
    assert.equal(await compare(page).getByRole('alert').count(), 0, '오래된 실패가 최신 성공을 덮지 않는다');
    assert.ok(await stats(page).count());
    // 새 요청을 붙잡은 채 비교를 닫고 늦게 풀어도 다시 연 비교에 영향이 없다
    await reloadButton(page).click(); // 2번
    await untilHeld(app, 3);
    await page.getByRole('button', { name: '차이 닫기' }).click();
    await compare(page).waitFor({ state: 'detached' });
    await settle(app, 2, false);
    await frames(page);
    await setAuto(app, 'ok');
    await page.getByRole('button', { name: '차이 보기' }).click();
    await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
    assert.equal(await compare(page).getByRole('alert').count(), 0);
    assert.equal(await reading(page).count(), 0);
    await assertReadOnly(page, two);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
