// 보존한 원래 응답(raw-record.ts)을 오프라인으로 다시 돌린다: 제품 규칙 그대로 위치 검증(verifyFindings) → 키(quoteKey) → 합치기(mergeFindings).
// 결과를 회차 복사본에 저장된 검사 결과와 비교하고, 원래 결과마다 남김·버림과 버린 이유(이 화 문장 없음 / 근거 없음 / 둘 다)를 붙인다.
// 모델을 부르지 않는다. 회차 ai.db는 읽기 전용으로만 연다. 원문이 들어 있는 상세는 저장소 밖 작업 폴더에만 쓰고, 공개용 요약에는 수만 담는다.
// 과거 실행(M10까지)은 원래 응답을 남기지 않았다. 이 재생은 기록을 켠 실행에만 쓸 수 있다.

import { readFileSync } from 'node:fs';
import { parseDetection, type Finding } from '../../src/core/ai/detection.ts';
import { locateQuote } from '../../src/core/ai/locate.ts';
import { mergeFindings, quoteKey, verifyFindings, type PriorLines } from '../../src/core/ai/verify.ts';
import { chapterNumber } from '../../src/core/project/chapters.ts';
import { chapterLines } from '../../src/main/analyzer.ts';
import { storedRun, type KeyedFinding } from './merge-runs.ts';
import type { RawAttempt, RawPlan } from './raw-record.ts';

export type DropReason = 'no-target' | 'no-evidence' | 'no-target-and-evidence';

export interface ReplayedFinding {
  batch: number;
  kept: boolean;
  reason: DropReason | null;
  finding: Finding;
}

export interface ChapterReplay {
  file: string;
  /** 묶음마다 응답이 있는가 (없으면 그 화는 저장되지 않았어야 한다) */
  complete: boolean;
  /** 응답 형식이 틀린 묶음 */
  badFormat: number[];
  findings: ReplayedFinding[];
  merged: KeyedFinding[];
  stored: KeyedFinding[] | null;
  /** 다시 돌린 합치기 결과가 저장된 검사 결과와 같은가 (저장되지 않았으면 null) */
  matchesStored: boolean | null;
}

const comparable = (fs: KeyedFinding[]) =>
  JSON.stringify(
    fs.map((f) => ({
      category: f.category,
      key: f.key,
      claim: f.claim,
      confidence: f.confidence,
      target: { line: f.target.line, start: f.target.start, end: f.target.end, quote: f.target.quote },
      evidence: f.evidence.map((e) => ({ file: e.file, chapter: e.chapter, quote: e.quote, line: e.line, start: e.start, end: e.end })),
    })),
  );

export function readRaw(path: string): { plans: RawPlan[]; attempts: RawAttempt[] } {
  const lines = readFileSync(path, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as RawPlan | RawAttempt);
  return { plans: lines.filter((l): l is RawPlan => l.type === 'plan'), attempts: lines.filter((l): l is RawAttempt => l.type === 'attempt') };
}

/** root: 회차 복사본 (chapters/와 .loreweave/ai.db), rawPath: 그 회차의 기록 */
export async function replayRun(root: string, rawPath: string, dbPath: string): Promise<ChapterReplay[]> {
  const { plans, attempts } = readRaw(rawPath);
  const stored = storedRun(dbPath);
  const out: ChapterReplay[] = [];
  for (const plan of plans) {
    const target = await chapterLines(root, plan.file);
    const priorLines: PriorLines = new Map();
    for (const n of plan.factChapters) {
      const file = `${String(n).padStart(3, '0')}.md`;
      priorLines.set(n, { file, lines: (await chapterLines(root, file)).lines });
    }
    // 묶음마다 마지막 응답 (재시도 끝에 받은 것)
    const responses = Array.from({ length: plan.batches }, (_, b) =>
      attempts.filter((a) => a.file === plan.file && a.batch === b && a.outcome === 'response').at(-1),
    );
    const complete = responses.every(Boolean);
    const badFormat: number[] = [];
    const findings: ReplayedFinding[] = [];
    const all: Finding[] = [];
    responses.forEach((r, batch) => {
      if (!r) return;
      let parsed: Finding[];
      try {
        parsed = parseDetection(r.data);
      } catch {
        badFormat.push(batch);
        return;
      }
      for (const f of parsed) {
        const t = locateQuote(target.lines, f.target_quote) !== null;
        const ev = f.evidence.some((e) => {
          const prior = priorLines.get(e.chapter);
          return !!prior && locateQuote(prior.lines, e.quote) !== null;
        });
        findings.push({ batch, kept: t && ev, reason: t && ev ? null : !t && !ev ? 'no-target-and-evidence' : !t ? 'no-target' : 'no-evidence', finding: f });
        all.push(f);
      }
    });
    // 제품과 같은 순서: 묶음 순서대로 이어 붙여 검증하고, 키를 붙여 합친다
    const verified = verifyFindings(all, target.lines, priorLines);
    const merged = mergeFindings(verified.findings.map((f) => ({ ...f, key: quoteKey(target.lines[f.target.line]!.slice(f.target.start, f.target.end)) })));
    const saved = stored.get(chapterNumber(plan.file)!) ?? null;
    out.push({ file: plan.file, complete, badFormat, findings, merged, stored: saved, matchesStored: saved === null ? null : comparable(saved) === comparable(merged) });
  }
  return out;
}

/** 공개해도 되는 요약 (수만) */
export function replaySummary(run: string, chapters: ChapterReplay[], attempts: RawAttempt[]) {
  const count = (pred: (f: ReplayedFinding) => boolean) => chapters.reduce((n, c) => n + c.findings.filter(pred).length, 0);
  return {
    run,
    chapters: chapters.length,
    attempts: { total: attempts.length, response: attempts.filter((a) => a.outcome === 'response').length, error: attempts.filter((a) => a.outcome === 'error').length, aborted: attempts.filter((a) => a.outcome === 'aborted').length, retried: attempts.filter((a) => a.attempt > 1).length, unattributed: attempts.filter((a) => a.file === null).length },
    rawFindings: count(() => true),
    kept: count((f) => f.kept),
    dropped: { noTarget: count((f) => f.reason === 'no-target'), noEvidence: count((f) => f.reason === 'no-evidence'), both: count((f) => f.reason === 'no-target-and-evidence') },
    merged: chapters.reduce((n, c) => n + c.merged.length, 0),
    matchesStored: chapters.filter((c) => c.matchesStored === true).length,
    differsFromStored: chapters.filter((c) => c.matchesStored === false).map((c) => c.file),
    notSaved: chapters.filter((c) => c.stored === null).map((c) => c.file),
    incomplete: chapters.filter((c) => !c.complete).map((c) => c.file),
    badFormat: chapters.filter((c) => c.badFormat.length > 0).map((c) => c.file),
  };
}
