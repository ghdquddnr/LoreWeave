// 반대 방향: 먼저 시작한 바깥(watcher) 색인 읽기가 끝나기 전에, 사용자가 바깥 변경을 불러온 뒤 입력해 저장(저장 처리가 Y를 색인)했을 때,
// 늦게 끝난 옛 watcher 색인(X1)이 저장 색인(Y)을 옛 바이트로 덮지 않는지 본다. (index-reindex-order: watcher끼리, save-index-order: 저장이 먼저인 방향.)
// 장벽:
//   - 색인 읽기: 바깥 변경 X1의 reindexChapter의 readFile(바이트를 얻은 직후)과 stat 반환을 붙잡는다 (chapterHash 읽기와 충돌 알림은 정상 전달된다).
//   - 이벤트 전달(fs.watch 콜백): 자기 쓰기 이벤트가 watcher 이벤트 번호를 먼저 올리면 옛 읽기는 정상적으로 건너뛰어진다. gated 테스트는 실제 fs.watch 이벤트의 전달만 붙잡아
//     그 순서(자기 쓰기 이벤트가 아직 전달되지 않음)를 만든다. 해시나 이벤트를 만들어 내지 않는다. ungated 테스트는 장벽 없이 정상 순서를 본다.
// 완료 관측: 저장은 chapter:write 처리기(쓰기+색인)가 끝나기 직전의 카운터(writeDone), 옛 색인은 readFile·stat 반환 카운터와 main 이벤트 루프 한 번,
//   자기 쓰기 이벤트의 억제는 이벤트 전달 뒤 그 chapterHash 읽기가 반환되고 이벤트 루프를 한 번 돈 뒤로 본다. (시작 카운터를 색인 커밋으로 보지 않는다.)
// 실제 앱(Electron + Playwright). 합성 원고(BOM + CRLF + frontmatter). 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const body = (text: string) => `﻿---\r\nid: one\r\ntitle: One\r\n---\r\n${text}\r\n`;
const ONE = body('Alpha originalword');
const X1 = body('Alpha firstword');

