// Aggregates results/<strategy>__<model>__<effort>__r<n>/ runs into results/summary.{json,md}.
// Criteria are the ones fixed in docs/M0-PLAN.md §3 (test split, threshold 0).

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EvalReport } from './evaluate.ts';

const RESULTS = join(import.meta.dirname, '..', 'results');

interface Run {
  strategy: string;
  model: string;
  repeat: number;
  m: EvalReport;
  usage: { total: { input_tokens: number; output_tokens: number; reasoning_tokens: number; calls: number }; cost_per_chapter_usd: number };
}

const runs: Run[] = [];
for (const d of readdirSync(RESULTS)) {
  const parts = d.split('__');
  if (parts.length !== 4 || !existsSync(join(RESULTS, d, 'metrics.json'))) continue;
  runs.push({
    strategy: parts[0],
    model: parts[1],
    repeat: Number(parts[3].slice(1)),
    m: JSON.parse(readFileSync(join(RESULTS, d, 'metrics.json'), 'utf8')),
    usage: JSON.parse(readFileSync(join(RESULTS, d, 'usage.json'), 'utf8')),
  });
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const nums = (xs: (number | null)[]) => xs.filter((x): x is number => x !== null);
const pct = (x: number | null | undefined) => (x === null || x === undefined || Number.isNaN(x) ? '-' : `${(x * 100).toFixed(0)}%`);

const groups = new Map<string, Run[]>();
for (const r of runs) groups.set(`${r.strategy}|${r.model}`, [...(groups.get(`${r.strategy}|${r.model}`) ?? []), r]);

const ORDER = ['full-context', 'target-only', 'a-search', 'b-facts', 'c-summary', 'd-entity'];
const rows = [...groups.values()]
  .map((rs) => {
    const t0 = rs.map((r) => r.m.by_threshold[0]);
    const recalls = t0.map((t) => t.test.recall);
    return {
      strategy: rs[0].strategy,
      model: rs[0].model,
      repeats: rs.length,
      test_recall: mean(recalls),
      test_recall_range: Math.max(...recalls) - Math.min(...recalls),
      test_precision: mean(nums(t0.map((t) => t.test.precision))),
      fp_per_chapter: mean(t0.map((t) => t.all.fp_per_chapter)),
      quote_existence: mean(nums(rs.map((r) => r.m.quotes.existence_rate))),
      evidence_chapter_accuracy: mean(nums(rs.map((r) => r.m.evidence.chapter_accuracy))),
      trap_rate_test: mean(rs.map((r) => r.m.traps.test.rate)),
      retrieval_recall: mean(nums(rs.map((r) => r.m.retrieval.retrieval_recall))),
      judge_recall: mean(nums(rs.map((r) => r.m.retrieval.judge_recall))),
      echo: mean(rs.map((r) => r.m.echo_count)),
      review: mean(rs.map((r) => r.m.review_queue.length)),
      input_tokens_per_chapter: mean(rs.map((r) => r.usage.total.input_tokens / r.m.n_chapters)),
      output_tokens_per_chapter: mean(rs.map((r) => r.usage.total.output_tokens / r.m.n_chapters)),
      cost_per_chapter_usd: mean(rs.map((r) => r.usage.cost_per_chapter_usd)),
      // per-category recall on test, pooled over repeats
      category_recall_test: Object.fromEntries(
        Object.keys(rs[0].m.breakdown.test.category).map((c) => [c, mean(rs.map((r) => r.m.breakdown.test.category[c].recall))]),
      ),
      explicitness_recall_test: Object.fromEntries(
        Object.keys(rs[0].m.breakdown.test.explicitness).map((c) => [c, mean(rs.map((r) => r.m.breakdown.test.explicitness[c].recall))]),
      ),
      distance_recall_test: Object.fromEntries(
        Object.keys(rs[0].m.breakdown.test.distance).map((c) => [c, mean(rs.map((r) => r.m.breakdown.test.distance[c].recall))]),
      ),
      missed_test: [...new Set(rs.flatMap((r) => r.m.missed.test))].sort(),
      trap_hits: [...new Set(rs.flatMap((r) => r.m.traps.hit_ids))].sort(),
    };
  })
  .sort((a, b) => ORDER.indexOf(a.strategy) - ORDER.indexOf(b.strategy) || a.model.localeCompare(b.model));

type Row = (typeof rows)[number];
const CRITERIA: [string, (r: Row) => boolean][] = [
  ['Recall ≥ 60%', (r) => r.test_recall >= 0.6],
  ['Precision ≥ 50%', (r) => r.test_precision >= 0.5],
  ['FP/화 ≤ 1', (r) => r.fp_per_chapter <= 1],
  ['인용문 실재율 ≥ 98%', (r) => r.quote_existence >= 0.98],
  ['근거 챕터 정확도 ≥ 90%', (r) => r.evidence_chapter_accuracy >= 0.9],
  ['함정 오탐률 ≤ 25%', (r) => r.trap_rate_test <= 0.25],
  ['3회 Recall 편차 ≤ 10%p', (r) => r.repeats >= 3 && r.test_recall_range <= 0.1],
];

const md: string[] = [
  '# M0-A 결과 요약 (자동 생성: `pnpm aggregate`)',
  '',
  'test split, confidence 임계값 0 (모든 지적). 반복 평균. 기준은 `docs/M0-PLAN.md` §3.',
  '',
  '| 전략 | 모델 | 반복 | Recall | 편차 | Precision | FP/화 | 인용 실재 | 근거 화 | 함정 오탐 | retrieval | judge | 입력 tok/화 | $/화 |',
  '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ...rows.map(
    (r) =>
      `| ${r.strategy} | ${r.model} | ${r.repeats} | ${pct(r.test_recall)} | ${(r.test_recall_range * 100).toFixed(0)}%p | ${pct(r.test_precision)} | ${r.fp_per_chapter.toFixed(2)} | ${pct(r.quote_existence)} | ${pct(r.evidence_chapter_accuracy)} | ${pct(r.trap_rate_test)} | ${pct(r.retrieval_recall)} | ${pct(r.judge_recall)} | ${Math.round(r.input_tokens_per_chapter)} | ${r.cost_per_chapter_usd.toFixed(4)} |`,
  ),
  '',
  '## 기준 충족',
  '',
  `| 전략 | 모델 | ${CRITERIA.map(([n]) => n).join(' | ')} |`,
  `|---|---|${CRITERIA.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.strategy} | ${r.model} | ${CRITERIA.map(([, f]) => (f(r) ? '✅' : '❌')).join(' | ')} |`),
  '',
  '## 유형별 Recall (test, 반복 평균)',
  '',
  `| 전략 | 모델 | ${Object.keys(rows[0].category_recall_test).join(' | ')} | L1 | L2 | L3 | near | mid | far |`,
  `|---|---|${Object.keys(rows[0].category_recall_test).map(() => '---').join('|')}|---|---|---|---|---|---|`,
  ...rows.map(
    (r) =>
      `| ${r.strategy} | ${r.model} | ${Object.values(r.category_recall_test).map(pct).join(' | ')} | ${['L1', 'L2', 'L3'].map((k) => pct(r.explicitness_recall_test[k])).join(' | ')} | ${['near', 'mid', 'far'].map((k) => pct(r.distance_recall_test[k])).join(' | ')} |`,
  ),
  '',
  '## 놓친 test 오류 (반복 중 한 번이라도) · 함정 오탐',
  '',
  ...rows.map((r) => `- ${r.strategy} / ${r.model}: 놓침 ${r.missed_test.join(', ') || '없음'} · 함정 ${r.trap_hits.join(', ') || '없음'}`),
  '',
];

writeFileSync(join(RESULTS, 'summary.json'), JSON.stringify(rows, null, 2) + '\n');
writeFileSync(join(RESULTS, 'summary.md'), md.join('\n'));
console.log(md.join('\n'));
