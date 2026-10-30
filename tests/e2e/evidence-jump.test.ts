// 검사 근거로 이동: 저장된 위치(검사할 때의 줄·글자)를 믿지 않고, 근거 화의 지금 본문(저장 전 입력 포함)에서 근거 문장을 다시 찾아 선택한다.
// 감독 재현: 근거 문장 앞에 문단을 넣은 뒤 근거를 누르면 저장된 줄의 다른 문장(DECOY_SENTENCE)이 선택됐다.
// 실제 앱(Electron + Playwright). 검사 결과는 합성으로 미리 저장한다. OpenAI는 부르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { locateQuote } from '../../src/core/ai/locate.ts';
import { openManuscript } from '../../src/core/manuscript/index.ts';
import { visibleLines } from '../../src/core/manuscript/lines.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const QUOTE = 'EVIDENCE_QUOTE';
const at = (text: string, quote: string) => locateQuote(visibleLines(openManuscript(text).doc), quote)!;

/**
 * 002의 검사 결과 하나와 그 근거(evidenceFile의 QUOTE)를 저장한다. 근거 위치는 검사할 때의 본문 checkedText로 정하고,
 * 지금 원고는 files로 쓴다 (검사 뒤 고친 원고)
 */
async function project(checkedText: string, files: Record<string, string>, evidenceFile = '001.md'): Promise<string> {
  const dir = await tempDir('evidence');
  await mkdir(join(dir, 'chapters'));
  for (const [file, text] of Object.entries(files)) await writeFile(join(dir, 'chapters', file), text);
  const target = at(files['002.md']!, 'TARGET_BODY');
  const db = AiStore.open(dir);
  db.saveCheck({
    file: '002.md',
    contentHash: 'synthetic',
    model: 'fake',
    modelVersion: 'fake',
    promptVersion: 'fake',
    costUsd: 0,
    createdAt: new Date().toISOString(),
    factCount: 1,
    dropped: 0,
    inputs: [{ file: evidenceFile, contentHash: 'old' }],
    findings: [
      {
        category: 'age',
        claim: 'SYNTHETIC_CLAIM',
        confidence: 0.9,
        key: 'synthetic',
        target: { quote: 'TARGET_BODY', ...target },
        evidence: [{ file: evidenceFile, chapter: Number(evidenceFile.slice(0, 3)), quote: QUOTE, ...at(checkedText, QUOTE) }],
      },
    ],
  });
  db.close();
  return dir;
}
const ORIGINAL = `# ONE\n\n${QUOTE}\n`;
const TWO = '# TWO\n\nTARGET_BODY\n';

const editor = (page: Page) => page.locator('.ProseMirror');
const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const evidence = (page: Page, n = 1) => page.locator('section.issues').getByRole('button', { name: new RegExp(`^${n}화:`) });
const MISSING = '근거 문장을 지금 원고에서 찾을 수 없습니다';

async function openAt002(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await chapter(page, 'TWO').click();
  await page.getByText('SYNTHETIC_CLAIM', { exact: true }).waitFor();
}
async function withApp(dir: string, work: (app: ElectronApplication, page: Page) => Promise<void>) {
  const { app, page } = await launch(await tempDir('evidence-userdata'));
  try {
    await openAt002(app, page, dir);
    await work(app, page);
  } finally {
    await closeWindow(app);
  }
}
/** 근거를 누르고 그 화가 열려 무엇이 선택됐는지 (선택이 없으면 잠시 기다린 뒤 빈 문자열) */
async function clickEvidence(page: Page, bodyText: string, n = 1): Promise<string> {
  await evidence(page, n).click();
  await editor(page).getByText(bodyText, { exact: true }).waitFor();
  await page.waitForFunction(() => !!window.getSelection()?.toString(), null, { timeout: 2000 }).catch(() => {});
  return selection(page);
}

// [경우, 검사할 때의 001 본문(근거 위치를 정함), 지금 001 본문, 근거 문장이 있는 지금 줄]
for (const [name, checked, current, line] of [
  ['근거 앞에 문단을 넣음 (감독 재현)', ORIGINAL, `# ONE

DECOY_SENTENCE

${QUOTE}
`, QUOTE],
  ['근거 앞 문단을 지움', `# ONE

DECOY_SENTENCE

X

${QUOTE}
`, `${QUOTE}
`, QUOTE],
  ['근거가 다른 자리로 옮겨짐', ORIGINAL, `# ONE

DECOY_SENTENCE

DECOY_TWO

앞말 ${QUOTE} 뒷말
`, `앞말 ${QUOTE} 뒷말`],
  ['그대로 (정상 근거)', ORIGINAL, ORIGINAL, QUOTE],
] as const) {
  test(`근거 이동 (${name}): 지금 본문에서 근거 문장을 다시 찾아 그 문장만 선택하고, 원고는 바꾸지 않는다`, { timeout: 90_000 }, async () => {
    const dir = await project(checked, { '001.md': current, '002.md': TWO });
    await withApp(dir, async (_app, page) => {
      assert.equal(await clickEvidence(page, line), QUOTE);
      assert.equal(await page.getByText(MISSING, { exact: false }).count(), 0);
    });
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), current);
  });
}

