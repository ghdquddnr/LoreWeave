// 저장이 진행 중일 때 에디터가 받아들인 추가 입력(B)이 사라지거나, 먼저 시작한 저장의 응답(A)이 "저장됨"으로 오인되지 않는지 본다.
// 장벽은 main의 디스크 호출이다: 저장이 임시 파일을 연(open) 직후 붙잡는다 (고정 대기나 부하로 경합을 만들지 않는다).
// 실제 앱(Electron + Playwright). 실제 API는 쓰지 않는다. 원고는 임시 폴더의 합성 원고(BOM + CRLF + frontmatter)다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const TWO = '# Two\n\nBeta text\n';
const withText = (text: string) => ONE.replace('Alpha text', text);

async function project(): Promise<string> {
  const dir = await tempDir('inflight-input');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const read = (dir: string, f = '001.md') => readFile(join(dir, 'chapters', f), 'utf8');
const status = (page: Page, text: string) => page.getByRole('status').getByText(text, { exact: true });

type G = { held: boolean; armed: boolean; opens: number; release?: () => void };
/** prefix 아래 파일을 연 직후, 무장된 장벽이 있으면 그 호출을 붙잡는다. 한 번 붙잡으면 해제될 때까지 무장이 꺼진다 */
async function installBarrier(app: ElectronApplication, prefix: string) {
  await app.evaluate((_e, prefix) => {
    const g = globalThis as unknown as G;
    const fsp = process.getBuiltinModule('fs/promises');
    g.held = false;
    g.armed = false;
    g.opens = 0;
    const open = fsp.open;
    fsp.open = (async (path: string, ...args: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (String(path).startsWith(prefix)) {
        g.opens++;
        if (g.armed) {
          g.armed = false;
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
          g.held = false;
        }
      }
      return handle;
    }) as typeof fsp.open;
  }, join(prefix, 'chapters'));
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const opens = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).opens);
const isHeld = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).held);
/** 장벽에 걸릴 때까지 (수신 증거: main이 임시 파일을 열었다) */
async function waitHeld(page: Page, app: ElectronApplication) {
  for (let n = 0; n < 500 && !(await isHeld(app)); n++) await page.waitForTimeout(10);
  assert.equal(await isHeld(app), true, '저장을 붙잡지 못했다');
}

/** 상태 줄(role=status)의 글자가 바뀔 때마다 window.statusSeen에 쌓는다 */
const recordStatus = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { statusSeen: string[] };
    w.statusSeen = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[role="status"]')) w.statusSeen.push((el as HTMLElement).innerText);
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });

async function start(userData: string, dir: string) {
  const { app, page } = await launch(userData);
  await installBarrier(app, dir);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('Alpha text').click();
  await page.keyboard.press('End');
  return { app, page };
}

test('저장 중 받아들인 입력 B: 먼저 시작한 저장 A의 응답은 "저장됨"이 아니고, A만 먼저 디스크에 있다가 B가 다음 저장으로 들어간다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await start(await tempDir('inflight-input-userdata'), dir);
  try {
    await arm(app);
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await waitHeld(page, app);
    await status(page, '저장 중…').waitFor();
    // 저장 A가 main에서 붙잡힌 동안 에디터는 B를 받아들인다
    await page.keyboard.type(' B');
    assert.equal(await editor(page).getByText('Alpha text A B', { exact: true }).count(), 1);
    assert.equal(await read(dir), ONE, 'A가 디스크에 닿기 전이다');
    // 다음 저장(B)의 쓰기도 붙잡아, A의 응답 뒤 B가 디스크에 닿기 전의 상태를 고정한다
    const before = await opens(app);
    await arm(app);
    await recordStatus(page);
    await release(app);
    await waitHeld(page, app);
    assert.ok((await opens(app)) > before, '다음 저장이 시작되지 않았다');
    assert.equal(await read(dir), withText('Alpha text A'), 'A만 디스크에 있다 (B는 아직)');
    // A의 응답이 도착해 B의 저장이 시작될 때까지 상태 줄이 한 번이라도 "저장됨"이었으면 안 된다 (화면 변화를 모두 기록해 본다)
    const seen = await page.evaluate(() => (window as unknown as { statusSeen: string[] }).statusSeen);
    assert.ok(seen.length > 0, '상태 줄 변화를 기록하지 못했다');
    assert.deepEqual(seen.filter((t) => t.includes('저장됨')), [], 'A의 응답이 최종 저장 완료로 보이면 안 된다');
    await release(app);
    await status(page, '저장됨').waitFor();
    assert.equal(await read(dir), withText('Alpha text A B'));
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('저장 중 받아들인 입력 B 뒤 Ctrl+S: 진행 중 저장이 끝나면 이어서 저장하고, 화를 옮겼다 돌아와도 A+B가 바이트로 남는다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await start(await tempDir('inflight-input-userdata'), dir);
  try {
    await arm(app);
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await waitHeld(page, app);
    await page.keyboard.type(' B');
    await page.keyboard.press('Control+S'); // 진행 중 저장을 기다렸다가 B를 저장한다
    await release(app);
    await status(page, '저장됨').waitFor();
    assert.equal(await read(dir), withText('Alpha text A B'));
    await chapter(page, 'Two').click();
    await editor(page).getByText('Beta text').waitFor();
    await chapter(page, 'One').click();
    await editor(page).getByText('Alpha text A B', { exact: true }).waitFor();
    assert.equal(await read(dir), withText('Alpha text A B'));
    assert.equal(await read(dir, '002.md'), TWO);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

test('저장 중 받아들인 입력 B 뒤 바로 화 이동: 이동 전 저장이 A+B를 디스크에 남기고, 앱을 다시 띄워 다시 열어도 그대로다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const userData = await tempDir('inflight-input-userdata');
  const first = await start(userData, dir);
  let app = first.app;
  let page = first.page;
  try {
    await arm(app);
    await page.keyboard.type(' A');
    await page.keyboard.press('Control+S');
    await waitHeld(page, app);
    await page.keyboard.type(' B');
    await chapter(page, 'Two').click(); // 이동 전 저장(leave)은 진행 중 저장을 기다린 뒤 B를 저장한다
    await release(app);
    await editor(page).getByText('Beta text').waitFor();
    assert.equal(await read(dir), withText('Alpha text A B'));
    await closeWindow(app);
    ({ app, page } = await launch(userData));
    // 다시 실행하면 마지막 폴더는 열리지만 어느 화가 열릴지는 이 테스트가 정하지 않는다: 1화를 직접 연다
    await chapter(page, 'One').click();
    await editor(page).getByText('Alpha text A B', { exact: true }).waitFor();
    assert.equal(await read(dir), withText('Alpha text A B'));
    assert.equal(await read(dir, '002.md'), TWO);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
