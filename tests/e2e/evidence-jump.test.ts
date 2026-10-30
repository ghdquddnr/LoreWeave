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

// ---- 검색창에 포커스가 있어 근거 jump/collapse가 편집기 포커스를 가져가지 않은 뒤, 사용자가 명시적으로 본문으로 돌아와 입력하는 경로 ----
// 근거 jump(정상 quote)와 quote 없음 collapse 두 경우만: 편집기에 jump/collapse가 선택을 만들고(포커스는 검색창이 가진다) → 사용자가 본문 한 곳을 클릭해 돌아와 End 뒤 입력 → Ctrl+S →
// 다른 화로 이동 → 다시 열기: 실제 저장 완료·디스크 바이트·다시 연 본문이 예상과 같아야 한다. 선택만 검사하거나 저장 함수를 대체하지 않는다.
// 예상 본문은 미리 정한다: 사용자는 'TARGET_BODY' 문단을 클릭하고 End를 눌러 그 줄 끝에 ' ADDED'를 입력한다 → 그 문단만 'TARGET_BODY ADDED'가 되고 근거 문장/다른 문단은 그대로다.
// 지연 focus 프레임(jump/collapse가 예약)은 renderer의 requestAnimationFrame을 테스트가 보관해(합성 스케줄러 제어) 사용자가 검색창을 선택한 뒤에 하나씩 실행한다.
// 관측(제품 hook 없음): TipTap이 `.ProseMirror`에 붙인 editor를 읽기 전용으로 읽어 PM 선택 from/to와 선택 본문, activeElement 종류를 단계마다 기록한다. 진단 evaluate는 순서에 끼어들 수 있다.
const TYPED = ' ADDED';
const BODY_QUOTE = `# TWO\n\nTARGET_BODY\n\n${QUOTE}\n`;
const BODY_REWRITTEN = `# TWO\n\nTARGET_BODY\n\nREWRITTEN\n`;

type FrameHeld = { cb: (t: number) => void; stage: string };
type PmObs = { from: number; to: number; text: string; active: string };
type FrameWindow = { framesHeld: FrameHeld[]; rafOriginal: typeof window.requestAnimationFrame; stage: string; readPm: () => PmObs };

async function holdFrames(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as FrameWindow;
    w.framesHeld = [];
    w.stage = 'before';
    w.rafOriginal = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      w.framesHeld.push({ cb, stage: w.stage });
      return w.framesHeld.length;
    };
    // 페이지 안 함수: 이름 붙은 함수를 변수에 담지 않고 속성에 대입한다 (테스트 변환기의 이름 도우미가 페이지에 없다)
    w.readPm = () => {
      const ed = (document.querySelector('.ProseMirror') as unknown as { editor: { state: { selection: { from: number; to: number }; doc: { textBetween(a: number, b: number): string } } } }).editor;
      const { from, to } = ed.state.selection;
      const el = document.activeElement as HTMLElement | null;
      const active = el?.classList.contains('ProseMirror') ? 'editor' : el instanceof HTMLInputElement ? 'input' : (el?.tagName.toLowerCase() ?? 'none');
      return { from, to, text: ed.state.doc.textBetween(from, to), active };
    };
  });
}
const readPm = (page: Page) => page.evaluate(() => (window as unknown as FrameWindow).readPm());

