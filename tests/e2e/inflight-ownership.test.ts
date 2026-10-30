// 프로젝트를 바꾸기 전에 시작한 main의 원고 작업(새 화·저장·id 재발급)이 바꾼 뒤에 끝나도, 그 결과는 원래 폴더에만 남고
// 새 프로젝트의 감시(바깥 수정 알림)·검색 색인·자기 쓰기 기록은 건드리지 않는다.
// 실제 앱(Electron + Playwright). 장벽은 main 작업 안의 디스크 호출이다: A/chapters 아래 파일을 연(open) 직후 붙잡는다.
// 실제 API는 쓰지 않는다. 원고는 임시 폴더의 합성 원고다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(prefix: string, files: Record<string, string>): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  for (const [f, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', f), text);
  return dir;
}
const editor = (page: Page) => page.locator('.ProseMirror');
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const read = (dir: string, f = '001.md') => readFile(join(dir, 'chapters', f), 'utf8');
const dup = (title: string) => `---\nid: same-id\ntitle: ${title}\n---\n${title} 본문\n`;

/**
 * main의 fs를 감싼다: fs.watch 대상을 기록하고, prefix 아래 파일을 처음 연(fs.promises.open) 직후 그 작업을 붙잡는다.
 * 원고 작업은 (임시) 파일을 연 다음 쓰므로, 붙잡은 동안 파일은 생겼지만 작업은 끝나지 않았다
 */
async function installBarrier(app: ElectronApplication, prefix: string) {
  await app.evaluate((_e, prefix) => {
    const g = globalThis as unknown as { watches: string[]; held: boolean; release?: () => void; armed: boolean };
    const fs = process.getBuiltinModule('fs');
    const fsp = process.getBuiltinModule('fs/promises');
    g.watches = [];
    g.held = false;
    g.armed = true;
    const watch = fs.watch;
    fs.watch = ((path: string, ...args: unknown[]) => {
      g.watches.push(String(path));
      return (watch as (...a: unknown[]) => unknown)(path, ...args);
    }) as typeof fs.watch;
    const open = fsp.open;
    fsp.open = (async (path: string, ...args: unknown[]) => {
      const handle = await (open as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (g.armed && String(path).startsWith(prefix)) {
        g.armed = false;
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
      }
      return handle;
    }) as typeof fsp.open;
  }, join(prefix, 'chapters'));
}
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { held: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
const lastWatch = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { watches: string[] }).watches.at(-1));
async function waitHeld(app: ElectronApplication, page: Page) {
  for (let n = 0; n < 300 && !(await held(app)); n++) await page.waitForTimeout(10);
  assert.equal(await held(app), true, 'main 작업을 붙잡지 못했다');
}
/** 작업이 끝나 renderer 잠금이 풀릴 때까지 (붙잡은 작업의 응답이 처리된 뒤다) */
async function waitEditable(page: Page) {
  for (let n = 0; n < 300 && (await editor(page).getAttribute('contenteditable')) !== 'true'; n++) await page.waitForTimeout(10);
  assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
}
async function open(app: ElectronApplication, page: Page, dir: string, first = false) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: first ? '원고 폴더 열기' : '열기', exact: true }).click();
}
/** 지금 프로젝트의 색인으로 찾은 줄 수 */
const searchTotal = (page: Page, query: string) =>
  page.evaluate(`window.loreweave.chapters.search(${JSON.stringify(query)}).then((r) => r.total)`) as Promise<number>;
/** 열린 화(깨끗한 상태)를 바깥에서 바꾸면 감시가 알려 다시 불러온다 */
async function assertOutsideNotice(page: Page, dir: string, file: string, text: string, shown: string) {
  await writeFile(join(dir, 'chapters', file), text);
  await page.getByRole('status').getByText('다른 프로그램에서 바뀌어 다시 불러왔습니다').waitFor({ timeout: 5000 });
  await editor(page).getByText(shown).waitFor({ timeout: 5000 });
}

// ---- 새 화: 파일을 만든 직후 붙잡고, 그사이 열기가 성공(두 완료 순서)·같은 폴더 다시 열기·취소·실패한다

