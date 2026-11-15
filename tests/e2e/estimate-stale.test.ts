// 분석 예상 비용 IPC(ai:estimate)의 프로젝트 소유권: 예상을 기다리는 사이 다른 프로젝트(같은 폴더 다시 열기 포함)를 열면 옛 성공이나 옛 읽기 오류를 돌려주지 않고 STALE_PROJECT로 끝나는지 본다.
// 장벽: 격리 userData의 settings.json 읽기(handler가 estimate 전에 기다린다) 반환을 붙잡는다. 실제 등록된 main handler가 처리하고 대역은 없다. AI DB·키·실제 API는 쓰지 않는다.
// 격리: hooks/main-isolated-userdata-entry.cjs가 제품 main을 불러오기 전에 이 테스트의 독점 새 userData를 강제하고 증거를 남긴다 (setup이 그 증거를 확인한다).
// 합성 원고(BOM + CRLF + frontmatter). 원고 바이트는 첫 테스트에서 실행한 A의 두 합성 파일(001.md, 002.md)만 Buffer로 비교한다.

import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, currentTokenFn, launch, stubFolderDialog, tempDir } from './launch.ts';

const ENTRY = join(__dirname, 'hooks', 'main-isolated-userdata-entry.cjs');

const STALE = /원고 폴더가 바뀌어/;
const doc = (id: string, title: string, text: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n${text}\r\n`;
async function project(prefix: string): Promise<string> {
  const dir = await tempDir(prefix);
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), doc('p1', 'One', 'alpha one'));
  await writeFile(join(dir, 'chapters', '002.md'), doc('p2', 'Two', 'alpha two'));
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

type Outcome = { ok: true; chars: number; costUsd: number } | { ok: false; message: string };
const startEstimate = (page: Page, files: string[], slot: string, token?: number) =>
  page.evaluate(
    `(async () => { const t = ${token ?? 'await (' + currentTokenFn + ')()'}; window.${slot} = null;
       window.loreweave.ai.estimate(${JSON.stringify(files)}, t).then((r) => (window.${slot} = { ok: true, chars: r.chars, costUsd: r.costUsd }), (e) => (window.${slot} = { ok: false, message: String(e && e.message) })); })()`,
  );
const settled = async (page: Page, slot: string): Promise<Outcome> => {
  await waitUntil(page, `${slot} 예상이 끝나지 않았다`, async () => (await page.evaluate(`window.${slot}`)) !== null);
  return (await page.evaluate(`window.${slot}`)) as Outcome;
};

async function setup() {
  const A = await project('est-A');
  const userData = await tempDir('est-userdata');
  const { app, page } = await launch(userData, { LW_TEST_USERDATA: userData }, ENTRY);
  // 격리 증거: 시작 파일이 제품 main보다 먼저, 비어 있던 이 userData를 강제하고 기록했다. 앱의 userData도 같다 (기본 프로필이 아니다)
  const evidence = JSON.parse(await readFile(join(userData, '.isolated-entry-evidence.json'), 'utf8')) as { stage: string; userData: string; entriesBefore: string[] };
  assert.equal(evidence.stage, 'before-product-main');
  assert.deepEqual(evidence.entriesBefore, []);
  assert.equal(evidence.userData, await app.evaluate(({ app: a }) => a.getPath('userData')));
  assert.equal((await realpath(userData)).toLowerCase(), evidence.userData.toLowerCase());
  await install(app, join(evidence.userData, 'settings.json'));
  await stubFolderDialog(app, A);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await chapter(page, 'Two').waitFor();
  return { A, app, page };
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
/** 다음 settings 읽기 하나를 붙잡도록 하고 예상을 시작한다 */
async function estimateHeld(app: ElectronApplication, page: Page, slot: string, files = ['001.md', '002.md']) {
  await arm(app);
  await startEstimate(page, files, slot);
  await waitUntil(page, '예상이 settings 읽기에서 붙잡히지 않았다', () => held(app));
}
const bytes = async (dir: string) => [await readFile(join(dir, 'chapters', '001.md')), await readFile(join(dir, 'chapters', '002.md'))];

test('예상을 기다리는 사이 B를 열면, 늦게 성공한 옛 예상을 돌려주지 않고 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup();
  const B = await project('est-B');
  try {
    const before = await bytes(A);
    await estimateHeld(app, page, 'rA');
    await reopen(app, page, B);
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `옛 예상이 결과를 돌려줬다: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, STALE, JSON.stringify(r));
    assert.deepEqual(await bytes(A), before, '실행한 A의 합성 파일 두 개의 바이트는 그대로다');
  } finally {
    await cleanup(app, page);
  }
});

test('예상을 기다리는 사이 같은 A를 다시 열어도 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup();
  try {
    await estimateHeld(app, page, 'rA');
    await reopen(app, page, A);
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false, `옛 예상이 결과를 돌려줬다: ${JSON.stringify(r)}`);
    assert.match((r as { message: string }).message, STALE, JSON.stringify(r));
  } finally {
    await cleanup(app, page);
  }
});

test('기다리는 사이 옛 프로젝트의 파일 읽기가 실패하고 B가 열렸다면, 그 읽기 오류가 아니라 STALE_PROJECT로 끝난다', { timeout: 120_000 }, async () => {
  const { A, app, page } = await setup();
  const B = await project('est-B');
  try {
    await estimateHeld(app, page, 'rA', ['001.md', '002.md']);
    await rm(join(A, 'chapters', '002.md')); // 이 테스트가 만든 합성 A의 파일: 예상이 이어지면 읽기 오류가 난다
    await reopen(app, page, B);
    await release(app);
    const r = await settled(page, 'rA');
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, STALE, `옛 읽기 오류가 새 요청의 오류로 남았다: ${JSON.stringify(r)}`);
  } finally {
    await cleanup(app, page);
  }
});

test('정상: 같은 프로젝트의 예상은 그대로 chars/cost를 돌려주고, 진짜 입력 오류는 그 오류로 남는다', { timeout: 120_000 }, async () => {
  const { app, page } = await setup();
  try {
    await estimateHeld(app, page, 'ok');
    await release(app);
    const ok = await settled(page, 'ok');
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.ok((ok as { chars: number }).chars > 0 && (ok as { costUsd: number }).costUsd > 0, JSON.stringify(ok));
    await startEstimate(page, ['999.md'], 'real'); // 없는 화
    const real = await settled(page, 'real');
    assert.equal(real.ok, false);
    assert.doesNotMatch((real as { message: string }).message, STALE);
  } finally {
    await cleanup(app, page);
  }
});

test('없거나 옛 token의 예상 요청은 거절된다', { timeout: 120_000 }, async () => {
  const { app, page } = await setup();
  try {
    for (const [slot, token] of [['rOld', 9999], ['rNone', 'undefined']] as const) {
      await startEstimate(page, ['001.md'], slot, token as number);
      const r = await settled(page, slot);
      assert.equal(r.ok, false, `${slot}: ${JSON.stringify(r)}`);
      assert.match((r as { message: string }).message, STALE);
    }
  } finally {
    await cleanup(app, page);
  }
});
