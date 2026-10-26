// M10 계획의 오프라인 집계 (M10-PLAN.md 1절). API를 부르지 않는다. 저장된 결과만 읽는다.
//   pnpm tsx scripts/m10-m4-matrix.ts [--json <출력 파일>]
// 합성 원고(M0-A 벤치마크) 오류 30개를 오류 ID별로, 저장된 10회 검사에서 찾았는지 모은다.
//   - m0a-d1: M0-A B 전략 detect-1 luna 3회 (태그 spike-m0a-2026-10-24의 회별 metrics.json). 입력은 M0-A 추출본
//   - m4-d1: M4 제품 detect-1 1회 (test는 spikes/m9-followup, dev는 docs/M4-REPORT.md "놓친 오류" 표)
//   - m9-d2: detect-2 후보 3회 (spikes/m9-run)
//   - m9-p: detect-1 + 같은 속성 이름 사실 더하기 3회 (spikes/m9-predicate)
// m4-d1·m9-d2·m9-p는 같은 저장 분석(M4 스냅숏)에서 고른 입력이고, m0a-d1은 다른 추출본이다. 조건이 다른 비교는 동등 실험이 아니다.
// 같은 조건 안의 두 회를 합친(합집합) 결과도 센다. 오탐은 회마다 (화, 종류)로 구분해 합친 근사값이다.

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..');
const readJson = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const TAG = 'spike-m0a-2026-10-24';

interface Run {
  id: string;
  condition: 'm0a-d1' | 'm4-d1' | 'm9-d2' | 'm9-p';
  missed: Set<string>;
  /** 평가기 오탐(unlabeled·trap·fabricated)을 (화, 종류)로 */
  fps: string[];
}

function loadRuns(): Run[] {
  const runs: Run[] = [];
  for (const r of [0, 1, 2]) {
    const m = JSON.parse(
      execFileSync('git', ['show', `${TAG}:spikes/m0a-ai-feasibility/results/b-facts__gpt-6-luna__low__r${r}/metrics.json`], { cwd: ROOT, encoding: 'utf8' }),
    );
    // 확신도 0.7 적용 뒤 (제품 기준). 이 세 회는 0.7 미만 결과가 없어 전후가 같다
    const findings = (m.findings as { target_chapter: number; finding: { category: string; confidence: number }; label: string }[]).filter((f) => f.finding.confidence >= 0.7);
    runs.push({
      id: `m0a-d1-r${r}`,
      condition: 'm0a-d1',
      missed: new Set(m.missed.all as string[]),
      fps: findings.filter((f) => ['unlabeled', 'trap', 'fabricated'].includes(f.label)).map((f) => `${f.target_chapter}:${f.finding.category}`),
    });
  }
  const followup = readJson('spikes/m9-followup/results.json');
  // M4 당시 dev 누락은 기록 파일이 없어 보고서 표에서 옮긴다 (docs/M4-REPORT.md). 오탐 0 (같은 보고서)
  runs.push({ id: 'm4-d1', condition: 'm4-d1', missed: new Set([...followup.runs['d1-m4'].missedTest, 'E09', 'E24', 'E25', 'E28']), fps: [] });
  const d2 = readJson('spikes/m9-run/results.json').m4.runs;
  for (const k of ['m4-1', 'm4-2', 'm4-3']) {
    runs.push({
      id: `m9-d2-${k}`,
      condition: 'm9-d2',
      missed: new Set([...d2[k].missedTest, ...d2[k].missedDev]),
      fps: (d2[k].falsePositives as { chapter: number; category: string }[]).map((f) => `${f.chapter}:${f.category}`),
    });
  }
  const p = readJson('spikes/m9-predicate/results.json').m4;
  for (const k of ['m4-1', 'm4-2', 'm4-3']) {
    // 자동 채점의 오탐 수. m4-3의 2개는 8화 (사람 판정으로는 E13의 중복)
    const fp = p[k].auto.after07.fp as number;
    runs.push({ id: `m9-p-${k}`, condition: 'm9-p', missed: new Set([...p[k].missedTest, ...p[k].missedDev]), fps: Array.from({ length: fp }, (_, i) => `8:auto-${i}`) });
  }
  return runs;
}

