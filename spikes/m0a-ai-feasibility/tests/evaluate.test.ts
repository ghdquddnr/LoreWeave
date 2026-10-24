import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadChapters, loadGroundTruth } from '../src/benchmark.ts';
import { evaluate, locate } from '../src/evaluate.ts';
import type { ChapterPrediction, Finding, Predictions } from '../src/schema.ts';

const chapters = loadChapters();
const gt = loadGroundTruth();

function run(chs: ChapterPrediction[]): Predictions {
  // Every target chapter 2..15 is present, as a real run would be.
  const byCh = new Map(chs.map((c) => [c.target_chapter, c]));
  const all: ChapterPrediction[] = [];
  for (let n = 2; n <= 15; n++) all.push(byCh.get(n) ?? { target_chapter: n, findings: [] });
  return { run_id: 't', strategy: 'test', model: 'none', chapters: all };
}

function finding(p: Partial<Finding> & Pick<Finding, 'target_quote'>): Finding {
  return { category: 'name', claim: '', evidence: [], confidence: 0.9, ...p };
}

const oracle = (): ChapterPrediction[] => {
  const byCh = new Map<number, Finding[]>();
  for (const e of gt.errors) {
    const list = byCh.get(e.target.chapter) ?? [];
    list.push(
      finding({
        category: e.category,
        target_quote: e.target.quotes[0],
        evidence: e.sources.map((s) => ({ chapter: s.chapter, quote: s.quotes[0] })),
      }),
    );
    byCh.set(e.target.chapter, list);
  }
  return [...byCh].map(([target_chapter, findings]) => ({ target_chapter, findings }));
};

test('locate: exact, whitespace, curly quotes, elision', () => {
  const text = '민수는 "안녕"이라고   말했다.\n그리고 웃었다.';
  assert.deepEqual(locate(text, '민수는'), { start: 0, end: 3 });
  assert.ok(locate(text, '이라고 말했다.'));
  assert.ok(locate(text, '“안녕”이라고'));
  assert.ok(locate(text, '민수는 … 웃었다.'));
  assert.equal(locate(text, '지현은'), null);
  assert.equal(locate(text, '웃었다. … 민수는'), null); // elided parts must be in order
  assert.equal(locate(text, '   '), null);
});

test('every ground-truth quote exists in its chapter', () => {
  for (const e of gt.errors) {
    for (const q of e.target.quotes) assert.ok(locate(chapters.get(e.target.chapter)!, q), `${e.id} target`);
    for (const s of e.sources) for (const q of s.quotes) assert.ok(locate(chapters.get(s.chapter)!, q), `${e.id} source`);
  }
  for (const t of gt.traps) for (const q of t.quotes) assert.ok(locate(chapters.get(t.chapter)!, q), t.id);
});

test('oracle predictions score perfectly', () => {
  const r = evaluate(run(oracle()), gt, chapters);
  const at0 = r.by_threshold[0];
  assert.equal(at0.all.recall, 1);
  assert.equal(at0.all.precision, 1);
  assert.equal(at0.all.fp, 0);
  assert.equal(at0.test.recall, 1);
  assert.equal(r.quotes.existence_rate, 1);
  assert.equal(r.evidence.chapter_accuracy, 1);
  assert.equal(r.evidence.quote_accuracy, 1);
  assert.equal(r.category_agreement, 1);
  assert.equal(r.traps.all.rate, 0);
  assert.equal(r.n_chapters, 14);
});

test('trap hit counts as FP and trap false alarm', () => {
  const t = gt.traps.find((x) => x.id === 'T09')!;
  const r = evaluate(run([{ target_chapter: t.chapter, findings: [finding({ target_quote: t.quotes[0] })] }]), gt, chapters);
  assert.equal(r.by_threshold[0].all.fp, 1);
  assert.equal(r.traps.all.hit, 1);
  assert.equal(r.traps.test.hit, 1);
  assert.deepEqual(r.traps.hit_ids, ['T09']);
  assert.equal(r.findings[0].label, 'trap');
});