test('근거 문장이 지워짐: 다른 문장을 선택하지 않고 찾을 수 없다고 알린다. 원고는 바꾸지 않는다', { timeout: 90_000 }, async () => {
  const current = '# ONE\n\nDECOY_SENTENCE\n\nREWRITTEN\n';
  const dir = await project(`# ONE\n\nDECOY_SENTENCE\n\n${QUOTE}\n`, { '001.md': current, '002.md': TWO });
  await withApp(dir, async (_app, page) => {
    await evidence(page).click();
    await page.getByText(MISSING, { exact: false }).waitFor();
    await editor(page).getByText('REWRITTEN', { exact: true }).waitFor();
    assert.equal(await selection(page), '');
  });
  assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), current);
});

test('같은 화의 저장 전 입력: 근거 화를 열어 둔 채 근거 앞에 문단을 입력하고 바로 누르면, 입력한 지금 본문에서 찾는다', { timeout: 90_000 }, async () => {
  // 002의 근거가 002 자신의 문장이다
  const two = `# TWO\n\nTARGET_BODY\n\n${QUOTE}\n`;
  const dir = await project(two, { '001.md': ORIGINAL, '002.md': two }, '002.md');
  await withApp(dir, async (_app, page) => {
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('End');
    // 자동 저장(1.5초)을 기다리지 않는다: 저장된 위치의 줄에는 이제 입력한 문단이 있다
    await page.keyboard.press('Enter');
    await page.keyboard.type('TYPED_DECOY');
    assert.equal(await clickEvidence(page, QUOTE, 2), QUOTE);
  });
});

test('저장 실패 뒤 이동 취소: 지금 화를 저장하지 못해 계속하지 않으면 근거 화로 가지 않고 아무것도 선택하지 않는다', { timeout: 90_000 }, async () => {
  const dir = await project(ORIGINAL, { '001.md': `# ONE\n\nDECOY_SENTENCE\n\n${QUOTE}\n`, '002.md': TWO });
  await withApp(dir, async (app, page) => {
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
      handlers.set('chapter:write', async () => {
        throw new Error('저장 실패 (테스트)');
      });
    });
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 저장안됨');
    const dialog = new Promise<string>((resolve) => page.once('dialog', (d) => void d.dismiss().then(() => resolve(d.message()))));
    await evidence(page).click();
    assert.match(await dialog, /저장되지 않은 변경/);
    await editor(page).getByText('TARGET_BODY 저장안됨', { exact: true }).waitFor();
    assert.equal(await editor(page).getByText('DECOY_SENTENCE').count(), 0);
    assert.equal(await page.getByText(MISSING, { exact: false }).count(), 0);
    // 창을 닫을 때도 저장하지 못해 다시 묻는다: 이번에는 계속한다 (저장 못 한 입력은 버린다)
    page.on('dialog', (d) => void d.accept());
  });
});

test('늦은 응답: 근거 화를 읽는 동안 다른 화로 옮기거나 다른 프로젝트를 열면, 늦게 온 근거 화가 선택·알림을 남기지 않는다', { timeout: 90_000 }, async () => {
  const dir = await project(ORIGINAL, { '001.md': `# ONE\n\nDECOY_SENTENCE\n\n${QUOTE}\n`, '002.md': TWO, '003.md': '# THREE\n\nTHREE_BODY\n' });
  const other = await tempDir('evidence-other');
  await mkdir(join(other, 'chapters'));
  await writeFile(join(other, 'chapters', '001.md'), '# OTHER\n\nOTHER_BODY\n');
  await withApp(dir, async (app, page) => {
    for (const next of ['chapter', 'project'] as const) {
      if (next === 'project') {
        await chapter(page, 'TWO').click();
        await page.getByText('SYNTHETIC_CLAIM', { exact: true }).waitFor();
      }
      // 001 읽기는 원래 처리를 끝까지 한 뒤 응답만 붙잡는다
      await app.evaluate(({ ipcMain }) => {
        const g = globalThis as unknown as { held: boolean; release?: () => void };
        g.held = false;
        const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, (...a: unknown[]) => Promise<unknown>> })._invokeHandlers;
        const original = handlers.get('chapter:read')!;
        handlers.set('chapter:read', async (...args: unknown[]) => {
          const r = await Promise.resolve()
            .then(() => original(...args))
            .then(
              (v) => ({ v }),
              (e: unknown) => ({ e }),
            );
          if (args[1] === '001.md' && !g.held) {
            handlers.set('chapter:read', original);
            g.held = true;
            await new Promise<void>((resolve) => (g.release = resolve));
          }
          if ('e' in r) throw r.e;
          return r.v;
        });
      });
      await evidence(page).click();
      for (let n = 0; n < 300 && !(await app.evaluate(() => (globalThis as unknown as { held: boolean }).held)); n++) await page.waitForTimeout(10);
      if (next === 'chapter') {
        await chapter(page, 'THREE').click();
        await editor(page).getByText('THREE_BODY', { exact: true }).waitFor();
      } else {
        await stubFolderDialog(app, other);
        await page.getByRole('button', { name: '열기', exact: true }).click();
        await editor(page).getByText('OTHER_BODY', { exact: true }).waitFor();
      }
      await app.evaluate(() => (globalThis as unknown as { release?: () => void }).release?.());
      // 늦은 응답이 화면에 도착할 때까지 한 번 다녀온다
      await page.evaluate(() => window.loreweave.ai.status());
      await page.waitForTimeout(200);
      assert.equal(await editor(page).getByText(QUOTE).count(), 0);
      assert.equal(await selection(page), '');
      assert.equal(await page.getByText(MISSING, { exact: false }).count(), 0);
    }
  });
});

