// 같은 프로젝트 세대·같은 파일에서 watcher의 파일 읽기 두 개가 서로 다른 순서로 끝나도, 더 최신 바깥 변경(수정/삭제)이 이미 알려졌다면
// 먼저 시작한 옛 읽기의 해시가 그 뒤에 renderer로 전달되어 최신 상태를 되돌리지 않는지 본다.
// (late-save-response/result는 저장 응답의 역전이다. 여기는 watcher 읽기끼리의 역전이다. stale-watcher는 세대 사이의 역전이다.)
// 장벽: 첫 watcher 읽기가 X1 바이트를 얻은 직후 반환만 붙잡는다. 관측: main이 renderer로 보낸 chapter:changed-outside 메시지(file, hash)를
// 창의 webContents.send에서 그대로 기록한다 (renderer가 처리한 입력은 그 메시지다). 화면은 안내·본문으로 확인한다.
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const body = (text: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${text}\r\n`;
const X1 = body('first outside');
const X2 = body('second outside');
const X3 = body('third outside');

async function project(): Promise<string> {
  const dir = await tempDir('watcher-order');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const alert = (page: Page) => page.getByRole('alert');

type Sent = { file: string; hash: string | null };
type G = { armed: boolean; held: boolean; holds: number; sent: Sent[]; release?: () => void };
/** armed일 때 화 파일(target)을 처음 읽은 직후 반환을 붙잡는다. 창으로 나가는 chapter:changed-outside 메시지를 기록한다 */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate(({ BrowserWindow }, target) => {
    const g = globalThis as unknown as G;
    g.armed = false;
    g.held = false;
    g.holds = 0;
    g.sent = [];
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (g.armed && String(path) === target) {
        g.armed = false;
        g.holds++;
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
      return bytes;
    }) as typeof fsp.readFile;
    const wc = BrowserWindow.getAllWindows()[0]!.webContents;
    const send = wc.send.bind(wc);
    wc.send = ((channel: string, ...args: unknown[]) => {
      if (channel === 'chapter:changed-outside') g.sent.push(args[0] as Sent);
      return send(channel, ...args);
    }) as typeof wc.send;
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const state = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, holds: g.holds, sent: [...g.sent] }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
const hashOf = (text: string) => createHash('sha256').update(Buffer.from(text)).digest('hex');

async function start() {
  const dir = await project();
  const path = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('watcher-order-userdata'));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('Alpha text').waitFor();
  await install(app, path);
  return { app, page, path };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

test('watcher 읽기 역전 (수정): 더 최신 수정 X2가 알려진 뒤 옛 읽기(X1)가 늦게 끝나도 그 해시는 renderer로 가지 않고, 이후 실제 변경은 여전히 알려진다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    // 1) 첫 읽기: X1 바이트를 얻은 직후 반환이 붙잡힌다
    await arm(app);
    await writeFile(path, X1);
    await waitUntil(page, '첫 watcher 읽기를 붙잡지 못했다', async () => (await state(app)).held);
    assert.deepEqual((await state(app)).sent, [], '첫 읽기는 아직 아무것도 보내지 않았다');
    // 2) 더 최신 수정 X2: 두 번째 읽기가 끝나 renderer로 전달된다 (메시지와 화면으로 확인)
    await writeFile(path, X2);
    await waitUntil(page, 'X2 변경이 renderer로 전달되지 않았다', async () => (await state(app)).sent.length === 1);
    assert.deepEqual((await state(app)).sent, [{ file: '001.md', hash: hashOf(X2) }]);
    await editor(page).getByText('second outside').waitFor({ timeout: 10_000 });
    // 3) 옛 읽기를 푼다: main이 그 결과를 renderer로 보내지 않아야 한다 (읽기가 반환된 뒤의 메시지 목록으로 판단)
    await release(app);
    await waitUntil(page, '첫 읽기가 반환되지 않았다', async () => !(await state(app)).held);
    // 반환 뒤의 비동기 처리(then)가 끝나도록 main에서 한 번 더 이벤트 루프를 돈다
    await app.evaluate(() => new Promise<void>((r) => setImmediate(r)));
    assert.deepEqual((await state(app)).sent, [{ file: '001.md', hash: hashOf(X2) }], '옛 읽기의 해시(X1)가 renderer로 전달되었다');
    assert.equal(await editor(page).getByText('second outside').count(), 1);
    assert.equal(await readFile(path, 'utf8'), X2);
    // 4) 그 뒤의 실제 바깥 변경 X3은 여전히 알려진다
    await writeFile(path, X3);
    await waitUntil(page, 'X3 변경이 renderer로 전달되지 않았다', async () => (await state(app)).sent.length === 2);
    assert.deepEqual((await state(app)).sent[1], { file: '001.md', hash: hashOf(X3) });
    await editor(page).getByText('third outside').waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), X3);
  } finally {
    await cleanup(app, page);
  }
});

test('watcher 읽기 역전 (삭제): 더 최신 삭제가 알려진 뒤 옛 읽기(X1)가 늦게 끝나도 삭제 안내와 수락한 입력이 유지되고, 사용자가 고르면 다시 만든다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    await arm(app);
    await writeFile(path, X1);
    await waitUntil(page, '첫 watcher 읽기를 붙잡지 못했다', async () => (await state(app)).held);
    // 최신 상태: 바깥이 파일을 지웠다. 두 번째 읽기(null)가 전달되고 삭제 안내가 뜬다
    await rm(path);
    await waitUntil(page, '삭제가 renderer로 전달되지 않았다', async () => (await state(app)).sent.length === 1);
    assert.deepEqual((await state(app)).sent, [{ file: '001.md', hash: null }]);
    await alert(page).getByText(/지워졌거나 이름이 바뀌었습니다/).waitFor({ timeout: 10_000 });
    // 충돌 중에 받아들인 입력 (자동 저장은 충돌로 멈춰 있다)
    await editor(page).getByText('Alpha text').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' A');
    // 옛 읽기를 푼다
    await release(app);
    await waitUntil(page, '첫 읽기가 반환되지 않았다', async () => !(await state(app)).held);
    await app.evaluate(() => new Promise<void>((r) => setImmediate(r)));
    assert.deepEqual((await state(app)).sent, [{ file: '001.md', hash: null }], '옛 읽기의 해시(X1)가 삭제 뒤에 renderer로 전달되었다');
    assert.equal(await alert(page).getByText(/지워졌거나 이름이 바뀌었습니다/).count(), 1, '삭제 안내가 옛 해시 안내로 바뀌었다');
    assert.equal(await editor(page).getByText('Alpha text A', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    await assert.rejects(readFile(path), /ENOENT/);
    await page.getByRole('button', { name: '내 것으로 다시 만들기' }).click();
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), body('Alpha text A'));
  } finally {
    await cleanup(app, page);
  }
});
