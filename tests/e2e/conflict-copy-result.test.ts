// 충돌 비교의 [내 내용 복사]는 대기·성공·실패를 정확히 알린다: 실패하면 실패라고 하고 다시 시도할 수 있으며, 이전 성공 안내가 이번 대기·실패 뒤에 남지 않고,
// 겹친 복사는 최신 조작의 결과만 보인다. 복사가 실패해도 원고 저장·덮어쓰기·디스크 불러오기는 실행되지 않고 충돌 상태·미저장 본문·디스크 바이트는 그대로다.
// 합성 원고·격리 userData. renderer의 navigator.clipboard.writeText를 테스트 대역으로 바꿔 호출별로 장벽(성공/거절/붙잡기)을 건다 (실제 OS 클립보드·수동 GUI 확인이 아님). 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const TWO = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B')}`;
const OUTSIDE = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B', 'DISK_LINE')}`;

interface Clip {
  auto: 'ok' | 'fail' | 'hold';
  calls: { text: string; settle(ok: boolean): void }[];
}
const editor = (page: Page) => page.locator('.ProseMirror');
const compare = (page: Page) => page.getByRole('region', { name: '내 화면과 디스크의 차이' });
const copyButton = (page: Page) => compare(page).getByRole('button', { name: '내 내용 복사' });
const note = (page: Page) => compare(page).locator('.copy-note');
const setAuto = (page: Page, auto: Clip['auto']) => page.evaluate((a) => void ((window as unknown as { __clip: Clip }).__clip.auto = a), auto);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __clip: Clip }).__clip.calls.map((c) => c.text));
const settle = (page: Page, i: number, ok: boolean) => page.evaluate(([i, ok]) => (window as unknown as { __clip: Clip }).__clip.calls[i as number]!.settle(ok as boolean), [i, ok] as const);
const settledFrames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

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
  // 문자열로 넘긴다: 테스트 변환기가 함수에 붙이는 이름 도우미(__name)가 renderer에는 없다
  await page.evaluate(`(() => {
    const clip = { auto: 'ok', calls: [] };
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
  // 충돌 상태 만들기: 내 입력 + 바깥 변경
  await editor(page).getByText('KEEP_A', { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' MINE');
  await writeFile(two, OUTSIDE);
  await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: '차이 보기' }).click();
  await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
  return { app, page, two };
}
const typeMore = async (page: Page, text: string, add: string) => {
  await editor(page).getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(add);
};
/** 복사 뒤에도 충돌 상태·미저장 본문·디스크 바이트가 그대로다 (복사 실패가 저장·덮어쓰기·불러오기를 대신하지 않는다) */
async function assertUntouched(page: Page, two: string, mine: RegExp) {
  assert.equal(await readFile(two, 'utf8'), OUTSIDE, '디스크 바이트 그대로');
  assert.equal(await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).count(), 1, '충돌 상태 유지');
  assert.match(await editor(page).innerText(), mine, '미저장 본문 유지');
}

test('복사가 실패하면 실패라고 알리고 다시 시도할 수 있으며, 원고·충돌 상태는 그대로다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start('ccr-fail');
  try {
    await setAuto(page, 'fail');
    await copyButton(page).click();
    await note(page).getByText(/복사하지 못했습니다/).waitFor({ timeout: 10_000 });
    assert.equal(await compare(page).getByText('복사했습니다').count(), 0, '실패를 성공으로 보이지 않는다');
    await assertUntouched(page, two, /KEEP_A MINE/);
    // 다시 시도: 이번엔 성공
    await setAuto(page, 'ok');
    await copyButton(page).click();
    await note(page).getByText('복사했습니다').waitFor();
    assert.equal(await note(page).getByText(/복사하지 못했습니다/).count(), 0, '이전 실패 안내가 남지 않는다');
    assert.equal((await calls(page)).length, 2, '시도마다 한 번씩');
    await assertUntouched(page, two, /KEEP_A MINE/);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('이전 성공 안내는 새 복사의 대기·실패 동안 남지 않고, 대기 중 안내가 있으며, 클릭 시점의 최신 본문을 복사한다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start('ccr-stale');
  try {
    await copyButton(page).click();
    await note(page).getByText('복사했습니다').waitFor();
    // 새 입력 → 재복사를 붙잡는다: 이전 성공 안내가 사라지고 대기 중으로 보인다
    await typeMore(page, 'KEEP_A MINE', ' LATER');
    await setAuto(page, 'hold');
    await copyButton(page).click();
    await note(page).getByText(/복사하는 중/).waitFor();
    assert.equal(await compare(page).getByText('복사했습니다').count(), 0, '대기 중에는 이전 성공 안내가 남지 않는다');
    assert.match((await calls(page))[1]!, /KEEP_A MINE LATER/, '클릭 시점의 최신 본문을 복사한다');
    await settle(page, 1, false);
    await note(page).getByText(/복사하지 못했습니다/).waitFor();
    assert.equal(await compare(page).getByText('복사했습니다').count(), 0, '이전 성공이 이번 실패 뒤에 되살아나지 않는다');
    // 같은 흐름의 성공
    await copyButton(page).click();
    await note(page).getByText(/복사하는 중/).waitFor();
    await settle(page, 2, true);
    await note(page).getByText('복사했습니다').waitFor();
    await assertUntouched(page, two, /KEEP_A MINE LATER/);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('겹친 복사는 최신 조작의 결과만 반영하고, 비교를 닫은 뒤의 늦은 응답은 다시 연 비교를 오염하지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start('ccr-overlap');
  try {
    await setAuto(page, 'hold');
    await copyButton(page).click(); // 0번 (먼저)
    await typeMore(page, 'KEEP_A MINE', ' NEWER');
    await copyButton(page).click(); // 1번 (최신)
    await note(page).getByText(/복사하는 중/).waitFor();
    assert.equal((await calls(page)).length, 2);
    // 최신(1번)이 실패, 오래된(0번)이 뒤늦게 성공해도 최신 결과(실패)를 덮지 않는다
    await settle(page, 1, false);
    await note(page).getByText(/복사하지 못했습니다/).waitFor();
    await settle(page, 0, true);
    await settledFrames(page);
    assert.equal(await compare(page).getByText('복사했습니다').count(), 0, '오래된 성공이 최신 실패를 덮지 않는다');
    await note(page).getByText(/복사하지 못했습니다/).waitFor();
    // 새 복사를 붙잡은 채 비교를 닫고, 늦게 풀어도 다시 연 비교에 안내가 남지 않는다
    await copyButton(page).click(); // 2번
    await note(page).getByText(/복사하는 중/).waitFor();
    await page.getByRole('button', { name: '차이 닫기' }).click();
    await compare(page).waitFor({ state: 'detached' });
    await settle(page, 2, true);
    await settledFrames(page);
    await page.getByRole('button', { name: '차이 보기' }).click();
    await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
    assert.equal(await note(page).count(), 0, '다시 연 비교에 이전 복사 안내가 남지 않는다');
    await assertUntouched(page, two, /KEEP_A MINE NEWER/);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
