// 저장(임시 파일 → fsync → 이름 바꾸기) 도중 다른 프로그램이 원고를 바꾸면, 이름 바꾸기 직전 다시 확인해 덮어쓰지 않는다.
// 실제 앱(Electron + Playwright). 장벽은 main 저장 작업 안의 디스크 호출이다:
//   - 임시 파일 준비: 001.md.<uuid>.tmp를 연(fs.promises.open) 직후 붙잡는다
//   - 재시도 대기: 첫 이름 바꾸기(fs.promises.rename)를 붙잡았다가 EPERM으로 실패시킨다 (백신·OneDrive가 잡고 있는 것처럼)
// 마지막 확인과 이름 바꾸기 사이의 짧은 틈은 막지 못한다 (일반 파일 시스템). 이 테스트는 그 앞의 긴 대기만 다룬다. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const ORIGINAL = '# A\n\noriginal\n';
const LOCAL = '# A\n\nlocal saved\n';
const EXTERNAL = '# A\n\nexternal must survive\n';
const NOT_UTF8 = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]);

const editor = (page: Page) => page.locator('.ProseMirror');
const chapters = (dir: string) => join(dir, 'chapters');

async function openProject(prefix: string, files: Record<string, string>) {
  const dir = await tempDir(prefix);
  await mkdir(chapters(dir));
  for (const [f, text] of Object.entries(files)) await writeFile(join(chapters(dir), f), text);
  const { app, page } = await launch(await tempDir(`${prefix}-userdata`));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  return { dir, app, page };
}

type Barrier = 'temp' | 'retry' | 'rename-fails';
/**
 * main의 fs.promises를 감싼다. target(화 파일 경로)의 저장에서
 * temp: 임시 파일을 연 직후 붙잡는다 / retry: 첫 이름 바꾸기를 붙잡았다가 EPERM / rename-fails: 이름 바꾸기가 늘 EPERM
 */
async function installBarrier(app: ElectronApplication, target: string, mode: Barrier) {
  await app.evaluate(
    (_e, { target, mode }) => {
      const g = globalThis as unknown as { held: boolean; release?: () => void; renames: number };
      const fsp = process.getBuiltinModule('fs/promises');
      g.held = false;
      g.renames = 0;
      // 이 함수는 앱 안에서 실행된다: 이름 붙은 도우미 함수를 두지 않는다 (테스트 변환기가 붙이는 이름 도우미가 앱에는 없다)
      const open = fsp.open;
      fsp.open = (async (path: string, ...args: unknown[]) => {
        const handle = await (open as (...a: unknown[]) => Promise<unknown>)(path, ...args);
        if (mode === 'temp' && String(path).startsWith(`${target}.`) && String(path).endsWith('.tmp') && !g.held) {
          g.held = true;
          await new Promise<void>((resolve) => (g.release = resolve));
        }
        return handle;
      }) as typeof fsp.open;
      const rename = fsp.rename;
      fsp.rename = (async (from: string, to: string) => {
        if (String(from).startsWith(`${target}.`) && String(from).endsWith('.tmp')) {
          g.renames++;
          if (mode === 'retry' && g.renames === 1) {
            g.held = true;
            await new Promise<void>((resolve) => (g.release = resolve));
          }
          if (mode === 'rename-fails' || (mode === 'retry' && g.renames === 1)) {
            throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' });
          }
        }
        return rename(from, to);
      }) as typeof fsp.rename;
    },
    { target, mode },
  );
}
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { held: boolean }).held);
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
const renames = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as { renames: number }).renames);
async function waitHeld(app: ElectronApplication, page: Page) {
  for (let n = 0; n < 300 && !(await held(app)); n++) await page.waitForTimeout(10);
  assert.equal(await held(app), true, '저장 작업을 붙잡지 못했다');
}
/** 렌더러를 거치지 않고 프로젝트 token 1(새 사용자 데이터에서 처음 연 프로젝트)로 저장을 보낸다. expected: 'read'면 지금 디스크의 해시 */
async function startWrite(page: Page, file: string, text: string, expected: 'read' | null) {
  await page.evaluate(`(() => {
    const c = window.loreweave.chapters;
    const hash = ${expected === 'read' ? `c.read(${JSON.stringify(file)}, 1).then((r) => r.hash)` : 'Promise.resolve(null)'};
    window.result = hash.then((h) => c.write(${JSON.stringify(file)}, ${JSON.stringify(text)}, h, 1)).catch((e) => ({ status: 'error', message: e.message }));
  })()`);
}
const result = (page: Page) => page.evaluate('window.result') as Promise<{ status: string; diskHash?: string | null; message?: string }>;
const tempFiles = async (dir: string) => (await readdir(chapters(dir))).filter((f) => f.endsWith('.tmp'));

