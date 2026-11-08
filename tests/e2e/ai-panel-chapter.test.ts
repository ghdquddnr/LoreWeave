// 같은 프로젝트에서 화를 바꿀 때 AI 패널(문제 가능성·AI가 찾은 사실)의 결과·조작이 그 화에 묶이는가.
// 감독 재현: 001 결과를 보던 중 002로 옮기고 002 조회 응답이 늦으면, 002 화면에 001 결과와 [무시]가 남아 누르면 002 결과가 무시됐다.
// 실제 앱(Electron + Playwright). 분석·검사 결과는 합성으로 미리 저장하고, main의 조회 처리기 응답을 붙잡거나 실패시킨다. OpenAI는 부르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

/** 001.md(ONE)·002.md(TWO)와 각 화의 합성 분석·검사 결과. extra: 001의 검사 결과를 하나 더 둔다 */
async function project(extra = false): Promise<string> {
  const dir = await tempDir('panel-chapter');
  await mkdir(join(dir, 'chapters'));
  const db = AiStore.open(dir);
  const createdAt = new Date().toISOString();
  const meta = { contentHash: 'synthetic', model: 'fake', modelVersion: 'fake', promptVersion: 'fake', costUsd: 0, createdAt };
  for (const [file, m] of [
    ['001.md', 'ONE'],
    ['002.md', 'TWO'],
  ] as const) {
    const body = `${m}_BODY`;
    await writeFile(join(dir, 'chapters', file), `# ${m}\n\n${body}\n`);
    const target = { quote: body, line: 3, start: 0, end: body.length };
    db.saveAnalysis({ file, ...meta, summary: '요약', droppedQuotes: 0, entities: [], facts: [{ entity: '인물', predicate: '나이', value: `${m}_FACT`, ...target }] });
    const findings = [{ category: 'age' as const, claim: `${m}_CLAIM`, confidence: 0.9, key: m as string, target, evidence: [] }];
    if (extra && m === 'ONE') findings.push({ category: 'age', claim: 'ONE_SECOND_CLAIM', confidence: 0.9, key: 'ONE2', target, evidence: [] });
    db.saveCheck({ file, ...meta, factCount: 0, dropped: 0, inputs: [], findings });
  }
  db.close();
  return dir;
}
/** 저장된 무시 여부 (앱이 닫힌 뒤 읽는다) */
function dismissed(dir: string, file: string): boolean[] {
  const db = AiStore.open(dir);
  try {
    return db.check(file)!.findings.map((f) => f.dismissed);
  } finally {
    db.close();
  }
}

/**
 * ai:check-result·ai:analysis 처리기를 감싼다. gate(채널:화)를 걸면 그 화의 다음 조회 한 번은 원래 처리를 끝까지 한 뒤
 * hold면 응답을 붙잡고(release까지), fail이면 실패로 돌려준다. 끝난 조회는 done에 남긴다
 */
async function instrument(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const g = globalThis as unknown as {
      gates: Record<string, { hold?: boolean; fail?: boolean; failWith?: string }>;
      held: Record<string, boolean>;
      release: Record<string, () => void>;
      done: Record<string, number>;
    };
    g.gates = {};
    g.held = {};
    g.release = {};
    g.done = {};
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
    for (const name of ['ai:check-result', 'ai:analysis']) {
      const original = handlers.get(name)!;
      handlers.set(name, async (...args: unknown[]) => {
        const key = `${name}:${String(args[1])}`;
        const gate = g.gates[key];
        delete g.gates[key];
        const r = await Promise.resolve()
          .then(() => original(...args))
          .then(
            (v) => ({ v }),
            (e: unknown) => ({ e }),
          );
        if (gate?.hold) {
          g.held[key] = true;
          await new Promise<void>((resolve) => (g.release[key] = resolve));
        }
        g.done[key] = (g.done[key] ?? 0) + 1;
        if (gate?.fail) throw new Error(gate.failWith ?? '조회 실패 (테스트)');
        if ('e' in r) throw r.e;
        return r.v;
      });
    }
  });
}
const gate = (app: ElectronApplication, key: string, how: { hold?: boolean; fail?: boolean; failWith?: string }) =>
  app.evaluate((_e, [k, h]) => void ((globalThis as unknown as { gates: Record<string, unknown> }).gates[k] = h), [key, how] as const);
