// 검사 결과 검증 (ADR 0001 결정 2, M4-PLAN 1절).
// 모델이 낸 문장이 실제 원고에 있는지 본다. 이 화 문장이 없으면 결과를 버리고,
// 근거는 앞 화 본문에 있는 것만 남긴다. 남는 근거가 없으면 결과를 버린다.

import type { Category, Finding } from './detection.ts';
import { locateQuote, type QuoteLocation } from './locate.ts';

export interface LocatedQuote extends QuoteLocation {
  quote: string;
}

export interface LocatedEvidence extends LocatedQuote {
  file: string;
  chapter: number;
}

export interface LocatedFinding {
  category: Category;
  claim: string;
  confidence: number;
  target: LocatedQuote;
  evidence: LocatedEvidence[];
}

/** 앞 화의 본문 줄. 화 번호로 찾는다 */
export type PriorLines = Map<number, { file: string; lines: string[] }>;

export function verifyFindings(
  findings: Finding[],
  targetLines: string[],
  priorLines: PriorLines,
): { findings: LocatedFinding[]; dropped: Finding[] } {
  const kept: LocatedFinding[] = [];
  const dropped: Finding[] = [];
  for (const f of findings) {
    const target = locateQuote(targetLines, f.target_quote);
    const evidence: LocatedEvidence[] = [];
    for (const e of f.evidence) {
      const prior = priorLines.get(e.chapter);
      const at = prior && locateQuote(prior.lines, e.quote);
      if (prior && at) evidence.push({ file: prior.file, chapter: e.chapter, quote: e.quote, ...at });
    }
    if (target && evidence.length > 0) {
      kept.push({ category: f.category, claim: f.claim, confidence: f.confidence, target: { quote: f.target_quote, ...target }, evidence });
    } else {
      dropped.push(f);
    }
  }
  return { findings: kept, dropped };
}
