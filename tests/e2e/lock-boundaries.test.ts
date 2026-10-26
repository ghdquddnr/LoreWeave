// 새 잠금(PR #71)의 경계: 원고 조작과 프로젝트 열기 응답이 겹칠 때, 저장 충돌로 버림을 거절할 때, 재발급이 실패할 때.
// 실제 앱(Electron + Playwright). 판정은 시간 대신 IPC 장벽(붙잡은 응답)·호출 수·contenteditable·디스크 바이트로 한다. 실제 API는 쓰지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
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
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
const read = (dir: string, f = '001.md') => readFile(join(dir, 'chapters', f), 'utf8');
const dup = (title: string) => `---\nid: same-id\ntitle: ${title}\n---\n${title} 본문\n`;

type Mode = 'hold' | 'fail-after' | 'fail-before';
/**
 * channel 처리기를 감싼다. 호출 수를 세고, hold면 처리기를 끝까지 실행한 뒤 응답만 붙잡는다.
 * fail-before는 처리기를 실행하지 않고(디스크 변경 없음) 붙잡았다가 실패한다
 */
async function wrap(app: ElectronApplication, channel: string, mode: Mode | 'count') {
  await app.evaluate(
    ({ ipcMain }, { channel, mode }) => {
      const g = globalThis as unknown as { calls: Record<string, number>; held: Record<string, boolean>; release: Record<string, () => void> };
      g.calls ??= {};
      g.held ??= {};
      g.release ??= {};
      g.calls[channel] = 0;
      g.held[channel] = false;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get(channel)!;
      handlers.set(channel, async (...args: unknown[]) => {
        g.calls[channel]!++;
        if (mode === 'count') return original(...args);
        const result = mode === 'fail-before' ? undefined : await original(...args);
        g.held[channel] = true;
        await new Promise<void>((resolve) => (g.release[channel] = resolve));
        handlers.set(channel, original);
        if (mode !== 'hold') throw new Error(`늦게 실패한 ${channel}`);
        return result;
      });
    },
    { channel, mode },
  );
}
const calls = (app: ElectronApplication, channel: string) =>
  app.evaluate((_e, c) => (globalThis as unknown as { calls: Record<string, number> }).calls?.[c] ?? 0, channel);
const isHeld = (app: ElectronApplication, channel: string) =>
  app.evaluate((_e, c) => !!(globalThis as unknown as { held: Record<string, boolean> }).held?.[c], channel);
const release = (app: ElectronApplication, channel: string) =>
  app.evaluate((_e, c) => (globalThis as unknown as { release: Record<string, () => void> }).release?.[c]?.(), channel);
async function waitHeld(app: ElectronApplication, page: Page, channel: string) {
  for (let n = 0; n < 300 && !(await isHeld(app, channel)); n++) await page.waitForTimeout(10);
  assert.equal(await isHeld(app, channel), true, `${channel} 응답을 붙잡지 못했다`);
}
const contentEditable = (page: Page) => editor(page).getAttribute('contenteditable');
async function waitEditable(page: Page, want: 'true' | 'false') {
  for (let n = 0; n < 200 && (await contentEditable(page)) !== want; n++) await page.waitForTimeout(10);
  assert.equal(await contentEditable(page), want);
}
/** 잠긴 에디터에 입력·붙여넣기를 시도하고, 문서에 들어가지 않았는지 본다 */
async function assertRejectsInput(page: Page, marker: string) {
  await editor(page).click();
  await page.keyboard.press('End');
  await page.keyboard.type(` ${marker}`);
  await page.keyboard.insertText(` ${marker}-PASTE`);
  assert.ok(!(await editor(page).innerText()).includes(marker), `잠긴 에디터가 ${marker}을(를) 받았다`);
}
async function open(app: ElectronApplication, page: Page, dir: string, first = false) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: first ? '원고 폴더 열기' : '열기', exact: true }).click();
}

// ---- 1) 원고 조작 응답과 프로젝트 열기 응답을 둘 다 붙잡고 해제 순서를 바꾼다

