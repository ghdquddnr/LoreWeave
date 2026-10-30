// AI 검토 화면과 원고 표시 (P3): 문제 가능성 카드·사실 2열·접이식 섹션, stale/MISSING/MOVED/낮은 확신/무시 표시, 탐색기 배지(실제 문제 수),
// 원고 거터 번호와 문제 문장 밑줄(표시 전용: 문서·저장 바이트·undo·클립보드에 섞이지 않음), 조합 경계, 무시가 배지·밑줄에 반영됨.
// 실제 앱(Electron + Playwright). 검사·분석 결과는 합성으로 미리 저장한다 (AiStore 직접). OpenAI는 부르지 않는다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { locateQuote } from '../../src/core/ai/locate.ts';
import { openManuscript } from '../../src/core/manuscript/index.ts';
import { visibleLines } from '../../src/core/manuscript/lines.ts';
import { AiStore } from '../../src/main/ai-db.ts';
import { chapterHash } from '../../src/main/project-files.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `﻿---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const lines = (...l: string[]) => `${l.join('\r\n')}\r\n`;
const ONE = `${envelope('one', 'ONE')}${lines('EVIDENCE_QUOTE')}`;
const TWO = `${envelope('two', 'TWO')}${lines('# HEADING_LINE', '', 'FIRST_PARAGRAPH', '', '> QUOTE_LINE', '', 'TARGET_BODY', '', 'SECOND_PARAGRAPH TARGET_LOW')}`;
// 003: 검사 뒤 바뀐 화 (MOVE_ME는 검사 때 다른 줄에 있었고, GONE_QUOTE는 지금 없다)
const THREE = `${envelope('three', 'THREE')}${lines('INTRO_LINE', '', 'MOVE_ME sentence')}`;
const FOUR = `${envelope('four', 'FOUR')}${lines('PLAIN_LINE')}`;
const at = (text: string, quote: string) => locateQuote(visibleLines(openManuscript(text).doc), quote)!;

async function project(): Promise<string> {
  const dir = await tempDir('review');
  await mkdir(join(dir, 'chapters'));
  for (const [n, text] of [[1, ONE], [2, TWO], [3, THREE], [4, FOUR]] as const) await writeFile(join(dir, 'chapters', `00${n}.md`), text);
  const hash = async (f: string) => (await chapterHash(dir, f))!;
  const base = { model: 'fake', modelVersion: 'fake', promptVersion: 'fake', costUsd: 0, createdAt: new Date().toISOString() };
  const db = AiStore.open(dir);
  // 001: 분석 최신
  db.saveAnalysis({ file: '001.md', contentHash: await hash('001.md'), ...base, summary: 'S1', droppedQuotes: 0, entities: [{ name: 'ALICE', aliases: [] }], facts: [{ entity: 'ALICE', predicate: 'age', value: '20', quote: 'EVIDENCE_QUOTE', ...at(ONE, 'EVIDENCE_QUOTE') }] });
  // 002: 분석 최신 + 검사 최신 (보이는 결과 1, 확신 낮음 1, 무시 1)
  db.saveAnalysis({
    file: '002.md',
    contentHash: await hash('002.md'),
    ...base,
    summary: 'S2',
    droppedQuotes: 0,
    entities: [{ name: 'ALICE', aliases: [] }],
    facts: [
      { entity: 'ALICE', predicate: 'job', value: 'WRITER', quote: 'FIRST_PARAGRAPH', ...at(TWO, 'FIRST_PARAGRAPH') },
      { entity: 'ALICE', predicate: 'home', value: 'GONE_HOME', quote: 'GONE_FACT_QUOTE', line: 0, start: 0, end: 5 },
    ],
  });
  const finding = (category: 'age' | 'number', claim: string, confidence: number, key: string, quote: string) => ({
    category,
    claim,
    confidence,
    key,
    target: { quote, ...at(TWO, quote) },
    evidence: [{ file: '001.md', chapter: 1, quote: 'EVIDENCE_QUOTE', ...at(ONE, 'EVIDENCE_QUOTE') }],
  });
  db.saveCheck({
    file: '002.md',
    contentHash: await hash('002.md'),
    ...base,
    factCount: 1,
    dropped: 0,
    inputs: [{ file: '001.md', contentHash: await hash('001.md') }],
    findings: [
      finding('age', 'VISIBLE_CLAIM', 0.9, 'k-visible', 'TARGET_BODY'),
      finding('number', 'LOW_CLAIM', 0.4, 'k-low', 'TARGET_LOW'),
      finding('age', 'DISMISSED_CLAIM', 0.9, 'k-dismissed', 'FIRST_PARAGRAPH'),
    ],
  });
  db.dismiss('002.md', 'age', 'k-dismissed', base.createdAt);
  // 003: 검사가 오래됨 (본문이 바뀜). MOVE_ME는 검사 때 0줄이었지만 지금은 2줄, GONE_QUOTE는 지금 없다
  db.saveCheck({
    file: '003.md',
    contentHash: 'old-hash',
    ...base,
    factCount: 1,
    dropped: 0,
    inputs: [{ file: '001.md', contentHash: await hash('001.md') }],
    findings: [
      { category: 'age', claim: 'MOVED_CLAIM', confidence: 0.9, key: 'k-moved', target: { quote: 'MOVE_ME sentence', line: 0, start: 0, end: 16 }, evidence: [] },
      { category: 'age', claim: 'MISSING_CLAIM', confidence: 0.9, key: 'k-missing', target: { quote: 'GONE_QUOTE', line: 4, start: 0, end: 10 }, evidence: [] },
    ],
  });
  db.close();
  return dir;
}