for (const order of ['B 화면 뒤 해제', 'B 응답 전 해제'] as const) {
  test(`새 화 늦은 완료 (${order}): A에 새 화가 남고, 마지막 감시는 B이며 B의 바깥 수정 알림·검색·저장이 정상이다`, { timeout: 90_000 }, async () => {
    const A = await project('inflight-create-A', { '001.md': '# A\n\nalpha\n' });
    const B = await project('inflight-create-B', { '001.md': '# B\n\nbeta\n' });
    const { app, page } = await launch(await tempDir('inflight-create-userdata'));
    try {
      await open(app, page, A, true);
      await editor(page).getByText('alpha').waitFor();
      await installBarrier(app, A);
      await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
      await waitHeld(app, page);
      if (order === 'B 화면 뒤 해제') {
        await open(app, page, B);
        await editor(page).getByText('beta').waitFor({ timeout: 5000 });
        await release(app);
      } else {
        // main은 B를 열었지만 그 응답은 아직 화면에 오지 않았다
        await app.evaluate(({ ipcMain }) => {
          const g = globalThis as unknown as { chooseDone: boolean; releaseChoose?: () => void };
          const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
          const original = handlers.get('project:choose')!;
          handlers.set('project:choose', async (...args: unknown[]) => {
            const result = await original(...args);
            g.chooseDone = true;
            await new Promise<void>((resolve) => (g.releaseChoose = resolve));
            handlers.set('project:choose', original);
            return result;
          });
        });
        await open(app, page, B);
        for (let n = 0; n < 300 && !(await app.evaluate(() => !!(globalThis as unknown as { chooseDone?: boolean }).chooseDone)); n++) await page.waitForTimeout(10);
        await release(app);
        await app.evaluate(() => (globalThis as unknown as { releaseChoose?: () => void }).releaseChoose?.());
        await editor(page).getByText('beta').waitFor({ timeout: 5000 });
      }
      await waitEditable(page);
      assert.equal(await lastWatch(app), join(B, 'chapters'));
      // A의 새 화는 A에 남고, B는 그대로다
      assert.deepEqual(await readdir(join(A, 'chapters')), ['001.md', '002.md']);
      assert.ok((await read(A, '002.md')).length > 0);
      assert.equal(await read(A), '# A\n\nalpha\n');
      assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
      assert.deepEqual(await list(page).getByRole('button').allTextContents(), ['B']);
      assert.equal(await searchTotal(page, 'alpha'), 0);
      assert.equal(await searchTotal(page, 'beta'), 1);
      // B의 바깥 수정 알림이 살아 있다
      await assertOutsideNotice(page, B, '001.md', '# B\n\nbeta outside\n', 'beta outside');
      await editor(page).getByText('beta outside').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' saved');
      await page.keyboard.press('Control+S');
      await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
      assert.equal(await read(B), '# B\n\nbeta outside saved\n');
    } finally {
      await release(app).catch(() => {});
      await app.evaluate(() => (globalThis as unknown as { releaseChoose?: () => void }).releaseChoose?.()).catch(() => {});
      await closeWindow(app);
    }
  });
}