async function returnAndType(app: ElectronApplication, page: Page, dir: string, kind: 'found' | 'missing') {
  const two = join(dir, 'chapters', '002.md');
  const original = kind === 'found' ? BODY_QUOTE : BODY_REWRITTEN;
  const expected = original.replace('TARGET_BODY', `TARGET_BODY${TYPED}`);
  void app;
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  // 시작 포커스가 끝난 뒤의 상태에서 시작한다
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 });
  if (kind === 'missing') {
    // 접힐 선택을 먼저 만든다: 실제 키로 TARGET_BODY 한 줄 선택
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    assert.equal(await selection(page), 'TARGET_BODY');
  }
  await holdFrames(page);
  // PM 상태는 DOM 선택을 selectionchange로 뒤늦게 반영한다(PR112 관측): PM 선택이 TARGET_BODY가 될 때까지 조건으로 기다린 뒤 읽는다 (프레임 보관 중이라 기본 rAF polling 대신 polling 간격을 쓴다)
  if (kind === 'missing') await page.waitForFunction(() => (window as unknown as FrameWindow).readPm().text === 'TARGET_BODY', null, { polling: 25, timeout: 5000 });
  const preJump = await readPm(page);
  await page.evaluate(() => void ((window as unknown as FrameWindow).stage = 'jump'));
  await evidence(page, 2).click({ force: true }); // 근거 버튼 (Playwright의 안정 대기가 rAF를 쓰므로 force)
  if (kind === 'missing') await page.getByText(MISSING, { exact: false }).waitFor();
  // jump/collapse effect 실행 신호: 그 지연 focus 프레임이 jump 단계로 예약된다. 프레임 해제 전의 PM 선택을 직접 읽는다
  await page.waitForFunction(() => (window as unknown as FrameWindow).framesHeld.some((f) => f.stage === 'jump'), null, { polling: 25, timeout: 15_000 });
  const afterJump = await readPm(page);
  // 사용자가 예약된 focus가 실행되기 전에 검색창을 선택한다 (마우스)
  await page.getByRole('searchbox', { name: '원고 검색' }).click({ force: true });
  const atSearch = await readPm(page);
  // 보관 프레임을 하나씩 실행하며 관측한다 (목록이 빌 때까지)
  const log = await page.evaluate(async () => {
    const w = window as unknown as FrameWindow;
    window.requestAnimationFrame = (cb) => {
      w.framesHeld.push({ cb, stage: 'run' });
      return w.framesHeld.length;
    };
    const steps: Array<{ order: number; stage: string; afterCallback: PmObs; afterRealFrame: PmObs }> = [];
    let order = 0;
    while (w.framesHeld.length > 0 && order < 1000) {
      const frame = w.framesHeld.shift()!;
      order += 1;
      frame.cb(performance.now());
      const afterCallback = w.readPm();
      await new Promise<void>((resolve) => w.rafOriginal(() => resolve()));
      steps.push({ order, stage: frame.stage, afterCallback, afterRealFrame: w.readPm() });
    }
    window.requestAnimationFrame = w.rafOriginal;
    await new Promise<void>((resolve) => w.rafOriginal(() => resolve()));
    return { steps, drained: w.framesHeld.length === 0, final: w.readPm() };
  });
  // 사용자가 명시적으로 본문으로 돌아온다: TARGET_BODY 문단을 클릭하고 End, 입력 (활성 요소·선택을 강제하지 않는다)
  await editor(page).getByText('TARGET_BODY', { exact: true }).click();
  const returned = await readPm(page);
  await page.keyboard.press('End');
  await page.keyboard.type(TYPED);
  const typed = await readPm(page);
  await page.keyboard.press('Control+S');
  await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
  const diskAfterSave = await readFile(two, 'utf8');
  // 다른 화로 이동했다가 다시 연다
  await chapter(page, 'ONE').click();
  await editor(page).getByText(QUOTE).waitFor();
  await chapter(page, 'TWO').click();
  await editor(page).getByText(`TARGET_BODY${TYPED}`, { exact: true }).waitFor({ timeout: 10_000 });
  const reopened = await page.evaluate(() => (document.querySelector('.ProseMirror') as HTMLElement).innerText.replace(/\n+/g, '⏎'));
  console.log(JSON.stringify({ kind, preJump, afterJump, atSearch, steps: log.steps, final: log.final, returned, typed, reopened }));
  // 단계별 근거
  assert.ok(log.steps.some((st) => st.stage === 'jump'), `jump/collapse가 예약한 지연 focus 프레임이 실행됐다: ${JSON.stringify(log.steps.map((st) => [st.order, st.stage]))}`);
  assert.ok(log.drained, '보관된 프레임이 모두 실행되어 목록이 비었다');
  if (kind === 'found') assert.equal(afterJump.text, QUOTE, `프레임 해제 전에 PM 선택이 근거 문장이다: ${JSON.stringify(afterJump)}`);
  else {
    assert.equal(preJump.text, 'TARGET_BODY', 'collapse 전 PM 선택은 TARGET_BODY였다');
    assert.equal(afterJump.from, afterJump.to, `collapse로 PM 선택이 접혔다: ${JSON.stringify(afterJump)}`);
  }
  assert.equal(atSearch.active, 'input', '사용자가 검색창을 선택했다 (실제 마우스 선택)');
  for (const st of log.steps) {
    for (const state of [st.afterCallback, st.afterRealFrame]) {
      assert.equal(state.active, 'input', `${st.order}번째(${st.stage}) 프레임 뒤에도 검색창 포커스가 유지된다 ${JSON.stringify(state)}`);
      assert.deepEqual({ from: state.from, to: state.to }, { from: afterJump.from, to: afterJump.to }, `${st.order}번째 프레임 뒤에도 PM 선택이 그대로다`);
    }
  }
  assert.equal(returned.active, 'editor', '명시적으로 돌아온 뒤 편집기가 포커스를 가진다');
  // 실제 저장 완료·디스크 바이트·다시 연 본문
  assert.equal(diskAfterSave, expected, '저장된 원고가 예상한 정확한 바이트다 (사용자가 클릭한 문단 끝에 입력만 들어갔다)');
  assert.equal(await readFile(two, 'utf8'), expected, '다른 화로 이동·다시 연 뒤에도 디스크 바이트가 같다');
  assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ORIGINAL, '다른 화 원고는 바뀌지 않는다');
  assert.equal(reopened.includes(`TARGET_BODY${TYPED}`), true, `다시 연 본문에 입력이 있다: ${reopened}`);
  assert.equal(reopened.includes(kind === 'found' ? QUOTE : 'REWRITTEN'), true, '근거 문장/다른 문단은 그대로다');
  void typed;
}

for (const kind of ['found', 'missing'] as const) {
  test(`검색창이 포커스를 가진 채 근거 ${kind === 'found' ? 'jump' : '없음 collapse'}가 지나간 뒤 본문으로 돌아와 입력·저장·다른 화 이동·다시 열기: 입력이 클릭한 문단 끝에 정확한 바이트로 보존된다`, { timeout: 120_000 }, async () => {
    const dir = await project(BODY_QUOTE.replace('TARGET_BODY\n', 'TARGET_BODY\n'), { '001.md': ORIGINAL, '002.md': kind === 'found' ? BODY_QUOTE : BODY_REWRITTEN }, '002.md');
    await withApp(dir, async (app, page) => {
      await returnAndType(app, page, dir, kind);
    });
  });
}