const editor = (page: Page) => page.locator('.ProseMirror');
const nav = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const chapter = (page: Page, title: string) => nav(page).getByRole('button', { name: title });
const issues = (page: Page) => page.locator('section.issues');
const facts = (page: Page) => page.locator('aside.facts');
async function start(prefix: string): Promise<{ app: ElectronApplication; page: Page; dir: string }> {
  const dir = await project();
  const { app, page } = await launch(await tempDir(prefix));
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await chapter(page, 'TWO').click();
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  await issues(page).getByText('VISIBLE_CLAIM', { exact: true }).waitFor();
  return { app, page, dir };
}

const marked = (page: Page) => page.evaluate(() => [...document.querySelectorAll('.ProseMirror .issue-mark')].map((e) => e.textContent));
const dots = (page: Page) => page.evaluate(() => document.querySelectorAll('.ProseMirror > p.has-issue').length);
/** 거터 번호: 계산된 스타일은 counter()를 풀어 주지 않으므로, 번호를 올리는 문단(counter-increment)과 ::before가 counter를 쓰는지를 본다. 실제 번호 모양은 캡처로 본다 */
const gutter = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('.ProseMirror > *')].map((el) => {
      const numbered = getComputedStyle(el).counterIncrement.startsWith('pno') && getComputedStyle(el, '::before').content.includes('counter(pno)');
      return `${el.tagName.toLowerCase()}:${el.textContent}:${numbered ? 'N' : '-'}`;
    }),
  );
const snapshot = (page: Page) =>
  page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { toJSON(): unknown }; selection: { from: number; to: number } }; can(): { undo(): boolean } }; __marker?: number };
    return { marker: pm.__marker ?? null, doc: JSON.stringify(pm.editor.state.doc.toJSON()), from: pm.editor.state.selection.from, to: pm.editor.state.selection.to, canUndo: pm.editor.can().undo() };
  });

