// M10 오프라인 재현 (M10-PLAN.md 4-2): 저장된 M4 회차를 제품 합치기 규칙(merge-runs.ts)으로 실제로 합쳐 채점하고,
// 계획 1절의 "오류 ID 합집합" 수와 비교한다. API를 부르지 않는다. 모든 DB는 복사본을 읽기 전용으로 연다.
//   pnpm tsx scripts/m10-merge-score.ts --project <M4 원고 복사본> --group m9-d2=<ai.db>,<ai.db>,<ai.db> --group m9-p=<...> [--json <출력 파일>]
//   - project: chapters/NNN.md (M4 시험 원고, 벤치마크와 바이트까지 같아야 한다). M0-A 회차(태그의 predictions.json)를 제품 규칙으로 위치 검증하는 데 쓴다
//   - group: 같은 조건의 회차 ai.db (제품 runner가 저장한 검증·합친 결과). 순서대로 1회, 2회, ...
// 출력은 오류 ID·화 번호·수·평가기 라벨만 담는다 (원문·인용 없음). 경로는 남기지 않는다.

import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadChapters, loadGroundTruth } from '../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { evaluate, type EvalReport } from '../spikes/m0a-ai-feasibility/src/evaluate.ts';
import type { Predictions } from '../spikes/m0a-ai-feasibility/src/schema.ts';
import { chapterLines } from '../src/main/analyzer.ts';
import { toPredictions } from './export-predictions.ts';
import { differsFromBenchmark, judgeM4, M0A_BENCHMARK } from './lib/m4-score.ts';
import { locateRun, mergedPredictions, mergeRuns, storedRun, type RunFindings } from './lib/merge-runs.ts';

const ROOT = join(__dirname, '..');
const TAG = 'spike-m0a-2026-10-24';
const T = 0.7;

interface Run {
  id: string;
  predictions: Predictions;
  findings: RunFindings;
  /** 위치 검증에서 버린 결과 수 (M0-A 회차만. 제품 runner 결과는 이미 검증됨) */
  droppedByVerify: number;
}

const testErrors = new Set(loadGroundTruth(M0A_BENCHMARK).errors.filter((e) => e.split === 'test').map((e) => e.id));
const report = (p: Predictions): EvalReport => evaluate(p, loadGroundTruth(M0A_BENCHMARK), loadChapters(M0A_BENCHMARK));
/** 확신도 0.7 적용 뒤 test TP 오류 ID와, 평가기 라벨별 수 */
function at07(r: EvalReport) {
  // 평가기는 확신도 높은 순으로 라벨을 붙인다. 0.7 행의 TP 오류 ID는 0.7 이상 결과만 다시 분류해 얻는다
  const labeled = r.findings.filter((l) => l.finding.confidence >= T);
  return { labels: labeled.reduce<Record<string, number>>((m, l) => ({ ...m, [l.label]: (m[l.label] ?? 0) + 1 }), {}) };
}
function tpIds(p: Predictions): Set<string> {
  const filtered = { ...p, chapters: p.chapters.map((c) => ({ ...c, findings: c.findings.filter((f) => f.confidence >= T) })) };
  return new Set(report(filtered).findings.filter((l) => l.label === 'tp' && testErrors.has(l.error_id!)).map((l) => l.error_id!));
}

async function m0aRuns(project: string): Promise<Run[]> {
  const lines = new Map<number, { file: string; lines: string[] }>();
  for (let n = 1; n <= 15; n++) {
    const file = `${String(n).padStart(3, '0')}.md`;
    lines.set(n, { file, lines: (await chapterLines(project, file)).lines });
  }
  return [0, 1, 2].map((r) => {
    const p = JSON.parse(execFileSync('git', ['show', `${TAG}:spikes/m0a-ai-feasibility/results/b-facts__gpt-6-luna__low__r${r}/predictions.json`], { cwd: ROOT, encoding: 'utf8', maxBuffer: 1 << 26 })) as Predictions;
    const located = locateRun(p, (n) => lines.get(n) ?? null);
    // 평가기 입력도 제품 규칙을 거친 결과로 만든다 (위치 검증에서 버린 결과는 제품 화면에 나오지 않는다)
    return { id: `m0a-d1-r${r}`, predictions: mergedPredictions(`m0a-d1-r${r}`, p, located.findings), findings: located.findings, droppedByVerify: located.dropped };
  });
}

