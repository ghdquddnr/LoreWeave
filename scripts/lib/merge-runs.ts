// M10 "두 회 합치기" 오프라인 채점 (M10-PLAN.md 3절, 4-1). 모델을 부르지 않는다. 저장된 결과는 읽기 전용으로만 연다.
// 제품이 한 번의 검사에서 나눈 묶음을 합치는 규칙을 그대로 쓴다:
//   - 위치 검증: verifyFindings (이 화 문장이 원고에 없거나 남는 근거가 없으면 버린다). 제품 runner가 저장한 결과는 이미 검증·합친 것이다
//   - 키: quoteKey(원고에서 찾은 이 화 글자)
//   - 합치기: mergeFindings (같은 종류·같은 키는 하나로. 설명(claim)은 먼저 나온 것, 근거는 겹치지 않게 모으고, 확신도는 가장 높은 것)
// 두 회를 합칠 때는 1회 결과 뒤에 2회 결과를 이어 붙여 mergeFindings에 넣는다 (그래서 같은 결과의 설명은 1회 것이 남는다).
// 확신도 0.7 필터는 합친 뒤에 건다 (제품도 검사 안에서 합친 뒤 화면에서 숨긴다). 그래서 한 회 0.6, 다른 회 0.8인 결과는 0.8로 보인다.

import { DatabaseSync } from 'node:sqlite';
import type { Category } from '../../src/core/ai/detection.ts';
import { mergeFindings, quoteKey, verifyFindings, type LocatedFinding, type PriorLines } from '../../src/core/ai/verify.ts';
import type { Predictions } from '../../spikes/m0a-ai-feasibility/src/schema.ts';

export type KeyedFinding = LocatedFinding & { key: string };
/** 화 번호 → 그 화의 (검증·합친) 결과 */
export type RunFindings = Map<number, KeyedFinding[]>;

type Row = Record<string, unknown>;

/** 제품 runner가 저장한 검사 결과를 그대로 읽는다 (ai.db, 읽기 전용). 화 번호는 파일 이름의 숫자다 */
export function storedRun(dbPath: string): RunFindings {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const all = (sql: string, ...a: (string | number)[]) => db.prepare(sql).all(...a) as Row[];
    const out: RunFindings = new Map();
    for (const c of all('SELECT id, file FROM checks ORDER BY file')) {
      const id = Number(c['id']);
      const evidence = all('SELECT * FROM finding_evidence WHERE check_id = ? ORDER BY finding_ord, ord', id);
      out.set(
        Number(String(c['file']).replace(/\.md$/, '')),
        all('SELECT * FROM findings WHERE check_id = ? ORDER BY ord', id).map((f) => ({
          category: String(f['category']) as Category,
          claim: String(f['claim']),
          confidence: Number(f['confidence']),
          key: String(f['target_key']),
          target: { quote: String(f['target_quote']), line: Number(f['line']), start: Number(f['start_col']), end: Number(f['end_col']) },
          evidence: evidence
            .filter((e) => Number(e['finding_ord']) === Number(f['ord']))
            .map((e) => ({ file: String(e['file']), chapter: Number(e['chapter']), quote: String(e['quote']), line: Number(e['line']), start: Number(e['start_col']), end: Number(e['end_col']) })),
        })),
      );
    }
    return out;
  } finally {
    db.close();
  }
}

/**
 * 제품이 위치를 검증하지 않은 예측(M0-A 실행 결과)을 제품 규칙으로 검증·키·합치기 한다.
 * 근거로 들 수 있는 화는 그 화 context에 사실이 있던 앞 화뿐이다 (제품과 같다). linesOf는 화 번호의 본문 줄
 */
export function locateRun(predictions: Predictions, linesOf: (chapter: number) => { file: string; lines: string[] } | null): { findings: RunFindings; dropped: number } {
  const out: RunFindings = new Map();
  let dropped = 0;
  for (const cp of predictions.chapters) {
    const target = linesOf(cp.target_chapter);
    if (!target) throw new Error(`${cp.target_chapter}화 본문이 없습니다`);
    const priorLines: PriorLines = new Map();
    for (const n of new Set((cp.context ?? []).map((c) => c.chapter))) {
      const prior = linesOf(n);
      if (prior) priorLines.set(n, prior);
    }
    const verified = verifyFindings(cp.findings as Parameters<typeof verifyFindings>[0], target.lines, priorLines);
    dropped += verified.dropped.length;
    const keyed = verified.findings.map((f) => ({ ...f, key: quoteKey(target.lines[f.target.line]!.slice(f.target.start, f.target.end)) }));
    out.set(cp.target_chapter, mergeFindings(keyed));
  }
  return { findings: out, dropped };
}

/** 여러 회를 순서대로 이어 붙여 제품 mergeFindings로 합친다. 모든 회가 같은 화를 검사했어야 한다 */
export function mergeRuns(runs: RunFindings[]): RunFindings {
  if (runs.length < 2) throw new Error('두 회 이상이 필요합니다');
  const chapters = [...runs[0]!.keys()].sort((a, b) => a - b);
  for (const r of runs) {
    const got = [...r.keys()].sort((a, b) => a - b);
    if (JSON.stringify(got) !== JSON.stringify(chapters)) throw new Error(`검사한 화가 회마다 다릅니다: ${got.join(',')} ≠ ${chapters.join(',')}`);
  }
  return new Map(chapters.map((n) => [n, mergeFindings(runs.flatMap((r) => r.get(n)!))]));
}

/**
 * 합친 결과로 평가기 입력을 만든다. context는 base(한 회의 평가기 출력)의 것을 쓴다.
 * others를 주면 그 회들의 context가 base와 화마다 같은지 확인하고 다르면 오류를 낸다 (같은 입력을 보낸 회만 합친다)
 */
export function mergedPredictions(runId: string, base: Predictions, merged: RunFindings, others: Predictions[] = []): Predictions {
  for (const o of others) {
    for (const cp of base.chapters) {
      const other = o.chapters.find((c) => c.target_chapter === cp.target_chapter);
      if (!other || JSON.stringify(other.context) !== JSON.stringify(cp.context)) throw new Error(`${cp.target_chapter}화의 context가 회마다 다릅니다 (${o.run_id})`);
    }
  }
  return {
    ...base,
    run_id: runId,
    strategy: `${base.strategy}+merge`,
    chapters: base.chapters.map((cp) => ({
      target_chapter: cp.target_chapter,
      context: cp.context,
      findings: (merged.get(cp.target_chapter) ?? []).map((f) => ({
        category: f.category,
        target_quote: f.target.quote,
        claim: f.claim,
        confidence: f.confidence,
        evidence: f.evidence.map((e) => ({ chapter: e.chapter, quote: e.quote })),
      })),
    })),
  } as Predictions;
}