const ops = {
  create: {
    channel: 'chapter:create',
    files: { '001.md': '# A\n\nalpha\n' },
    async start(page: Page) {
      await editor(page).getByText('alpha').waitFor();
      await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
    },
    async assertA(A: string) {
      assert.deepEqual(await readdir(join(A, 'chapters')), ['001.md', '002.md']);
      assert.equal(await read(A), '# A\n\nalpha\n');
    },
  },
  reissue: {
    channel: 'chapter:reissue-id',
    files: { '001.md': dup('첫째'), '002.md': dup('둘째') },
    async start(page: Page) {
      await list(page).getByRole('button', { name: '둘째' }).click();
      await editor(page).getByText('둘째 본문').waitFor();
      await page.getByRole('button', { name: '새 id 발급' }).click();
    },
    async assertA(A: string) {
      const after = await read(A, '002.md');
      assert.doesNotMatch(after, /id: same-id/);
      assert.match(after, /둘째 본문\n$/);
      assert.equal(await read(A), dup('첫째'));
    },
  },
} as const;

for (const name of ['create', 'reissue'] as const) {
  for (const order of ['조작 먼저', '프로젝트 먼저'] as const) {
    test(`겹침 (${name}, ${order} 해제): 남은 조작이 있는 동안 잠금이 유지되고, 모두 끝나면 B는 편집·저장되며 A의 성공한 조작은 남고 B에는 원치 않는 쓰기가 없다`, { timeout: 90_000 }, async () => {
      const op = ops[name];
      const A = await project(`overlap-${name}-A`, op.files);
      const B = await project(`overlap-${name}-B`, { '001.md': '# B\n\nbeta\n' });
      const { app, page } = await launch(await tempDir(`overlap-${name}-userdata`));
      try {
        await open(app, page, A, true);
        await wrap(app, op.channel, 'hold');
        await op.start(page);
        await waitHeld(app, page, op.channel);
        await waitEditable(page, 'false');
        // 원고 조작이 남은 채 B를 연다 (main의 열기 처리기는 끝내고 응답만 붙잡는다)
        await wrap(app, 'project:choose', 'hold');
        await open(app, page, B);
        await waitHeld(app, page, 'project:choose');
        await assertRejectsInput(page, 'DURING-BOTH');

        if (order === '조작 먼저') {
          await release(app, op.channel);
          // 조작 응답이 처리된 것을 확인한다 (장벽). main은 이미 B라 이어지는 A 요청은 이전 token으로 거절된다
          if (name === 'create') {
            // 새 화 뒤 목록 요청이 거절된다. 프로젝트 열기가 남아 있으므로 여전히 잠겨 있다 (화면은 아직 A)
            await page.getByRole('status').getByText('원고 폴더가 바뀌어', { exact: false }).waitFor({ timeout: 5000 });
            await waitEditable(page, 'false');
            await assertRejectsInput(page, 'AFTER-OP');
          } else {
            // 열린 화를 다시 읽으려다 이전 token으로 거절된다: 편집할 수 있는 에디터 자체가 없다 (원고는 재발급 전에 저장됨)
            await page.locator('.editor-pane').getByText('원고 폴더가 바뀌어', { exact: false }).waitFor({ timeout: 5000 });
            assert.equal(await editor(page).count(), 0);
          }
          await release(app, 'project:choose');
          await editor(page).getByText('beta').waitFor({ timeout: 5000 });
        } else {
          await release(app, 'project:choose');
          await editor(page).getByText('beta').waitFor({ timeout: 5000 });
          // 화면은 B지만 A의 원고 조작이 남아 있으므로 B 에디터도 잠긴 채 열린다
          await waitEditable(page, 'false');
          await assertRejectsInput(page, 'AFTER-PROJECT');
          await release(app, op.channel);
        }
        await waitEditable(page, 'true');
        assert.equal(await page.locator('.sidebar header strong').innerText(), basename(B));
        assert.deepEqual(await list(page).getByRole('button').allTextContents(), ['B']);
        assert.equal(await read(B), '# B\n\nbeta\n');
        assert.deepEqual(await readdir(join(B, 'chapters')), ['001.md']);
        await op.assertA(A);
        // B 편집·저장
        await editor(page).getByText('beta').click();
        await page.keyboard.press('End');
        await page.keyboard.type(' in B');
        await page.keyboard.press('Control+S');
        await saved(page);
        assert.equal(await read(B), '# B\n\nbeta in B\n');
        await op.assertA(A);
      } finally {
        await release(app, op.channel).catch(() => {});
        await release(app, 'project:choose').catch(() => {});
        await closeWindow(app);
      }
    });
  }
}

