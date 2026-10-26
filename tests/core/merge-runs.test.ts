// M10 두 회 합치기 (scripts/lib/merge-runs.ts). 제품 합치기 규칙과 평가기 라벨이 합친 뒤에 어떻게 되는지 확인한다.

import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { quoteKey } from '../../src/core/ai/verify.ts';
import { chapterLines } from '../../src/main/analyzer.ts';
import { loadChapters, loadGroundTruth } from '../../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { evaluate } from '../../spikes/m0a-ai-feasibility/src/evaluate.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';
import { locateRun, mergedPredictions, mergeRuns, type KeyedFinding, type RunFindings } from '../../scripts/lib/merge-runs.ts';
import { M0A_BENCHMARK } from '../../scripts/lib/m4-score.ts';

const f = (over: Partial<KeyedFinding> & { key: string }): KeyedFinding => ({
  category: 'age',
  claim: '설명',
  confidence: 0.9,
  target: { quote: over.key, line: 0, start: 0, end: over.key.length },
  evidence: [{ file: '001.md', chapter: 1, quote: '근거', line: 0, start: 0, end: 2 }],
  ...over,
});
const run = (findings: KeyedFinding[], chapter = 2): RunFindings => new Map([[chapter, findings]]);

test('합치기 규칙: 같은 종류·같은 문장은 하나로, 설명은 1회 것, 근거는 겹치지 않게 모으고, 확신도는 가장 높은 것', () => {
  const e2 = { file: '001.md', chapter: 1, quote: '다른 근거', line: 3, start: 0, end: 5 };
  const merged = mergeRuns([run([f({ key: 'A', claim: '1회 설명', confidence: 0.75 })]), run([f({ key: 'A', claim: '2회 설명', confidence: 0.95, evidence: [f({ key: 'A' }).evidence[0]!, e2] })])]).get(2)!;
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.claim, '1회 설명');
  assert.equal(merged[0]!.confidence, 0.95);
  assert.deepEqual(merged[0]!.evidence.map((e) => e.line), [0, 3]);
});

test('합치기 규칙: 같은 종류·다른 문장, 같은 문장·다른 종류는 따로 남는다', () => {
  const merged = mergeRuns([run([f({ key: 'A' }), f({ key: 'B' })]), run([f({ key: 'A', category: 'name' }), f({ key: 'C' })])]).get(2)!;
  assert.deepEqual(merged.map((x) => `${x.category}|${x.key}`), ['age|A', 'age|B', 'name|A', 'age|C']);
});

test('합치기 조건: 검사한 화가 회마다 다르거나 한 회뿐이면 합치지 않는다', () => {
  assert.throws(() => mergeRuns([run([])]), /두 회/);
  assert.throws(() => mergeRuns([run([], 2), run([], 3)]), /검사한 화/);
});

test('평가기 입력: context가 회마다 다르면 합치지 않는다. 같으면 1회 context를 쓴다', () => {
  const p = (ctx: string): Predictions => ({ run_id: 'r', strategy: 's', model: 'm', chapters: [{ target_chapter: 2, context: [{ chapter: 1, text: ctx }], findings: [] }] });
  const merged = mergeRuns([run([f({ key: 'A' })]), run([])]);
  assert.throws(() => mergedPredictions('x', p('가'), merged, [p('나')]), /context/);
  const out = mergedPredictions('x', p('가'), merged, [p('가')]);
  assert.deepEqual(out.chapters[0]!.context, [{ chapter: 1, text: '가' }]);
  assert.equal(out.chapters[0]!.findings.length, 1);
});

// ---- M0-A 벤치마크로: 합친 뒤 평가기 라벨 (TP 중복, echo, trap, 잘못된 인용, 낮은 확신도)

let project: string;
const lines = new Map<number, { file: string; lines: string[] }>();
before(async () => {
  project = await mkdtemp(join(tmpdir(), 'loreweave-merge-'));
  await mkdir(join(project, 'chapters'));
  for (let n = 1; n <= 15; n++) {
    const file = `${String(n).padStart(3, '0')}.md`;
    await copyFile(join(M0A_BENCHMARK, 'chapters', `ch${String(n).padStart(2, '0')}.md`), join(project, 'chapters', file));
    lines.set(n, { file, lines: (await chapterLines(project, file)).lines });
  }
});
after(async () => {
  await rm(project, { recursive: true, force: true });
});

const gt = () => loadGroundTruth(M0A_BENCHMARK);
const report = (p: Predictions) => evaluate(p, gt(), loadChapters(M0A_BENCHMARK));
/** 정답 오류 하나를 가리키는 예측 (지정 문장과 지정 근거) */
function pointing(id: string, over: { category?: string; confidence?: number; evidence?: { chapter: number; quote: string }[] } = {}) {
  const e = gt().errors.find((x) => x.id === id)!;
  return {
    target_chapter: e.target.chapter,
    finding: {
      category: over.category ?? e.category,
      target_quote: e.target.quotes[0]!,
      claim: id,
      confidence: over.confidence ?? 0.9,
      evidence: over.evidence ?? [{ chapter: e.sources[0]!.chapter, quote: e.sources[0]!.quotes[0]! }],
    },
  };
}
function predictions(id: string, items: ReturnType<typeof pointing>[]): Predictions {
  const chapters = [...new Set(items.map((i) => i.target_chapter))];
  return {
    run_id: id,
    strategy: 't',
    model: 'm',
    chapters: chapters.map((n) => ({
      target_chapter: n,
      // 근거로 들 수 있는 앞 화 (제품은 사실을 넘긴 앞 화만 근거로 받는다)
      context: Array.from({ length: n - 1 }, (_, i) => ({ chapter: i + 1, text: '' })),
      findings: items.filter((i) => i.target_chapter === n).map((i) => i.finding),
    })),
  } as Predictions;
}
const merge = (a: Predictions, b: Predictions) => {
  const la = locateRun(a, (n) => lines.get(n) ?? null);
  const lb = locateRun(b, (n) => lines.get(n) ?? null);
  return mergedPredictions('a+b', a, mergeRuns([la.findings, lb.findings]));
};
const labels = (p: Predictions, t = 0.7) => {
  const filtered = { ...p, chapters: p.chapters.map((c) => ({ ...c, findings: c.findings.filter((x) => x.confidence >= t) })) };
  return report(filtered).findings.map((l) => l.label).sort();
};