const release = (app: ElectronApplication, key: string) =>
  app.evaluate((_e, k) => (globalThis as unknown as { release: Record<string, () => void> }).release[k]?.(), key);
const done = (app: ElectronApplication, key: string) =>
  app.evaluate((_e, k) => (globalThis as unknown as { done: Record<string, number> }).done[k] ?? 0, key);
async function waitFor(page: Page, cond: () => Promise<boolean>, what: string) {
  for (let n = 0; n < 300 && !(await cond()); n++) await page.waitForTimeout(10);
  assert.ok(await cond(), what);
}
const waitHeld = (app: ElectronApplication, page: Page, key: string) =>
  waitFor(page, () => app.evaluate((_e, k) => !!(globalThis as unknown as { held: Record<string, boolean> }).held[k], key), `${key}를 붙잡지 못했다`);

const editor = (page: Page) => page.locator('.ProseMirror');
const issues = (page: Page) => page.locator('section.issues');
const facts = (page: Page) => page.locator('aside.facts');
const dismissButtons = (page: Page) => issues(page).getByRole('button', { name: '무시', exact: true });
// 화 버튼 이름에는 분석 상태 표시도 붙는다
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });

async function open(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
  await facts(page).getByText('ONE_FACT', { exact: false }).waitFor();
  await instrument(app);
}
async function release2(app: ElectronApplication) {
  await release(app, 'ai:check-result:002.md').catch(() => {});
  await release(app, 'ai:analysis:002.md').catch(() => {});
}

test('감독 재현: 002 조회가 늦는 동안 002 화면에 001의 결과·[무시]·사실이 보이지 않고, 응답 뒤 002에서 누르면 002만 무시한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('panel-chapter-userdata'));
  try {
    await open(app, page, dir);
    await gate(app, 'ai:check-result:002.md', { hold: true });
    await gate(app, 'ai:analysis:002.md', { hold: true });
    await chapter(page, 'TWO').click();
    await editor(page).getByText('TWO_BODY', { exact: true }).waitFor();
    await waitHeld(app, page, 'ai:check-result:002.md');
    await waitHeld(app, page, 'ai:analysis:002.md');
    assert.equal(await issues(page).getByText('ONE_CLAIM', { exact: true }).count(), 0);
    assert.equal(await dismissButtons(page).count(), 0);
    assert.equal(await facts(page).getByText('ONE_FACT', { exact: false }).count(), 0);
    await issues(page).getByText('불러오는 중…').waitFor();
    await facts(page).getByText('불러오는 중…').waitFor();
    await release2(app);
    await issues(page).getByText('TWO_CLAIM', { exact: true }).waitFor();
    await facts(page).getByText('TWO_FACT', { exact: false }).waitFor();
    await dismissButtons(page).click();
    await issues(page).getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
  } finally {
    await release2(app);
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir, '001.md'), [false]);
  assert.deepEqual(dismissed(dir, '002.md'), [true]);
});

test('001→002→001 빠른 이동, 응답 역순: 늦게 온 002의 성공·실패는 001 화면을 덮지 않고, 001에서 누르면 001만 무시한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('panel-chapter-userdata'));
  try {
    await open(app, page, dir);
    // 002 조회는 붙잡았다가 하나는 성공, 하나는 실패로 늦게 돌아온다
    await gate(app, 'ai:check-result:002.md', { hold: true });
    await gate(app, 'ai:analysis:002.md', { hold: true, fail: true });
    await chapter(page, 'TWO').click();
    await waitHeld(app, page, 'ai:check-result:002.md');
    await waitHeld(app, page, 'ai:analysis:002.md');
    await chapter(page, 'ONE').click();
    await editor(page).getByText('ONE_BODY', { exact: true }).waitFor();
    await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
    await facts(page).getByText('ONE_FACT', { exact: false }).waitFor();
    await release2(app);
    await waitFor(page, async () => (await done(app, 'ai:check-result:002.md')) === 1 && (await done(app, 'ai:analysis:002.md')) === 1, '002 조회가 끝나지 않았다');
    // 응답이 화면에 도착할 때까지 한 번 더 다녀온다 (같은 IPC 통로라 그 전에 처리된다)
    await page.evaluate(() => window.loreweave.ai.status());
    assert.equal(await issues(page).getByText('TWO_CLAIM', { exact: true }).count(), 0);
    assert.equal(await facts(page).getByText('TWO_FACT', { exact: false }).count(), 0);
    assert.equal(await page.getByText('읽지 못했습니다', { exact: false }).count(), 0);
    await issues(page).getByText('ONE_CLAIM', { exact: true }).waitFor();
    await dismissButtons(page).click();
    await issues(page).getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
  } finally {
    await release2(app);
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir, '001.md'), [true]);
  assert.deepEqual(dismissed(dir, '002.md'), [false]);
});