for (const outcome of ['같은 폴더 다시 열기', '열기 취소', '열기 실패'] as const) {
  test(`새 화 늦은 완료 (${outcome}): 새 화가 A에 남고 A를 감시하며, A의 바깥 수정 알림·검색이 정상이다`, { timeout: 90_000 }, async () => {
    const A = await project('inflight-keep-A', { '001.md': '# A\n\nalpha\n' });
    const broken = await tempDir('inflight-broken');
    await writeFile(join(broken, 'chapters'), 'not a folder');
    const { app, page } = await launch(await tempDir('inflight-keep-userdata'));
    try {
      await open(app, page, A, true);
      await editor(page).getByText('alpha').waitFor();
      await installBarrier(app, A);
      await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
      await waitHeld(app, page);
      if (outcome === '같은 폴더 다시 열기') {
        await open(app, page, A);
        await editor(page).getByText('alpha').waitFor({ timeout: 5000 });
      } else if (outcome === '열기 취소') {
        await app.evaluate(({ dialog }) => {
          dialog.showOpenDialog = (async () => ({ canceled: true, filePaths: [] })) as typeof dialog.showOpenDialog;
        });
        await page.getByRole('button', { name: '열기', exact: true }).click();
      } else {
        await open(app, page, broken);
        await page.getByRole('status').getByText(/폴더나 위치를 사용할 수 없습니다|파일이나 폴더 위치를 사용할 수 없습니다/).waitFor({ timeout: 5000 });
      }
      await release(app);
      if (outcome !== '같은 폴더 다시 열기') {
        // 열기가 없었으므로 새 화가 열린다
        await list(page).getByRole('button').nth(1).waitFor({ timeout: 5000 });
      }
      await waitEditable(page);
      assert.equal(await lastWatch(app), join(A, 'chapters'));
      assert.deepEqual(await readdir(join(A, 'chapters')), ['001.md', '002.md']);
      assert.equal(await read(A), '# A\n\nalpha\n');
      assert.equal(await searchTotal(page, 'alpha'), 1);
      // 001을 열어 두고 바깥에서 바꾸면 알린다
      if (outcome !== '같은 폴더 다시 열기') await list(page).getByRole('button', { name: 'A' }).click();
      await editor(page).getByText('alpha').waitFor();
      await assertOutsideNotice(page, A, '001.md', '# A\n\nalpha outside\n', 'alpha outside');
      assert.equal(await searchTotal(page, 'outside'), 1);
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
  });
}

// ---- 저장: A의 저장을 임시 파일을 연 직후 붙잡고 B를 연다

test('저장 늦은 완료: A 파일에 저장되고, B 색인에 A 본문이 들어가지 않으며, A가 쓴 것과 같은 바이트의 B 바깥 수정도 알린다', { timeout: 90_000 }, async () => {
  const A = await project('inflight-write-A', { '001.md': '# A\n\nalpha\n' });
  const B = await project('inflight-write-B', { '001.md': '# B\n\nbeta\n' });
  const { app, page } = await launch(await tempDir('inflight-write-userdata'));
  const late = '# A\n\nalpha zebraword\n';
  try {
    await open(app, page, A, true);
    await editor(page).getByText('alpha').waitFor();
    await installBarrier(app, A);
    // 렌더러는 전환 전에 저장을 기다리므로, 늦은 저장은 A의 token(새 사용자 데이터에서 처음 연 프로젝트 = 1)으로 직접 보낸다
    await page.evaluate(`(() => {
      const c = window.loreweave.chapters;
      window.lateWrite = c.read('001.md', 1).then(({ hash }) => c.write('001.md', ${JSON.stringify(late)}, hash, 1));
    })()`);
    await waitHeld(app, page);
    await open(app, page, B);
    await editor(page).getByText('beta').waitFor({ timeout: 5000 });
    await release(app);
    assert.equal(await page.evaluate('window.lateWrite.then((r) => r.status)'), 'saved');
    assert.equal(await read(A), late);
    assert.equal(await lastWatch(app), join(B, 'chapters'));
    assert.equal(await searchTotal(page, 'zebraword'), 0);
    assert.equal(await searchTotal(page, 'beta'), 1);
    // A가 쓴 것과 같은 바이트로 B를 바깥에서 바꿔도 자기 쓰기로 착각하지 않고 알린다
    await assertOutsideNotice(page, B, '001.md', late, 'alpha zebraword');
    assert.equal(await read(A), late);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

// ---- id 재발급: 열린 화의 재발급을 임시 파일을 연 직후 붙잡고 B를 연다

test('id 재발급 늦은 완료: A에 새 id와 원래 본문이 남고, B 색인에 A 본문이 들어가지 않으며, B 감시·저장이 정상이다', { timeout: 90_000 }, async () => {
  const A = await project('inflight-reissue-A', { '001.md': dup('첫째'), '002.md': dup('둘째') });
  const B = await project('inflight-reissue-B', { '001.md': '# B\n\nbeta\n' });
  const { app, page } = await launch(await tempDir('inflight-reissue-userdata'));
  try {
    await open(app, page, A, true);
    await list(page).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await installBarrier(app, A);
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await waitHeld(app, page);
    await open(app, page, B);
    await editor(page).getByText('beta').waitFor({ timeout: 5000 });
    await release(app);
    await waitEditable(page);
    const after = await read(A, '002.md');
    assert.doesNotMatch(after, /id: same-id/);
    assert.match(after, /둘째 본문\n$/);
    assert.equal(await read(A), dup('첫째'));
    assert.equal(await lastWatch(app), join(B, 'chapters'));
    assert.equal(await searchTotal(page, '둘째'), 0);
    assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
    await assertOutsideNotice(page, B, '001.md', '# B\n\nbeta outside\n', 'beta outside');
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
