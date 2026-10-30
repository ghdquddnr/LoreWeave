// 저장 충돌의 현재/디스크 차이 비교 (P4): 읽기 전용 비교, 비교하는 동안 계속 쓴 편집과 디스크 재변경 반영, 오래된 비교로 덮어쓰지 않음,
// 삭제·비UTF8 디스크, 내 내용 복사, 편집기 문서·선택·undo 불변, 원고 바이트(BOM·CRLF·frontmatter) 보존.
// 실제 앱(Electron + Playwright). 합성 원고·별도 userData. 외부 변경은 테스트가 파일을 직접 고친다 (다른 프로그램 흉내).

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const ONE = `${envelope('one', 'ONE')}${lines('ONLY_LINE')}`;
const TWO = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B')}`;

const editor = (page: Page) => page.locator('.ProseMirror');
const compare = (page: Page) => page.getByRole('region', { name: '내 화면과 디스크의 차이' });
const rows = (page: Page) => compare(page).locator('.diff li').evaluateAll((els) => els.map((e) => `${e.className.replace('diff-', '')}:${e.querySelector('.diff-text')?.textContent ?? e.textContent}`));

async function start(): Promise<{ app: ElectronApplication; page: Page; dir: string; two: string }> {
  const dir = await tempDir('conflict-compare');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  const two = join(dir, 'chapters', '002.md');
  await writeFile(two, TWO);
  const { app, page } = await launch(await tempDir('conflict-compare-ud'));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'TWO' }).click();
  await editor(page).getByText('CHANGE_ME', { exact: true }).waitFor();
  return { app, page, dir, two };
}
const typeIn = async (page: Page, text: string, add: string) => {
  await editor(page).getByText(text, { exact: true }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(add);
};
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as unknown as { editor: { state: { selection: { from: number; to: number } }; can(): { undo(): boolean } }; __marker?: number };
    return { marker: pm.__marker ?? null, from: pm.editor.state.selection.from, to: pm.editor.state.selection.to, canUndo: pm.editor.can().undo() };
  });