test('조회 실패: 지금 화의 조회가 실패하면 무한 로딩이 아니라 안내와 [다시 읽기]를 보이고, 다시 읽으면 정상 표시·무시된다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('panel-chapter-userdata'));
  try {
    await open(app, page, dir);
    await gate(app, 'ai:check-result:002.md', { fail: true });
    await gate(app, 'ai:analysis:002.md', { fail: true });
    await chapter(page, 'TWO').click();
    await issues(page).getByText('검사 결과를 읽지 못했습니다', { exact: false }).waitFor();
    await facts(page).getByText('분석 결과를 읽지 못했습니다', { exact: false }).waitFor();
    assert.equal(await page.getByText('불러오는 중…').count(), 0);
    assert.equal(await dismissButtons(page).count(), 0);
    await issues(page).getByRole('button', { name: '다시 읽기', exact: true }).click();
    await facts(page).getByRole('button', { name: '다시 읽기', exact: true }).click();
    await issues(page).getByText('TWO_CLAIM', { exact: true }).waitFor();
    await facts(page).getByText('TWO_FACT', { exact: false }).waitFor();
    assert.equal(await page.getByText('읽지 못했습니다', { exact: false }).count(), 0);
    await dismissButtons(page).click();
    await issues(page).getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
  } finally {
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir, '001.md'), [false]);
  assert.deepEqual(dismissed(dir, '002.md'), [true]);
});

test('같은 화 다시 읽기: 무시 뒤 결과를 다시 읽는 동안 남은 결과의 [무시]는 막히고, 새 결과가 오면 다시 눌린다', { timeout: 90_000 }, async () => {
  const dir = await project(true);
  const { app, page } = await launch(await tempDir('panel-chapter-userdata'));
  try {
    await open(app, page, dir);
    assert.equal(await dismissButtons(page).count(), 2);
    await gate(app, 'ai:check-result:001.md', { hold: true });
    await dismissButtons(page).first().click();
    await waitHeld(app, page, 'ai:check-result:001.md');
    // 이전 조회의 결과(무시 전)는 보이지만 결과 번호가 바뀌었을 수 있어 누르지 못한다
    assert.equal(await dismissButtons(page).count(), 2);
    for (const b of await dismissButtons(page).all()) assert.equal(await b.isDisabled(), true);
    await release(app, 'ai:check-result:001.md');
    await issues(page).getByText('무시한 결과 1개 보기', { exact: true }).waitFor();
    assert.equal(await dismissButtons(page).count(), 1);
    assert.equal(await dismissButtons(page).isDisabled(), false);
  } finally {
    await release(app, 'ai:check-result:001.md').catch(() => {});
    await closeWindow(app);
  }
  assert.deepEqual(dismissed(dir, '001.md'), [true, false]);
  assert.deepEqual(dismissed(dir, '002.md'), [false]);
});