test('카드·사실·탐색기 배지: 실제 데이터로 문제 가능성 카드 계층, 낮은 확신·무시 칩, 사실 2열, 접이식, 배지(문제 수·최신·바뀜)가 나온다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('review-cards');
  try {
    // 탐색기 배지: 002 문제 가능성 1개(낮은 확신·무시 제외), 001 분석 최신, 003 검사 뒤 바뀜, 004 없음
    const counts = await page.evaluate(() => window.loreweave.ai.analysisStatus(1));
    assert.deepEqual(counts.issueCounts, { '002.md': 1, '003.md': 2 }, '검사한 화의 보이는 문제 수만 (002: 낮은 확신·무시 제외)');
    await page.waitForFunction(() => document.querySelector('nav[aria-label="화 목록"] .mark-issues') !== null);
    const labels = await nav(page).locator('.chapter').evaluateAll((els) => els.map((e) => ({ text: e.firstChild?.textContent, mark: e.querySelector('.mark')?.getAttribute('aria-label') ?? null, glyph: e.querySelector('.mark')?.textContent ?? null, ai: e.getAttribute('data-ai') })));
    assert.deepEqual(labels, [
      { text: 'ONE', mark: 'AI 분석됨', glyph: '✓', ai: null },
      { text: 'TWO', mark: '문제 가능성 1개', glyph: '1', ai: null },
      { text: 'THREE', mark: '검사한 뒤 본문이 바뀜', glyph: '◐', ai: null },
      { text: 'FOUR', mark: null, glyph: null, ai: 'none' },
    ]);

    // 카드: 헤더(분류·확신·무시), 주장, 인용 우물(이 화/앞 화). 낮은 확신·무시는 기본 숨김
    assert.equal(await issues(page).getByRole('heading', { name: '문제 가능성 (1)' }).count(), 1);
    const card = issues(page).locator('.issue-card');
    assert.equal(await card.count(), 1);
    await card.getByText('나이', { exact: true }).waitFor();
    await card.getByText('확신 0.9').waitFor();
    await card.getByRole('button', { name: '무시', exact: true }).waitFor();
    assert.match(await card.locator('.quote-well').innerText(), /이 화: “?TARGET_BODY”?[\s\S]*1화: “EVIDENCE_QUOTE”/);
    await issues(page).getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click();
    const low = issues(page).locator('.issue-card.low');
    await low.getByText('확신 낮음', { exact: true }).waitFor();
    await issues(page).getByRole('button', { name: '확신이 낮은 결과 숨기기' }).click();
    await issues(page).getByRole('button', { name: '무시한 결과 1개 보기' }).click();
    await issues(page).locator('.issue-card.dismissed').getByText('무시함', { exact: true }).waitFor();
    await issues(page).getByRole('button', { name: '무시한 결과 숨기기' }).click();

    // 사실: 속성-값 2열, 인용 MISSING 칩, 접이식
    const fact = facts(page).locator('li').filter({ hasText: 'job' });
    await fact.waitFor();
    assert.equal(await fact.locator('.attr').innerText(), 'job');
    assert.equal(await fact.locator('.val').innerText(), 'WRITER');
    const columns = await fact.locator('.fact').evaluate((el) => getComputedStyle(el).gridTemplateColumns.split(' ').length);
    assert.equal(columns, 2, '속성-값 2열');
    assert.equal(await facts(page).getByText('job: WRITER', { exact: true }).count(), 1, '접근·텍스트에는 "속성: 값"이 남는다');
    await facts(page).locator('li').filter({ hasText: 'home' }).getByText('MISSING', { exact: true }).waitFor();
    const toggle = facts(page).getByRole('button', { name: 'AI가 찾은 사실' });
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
    await toggle.click();
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await facts(page).locator('.sec-body').isVisible(), false);
    await toggle.click();
    await facts(page).locator('.sec-body').waitFor();
  } finally {
    await closeWindow(app);
  }
});