async function project(): Promise<string> {
  const dir = await tempDir('watcher-vs-save');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const search = (page: Page, q: string) => page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(q)}).then((r) => r.total)`) as Promise<number>;

type G = {
  mode: 'off' | 'after-read' | 'hash';
  statArm: boolean;
  statPlain: number;
  skip: number;
  statPending: boolean;
  held: boolean;
  statHeld: boolean;
  readReturned: number;
  statReturned: number;
  plainReads: number;
  gate: boolean;
  queued: Array<[string, string]>;
  delivered: number;
  writeDone: number;
  release?: () => void;
  statRelease?: () => void;
  deliver?: (event: string, name: string) => void;
};
/** 프로젝트를 열기 전에 설치한다 (fs.watch는 열 때 만들어진다) */
async function install(app: ElectronApplication, target: string) {
  await app.evaluate(({ ipcMain }, target) => {
    const g = globalThis as unknown as G;
    Object.assign(g, { mode: 'off', skip: 0, statPending: false, statArm: false, statPlain: 0, held: false, statHeld: false, readReturned: 0, statReturned: 0, plainReads: 0, gate: false, queued: [], delivered: 0, writeDone: 0 });
    const fs = process.getBuiltinModule('fs');
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      let hold = false;
      if (String(path) === target && g.mode !== 'off') {
        if (g.skip > 0) g.skip--;
        else {
          hold = true;
          g.statPending = g.mode === 'after-read'; // after-read: 바로 뒤이어 호출되는 같은 reindexChapter의 stat도 붙잡는다 (hash: chapterHash 읽기만)
          g.mode = 'off'; // 이 읽기 하나만 붙잡는다
        }
      }
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
        g.readReturned++;
      } else if (String(path) === target) g.plainReads++;
      return bytes;
    }) as typeof fsp.readFile;
    const stat = fsp.stat;
    fsp.stat = (async (path: unknown, ...args: unknown[]) => {
      const mine = String(path) === target;
      const hold = mine && (g.statPending || g.statArm);
      if (hold) {
        g.statPending = false;
        g.statArm = false;
      }
      const info = await (stat as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.statHeld = true;
        await new Promise<void>((resolve) => (g.statRelease = resolve));
        g.statHeld = false;
        g.statReturned++;
      } else if (mine) g.statPlain++;
      return info;
    }) as typeof fsp.stat;
    // 실제 fs.watch 이벤트의 전달만 붙잡는다 (닫혀 있으면 쌓아 두었다가 열 때 그대로 전달한다)
    const watch = fs.watch;
    fs.watch = ((path: string, ...args: unknown[]) => {
      const listener = args.find((a) => typeof a === 'function') as ((event: string, name: string) => void) | undefined;
      if (listener && String(path).startsWith(target.slice(0, target.lastIndexOf('chapters')))) {
        g.deliver = (event, name) => {
          g.delivered++;
          listener(event, name);
        };
        // 이 함수는 앱 안에서 실행된다: 이름 붙은 함수를 변수에 담지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없어, 있으면 fs.watch가 실패하고 감시가 조용히 꺼진다)
        return (watch as (...a: unknown[]) => unknown)(
          path,
          ...args.map((a) =>
            a === listener
              ? (event: string, name: string) => {
                  if (g.gate) g.queued.push([event, name]);
                  else g.deliver?.(event, name);
                }
              : a,
          ),
        );
      }
      return (watch as (...a: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.watch;
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    const original = handlers.get('chapter:write')!;
    handlers.set('chapter:write', async (...args: unknown[]) => {
      try {
        return await original(...args);
      } finally {
        g.writeDone++; // 쓰기와 색인 갱신까지 끝나 응답을 돌려주기 직전
      }
    });
  }, target);
}
/** 다음 readFile(자기 쓰기 이벤트의 chapterHash 읽기)이 바이트를 얻은 직후 반환을 붙잡는다 */
const armHashRead = (app: ElectronApplication) => app.evaluate(() => void Object.assign(globalThis as unknown as G, { mode: 'hash', skip: 0 }));
/** 다음 stat(저장 처리의 색인 stat)이 값을 얻은 직후 반환을 붙잡는다 */
const armStat = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).statArm = true));
/** 다음 이벤트의 첫 readFile(chapterHash)은 지나가고, 그 다음 색인 읽기(와 stat)를 붙잡는다 */
const armIndexRead = (app: ElectronApplication) => app.evaluate(() => void Object.assign(globalThis as unknown as G, { mode: 'after-read', skip: 1 }));
const closeGate = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).gate = true));
/** 쌓인 이벤트를 전달한다 */
const openGate = (app: ElectronApplication) =>
  app.evaluate(() => {
    const g = globalThis as unknown as G;
    g.gate = false;
    const queued = g.queued.splice(0);
    for (const [event, name] of queued) {
      g.delivered++;
      g.deliver?.(event, name);
    }
    return queued.length;
  });
const releaseIndexRead = (app: ElectronApplication) => app.evaluate(() => { const g = globalThis as unknown as G; g.release?.(); g.statRelease?.(); });
const state = (app: ElectronApplication) =>
  app.evaluate(() => { const g = globalThis as unknown as G; return { held: g.held, statHeld: g.statHeld, readReturned: g.readReturned, statReturned: g.statReturned, plainReads: g.plainReads, statPlain: g.statPlain, queued: g.queued.length, delivered: g.delivered, writeDone: g.writeDone }; });
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>, app?: ElectronApplication) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, app ? `${what} ${JSON.stringify(await state(app))}` : what);
}
const turn = (app: ElectronApplication) => app.evaluate(() => new Promise<void>((r) => setImmediate(r)));

async function start() {
  const dir = await project();
  const path = join(dir, 'chapters', '001.md');
  const { app, page } = await launch(await tempDir('watcher-vs-save-userdata'));
  await install(app, path);
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'One').click();
  await editor(page).getByText('originalword').waitFor();
  await waitUntil(page, '처음 색인이 준비되지 않았다', async () => (await search(page, 'originalword')) === 1);
  return { app, page, path };
}
const cleanup = async (app: ElectronApplication, page: Page) => {
  await releaseIndexRead(app).catch(() => {});
  await openGate(app).catch(() => {});
  // 정리용: 저장하지 못한 변경이 남은 채 닫으면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다 (판정에 쓰지 않는다)
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};

for (const order of ['event-first', 'event-held'] as const) {
  test(`바깥 X1의 늦은 색인 읽기 vs 그 뒤 저장 Y (${order === 'event-held' ? '자기 쓰기 이벤트가 아직 전달되지 않은 순서' : '자기 쓰기 이벤트가 먼저 처리된 순서'}): 저장 색인 Y가 옛 X1 색인으로 덮이지 않는다`, { timeout: 90_000 }, async () => {
    const { app, page, path } = await start();
    try {
      // 1) 바깥 변경 X1: chapterHash와 충돌 알림(깨끗한 에디터는 불러오기)은 정상 전달되고, 색인 읽기(readFile+stat)는 붙잡힌다
      await armIndexRead(app);
      await writeFile(path, X1);
      await waitUntil(page, 'X1 색인 읽기(readFile+stat)를 붙잡지 못했다', async () => {
        const s = await state(app);
        return s.held && s.statHeld;
      }, app);
      await editor(page).getByText('firstword').waitFor({ timeout: 10_000 }); // 사용자가 바깥 변경을 불러왔다
      assert.equal(await search(page, 'firstword'), 0, '옛 색인 읽기는 아직 붙잡혀 있다');
      await closeGate(app); // 이 뒤의 (자기 쓰기) 이벤트는 전달을 붙잡는다. 두 순서 모두 전달 시점을 이 테스트가 정한다
      // 2) 입력 Y를 받아들이고 저장한다: 저장 처리(쓰기+색인)가 끝날 때까지 기다린다
      await editor(page).getByText('firstword').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' mine');
      const doneBefore = (await state(app)).writeDone;
      await page.keyboard.press('Control+S');
      await waitUntil(page, '저장 처리가 끝나지 않았다', async () => (await state(app)).writeDone === doneBefore + 1);
      assert.equal(await readFile(path, 'utf8'), body('Alpha firstword mine'));
      assert.equal(await search(page, 'mine'), 1, '저장 색인 Y가 반영됐다');
      assert.equal((await state(app)).held, true, '옛 색인 읽기는 아직 붙잡혀 있다');
      // 쌓아 둔 자기 쓰기 이벤트를 전달하고 그 chapterHash 읽기가 끝나 처리(자기 쓰기 억제)가 끝날 때까지 기다린다.
      // 게이트가 닫혀 있는 동안에는 이 읽기가 일어나지 않으므로 전달 직전의 plainReads가 기준이다 (저장 처리의 읽기와 섞이지 않는다)
      const deliverAndSettle = async () => {
        const reads = (await state(app)).plainReads;
        const delivered = await openGate(app);
        assert.ok(delivered >= 1, '자기 쓰기 이벤트가 쌓이지 않았다');
        await waitUntil(page, '자기 쓰기 이벤트의 해시 읽기가 끝나지 않았다', async () => (await state(app)).plainReads > reads, app);
        await turn(app);
      };
      const releaseOld = async () => {
        // 옛 X1 읽기를 푼다: readFile과 stat이 모두 반환되고 main 이벤트 루프를 한 번 돈 뒤 (옛 색인의 쓰기 또는 skip이 끝난 뒤)
        await releaseIndexRead(app);
        await waitUntil(page, '옛 색인 읽기가 모두 반환되지 않았다', async () => {
          const s = await state(app);
          return s.readReturned === 1 && s.statReturned === 1;
        });
        await turn(app);
      };
      if (order === 'event-first') {
        await deliverAndSettle(); // 자기 쓰기 이벤트 번호가 먼저 오른다
        await releaseOld();
      } else {
        await releaseOld(); // 자기 쓰기 이벤트가 아직 전달되지 않은 채 옛 읽기가 끝난다
        await deliverAndSettle(); // 그 뒤 자기 쓰기 이벤트가 처리되어 억제된다
      }
      assert.equal(await search(page, 'mine'), 1, '옛 X1 색인이 저장 색인 Y를 덮었다');
      assert.equal(await search(page, 'firstword'), 1, '화 본문 X1 부분은 저장 본문에도 있다');
      assert.equal(await readFile(path, 'utf8'), body('Alpha firstword mine'));
      assert.equal(await editor(page).getByText('Alpha firstword mine', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
      assert.equal(await page.getByRole('alert').count(), 0, '자기 쓰기가 바깥 변경 충돌로 보이면 안 된다');
    } finally {
      await cleanup(app, page);
    }
  });
}

test('두 저장 사이의 옛 자기 쓰기 해시 읽기: 저장 색인과 watcher 색인이 둘 다 건너뛰어 최신 본문이 색인에서 빠지지 않는다', { timeout: 90_000 }, async () => {
  const { app, page, path } = await start();
  try {
    // 1) 첫 저장 (firstsave): 그 자기 쓰기 이벤트 전달은 붙잡아 둔다. 저장 처리 완료와 색인(검색 1)을 확인한다
    await closeGate(app);
    await editor(page).getByText('originalword').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' firstsave');
    let done = (await state(app)).writeDone;
    await page.keyboard.press('Control+S');
    await waitUntil(page, '첫 저장 처리가 끝나지 않았다', async () => (await state(app)).writeDone === done + 1, app);
    await waitUntil(page, '첫 저장이 색인에 반영되지 않았다', async () => (await search(page, 'firstsave')) === 1, app);
    // 2) 그 (실제) 자기 쓰기 이벤트를 전달하고, chapterHash가 firstsave 바이트를 얻은 직후 반환을 붙잡는다
    await armHashRead(app);
    assert.ok((await openGate(app)) >= 1, '첫 저장의 자기 쓰기 이벤트가 쌓이지 않았다');
    await waitUntil(page, '자기 쓰기 이벤트의 해시 읽기를 붙잡지 못했다', async () => (await state(app)).held, app);
    // 3) 두 번째 저장 (secondword): 쓰기는 성공하고 저장 색인 stat 반환이 붙잡힌다. 그 새 자기 쓰기 이벤트 전달도 붙잡는다
    await closeGate(app);
    await armStat(app);
    await editor(page).getByText('firstsave').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' secondword');
    done = (await state(app)).writeDone;
    await page.keyboard.press('Control+S');
    await waitUntil(page, '두 번째 저장의 색인 stat을 붙잡지 못했다', async () => (await state(app)).statHeld, app);
    assert.equal(await readFile(path, 'utf8'), body('Alpha originalword firstsave secondword'));
    // 4) 옛 해시 읽기를 푼다: 해시(firstsave)는 지금 자기 쓰기와 달라 바깥 변경으로 보이고, watcher 색인이 최신 바이트(secondword)를 읽는다.
    //    그 색인 읽기의 readFile과 stat이 모두 반환될 때까지 (옛 해시 읽기 하나 + 색인 읽기 하나) 기다린 뒤 이벤트 루프를 한 번 돈다
    const before = await state(app);
    await app.evaluate(() => (globalThis as unknown as G).release?.());
    await waitUntil(page, 'watcher 색인 읽기(readFile+stat)가 끝나지 않았다', async () => {
      const s = await state(app);
      return s.plainReads > before.plainReads && s.statPlain > before.statPlain;
    }, app);
    await turn(app);
    // 5) 저장의 색인 stat을 푼다: 저장 처리(쓰기+색인)가 끝날 때까지 기다린다
    await app.evaluate(() => (globalThis as unknown as G).statRelease?.());
    await waitUntil(page, '두 번째 저장 처리가 끝나지 않았다', async () => (await state(app)).writeDone === done + 1, app);
    await turn(app);
    // 6) 두 번째 저장의 자기 쓰기 이벤트를 전달하고 그 해시 읽기(자기 쓰기 억제)가 끝난 뒤의 최종 상태
    const reads = (await state(app)).plainReads;
    assert.ok((await openGate(app)) >= 1, '두 번째 저장의 자기 쓰기 이벤트가 쌓이지 않았다');
    await waitUntil(page, '자기 쓰기 이벤트의 해시 읽기가 끝나지 않았다', async () => (await state(app)).plainReads > reads, app);
    await turn(app);
    assert.equal(await search(page, 'secondword'), 1, '최신 본문(secondword)이 색인에서 빠졌다');
    assert.equal(await readFile(path, 'utf8'), body('Alpha originalword firstsave secondword'));
    assert.equal(await editor(page).getByText('Alpha originalword firstsave secondword', { exact: true }).count(), 1, '수락한 입력이 화면에 남아야 한다');
    assert.equal(await page.getByRole('alert').count(), 0, '자기 쓰기가 바깥 변경 충돌로 보이면 안 된다');
  } finally {
    await cleanup(app, page);
  }
});
