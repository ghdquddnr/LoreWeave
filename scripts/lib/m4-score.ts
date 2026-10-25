// M9 합성 원고(M4) 회귀 채점 (M9-PLAN 4절 기준 8). 회마다 따로 채점한다. 모델을 부르지 않는다.
// 채점은 main에 남아 있는 M0-A 평가기(spikes/m0a-ai-feasibility/src/evaluate.ts)와 정답표를 그대로 쓴다.
//   - 분모: test 분할 정답 오류 20개. 화당 오탐의 분모는 평가기와 같이 검사한 화 수(2~15화 = 14화)다.
//     원고는 15화지만 1화는 앞 화가 없어 검사하지 않는다. 15로 나누면 더 느슨해지므로 M4 관측값(0)과 같은 14를 쓴다
//   - 오탐: 평가기의 trap·fabricated·unlabeled를 모두 센다 (unlabeled는 사람 검토 전까지 오탐으로 본다)
//   - 기준은 제품과 같이 확신도 0.7 미만을 숨긴 뒤로 판정하고, 숨기기 전(0) 값도 함께 남긴다

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, type EvalReport } from '../../spikes/m0a-ai-feasibility/src/evaluate.ts';
import { loadChapters, loadGroundTruth } from '../../spikes/m0a-ai-feasibility/src/benchmark.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';

/** M9-PLAN 4절 기준 8 (M4 관측 90%·100%·0에서 Recall 1개 감소까지 허용) */
export const M4_CRITERIA = { minTestTp: 17, testTotal: 20, minPrecision: 0.85, maxFpPerChapter: 0.3, threshold: 0.7 } as const;

export interface M4Counts {
  tp: number;
  total: number;
  fp: number;
  recall: number;
  precision: number | null;
  fpPerChapter: number;
}

export interface M4Score {
  run: string;
  checkedChapters: number;
  /** 확신도 필터 전 (0) */
  before: M4Counts;
  /** 확신도 0.7 이상만 (제품 화면과 같음) */
  after: M4Counts;
  pass: boolean;
  failures: string[];
}

function countsAt(r: EvalReport, threshold: number): M4Counts {
  const row = r.by_threshold.find((t) => Math.abs(t.threshold - threshold) < 1e-9);
  if (!row) throw new Error(`평가기에 확신도 ${threshold} 결과가 없습니다`);
  const t = row.test;
  return { tp: t.tp, total: t.total, fp: t.fp, recall: t.recall, precision: t.precision, fpPerChapter: t.fp_per_chapter };
}

/** 한 회의 평가기 결과를 고정 기준으로 판정한다 */
export function judgeM4(run: string, r: EvalReport, expectedChapters: number): M4Score {
  const before = countsAt(r, 0);
  const after = countsAt(r, M4_CRITERIA.threshold);
  const failures: string[] = [];
  if (r.n_chapters !== expectedChapters) failures.push(`검사한 화 ${r.n_chapters} ≠ ${expectedChapters}`);
  if (after.total !== M4_CRITERIA.testTotal) failures.push(`test 정답 오류 ${after.total} ≠ ${M4_CRITERIA.testTotal}`);
  if (after.tp < M4_CRITERIA.minTestTp) failures.push(`Recall ${after.tp}/${after.total} < ${M4_CRITERIA.minTestTp}/${M4_CRITERIA.testTotal}`);
  // 결과가 하나도 없으면 Precision을 정할 수 없다. 통과로 보지 않는다
  if (after.precision === null || after.precision < M4_CRITERIA.minPrecision) failures.push(`Precision ${after.precision ?? '없음'} < ${M4_CRITERIA.minPrecision}`);
  if (after.fpPerChapter > M4_CRITERIA.maxFpPerChapter) failures.push(`화당 오탐 ${after.fpPerChapter} > ${M4_CRITERIA.maxFpPerChapter}`);
  return { run, checkedChapters: r.n_chapters, before, after, pass: failures.length === 0, failures };
}

/** 예측을 M0-A 벤치마크(또는 같은 형식의 폴더)로 채점한다 */
export function scoreM4(run: string, predictions: Predictions, expectedChapters: number, benchmarkDir?: string): M4Score {
  return judgeM4(run, evaluate(predictions, loadGroundTruth(benchmarkDir), loadChapters(benchmarkDir)), expectedChapters);
}

/** 세 회가 모두 통과해야 기준 8을 충족한다. 회 수가 다르면 충족하지 않는다 */
export function m4Passed(scores: M4Score[], runs = 3): boolean {
  return scores.length === runs && new Set(scores.map((s) => s.run)).size === runs && scores.every((s) => s.pass);
}

/** M0-A 벤치마크 폴더 (정답표와 원본 화) */
export const M0A_BENCHMARK = join(__dirname, '..', '..', 'spikes', 'm0a-ai-feasibility', 'benchmark');

/** M4 시험 원고의 화가 벤치마크 원본과 바이트까지 같은가 (정답표를 그대로 쓸 수 있는가). 다르면 그 이유 */
export function differsFromBenchmark(project: string, benchmarkDir = M0A_BENCHMARK): string | null {
  const files = readdirSync(join(project, 'chapters')).filter((f) => /^\d{3}\.md$/.test(f)).sort();
  const originals = readdirSync(join(benchmarkDir, 'chapters')).filter((f) => /^ch\d{2}\.md$/.test(f)).sort();
  if (files.length !== originals.length) return `화 수 ${files.length} ≠ 벤치마크 ${originals.length}`;
  for (const [i, f] of files.entries()) {
    const original = originals[i]!;
    if (Number(f.slice(0, 3)) !== Number(original.slice(2, 4))) return `${f}에 맞는 벤치마크 화가 없습니다`;
    if (!readFileSync(join(project, 'chapters', f)).equals(readFileSync(join(benchmarkDir, 'chapters', original)))) return `${f}가 벤치마크 원본과 다릅니다`;
  }
  return null;
}
