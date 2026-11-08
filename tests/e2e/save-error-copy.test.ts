// 일반 저장 실패 안내의 [본문 복사]: 눌렀을 때만, 누른 순간의 보이는 본문 전체를 복사한다.
// 복사 대기·성공·실패를 알리고 실패 뒤 다시 시도할 수 있으며, 어느 경우에도 저장 실패 상태·원고 입력·디스크 바이트는 그대로다.
// 합성 원고·격리 userData. 저장 실패는 main의 chapter:write 처리기를 대역으로 바꿔 만들고(무료 IPC 대역), 클립보드는 renderer의 navigator.clipboard.writeText 대역이다.
// 실제 OS 클립보드·수동 GUI·실제 IME 확인이 아니다. 유료·외부 호출 없음. 본문은 로그에 출력하지 않고 동등 여부만 판정한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n\r\nSecond line\r\n';

interface Clip {
  auto: 'ok' | 'fail';
  calls: string[];
}
const editor = (page: Page) => page.locator('.ProseMirror');
const bar = (page: Page) => page.locator('footer.statusbar');
const copyButton = (page: Page) => bar(page).getByRole('button', { name: '본문 복사', exact: true });
const note = (page: Page) => bar(page).locator('.copy-note');
const setAuto = (page: Page, auto: Clip['auto']) => page.evaluate((a) => void ((window as unknown as { __clip: Clip }).__clip.auto = a), auto);
const calls = (page: Page) => page.evaluate(() => (window as unknown as { __clip: Clip }).__clip.calls);
const writeCalls = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { writes: number }).writes);

async function start() {
  const dir = await tempDir('save-error-copy');
  await mkdir(join(dir, 'chapters'));
  const path = join(dir, 'chapters', '001.md');
  await writeFile(path, ONE);
  const { app, page } = await launch(await tempDir('save-error-copy-ud'));
  // chapter:write를 항상 실패시킨다 (EACCES). 호출 수를 센다
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as { writes: number };
    g.writes = 0;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers;
    handlers.set('chapter:write', async () => {
      g.writes++;
      throw Object.assign(new Error('EACCES: permission denied (synthetic)'), { code: 'EACCES' });
    });
  });
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'One' }).click();
  await editor(page).getByText('Alpha text').waitFor();
  await page.evaluate(`(() => {
    const clip = { auto: 'ok', calls: [] };
    window.__clip = clip;
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: (text) => {
        clip.calls.push(text);
        return clip.auto === 'ok' ? Promise.resolve() : Promise.reject(new Error('NotAllowedError (synthetic)'));
      },
    });
  })()`);
  return { app, page, path };
}

test('저장 실패 중 [본문 복사]는 누른 순간의 본문을 복사하고, 실패 뒤 다시 시도되며, 저장 실패·원고·디스크는 그대로다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  page.on('dialog', (d) => void d.accept()); // 저장 실패 상태로 끝내므로 정리용으로만 닫기 확인을 수락한다 (판정에 쓰지 않는다)
  try {
    // 저장이 실패하기 전에는 복사 버튼이 없고, 눌러서 복사된 적도 없다
    assert.equal(await copyButton(page).count(), 0);
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await bar(page).getByText('저장 실패', { exact: false }).waitFor({ timeout: 30_000 });
    await copyButton(page).waitFor();
    assert.deepEqual(await calls(page), [], '누르기 전에는 자동으로 복사되지 않는다');

    // 복사 직전의 추가 입력(디바운스·저장 시도 이전의 본문이 아니다)이 포함되어야 한다
    await page.keyboard.type(' B');
    const expected = 'Alpha text A B\n\nSecond line';
    await setAuto(page, 'fail');
    await copyButton(page).click();
    await note(page).getByText('복사하지 못했습니다').waitFor();
    assert.equal((await calls(page)).length, 1);
    assert.ok((await calls(page))[0] === expected, '실패한 시도도 누른 순간의 본문 전체(줄바꿈 포함)를 넘겼다');
    // 클립보드 실패가 저장 실패를 덮거나 해결된 것처럼 보이게 하지 않는다
    assert.ok(/저장 실패/.test(await bar(page).innerText()), '저장 실패 표시 유지');
    assert.equal(await copyButton(page).count(), 1, '다시 시도할 수 있다');

    // 다시 시도: 성공. 성공해도 저장됨으로 바뀌지 않는다
    await setAuto(page, 'ok');
    await copyButton(page).click();
    await note(page).getByText('본문 글자만 복사했습니다').waitFor();
    assert.equal((await calls(page)).length, 2);
    assert.ok((await calls(page))[1] === expected, '성공한 시도의 본문이 같다');
    const text = await bar(page).innerText();
    assert.ok(/저장 실패/.test(text) && !/저장됨/.test(text), '성공해도 저장됨으로 바뀌지 않는다');
    assert.ok(/저장된 것은 아닙니다/.test(text), '본문 복사임을 정확히 알린다');

    // 복사는 원고·디스크를 바꾸지 않고 추가 저장도 촉발하지 않는다. 입력은 그대로다
    const before = await writeCalls(app);
    await page.waitForTimeout(300);
    assert.equal(await writeCalls(app), before, '복사가 저장을 촉발하지 않았다');
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1, '입력 보존');
    assert.ok((await readFile(path, 'utf8')) === ONE, '원고 원본 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});