test('같은 화에서 인용이 없으면 기존 다른 문장 선택을 근거처럼 남기지 않고 본문은 그대로다', { timeout: 90_000 }, async () => {
  const checked = `# TWO\n\nTARGET_BODY\n\n${QUOTE}\n`;
  const current = '# TWO\n\nTARGET_BODY\n\nREWRITTEN\n';
  const dir = await project(checked, { '001.md': ORIGINAL, '002.md': current }, '002.md');
  await withApp(dir, async (_app, page) => {
    for (let n = 0; n < 2; n++) {
      await editor(page).getByText('TARGET_BODY', { exact: true }).click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      assert.equal(await selection(page), 'TARGET_BODY');
      await evidence(page, 2).click();
      await page.getByText(MISSING, { exact: false }).waitFor();
      assert.equal(await selection(page), '');
    }
    // 본문과 파일은 바뀌지 않는다 (저장 대기도 생기지 않는다)
    assert.equal(await editor(page).getByText('REWRITTEN', { exact: true }).count(), 1);
    await page.waitForTimeout(1500);
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), current);
  });
});

// 이 화 인용(IssuesPanel)과 사실 인용(FactsPanel): 지금 본문에 인용이 없으면 이전에 선택해 둔 글자를 남기지 않는다.
// 감독 재현: TARGET_BODY를 REWRITTEN으로 고쳐 쓴 뒤 REWRITTEN을 선택하고 인용을 누르면 REWRITTEN이 선택된 채 남았다.
for (const kind of ['target', 'fact'] as const) {
  test(`${kind === 'target' ? '이 화 인용' : '사실 인용'}: 본문에 인용이 없으면 기존 선택을 접고, 본문·undo·파일은 그대로이며, 인용이 돌아오면 다시 선택한다`, { timeout: 90_000 }, async () => {
    const dir = await project(ORIGINAL, { '001.md': ORIGINAL, '002.md': TWO });
    const db = AiStore.open(dir);
    db.saveAnalysis({
      file: '002.md',
      contentHash: 'synthetic',
      model: 'fake',
      modelVersion: 'fake',
      promptVersion: 'fake',
      summary: 'SYNTHETIC',
      droppedQuotes: 0,
      costUsd: 0,
      createdAt: new Date().toISOString(),
      entities: [{ name: 'SYNTHETIC', aliases: [] }],
      facts: [{ entity: 'SYNTHETIC', predicate: 'kind', value: 'value', quote: 'TARGET_BODY', ...at(TWO, 'TARGET_BODY') }],
    });
    db.close();
    const panel = (page: Page) => page.locator(kind === 'target' ? 'section.issues' : 'aside.facts');
    const button = (page: Page) => panel(page).getByRole('button', { name: kind === 'target' ? '이 화: “TARGET_BODY”' : '“TARGET_BODY”', exact: true });
    const warning = (page: Page) => panel(page).getByText(kind === 'target' ? '지금 본문에서 이 문장을 찾을 수 없습니다' : '지금 본문에서 이 인용을 찾을 수 없습니다', { exact: false });
    await withApp(dir, async (_app, page) => {
      await editor(page).getByText('TARGET_BODY', { exact: true }).click();
      await page.keyboard.press('Home');
      await page.keyboard.press('Shift+End');
      await page.keyboard.type('REWRITTEN');
      for (let n = 0; n < 2; n++) {
        await page.keyboard.press('Home');
        await page.keyboard.press('Shift+End');
        assert.equal(await selection(page), 'REWRITTEN');
        await button(page).click();
        await warning(page).waitFor();
        await page.waitForFunction(() => window.getSelection()?.toString() === '', null, { timeout: 3000 });
      }
      assert.equal(await editor(page).getByText('REWRITTEN', { exact: true }).count(), 1);
      // 선택만 접었으므로 undo 기록은 그대로다: 되돌리면 인용이 돌아오고, 다시 누르면 선택된다
      await page.keyboard.press('Control+z');
      await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
      await button(page).click();
      await page.waitForFunction(() => window.getSelection()?.toString() === 'TARGET_BODY');
      assert.equal(await warning(page).count(), 0);
    });
    // 입력 중이던 REWRITTEN은 저장됐을 수 있으나, 되돌린 뒤에는 원래 본문이다 (파일은 두 상태 중 하나)
    assert.match(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), /^# TWO\n\n(REWRITTEN|TARGET_BODY)\n$/);
  });
}
