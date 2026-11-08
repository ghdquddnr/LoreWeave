// 충돌 안내의 [디스크 내용 불러오기 (내 수정은 버림)]: 미저장 수정이 사라지는 동작이라 먼저 폐기 확인을 받는다. 취소하면 편집기·undo·충돌 안내·디스크가 그대로이고, 수락했을 때만 기존 수동 reload 경로로 디스크 내용을 한 번 읽는다.
// 깨끗한 화의 외부 변경 자동 재읽기에는 폐기 확인이 없다.
// 합성 원고(BOM + CRLF + frontmatter)·격리 userData·실제 충돌 UI. main의 chapter:read/chapter:write를 호출 수 대역(원래 처리기로 통과)으로 감싸고, 확인(window.confirm)은 Playwright dialog 이벤트로 테스트가 제어하는 합성 검사다.
// 이 검사 안에서만 renderer의 1500ms 자동 저장 타이머를 가로채 미저장 입력이 저장되는 경합을 없앤다. 실제 OS IME·수동 GUI 확인이 아니다. 유료·외부 호출 없음.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const doc = (body: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${body}\r\n`;
const MESSAGE = '저장되지 않은 내 수정이 사라지고 디스크 내용을 불러옵니다. 계속할까요?';

const counts = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { c: { reads: number; writes: number } }).c);
const editor = (page: Page) => page.locator('.ProseMirror');
const overwriteButton = (page: Page) => page.getByRole('button', { name: '내 것으로 덮어쓰기' });
const reloadButton = (page: Page) => page.getByRole('button', { name: /디스크 내용 불러오기/ });
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('디스크 내용 불러오기: 폐기 확인을 먼저 받고, 취소하면 아무것도 바뀌지 않으며, 수락했을 때만 디스크 내용을 한 번 읽는다. 깨끗한 외부 변경 자동 재읽기에는 확인이 없다', { timeout: 120_000 }, async () => {
  const dir = await tempDir('conflict-reload-confirm');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, doc('Alpha text'));
  const { app, page } = await launch(await tempDir('conflict-reload-confirm-ud'));
  // 확인 응답은 테스트가 정한다 (accept 값). 메시지를 모두 기록한다
  const asked: string[] = [];
  let accept = false;
  page.on('dialog', (d) => {
    asked.push(d.message());
    void (accept ? d.accept() : d.dismiss());
  });
  try {
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { c: { reads: number; writes: number } };
      g.c = { reads: 0, writes: 0 };
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      for (const [channel, key] of [['chapter:read', 'reads'], ['chapter:write', 'writes']] as const) {
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
    await editor(page).getByText('Alpha text').waitFor();
    await page.evaluate(`(() => {
      const real = window.setTimeout.bind(window);
      window.setTimeout = (fn, delay, ...rest) => (delay === 1500 ? 0 : real(fn, delay, ...rest));
    })()`);

    // 미저장 수정 + 외부 변경 → 충돌
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' MINE');
    const external = doc('Alpha from disk');
    await writeFile(path, external);
    await overwriteButton(page).waitFor({ timeout: 15_000 });
    await reloadButton(page).waitFor();
    const base = await counts(app);
    assert.equal(base.writes, 0);

    // 1) 확인에서 취소: 본문·undo·충돌 안내·디스크가 그대로이고 읽기·쓰기도 없다. 계속 편집·차이 보기 가능
    await reloadButton(page).click();
    await settled(page);
    assert.deepEqual(asked, [MESSAGE], '폐기 확인을 먼저 받았다');
    assert.equal(await editor(page).getByText('Alpha text MINE', { exact: true }).count(), 1, '취소하면 미저장 본문이 그대로다');
    assert.equal(await overwriteButton(page).count(), 1, '충돌 안내가 그대로다');
    const afterCancel = await counts(app);
    assert.equal(afterCancel.reads, base.reads, '취소하면 디스크를 읽지 않았다');
    assert.equal(afterCancel.writes, 0, '취소가 저장을 만들지 않았다');
    assert.ok((await readFile(path, 'utf8')) === external, '디스크 바이트는 그대로다');
    await page.getByRole('button', { name: '차이 보기' }).click();
    await page.getByRole('region', { name: '내 화면과 디스크의 차이' }).waitFor();
    await page.getByRole('button', { name: '차이 닫기' }).click();
    // undo 기록이 살아 있다 (편집기가 교체되지 않았다): Ctrl+Z로 방금 쓴 글자가 되돌아간다
    await editor(page).getByText('Alpha text MINE').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+Z');
    await settled(page);
    assert.equal(await editor(page).getByText('Alpha text MINE', { exact: true }).count(), 0, 'undo 기록이 유지된다');
    await page.keyboard.press('Control+Shift+Z');
    await editor(page).getByText('Alpha text MINE', { exact: true }).waitFor();

    // 2) 확인 수락: 기존 수동 reload 경로로 디스크 내용을 읽는다 (읽기 1, 쓰기 0)
    accept = true;
    const readsBefore = (await counts(app)).reads;
    await reloadButton(page).click();
    await editor(page).getByText('Alpha from disk', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(asked.length, 2, '수락 때도 확인은 한 번만 물었다');
    const afterAccept = await counts(app);
    assert.equal(afterAccept.reads, readsBefore + 1, '디스크를 한 번 읽었다');
    assert.equal(afterAccept.writes, 0, '불러오기가 저장을 만들지 않았다');
    assert.equal(await overwriteButton(page).count(), 0, '충돌이 풀렸다');
    assert.ok((await readFile(path, 'utf8')) === external, '디스크 바이트는 그대로다');

    // 3) 깨끗한 화의 외부 변경 자동 재읽기에는 폐기 확인이 없다
    const askedBefore = asked.length;
    await writeFile(path, doc('Alpha changed again'));
    await editor(page).getByText('Alpha changed again', { exact: true }).waitFor({ timeout: 15_000 });
    assert.equal(asked.length, askedBefore, '깨끗한 외부 변경 재읽기에는 폐기 확인이 없다');
    assert.equal((await counts(app)).writes, 0);
  } finally {
    accept = true;
    await closeWindow(app);
  }
});