export function matrix() {
  const gt = readJson('spikes/m0a-ai-feasibility/benchmark/ground-truth.json') as { errors: { id: string; split: string; category: string }[] };
  const runs = loadRuns();
  const conditions = ['m0a-d1', 'm4-d1', 'm9-d2', 'm9-p'] as const;
  const testIds = gt.errors.filter((e) => e.split === 'test').map((e) => e.id);
  const perError = gt.errors.map((e) => {
    const found = Object.fromEntries(
      conditions.map((c) => {
        const rs = runs.filter((r) => r.condition === c);
        return [c, `${rs.filter((r) => !r.missed.has(e.id)).length}/${rs.length}`];
      }),
    );
    const n = runs.filter((r) => !r.missed.has(e.id)).length;
    return { id: e.id, split: e.split, category: e.category, found, foundRuns: n, stability: n === runs.length ? 'always' : n === 0 ? 'never' : 'varies' };
  });
  const testTp = (missed: Set<string>) => testIds.filter((id) => !missed.has(id)).length;
  const perRun = runs.map((r) => ({ id: r.id, condition: r.condition, testTp: testTp(r.missed), fp: r.fps.length, gate17: testTp(r.missed) >= 17 }));
  // 같은 조건 안의 두 회 합집합: 어느 한 회라도 찾으면 찾은 것, 오탐은 (화, 종류)가 다른 것만 더한다
  const unions: { condition: string; runs: string[]; testTp: number; fp: number; fpPerChapter: number }[] = [];
  for (const c of conditions) {
    const rs = runs.filter((r) => r.condition === c);
    for (let i = 0; i < rs.length; i++) {
      for (let j = i + 1; j < rs.length; j++) {
        const missed = new Set([...rs[i]!.missed].filter((id) => rs[j]!.missed.has(id)));
        const fp = new Set([...rs[i]!.fps, ...rs[j]!.fps]).size;
        unions.push({ condition: c, runs: [rs[i]!.id, rs[j]!.id], testTp: testTp(missed), fp, fpPerChapter: fp / 14 });
      }
    }
  }
  return {
    note: '저장된 결과만 다시 읽은 집계 (유료 호출 0). 조건이 다른 비교는 동등 실험·인과가 아니다. 합집합 오탐은 (화, 종류) 근사',
    sources: {
      'm0a-d1': `${TAG} spikes/m0a-ai-feasibility/results/b-facts__gpt-6-luna__low__r{0,1,2}/metrics.json (M0-A 추출본, 입력 형식 M0-A)`,
      'm4-d1': 'spikes/m9-followup/results.json runs.d1-m4 (test) + docs/M4-REPORT.md 놓친 오류 표 (dev)',
      'm9-d2': 'spikes/m9-run/results.json',
      'm9-p': 'spikes/m9-predicate/results.json (자동 채점)',
    },
    perRun,
    perError,
    unionsOfTwo: unions,
    summary: {
      runs: runs.length,
      runsBelowGate17: perRun.filter((r) => !r.gate17).map((r) => r.id),
      unionsOfTwoBelowGate17: unions.filter((u) => u.testTp < 17).map((u) => u.runs.join('+')),
      unionsOfTwoMinTestTp: Math.min(...unions.map((u) => u.testTp)),
      unionsOfTwoMaxFpPerChapter: Math.max(...unions.map((u) => u.fpPerChapter)),
      never: perError.filter((e) => e.stability === 'never').map((e) => e.id),
      varies: perError.filter((e) => e.stability === 'varies').map((e) => e.id),
    },
  };
}

if (require.main === module) {
  const r = matrix();
  console.log(`회별 test TP: ${r.perRun.map((x) => `${x.id} ${x.testTp}`).join(', ')}`);
  console.log(`17/20 미달 회: ${r.summary.runsBelowGate17.join(', ') || '없음'}`);
  console.log(`같은 조건 두 회 합집합 ${r.unionsOfTwo.length}개: 최저 test TP ${r.summary.unionsOfTwoMinTestTp}, 최대 화당 오탐 ${r.summary.unionsOfTwoMaxFpPerChapter.toFixed(3)}, 17 미달 ${r.summary.unionsOfTwoBelowGate17.join(', ') || '없음'}`);
  console.log(`10회 모두 놓침: ${r.summary.never.join(',')} · 회마다 갈림: ${r.summary.varies.join(',')}`);
  const i = process.argv.indexOf('--json');
  if (i !== -1 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, JSON.stringify(r, null, 1) + '\n');
}