// 저장된 결과 조회 실패는 읽기 실패다: EPERM/EACCES를 "파일에 쓸 수 없습니다"(쓰기 실패)로 안내하지 않는다. 기본 안내에는 IPC 접두사·코드·경로가 없고 원문은 접힌 기술 상세에 보존된다.
// 무료: 합성 결과·합성 원고만, 조회 처리기를 실패 대역으로 감싼다. OpenAI·유료 AI 실행 없음. 합성 Electron 검사이며 수동 GUI가 아니다.
test('결과 조회 실패(EACCES): 두 패널 모두 읽기 실패로 안내하고 원문은 접힌 상세에만 있으며, 상세 조작은 조회·쓰기가 없고, 다시 읽기로 복구된다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const files = ['001.md', '002.md'];
  const originals = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
  const { app, page } = await launch(await tempDir('panel-read-error-userdata'));
  try {
    await open(app, page, dir);
    // 쓰기 호출 수를 센다 (읽기 조회·상세 조작이 chapter:write를 만들지 않는다)
    await app.evaluate(({ ipcMain }) => {
      const g = globalThis as unknown as { writes: number };
      g.writes = 0;
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      const original = handlers.get('chapter:write')!;
      handlers.set('chapter:write', async (...args: unknown[]) => {
        g.writes++;
        return original(...args);
      });
    });
    const failWith = "EACCES: permission denied, open 'C:/Users/synthetic/ai/ai.db'";
    await gate(app, 'ai:check-result:002.md', { fail: true, failWith });
    await gate(app, 'ai:analysis:002.md', { fail: true, failWith });
    await chapter(page, 'TWO').click();
    await issues(page).getByText('검사 결과를 읽지 못했습니다', { exact: false }).waitFor();
    await facts(page).getByText('분석 결과를 읽지 못했습니다', { exact: false }).waitFor();
    for (const [name, panel, prefix] of [
      ['문제 가능성', issues(page), '검사 결과를 읽지 못했습니다'],
      ['AI가 찾은 사실', facts(page), '분석 결과를 읽지 못했습니다'],
    ] as const) {
      const text = await panel.locator('.error-note').first().innerText();
      for (const wrong of ['쓸 수 없습니다', '저장', '쓰기']) assert.ok(!text.includes(wrong), `${name}: 읽기 실패를 쓰기·저장 실패(${wrong})로 설명하지 않는다 (안내: ${text})`);
      assert.match(text, new RegExp(`${prefix}: .*읽을 수 없습니다`), `${name}: 읽기 실패로 안내한다`);
      for (const raw of ['Error invoking', 'EACCES', 'permission denied', 'C:/Users', 'synthetic', 'ai.db']) assert.ok(!text.includes(raw), `${name}: 기본 안내에 기술 문구(${raw})가 없다`);
      assert.equal(await panel.locator('.tech-detail').count(), 0, `${name}: 기술 상세는 기본 접힘이다`);
    }

    // 상세 열기/닫기: 원문 보존, 조회(done 개수)·쓰기 IPC 0
    const doneBefore = [await done(app, 'ai:check-result:002.md'), await done(app, 'ai:analysis:002.md')];
    for (const panel of [issues(page), facts(page)]) {
      await panel.getByRole('button', { name: '기술 상세' }).click();
      const detail = await panel.locator('.tech-detail').innerText();
      for (const raw of ['Error invoking', 'EACCES', 'permission denied', 'C:/Users/synthetic/ai/ai.db']) assert.ok(detail.includes(raw), `기술 상세에 원문(${raw})이 보존된다`);
      await panel.getByRole('button', { name: '상세 닫기' }).click();
      assert.equal(await panel.locator('.tech-detail').count(), 0);
    }
    assert.deepEqual([await done(app, 'ai:check-result:002.md'), await done(app, 'ai:analysis:002.md')], doneBefore, '상세 조작은 조회 IPC를 만들지 않는다');
    assert.equal(await app.evaluate(() => (globalThis as unknown as { writes: number }).writes), 0, '쓰기 IPC 0');

    // 다시 읽기로 복구 (해당 결과 조회만 다시 실행한다)
    await issues(page).getByRole('button', { name: '다시 읽기', exact: true }).click();
    await facts(page).getByRole('button', { name: '다시 읽기', exact: true }).click();
    await issues(page).getByText('TWO_CLAIM', { exact: true }).waitFor();
    await facts(page).getByText('TWO_FACT', { exact: false }).waitFor();
    assert.equal(await page.getByText('읽지 못했습니다', { exact: false }).count(), 0);
    assert.equal(await app.evaluate(() => (globalThis as unknown as { writes: number }).writes), 0, '복구 뒤에도 쓰기 IPC 0');
    const after = await Promise.all(files.map((f) => readFile(join(dir, 'chapters', f))));
    assert.ok(after.every((b, i) => Buffer.compare(b, originals[i]!) === 0), '원고 원본 바이트 불변');
  } finally {
    await closeWindow(app);
  }
});