// ---- 임시 파일 준비 중·재시도 대기 중에 바깥에서 바뀌면 conflict이고 바깥 바이트가 남는다

const changes = {
  바뀜: { apply: (path: string) => writeFile(path, EXTERNAL), disk: Buffer.from(EXTERNAL) as Buffer | null, diskHash: 'string' },
  지움: { apply: (path: string) => rm(path), disk: null, diskHash: 'null' },
  'UTF-8 아님': { apply: (path: string) => writeFile(path, NOT_UTF8), disk: NOT_UTF8 as Buffer | null, diskHash: 'string' },
} as const;

for (const barrier of ['temp', 'retry'] as const) {
  for (const [name, change] of Object.entries(changes)) {
    test(`${barrier === 'temp' ? '임시 파일 준비 중' : '이름 바꾸기 재시도 대기 중'} 바깥에서 ${name}: conflict를 돌려주고 바깥 바이트가 남으며 임시 파일이 정리된다`, { timeout: 60_000 }, async () => {
      const { dir, app, page } = await openProject(`race-${barrier}`, { '001.md': ORIGINAL });
      const path = join(chapters(dir), '001.md');
      try {
        await installBarrier(app, path, barrier);
        await startWrite(page, '001.md', LOCAL, 'read');
        await waitHeld(app, page);
        await change.apply(path);
        await release(app);
        const r = await result(page);
        assert.equal(r.status, 'conflict');
        assert.equal(r.diskHash === null ? 'null' : typeof r.diskHash, change.diskHash);
        if (change.disk) assert.deepEqual(await readFile(path), change.disk);
        else assert.deepEqual(await readdir(chapters(dir)), []);
        assert.deepEqual(await tempFiles(dir), []);
        // 재시도에서는 바뀐 것을 본 뒤 다시 이름을 바꾸지 않았다
        if (barrier === 'retry') assert.equal(await renames(app), 1);
      } finally {
        await release(app).catch(() => {});
        await closeWindow(app);
      }
    });
  }
}

test('expectedHash null(새 파일) 저장 중 바깥에서 같은 이름의 파일을 만들면 conflict이고 그 파일이 남는다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await openProject('race-null', { '001.md': ORIGINAL });
  const path = join(chapters(dir), '002.md');
  try {
    await installBarrier(app, path, 'temp');
    await startWrite(page, '002.md', LOCAL, null);
    await waitHeld(app, page);
    await writeFile(path, EXTERNAL);
    await release(app);
    assert.equal((await result(page)).status, 'conflict');
    assert.equal(await readFile(path, 'utf8'), EXTERNAL);
    assert.deepEqual(await tempFiles(dir), []);
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});

// ---- 회귀: 바뀌지 않았으면 재시도 뒤 저장되고, 재시도가 모두 실패하면 오류이며 원고·임시 파일이 남지 않는다

test('재시도 뒤 저장: 바깥 변경이 없으면 한 번 실패한 이름 바꾸기를 다시 해 저장한다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await openProject('race-retry-ok', { '001.md': ORIGINAL });
  const path = join(chapters(dir), '001.md');
  try {
    await installBarrier(app, path, 'retry');
    await startWrite(page, '001.md', LOCAL, 'read');
    await waitHeld(app, page);
    await release(app);
    assert.equal((await result(page)).status, 'saved');
    assert.equal(await readFile(path, 'utf8'), LOCAL);
    assert.equal(await renames(app), 2);
    assert.deepEqual(await tempFiles(dir), []);
  } finally {
    await closeWindow(app);
  }
});

