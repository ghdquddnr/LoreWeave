// 검사 비용 계획 IPC(ai:plan-check)의 프로젝트 소유권: 계획을 기다리는 사이 다른 프로젝트(같은 폴더 다시 열기 포함)를 열면 옛 계획이나 닫힌 AI 저장소의 오류를 돌려주지 않고 STALE_PROJECT로 끝나는지 본다.
// 장벽: 격리 userData의 settings.json 읽기(readSettings, handler가 계획 전에 기다린다) 반환을 붙잡는다. 실제 등록된 main handler가 계획을 처리하고 대역은 없다.
// 합성 원고(BOM + CRLF + frontmatter)와 합성 AI DB fixture(빈 ai.db)만 쓴다. 실제 API·키·실원고는 쓰지 않는다. 계획은 읽기이므로 원고 바이트와 ai.db 호출 기록이 그대로인지 함께 본다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, currentTokenFn, launch, stubFolderDialog, tempDir } from './launch.ts';

const STALE = /원고 폴더가 바뀌어/;
const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
async function project(prefix: string, withAiDb: boolean): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), doc('p1', 'One', 'alpha one'));
  await writeFile(join(dir, 'chapters', '002.md'), doc('p2', 'Two', 'alpha two'));
  if (withAiDb) AiStore.open(dir).close(); // 합성 AI DB fixture (분석·검사 기록 없음)
  return dir;
}
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

type G = { path: string; armed: boolean; held: boolean; release?: () => void };
async function install(app: ElectronApplication, settingsPath: string) {
  await app.evaluate((_e, settingsPath) => {
    const g = globalThis as unknown as G;
    g.path = settingsPath as string;
    g.armed = false;
    g.held = false;
    const fsp = process.getBuiltinModule('fs/promises');
    const readFile = fsp.readFile;
    fsp.readFile = (async (path: unknown, ...args: unknown[]) => {
      const hold = g.armed && String(path) === g.path;
      if (hold) g.armed = false; // 이 읽기 하나만 붙잡는다
      const bytes = await (readFile as (...a: unknown[]) => Promise<unknown>)(path, ...args);
      if (hold) {
        g.held = true;
        await new Promise<void>((resolve) => (g.release = resolve));
        g.held = false;
      }
      return bytes;
    }) as typeof fsp.readFile;
  }, settingsPath);
}
const arm = (app: ElectronApplication) => app.evaluate(() => void ((globalThis as unknown as G).armed = true));
const release = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).release?.());
const held = (app: ElectronApplication) => app.evaluate(() => (globalThis as unknown as G).held);
async function waitUntil(page: Page, what: string, ok: () => Promise<boolean>) {
  for (let n = 0; n < 400 && !(await ok()); n++) await page.waitForTimeout(25);
  assert.equal(await ok(), true, what);
}

type Outcome = { ok: true; batches: number; priors: number } | { ok: false; message: string };
const startPlan = (page: Page, file: string, slot: string, token?: number) =>
  page.evaluate(
    `(async () => { const t = ${token ?? 'await (' + currentTokenFn + ')()'}; window.${slot} = null;
       window.loreweave.ai.planCheck(${JSON.stringify(file)}, t).then((r) => (window.${slot} = { ok: true, batches: r.batches, priors: r.priors }), (e) => (window.${slot} = { ok: false, message: String(e && e.message) })); })()`,
  );
const settled = async (page: Page, slot: string): Promise<Outcome> => {
  await waitUntil(page, `${slot} 계획이 끝나지 않았다`, async () => (await page.evaluate(`window.${slot}`)) !== null);
  return (await page.evaluate(`window.${slot}`)) as Outcome;
};