test('evidence that only cites an inserted error span is an echo, not FP', () => {
  const e10 = gt.errors.find((x) => x.id === 'E10')!; // ch5 "이지연"
  const f = finding({
    target_quote: '한성마트 납품 1차분이 무사히 나가자', // ch11, not an error or trap span
    evidence: [{ chapter: 5, quote: e10.target.quotes[0] }],
  });
  const r = evaluate(run([{ target_chapter: 11, findings: [f] }]), gt, chapters);
  assert.equal(r.findings[0].label, 'echo');
  assert.equal(r.by_threshold[0].all.fp, 0);
  assert.equal(r.echo_count, 1);
});

test('fabricated quote is FP and goes to the review queue', () => {
  const r = evaluate(run([{ target_chapter: 3, findings: [finding({ target_quote: '존재하지 않는 문장입니다' })] }]), gt, chapters);
  assert.equal(r.findings[0].label, 'fabricated');
  assert.equal(r.by_threshold[0].all.fp, 1);
  assert.equal(r.quotes.existence_rate, 0);
  assert.equal(r.review_queue.length, 1);
});

test('unlabeled real quote is FP and goes to the review queue', () => {
  const r = evaluate(run([{ target_chapter: 2, findings: [finding({ target_quote: '창업은 낭만이 아닙니다.' })] }]), gt, chapters);
  assert.equal(r.findings[0].label, 'unlabeled');
  assert.equal(r.by_threshold[0].all.fp, 1);
  assert.equal(r.review_queue.length, 1);
});

test('second finding on the same error is a duplicate, not FP', () => {
  const e = gt.errors.find((x) => x.id === 'E04')!;
  const f = finding({ target_quote: e.target.quotes[0], category: 'age' });
  const r = evaluate(run([{ target_chapter: e.target.chapter, findings: [f, { ...f, confidence: 0.2 }] }]), gt, chapters);
  const at0 = r.by_threshold[0];
  assert.equal(at0.all.tp, 1);
  assert.equal(at0.all.fp, 0);
  assert.equal(r.duplicate_count, 1);
});

test('finding in the wrong chapter does not match', () => {
  const e = gt.errors.find((x) => x.id === 'E04')!;
  const r = evaluate(run([{ target_chapter: 4, findings: [finding({ target_quote: e.target.quotes[0] })] }]), gt, chapters);
  assert.equal(r.by_threshold[0].all.tp, 0);
});

test('confidence threshold filters findings', () => {
  const chs = oracle().map((c) => ({ ...c, findings: c.findings.map((f) => ({ ...f, confidence: 0.3 })) }));
  const r = evaluate(run(chs), gt, chapters);
  assert.equal(r.by_threshold.find((t) => t.threshold === 0.3)!.all.recall, 1);
  assert.equal(r.by_threshold.find((t) => t.threshold === 0.4)!.all.recall, 0);
});

test('test-split metrics ignore dev TPs and count all FPs', () => {
  const chs = oracle();
  chs.push({ target_chapter: 2, findings: [finding({ target_quote: '창업은 낭만이 아닙니다.' })] });
  const r = evaluate(run(chs), gt, chapters).by_threshold[0];
  assert.equal(r.test.tp, 20);
  assert.equal(r.dev.tp, 10);
  assert.equal(r.test.fp, 1);
  assert.equal(r.test.precision, 20 / 21);
});

test('retrieval recall uses the context the model saw', () => {
  const e = gt.errors.find((x) => x.id === 'E01')!; // ch9 ← ch2
  const withSrc = [{ chapter: 2, text: chapters.get(2)! }];
  const without = [{ chapter: 3, text: chapters.get(3)! }];
  const r1 = evaluate(run([{ target_chapter: 9, context: withSrc, findings: [] }]), gt, chapters);
  const r2 = evaluate(run([{ target_chapter: 9, context: without, findings: [] }]), gt, chapters);
  assert.equal(r1.retrieval.per_error[e.id], true);
  assert.equal(r2.retrieval.per_error[e.id], false);
  // chapters without recorded context are unknown, not misses
  assert.equal(r1.retrieval.per_error['E04'], undefined);
});