function storedRuns(name: string, dbs: string[]): Run[] {
  return dbs.map((db, i) => {
    const { predictions } = toPredictions(db, `${name}-${i + 1}`);
    return { id: `${name}-${i + 1}`, predictions: predictions as unknown as Predictions, findings: storedRun(db), droppedByVerify: 0 };
  });
}

function score(p: Predictions) {
  const s = judgeM4(p.run_id, report(p), 14);
  return { testTp: s.after.tp, fp: s.after.fp, precision: s.after.precision, fpPerChapter: s.after.fpPerChapter, pass: s.pass };
}

export async function reproduce(project: string, groups: [string, string[]][]) {
  const differs = differsFromBenchmark(project);
  if (differs) throw new Error(`M4 원고 복사본이 벤치마크와 다릅니다: ${differs}`);
  const conditions: [string, Run[]][] = [['m0a-d1', await m0aRuns(project)], ...groups.map(([n, dbs]) => [n, storedRuns(n, dbs)] as [string, Run[]])];
  const perRun = conditions.flatMap(([c, runs]) =>
    runs.map((r) => ({ condition: c, id: r.id, droppedByVerify: r.droppedByVerify, ...score(r.predictions), labels07: at07(report(r.predictions)).labels })),
  );
  const pairs = [];
  for (const [c, runs] of conditions) {
    for (let i = 0; i < runs.length; i++) {
      for (let j = i + 1; j < runs.length; j++) {
        const a = runs[i]!;
        const b = runs[j]!;
        const merged = mergedPredictions(`${a.id}+${b.id}`, a.predictions, mergeRuns([a.findings, b.findings]), c === 'm0a-d1' ? [] : [b.predictions]);
        const idUnion = new Set([...tpIds(a.predictions), ...tpIds(b.predictions)]);
        const mergedIds = tpIds(merged);
        const m = score(merged);
        const sa = score(a.predictions);
        const sb = score(b.predictions);
        pairs.push({
          condition: c,
          runs: [a.id, b.id],
          idUnionTestTp: idUnion.size,
          merged: m,
          labels07: at07(report(merged)).labels,
          /** 오류 ID 합집합에는 있지만 실제로 합친 결과의 TP에는 없는 것 (반대도) */
          inIdUnionOnly: [...idUnion].filter((id) => !mergedIds.has(id)).sort(),
          inMergedOnly: [...mergedIds].filter((id) => !idUnion.has(id)).sort(),
          fpSumOfRuns: sa.fp + sb.fp,
        });
      }
    }
  }
  return {
    note: '저장된 M4 회차를 제품 합치기 규칙(검증·quoteKey·mergeFindings)으로 실제로 합쳐 채점한 재현 (유료 호출 0). 확신도 0.7은 합친 뒤에 적용. 오탐은 평가기의 trap·fabricated·unlabeled',
    threshold: T,
    perRun,
    pairs,
    summary: {
      pairsWithDifferentTp: pairs.filter((p) => p.idUnionTestTp !== p.merged.testTp).map((p) => p.runs.join('+')),
      mergedMinTestTp: Math.min(...pairs.map((p) => p.merged.testTp)),
      mergedMaxFpPerChapter: Math.max(...pairs.map((p) => p.merged.fpPerChapter)),
      mergedFailingGate: pairs.filter((p) => !p.merged.pass).map((p) => p.runs.join('+')),
    },
  };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const opt = (n: string) => (args.indexOf(n) === -1 ? undefined : args[args.indexOf(n) + 1]);
  const project = opt('--project');
  const groups = args.flatMap((a, i) => (a === '--group' ? [args[i + 1]!] : [])).map((g) => {
    const [name, list] = g.split('=') as [string, string];
    return [name, list.split(',').map((p) => resolve(p))] as [string, string[]];
  });
  if (!project) {
    console.error('사용: pnpm tsx scripts/m10-merge-score.ts --project <M4 원고 복사본> --group <이름>=<ai.db>,<ai.db>,... [--json <출력 파일>]');
    process.exit(1);
  }
  void reproduce(resolve(project), groups).then((r) => {
    for (const p of r.pairs) console.log(`${p.runs.join(' + ')}: ID 합집합 ${p.idUnionTestTp}, 실제 합치기 TP ${p.merged.testTp} · 오탐 ${p.merged.fp} (두 회 합 ${p.fpSumOfRuns}) ${p.merged.pass ? '통과' : '미달'}`);
    console.log(JSON.stringify(r.summary));
    const out = opt('--json');
    if (out) writeFileSync(out, JSON.stringify(r, null, 1) + '\n');
  });
}