async function setup(withAiDb = true) {
  const A = await project('plan-A', withAiDb);
  const B = await project('plan-B', true);
  const userData = await tempDir('plan-userdata');
  const { app, page } = await launch(userData);
  // 격리 증거: 앱의 userData가 방금 만든 빈 임시 폴더다 (기본 프로필이 아니다)
  assert.equal(await app.evaluate(({ app: a }) => a.getPath('userData')), userData);
  await install(app, join(userData, 'settings.json'));
  await stubFolderDialog(app, A);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'Two').waitFor();
  return { A, B, app, page };
}
const reopen = async (app: ElectronApplication, page: Page, dir: string) => {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '열기', exact: true }).click();
  await chapter(page, 'Two').waitFor();
};
const cleanup = async (app: ElectronApplication, page: Page) => {
  await release(app).catch(() => {});
  page.on('dialog', (d) => void d.accept());
  await closeWindow(app);
};
/** 프로젝트를 연 직후 settings 쓰기·읽기가 끝나 장벽이 한가해질 때까지 기다린 뒤, 다음 settings 읽기 하나를 붙잡도록 하고 계획을 시작한다 */
async function planHeld(app: ElectronApplication, page: Page, slot: string) {
  await arm(app);
  await startPlan(page, '002.md', slot);
  await waitUntil(page, '계획이 settings 읽기에서 붙잡히지 않았다', () => held(app));
}
const bytes = async (dir: string) => [await readFile(join(dir, 'chapters', '001.md'), 'utf8'), await readFile(join(dir, 'chapters', '002.md'), 'utf8')];

test('계획을 기다리는 사이 B를 열면, 닫힌 AI 저장소의 오류도 옛 계획도 돌려주지 않고 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup(true);
  const B = await project('plan-B2', true);
  try {
    const before = await bytes(A);
    await planHeld(app, page, 'rA');
    await reopen(app, page, B);
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `옛 계획이 결과를 돌려줬다: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, STALE, `STALE_PROJECT가 아닌 오류: ${JSON.stringify(r)}`);
    assert.deepEqual(await bytes(A), before, '원고 바이트는 그대로다');
  } finally {
    await cleanup(app, page);
  }
});

test('계획을 기다리는 사이 같은 A를 다시 열어도 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup(true);
  try {
    await planHeld(app, page, 'rA');
    await reopen(app, page, A);
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `옛 계획이 결과를 돌려줬다: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, STALE, `STALE_PROJECT가 아닌 오류: ${JSON.stringify(r)}`);
  } finally {
    await cleanup(app, page);
  }
});

test('AI 저장소가 없는 프로젝트의 계획도 기다리는 사이 B를 열면 늦게 성공한 옛 계획을 돌려주지 않는다', { timeout: 120_000 }, async () => {
  const { app, page } = await setup(false);
  const B = await project('plan-B3', true);
  try {
    await planHeld(app, page, 'rA');
    await reopen(app, page, B);
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `늦게 성공한 옛 계획을 돌려줬다: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, STALE);
  } finally {
    await cleanup(app, page);
  }
});

test('정상: 같은 프로젝트의 계획은 그대로 성공하고, 진짜 오류(앞 화 없음)는 그 오류로 남는다', { timeout: 120_000 }, async () => {
  const { app, page } = await setup(true);
  try {
    await planHeld(app, page, 'ok');
    await release(app);
    const ok = await settled(page, 'ok');
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal((ok as { priors: number }).priors, 1);
    await startPlan(page, '001.md', 'real'); // 1화는 앞 화가 없어 검사할 수 없다
    const real = await settled(page, 'real');
    assert.equal(real.ok, false);
    assert.match((real as { message: string }).message, /앞 화가 없어/);
    assert.doesNotMatch((real as { message: string }).message, STALE);
  } finally {
    await cleanup(app, page);
  }
});

test('없거나 옛 token의 계획 요청은 거절된다', { timeout: 120_000 }, async () => {
  const { app, page } = await setup(true);
  try {
    for (const [slot, token] of [['rOld', 9999], ['rNone', 'undefined']] as const) {
      await startPlan(page, '002.md', slot, token as number);
      const r = await settled(page, slot);
      assert.equal(r.ok, false, `${slot}: ${JSON.stringify(r)}`);
      assert.match((r as { message: string }).message, STALE);
    }
  } finally {
    await cleanup(app, page);
  }
});