test('재시도가 모두 실패하면 저장 오류가 보이고, 입력은 화면에 남으며, 원고는 그대로이고 임시 파일이 남지 않는다', { timeout: 60_000 }, async () => {
  const { dir, app, page } = await openProject('race-rename-fails', { '001.md': ORIGINAL });
  const path = join(chapters(dir), '001.md');
  try {
    await installBarrier(app, path, 'rename-fails');
    await editor(page).getByText('original').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' typed');
    await page.keyboard.press('Control+S');
    await page.getByRole('status').getByText('EPERM', { exact: false }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(path, 'utf8'), ORIGINAL);
    assert.ok((await editor(page).innerText()).includes('original typed'));
    assert.deepEqual(await tempFiles(dir), []);
  } finally {
    // 닫을 때 다시 저장하려다 실패하면 확인 창이 뜬다. 합성 원고이므로 닫기를 허용한다
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

// ---- 에디터에서: 저장 중 바깥 수정 → 충돌 안내, 입력 보존, 그 뒤 명시적 덮어쓰기 / 디스크 불러오기 / 계속 편집

for (const action of ['내 것으로 덮어쓰기', '디스크 내용 불러오기'] as const) {
  test(`에디터 저장 중 바깥 수정 (${action}): 충돌을 알리고 입력은 화면에 남으며 바깥 바이트는 그대로이고, 사용자가 고른 대로 끝난다`, { timeout: 60_000 }, async () => {
    const { dir, app, page } = await openProject(`race-editor-${action === '내 것으로 덮어쓰기' ? 'overwrite' : 'reload'}`, { '001.md': ORIGINAL });
    const path = join(chapters(dir), '001.md');
    try {
      await installBarrier(app, path, 'temp');
      await editor(page).getByText('original').click();
      await page.keyboard.press('End');
      await page.keyboard.type(' typed');
      await page.keyboard.press('Control+S');
      await waitHeld(app, page);
      await writeFile(path, EXTERNAL);
      await release(app);
      await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 5000 });
      assert.equal(await readFile(path, 'utf8'), EXTERNAL);
      assert.ok((await editor(page).innerText()).includes('original typed'));
      assert.deepEqual(await tempFiles(dir), []);
      // 충돌 중 계속 입력해도 자동 저장하지 않는다
      await page.keyboard.type(' more');
      await page.keyboard.press('Control+S');
      assert.equal(await readFile(path, 'utf8'), EXTERNAL);
      if (action === '내 것으로 덮어쓰기') {
        await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).click();
        await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
        assert.equal(await readFile(path, 'utf8'), '# A\n\noriginal typed more\n');
      } else {
        await page.getByRole('button', { name: /디스크 내용 불러오기/ }).click();
        await editor(page).getByText('external must survive').waitFor({ timeout: 5000 });
        assert.equal(await readFile(path, 'utf8'), EXTERNAL);
      }
    } finally {
      await release(app).catch(() => {});
      await closeWindow(app);
    }
  });
}

// ---- id 재발급: 재발급 저장 중 바깥에서 바뀌면 id를 바꾸지 않고 오류를 보이며, 바깥 바이트가 남는다

test('id 재발급 저장 중 바깥 수정: 재발급 실패가 보이고 바깥 바이트(원래 id)가 남으며 다시 편집할 수 있다', { timeout: 60_000 }, async () => {
  const dup = (title: string) => `---\nid: same-id\ntitle: ${title}\n---\n${title} 본문\n`;
  const { dir, app, page } = await openProject('race-reissue', { '001.md': dup('첫째'), '002.md': dup('둘째') });
  const path = join(chapters(dir), '002.md');
  const external = '---\nid: same-id\ntitle: 둘째\n---\n둘째 바깥\n';
  try {
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await installBarrier(app, path, 'temp');
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await waitHeld(app, page);
    await writeFile(path, external);
    await release(app);
    await page.getByRole('status').getByText('id를 바꾸지 못했습니다', { exact: false }).waitFor({ timeout: 5000 });
    assert.equal(await readFile(path, 'utf8'), external);
    assert.equal(await readFile(join(chapters(dir), '001.md'), 'utf8'), dup('첫째'));
    assert.deepEqual(await tempFiles(dir), []);
    for (let n = 0; n < 300 && (await editor(page).getAttribute('contenteditable')) !== 'true'; n++) await page.waitForTimeout(10);
    assert.equal(await editor(page).getAttribute('contenteditable'), 'true');
  } finally {
    await release(app).catch(() => {});
    await closeWindow(app);
  }
});