// ---- 2) 저장 충돌 중 버림 확인을 거절하면 조작을 보내지 않는다

for (const name of ['create', 'reissue'] as const) {
  test(`충돌 + 버림 거절 (${name}): 조작 IPC 0, 입력은 화면에 남고, 바깥 수정은 그대로이며, 잠금·버튼이 돌아오고, 그 뒤 충돌을 명시적으로 풀어 저장할 수 있다`, { timeout: 60_000 }, async () => {
    const op = ops[name];
    const A = await project(`conflict-${name}`, op.files);
    const file = name === 'create' ? '001.md' : '002.md';
    const body = name === 'create' ? 'alpha' : '둘째 본문';
    const { app, page } = await launch(await tempDir(`conflict-${name}-userdata`));
    try {
      await open(app, page, A, true);
      if (name === 'reissue') await list(page).getByRole('button', { name: '둘째' }).click();
      await editor(page).getByText(body).click();
      await page.keyboard.press('End');
      await page.keyboard.type(' unsaved');
      // 자동 저장 전에 바깥에서 바꿔 충돌을 만든다
      const outside = name === 'create' ? '# A\n\noutside\n' : '---\nid: same-id\ntitle: 둘째\n---\noutside\n';
      await writeFile(join(A, 'chapters', file), outside);
      await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 5000 });
      await wrap(app, op.channel, 'count');
      page.once('dialog', (d) => void d.dismiss());
      if (name === 'create') await page.getByRole('button', { name: '+ 새 화', exact: true }).click();
      else await page.getByRole('button', { name: '새 id 발급' }).click();
      await waitEditable(page, 'true');
      assert.equal(await calls(app, op.channel), 0);
      assert.ok((await editor(page).innerText()).includes('unsaved'));
      assert.equal(await read(A, file), outside);
      assert.equal(await page.getByRole('button', { name: '+ 새 화', exact: true }).isDisabled(), false);
      // 충돌을 명시적으로 풀어 저장한다
      await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).click();
      await saved(page);
      assert.match(await read(A, file), new RegExp(`${body} unsaved\\n$`));
    } finally {
      await closeWindow(app);
    }
  });
}

// ---- 3) 재발급 처리 실패

test('재발급 실패: 대기 중 중복 조작은 보내지 않고, 실패 뒤 편집이 돌아오며, 원래 본문·id가 그대로이고 저장할 수 있다', { timeout: 60_000 }, async () => {
  const A = await project('reissue-fail', { '001.md': dup('첫째'), '002.md': dup('둘째') });
  const { app, page } = await launch(await tempDir('reissue-fail-userdata'));
  try {
    await open(app, page, A, true);
    await list(page).getByRole('button', { name: '둘째' }).click();
    await editor(page).getByText('둘째 본문').waitFor();
    await wrap(app, 'chapter:reissue-id', 'fail-before');
    await page.getByRole('button', { name: '새 id 발급' }).click();
    await waitHeld(app, page, 'chapter:reissue-id');
    await waitEditable(page, 'false');
    // 중복 조작: 재발급·새 화를 다시 눌러도 보내지 않는다
    await wrap(app, 'chapter:create', 'count');
    await page.getByRole('button', { name: '새 id 발급' }).click();
    assert.equal(await page.getByRole('button', { name: '+ 새 화', exact: true }).isDisabled(), true);
    assert.equal(await calls(app, 'chapter:reissue-id'), 1);
    assert.equal(await calls(app, 'chapter:create'), 0);
    await assertRejectsInput(page, 'DURING-REISSUE');
    await release(app, 'chapter:reissue-id');
    await page.getByRole('status').getByText('늦게 실패한 chapter:reissue-id', { exact: false }).waitFor({ timeout: 5000 });
    await waitEditable(page, 'true');
    assert.equal(await read(A, '002.md'), dup('둘째'));
    assert.equal(await read(A), dup('첫째'));
    assert.equal(await page.getByRole('alert').getByText(/같은 id를 쓰는 화가 있습니다/).count(), 1);
    await editor(page).getByText('둘째 본문').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' kept');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.equal(await read(A, '002.md'), '---\nid: same-id\ntitle: 둘째\n---\n둘째 본문 kept\n');
  } finally {
    await release(app, 'chapter:reissue-id').catch(() => {});
    await closeWindow(app);
  }
});