test('오래된 검사(stale): 숫자 배지 대신 ◐, 카드는 옛 결과·MOVED·MISSING으로 보이고 확정 오류처럼 밑줄·거터 점을 내지 않는다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('review-stale');
  try {
    await chapter(page, 'THREE').click();
    await editor(page).getByText('MOVE_ME sentence', { exact: true }).waitFor();
    await issues(page).getByText('MOVED_CLAIM', { exact: true }).waitFor();
    await issues(page).getByText('검사한 뒤 이 화나 앞 화의 본문이 바뀌었습니다').waitFor();
    const cards = issues(page).locator('.issue-card');
    assert.equal(await cards.count(), 2);
    assert.equal(await cards.locator('.chip-stale').count(), 2, '모든 카드가 옛 결과로 표시');
    const moved = cards.filter({ hasText: 'MOVED_CLAIM' });
    await moved.getByText('MOVED', { exact: true }).waitFor();
    const missing = cards.filter({ hasText: 'MISSING_CLAIM' });
    await missing.getByText('MISSING', { exact: true }).waitFor();
    // MOVED는 지금 본문에서 실제로 찾았을 때만: 누르면 현재 위치의 그 문장이 선택된다 (옛 줄이 아님)
    await moved.getByRole('button', { name: /^이 화:/ }).click();
    await page.waitForFunction(() => window.getSelection()?.toString() === 'MOVE_ME sentence', null, { timeout: 3000 });
    // MISSING은 이동하지 않고 선택만 접고 안내한다
    await missing.getByRole('button', { name: /^이 화:/ }).click();
    await issues(page).getByText('지금 본문에서 이 문장을 찾을 수 없습니다').waitFor();
    assert.equal((await page.evaluate(() => window.getSelection()?.toString() ?? '')), '', '찾지 못하면 이전 선택을 접는다');
    // 표시 층: 오래된 결과는 밑줄·거터 점이 없다
    await page.waitForTimeout(800);
    assert.deepEqual(await marked(page), []);
    assert.equal(await dots(page), 0);
  } finally {
    await closeWindow(app);
  }
});

test('거터와 밑줄은 표시 전용: 번호는 비어 있지 않은 본문 문단만(제목·인용·빈 줄 제외), 밑줄은 지금 본문에서 확인된 문제 문장만이고, 문서·undo·저장 바이트·클립보드에 섞이지 않는다', { timeout: 120_000 }, async () => {
  const { app, page, dir } = await start('review-display');
  try {
    // 거터: 표시 문단 번호 (CSS counter, 비어 있지 않은 본문 문단만)
    assert.deepEqual(await gutter(page), [
      'h1:HEADING_LINE:-',
      'p::-',
      'p:FIRST_PARAGRAPH:N',
      'p::-',
      'blockquote:QUOTE_LINE:-',
      'p::-',
      'p:TARGET_BODY:N',
      'p::-',
      'p:SECOND_PARAGRAPH TARGET_LOW:N',
    ]);
    // 밑줄: 확신 높고 무시하지 않은 TARGET_BODY만 (낮은 확신 TARGET_LOW·무시한 FIRST_PARAGRAPH 제외), 거터 점은 그 문단 하나
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 1);
    assert.deepEqual(await marked(page), ['TARGET_BODY']);
    assert.equal(await dots(page), 1);
    // 낮은 확신을 보이게 하면 그 문장도 밑줄이 생긴다 (지금 보이는 결과만 표시)
    await issues(page).getByRole('button', { name: '확신이 낮아 숨긴 결과 1개 보기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 2);
    assert.deepEqual(await marked(page), ['TARGET_BODY', 'TARGET_LOW']);
    await issues(page).getByRole('button', { name: '확신이 낮은 결과 숨기기' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 1);

    // 문서에는 장식이 없다: 마크·속성·텍스트에 밑줄/번호가 들어가지 않는다 (JSON 그대로), 아직 undo할 입력도 없다
    const before = await snapshot(page);
    assert.equal(before.canUndo, false, '장식 표시는 undo 기록을 만들지 않는다');
    assert.doesNotMatch(before.doc, /issue|has-issue|pno/);
    // 클립보드: 전체 선택 복사에 거터 번호·표시가 섞이지 않는다
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Control+c');
    const clip = await app.evaluate(({ clipboard }) => clipboard.readText());
    const expectedText = await page.evaluate(() => {
      const pm = document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { content: { size: number }; textBetween(a: number, b: number, sep: string): string } } } };
      const doc = pm.editor.state.doc;
      return doc.textBetween(0, doc.content.size, '\n\n');
    });
    // 인용 블록의 문단 구분은 PM이 정하므로 공백은 무시하고 글자만 비교한다 (거터 번호·표시 글자가 섞이면 달라진다)
    assert.equal(clip.replace(/\s+/g, ''), expectedText.replace(/\s+/g, ''), '복사한 글자는 문서의 글자와 같다');
    assert.ok(!/(^|\n)\d+TARGET|1FIRST|2TARGET|3SECOND/.test(clip), '거터 번호가 붙지 않는다');
    // 밑줄 문단에서 입력해도 정상: 입력은 문서에만 들어가고, 저장 바이트는 BOM·CRLF·frontmatter를 지킨다
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' TYPED');
    await editor(page).getByText('TARGET_BODY TYPED', { exact: true }).waitFor();
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), TWO.replace('TARGET_BODY', 'TARGET_BODY TYPED'), '저장 바이트: 입력만 더해졌다');
    // 저장하면 검사가 오래된 것이 된다: 숫자 배지는 ◐로, 밑줄·거터 점은 사라진다 (확정 오류처럼 보이지 않는다)
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 0, null, { timeout: 10_000 });
    assert.equal(await dots(page), 0);
    await nav(page).locator('.chapter').filter({ hasText: 'TWO' }).locator('.mark[aria-label="검사한 뒤 본문이 바뀜"]').waitFor();
    // undo/redo는 입력 한 단계만 (장식 갱신이 history를 만들지 않았다)
    await editor(page).getByText('TARGET_BODY TYPED', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+z');
    await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
    await page.keyboard.press('Control+Shift+z');
    await editor(page).getByText('TARGET_BODY TYPED', { exact: true }).waitFor();
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('무시: 저장되면 카드가 숨고 밑줄·거터 점이 사라지고 탐색기 배지가 ✓로 바뀌며, 문서·선택·undo·편집기 노드는 그대로다', { timeout: 90_000 }, async () => {
  const { app, page } = await start('review-dismiss');
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 1);
    await editor(page).getByText('FIRST_PARAGRAPH', { exact: true }).click();
    await page.keyboard.press('End');
    await page.evaluate(() => void ((document.querySelector('.ProseMirror') as unknown as { __marker: number }).__marker = 3));
    const before = await snapshot(page);
    await issues(page).locator('.issue-card').getByRole('button', { name: '무시', exact: true }).click();
    await issues(page).getByText('찾은 문제 가능성이 없습니다.').waitFor();
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 0);
    assert.equal(await dots(page), 0);
    await nav(page).locator('.chapter').filter({ hasText: 'TWO' }).locator('.mark[aria-label="검사함: 문제 가능성 없음"]').waitFor({ timeout: 10_000 });
    assert.deepEqual(await snapshot(page), before, '무시로 표시가 바뀌어도 편집기 노드·문서·선택·undo가 그대로');
    const counts = await page.evaluate(() => window.loreweave.ai.analysisStatus(1));
    assert.equal(counts.issueCounts['002.md'], 0);
  } finally {
    await closeWindow(app);
  }
});