test('평가기: 두 회가 같은 오류를 같은 문장·종류로 찾으면 하나(TP 1)로 합쳐지고, 다른 종류로 찾으면 TP 1 + 중복 1이다 (중복은 TP도 오탐도 아니다)', () => {
  const a = predictions('a', [pointing('E13')]);
  assert.deepEqual(labels(merge(a, predictions('b', [pointing('E13')]))), ['tp']);
  const other = merge(a, predictions('b', [pointing('E13', { category: 'relationship' })]));
  assert.deepEqual(labels(other), ['duplicate', 'tp']);
  const r = report(other).by_threshold.find((x) => x.threshold === 0.7)!.test;
  assert.equal(r.tp, 1);
  assert.equal(r.fp, 0);
});

test('평가기: 확신도 필터는 합친 뒤에 건다 (0.6과 0.8이면 0.8로 보이고, 0.6만 있으면 숨는다)', () => {
  const low = predictions('a', [pointing('E13', { confidence: 0.6 })]);
  assert.deepEqual(labels(merge(low, predictions('b', [pointing('E13', { confidence: 0.8 })]))), ['tp']);
  assert.deepEqual(labels(merge(low, predictions('b', [pointing('E13', { confidence: 0.6 })]))), []);
  // 필터 전(0)에는 남아 있다 (R5의 모집단: 합친 원래 결과)
  assert.deepEqual(labels(merge(low, low), 0), ['tp']);
});

test('평가기: 이 화 문장이 원고에 없거나 근거 화가 context 밖이면 제품 검증에서 버려져 합친 결과에 없다 (fabricated가 화면에 오지 않는다)', () => {
  const e = gt().errors.find((x) => x.id === 'E13')!;
  const fake = predictions('a', [{ ...pointing('E13'), finding: { ...pointing('E13').finding, target_quote: '원고에 없는 문장이다.' } }]);
  const located = locateRun(fake, (n) => lines.get(n) ?? null);
  assert.equal(located.dropped, 1);
  const outside = predictions('b', [pointing('E13', { evidence: [{ chapter: e.target.chapter + 1, quote: '아무 문장' }] })]);
  assert.equal(locateRun(outside, (n) => lines.get(n) ?? null).dropped, 1);
  assert.deepEqual(labels(merge(fake, outside)), []);
});

test('평가기: echo 근거와 정상 근거를 합치면 echo가 아니게 될 수 있다 (근거 합치기가 라벨을 바꾸는 경우)', () => {
  // 13화 정상 문장을 11화 삽입 오류(E22)만 근거로 들면 echo, 정상 근거를 더하면 정답표 밖(unlabeled, 오탐)
  const e22 = gt().errors.find((x) => x.id === 'E22')!;
  const line13 = lines.get(13)!.lines.find((l) => l.includes('25.5'))!;
  const quote13 = line13.split(/(?<=[.!?])\s/).find((s) => s.includes('25.5'))!;
  const item = (evidence: { chapter: number; quote: string }[]) => ({ target_chapter: 13, finding: { category: 'number', target_quote: quote13, claim: '지분', confidence: 0.9, evidence } });
  const echoOnly = predictions('a', [item([{ chapter: e22.target.chapter, quote: e22.target.quotes[0]! }])]);
  assert.deepEqual(labels(merge(echoOnly, echoOnly)), ['echo']);
  const normal = lines.get(8)!.lines.find((l) => l.includes('25.5'));
  assert.ok(normal, '8화에 희석 뒤 지분 문장이 있어야 한다');
  const q8 = normal.split(/(?<=[.!?])\s/).find((s) => s.includes('25.5'))!;
  const withNormal = predictions('b', [item([{ chapter: 8, quote: q8 }])]);
  assert.deepEqual(labels(withNormal), ['unlabeled']);
  assert.deepEqual(labels(merge(echoOnly, withNormal)), ['unlabeled']);
  assert.equal(quoteKey(`"${quote13}"`), quoteKey(quote13));
});

test('평가기: 함정(trap) 오탐은 두 회가 같은 문장·종류면 하나로 센다', () => {
  const trap = gt().traps[0]!;
  const target = lines.get(trap.chapter)!;
  const item = { target_chapter: trap.chapter, finding: { category: 'age', target_quote: trap.quotes[0]!, claim: '함정', confidence: 0.9, evidence: [{ chapter: 1, quote: lines.get(1)!.lines.find((l) => l.length > 10)!.slice(0, 10) }] } };
  assert.ok(target.lines.some((l) => l.includes(trap.quotes[0]!.slice(0, 8))));
  const p = { run_id: 'a', strategy: 't', model: 'm', chapters: [{ target_chapter: trap.chapter, context: Array.from({ length: trap.chapter - 1 }, (_, i) => ({ chapter: i + 1, text: '' })), findings: [item.finding] }] } as Predictions;
  const once = labels(merge(p, p));
  assert.deepEqual(once.filter((l) => l === 'trap'), ['trap']);
});