test('차이 보기: 내 화면(−)과 디스크(+)를 줄 단위로 보여 주고, 비교하는 동안 계속 쓴 내용과 디스크 재변경을 따라가며, 비교만으로는 아무것도 바꾸지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, two } = await start();
  try {
    await typeIn(page, 'CHANGE_ME', ' MINE1');
    await page.evaluate(() => void ((document.querySelector('.ProseMirror') as unknown as { __marker: number }).__marker = 4));
    const outside1 = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME BY_DISK1', '', 'KEEP_B', 'DISK_ONLY_LINE')}`;
    await writeFile(two, outside1);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    const before = await snapshot(page);

    await page.getByRole('button', { name: '차이 보기' }).click();
    await compare(page).getByText('내 화면에만 1줄 · 디스크에만 2줄').waitFor();
    assert.deepEqual(await rows(page), ['same:KEEP_A', 'same:(빈 줄)', 'del:CHANGE_ME MINE1', 'add:CHANGE_ME BY_DISK1', 'same:(빈 줄)', 'same:KEEP_B', 'add:DISK_ONLY_LINE']);
    assert.equal(await page.getByRole('button', { name: '차이 닫기' }).getAttribute('aria-expanded'), 'true');
    // 비교는 읽기 전용: 디스크도 편집기 상태도 그대로
    assert.equal(await readFile(two, 'utf8'), outside1);
    assert.deepEqual(await snapshot(page), before, '비교를 열어도 편집기 노드·선택·undo 가능 여부가 그대로');

    // 비교하는 동안 계속 쓴 내용: 내 쪽(−)만 다시 계산된다
    await typeIn(page, 'CHANGE_ME MINE1', ' MINE2');
    await compare(page).locator('.diff-del', { hasText: 'CHANGE_ME MINE1 MINE2' }).waitFor({ timeout: 5000 });

    // 디스크가 또 바뀜(watcher 알림): 디스크 쪽(+)을 다시 읽는다
    const outside2 = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME BY_DISK2', '', 'KEEP_B')}`;
    await writeFile(two, outside2);
    await compare(page).locator('.diff-add', { hasText: 'CHANGE_ME BY_DISK2' }).waitFor({ timeout: 15_000 });
    assert.equal(await compare(page).locator('.diff-add', { hasText: 'BY_DISK1' }).count(), 0, '오래된 디스크 내용은 남지 않는다');
    assert.equal(await compare(page).locator('.diff-add', { hasText: 'DISK_ONLY_LINE' }).count(), 0);

    // 내 내용 복사: 클립보드에 내 화면의 글이 들어간다
    await compare(page).getByRole('button', { name: '내 내용 복사' }).click();
    await compare(page).getByText('복사했습니다').waitFor();
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.match(clip, /CHANGE_ME MINE1 MINE2/);
    assert.match(clip, /KEEP_B/);

    // 내 것으로 덮어쓰기: 가장 최근 디스크 해시로 확인해 쓴다. 바이트는 BOM·CRLF·frontmatter를 지킨다
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(two, 'utf8'), `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME MINE1 MINE2', '', 'KEEP_B')}`);
    assert.equal(await compare(page).count(), 0, '충돌이 풀리면 비교 화면도 닫힌다');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('디스크 삭제: 비교 버튼 없이 안내하고, 내 것으로 다시 만들면 내 글이 그대로 파일이 된다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start();
  try {
    await typeIn(page, 'KEEP_B', ' MINE_AFTER_DELETE');
    await rm(two);
    await page.getByRole('button', { name: '내 것으로 다시 만들기' }).waitFor({ timeout: 15_000 });
    await page.getByText('이 화 파일이 다른 곳에서 지워졌거나 이름이 바뀌었습니다.').waitFor();
    assert.equal(await page.getByRole('button', { name: '차이 보기' }).count(), 0, '지워진 파일은 비교할 대상이 없다');
    await page.getByRole('button', { name: '내 것으로 다시 만들기' }).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(two, 'utf8'), `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B MINE_AFTER_DELETE')}`);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('디스크가 UTF-8이 아니게 바뀜: 비교는 읽을 수 없다고 알리고(기술 원문은 상세로), 아무것도 덮어쓰지 않으며 내 글은 화면에 남는다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start();
  try {
    await typeIn(page, 'KEEP_A', ' MINE_STAYS');
    const bad = Buffer.from([0xff, 0xfe, 0xfd, 0x80, 0x81, 0x0a, 0xc3, 0x28]);
    await writeFile(two, bad);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: '차이 보기' }).click();
    const alert = compare(page).getByRole('alert');
    await alert.waitFor({ timeout: 10_000 });
    const text = await alert.innerText();
    assert.doesNotMatch(text, /Error invoking|ENOENT|EISDIR|[A-Z]:\\/, '기본 안내에는 IPC 문구·코드·경로가 없다');
    await alert.getByRole('button', { name: '다시 비교' }).waitFor();
    assert.deepEqual(await readFile(two), bad, '디스크는 아무것도 덮어쓰지 않았다');
    await editor(page).getByText('KEEP_A MINE_STAYS', { exact: true }).waitFor();
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('충돌을 디스크 내용 불러오기로 풀거나 다른 화로 옮기면 상태줄이 "저장 멈춤"에 머물지 않고 새 편집기의 저장됨으로 돌아온다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start();
  try {
    await typeIn(page, 'KEEP_A', ' MINE_DISCARDED');
    const outside = `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B', 'FROM_DISK')}`;
    await writeFile(two, outside);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    await page.getByRole('status').getByText('저장 멈춤', { exact: false }).waitFor();
    await page.getByRole('button', { name: /디스크 내용 불러오기/ }).click();
    await editor(page).getByText('FROM_DISK', { exact: true }).waitFor();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole('status').getByText('저장 멈춤', { exact: false }).count(), 0, '불러온 뒤에는 저장 멈춤이 남지 않는다');
    assert.equal(await readFile(two, 'utf8'), outside, '디스크는 그대로');
    // 충돌 상태에서 다른 화로 옮겨도(확인에서 계속) 새 화의 상태줄은 저장됨이다
    await typeIn(page, 'KEEP_A', ' AGAIN');
    await writeFile(two, `${outside}\r\nSECOND_OUTSIDE`);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'ONE' }).click();
    await editor(page).getByText('ONLY_LINE', { exact: true }).waitFor();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByRole('status').getByText('저장 멈춤', { exact: false }).count(), 0);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('내 내용 복사는 누른 순간의 편집기 문서를 복사한다: 비교가 열린 채 바로 이어서 쓰고 복사해도, 연속 복사해도 최신 입력이 들어간다', { timeout: 90_000 }, async () => {
  const { app, page, two } = await start();
  try {
    await typeIn(page, 'KEEP_A', ' MINE');
    await writeFile(two, `${envelope('two', 'TWO')}${lines('KEEP_A', '', 'CHANGE_ME', '', 'KEEP_B', 'DISK_LINE')}`);
    await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).waitFor({ timeout: 15_000 });
    await page.getByRole('button', { name: '차이 보기' }).click();
    await compare(page).locator('.diff li').first().waitFor({ timeout: 10_000 });
    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
    // 비교가 준비된 뒤 편집하고 debounce(400ms) 전에 바로 복사
    await typeIn(page, 'KEEP_A MINE', ' LATEST_BACKUP_MARKER');
    await compare(page).getByRole('button', { name: '내 내용 복사' }).click();
    await compare(page).getByText('복사했습니다').waitFor();
    let clip = await clipboard();
    assert.match(clip, /LATEST_BACKUP_MARKER/, '복사 직전의 입력이 백업에 있다');
    assert.match(clip, /KEEP_A MINE LATEST_BACKUP_MARKER/);
    // 연속 복사: 또 쓰고 바로 다시 복사
    await typeIn(page, 'KEEP_A MINE LATEST_BACKUP_MARKER', ' SECOND_MARKER');
    await compare(page).getByRole('button', { name: '내 내용 복사' }).click();
    await page.waitForTimeout(150);
    clip = await clipboard();
    assert.match(clip, /LATEST_BACKUP_MARKER SECOND_MARKER/);
    assert.doesNotMatch(clip, /DISK_LINE/, '디스크 내용이 섞이지 않는다');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
