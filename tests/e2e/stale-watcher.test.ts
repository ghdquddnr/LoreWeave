// 같은 폴더를 다시 열면 token과 watcher가 새로 생긴다. 이전 watcher의 이벤트가 파일을 읽는 도중이었다면, 그 읽기가 늦게 끝나도
// 새 프로젝트 세대의 화면(편집 중인 글, 안내)에 바깥 변경으로 전달되지 않아야 한다.
// 장벽은 main의 fs 호출이다: 이전 watcher가 보낸 이벤트의 chapterHash가 파일을 읽은 직후(옛 바이트를 확보한 뒤) 반환만 붙잡는다.
// 호출 카운터(holds, watches)로 수신·해제·새 watcher를 구분한다. 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ONE = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text\r\n';
const X1 = '﻿---\r\nid: one\r\ntitle: One\r\n---\r\nAlpha text outside\r\n';
const withText = (text: string) => X1.replace('Alpha text outside', text);

async function project(): Promise<string> {
  const dir = await tempDir('stale-watcher');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const alert = (page: Page) => page.getByRole('alert');

type G = { armed: boolean; held: boolean; holds: number; watches: number; release?: () => void };
/** armed일 때 화 파일(target)을 처음 읽은 직후(바이트를 얻은 뒤) 반환을 붙잡는다. fs.watch 호출 수를 센다 */
async function installBarrier(app: ElectronApplication, target: string) {
  await app.evaluate((_e, target) => {
    const g = globalThis as unknown as G;
    g.armed = false;
    g.held = false;
    g.holds = 0;
    g.watches = 0;
    const fs = process.getBuiltinModule('fs');
    const watch = fs.watch;
    fs.watch = ((path: string, ...args: unknown[]) => {
      g.watches++;
      return (watch as (...a: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.watch;
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
  }, target);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const counters = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, holds: g.holds, watches: g.watches }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}
/** 상태 줄과 충돌 안내의 글자가 바뀔 때마다 window.seen에 쌓는다 */
const record = (page: Page) =>
  page.evaluate(() => {
    const w = window as unknown as { seen: string[] };
    w.seen = [];
    new MutationObserver(() => {
      w.seen.push([...document.querySelectorAll('[role="status"], [role="alert"]')].map((el) => (el as HTMLElement).innerText.replace(/\s+/g, ' ')).join(' | '));
    }).observe(document.body, { subtree: true, childList: true, characterData: true });
  });
const seen = (page: Page) => page.evaluate(() => (window as unknown as { seen: string[] }).seen);
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });

for (const edit of ['clean', 'dirty'] as const) {
  test(`같은 폴더 다시 열기 (${edit === 'clean' ? '저장된 상태' : '저장 전 입력 있음'}): 이전 watcher의 늦은 읽기가 새 세대에 바깥 변경으로 전달되지 않는다`, { timeout: 90_000 }, async () => {
    const dir = await project();
    const path = join(dir, 'chapters', '001.md');
    const { app, page } = await launch(await tempDir('stale-watcher-userdata'));
    try {
      await stubFolderDialog(app, dir);
      await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
      await chapter(page, 'One').click();
      await editor(page).getByText('Alpha text').waitFor();
      await installBarrier(app, path);
      // 1) 이전 watcher: 바깥 수정(X1)을 감지해 파일을 읽었고, 반환만 붙잡혀 있다
      await arm(app);
      await writeFile(path, X1);
      await waitUntil(page, '이전 watcher의 읽기를 붙잡지 못했다', async () => (await counters(app)).held);
      const old = await counters(app);
      assert.equal(old.holds, 1);
      // 2) 같은 폴더를 다시 연다 (새 token, 새 watcher)
      await app.evaluate(() => void ((globalThis as unknown as G).watches = 0));
      await stubFolderDialog(app, dir);
      await page.getByRole('button', { name: '열기', exact: true }).click();
      await waitUntil(page, '새 watcher가 만들어지지 않았다', async () => (await counters(app)).watches >= 1);
      await chapter(page, 'One').click();
      await editor(page).getByText('Alpha text outside').waitFor({ timeout: 10_000 });
      // 3) 새 세대에서 편집·저장한다 (자기 쓰기)
      await editor(page).getByText('Alpha text outside').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' A');
      await page.keyboard.press('Control+S');
      await saved(page);
      assert.equal(await readFile(path, 'utf8'), withText('Alpha text outside A'));
      if (edit === 'dirty') await page.keyboard.type(' B'); // 저장 전 입력
      await record(page);
      // 4) 이전 watcher의 늦은 읽기를 푼다. main에서 반환된 뒤 renderer가 처리할 시간 동안 안내/충돌이 없어야 한다
      assert.equal((await counters(app)).held, true);
      await release(app);
      await waitUntil(page, '읽기가 반환되지 않았다', async () => !(await counters(app)).held);
      await page.evaluate(() => window.loreweave.ai.status()); // token과 무관한 renderer 왕복
      assert.equal(await alert(page).count(), 0, '이전 watcher의 늦은 읽기가 새 세대에 충돌 안내를 만들었다');
      assert.deepEqual(
        (await seen(page)).filter((t) => t.includes('다른 프로그램')),
        [],
        '이전 watcher의 늦은 읽기가 새 세대에 바깥 변경 안내를 만들었다',
      );
      const expected = edit === 'dirty' ? 'Alpha text outside A B' : 'Alpha text outside A';
      assert.equal(await editor(page).getByText(expected, { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
      if (edit === 'dirty') {
        await page.keyboard.press('Control+S');
        await saved(page);
      }
      assert.equal(await readFile(path, 'utf8'), withText(expected));
    } finally {
      await release(app).catch(() => {});
      // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
      page.on('dialog', (d) => void d.accept());
      await closeWindow(app);
    }
  });
}