test('조합(합성 이벤트 경계): 조합 중에는 표시 장식을 바꾸지 않고, 끝난 뒤에 반영한다 (실제 IME 검증 아님)', { timeout: 90_000 }, async () => {
  const { app, page } = await start('review-composition');
  try {
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 1);
    await editor(page).getByText('FIRST_PARAGRAPH', { exact: true }).click();
    await page.keyboard.press('End');
    // 합성 조합 시작: ProseMirror가 조합 중으로 본다
    await page.evaluate(() => void document.querySelector('.ProseMirror')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' })));
    assert.equal(await page.evaluate(() => (document.querySelector('.ProseMirror') as unknown as { editor: { view: { composing: boolean } } }).editor.view.composing), true);
    // 조합 중에 표시 대상이 바뀐다 (무시): 장식은 아직 그대로여야 한다
    await issues(page).locator('.issue-card').getByRole('button', { name: '무시', exact: true }).click();
    await issues(page).getByText('찾은 문제 가능성이 없습니다.').waitFor();
    await page.waitForTimeout(1200);
    assert.deepEqual(await marked(page), ['TARGET_BODY'], '조합 중에는 장식을 바꾸지 않는다');
    // 조합이 끝나면 반영한다
    await page.evaluate(() => void document.querySelector('.ProseMirror')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' })));
    await page.waitForFunction(() => document.querySelectorAll('.ProseMirror .issue-mark').length === 0, null, { timeout: 5000 });
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
