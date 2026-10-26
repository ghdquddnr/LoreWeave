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

/**
 * 무시 목록에서 "같은 문장"을 알아보는 키. 원고에서 찾은 글자(모델이 낸 인용이 아니라)로 만든다.
 * NFC, 공백 개수, 따옴표 모양, 문장을 감싼 따옴표가 있는지 없는지는 같게 본다
 * (모델이 같은 대사를 따옴표째 인용하기도, 빼고 인용하기도 한다). 작가가 글자를 고치면 키가 달라진다.
 */
export function quoteKey(text: string): string {
  return text
    .normalize('NFC')
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^["'「『]+|["'」』]+$/g, '')
    .trim();
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

/**
 * 나눠 검사한 결과를 합친다: 같은 종류·같은 이 화 문장(key)의 결과는 하나로, 근거는 겹치지 않게 모은다.
 * 확신도는 가장 높은 것을 쓰고, 설명도 그 결과(확신도가 같으면 먼저 나온 결과)의 것을 쓴다.
 * 설명과 확신도를 다른 결과에서 가져오면, 숨겨질 낮은 확신도의 설명(예: "모순이라고 단정할 수 없다")이
 * 다른 결과의 높은 확신도로 화면에 보일 수 있다 (M10-DIAGNOSIS.md 2절).
 */
export function mergeFindings<T extends LocatedFinding & { key: string }>(findings: T[]): T[] {
  const merged = new Map<string, T>();
  for (const f of findings) {
    const id = `${f.category}|${f.key}`;
    const seen = merged.get(id);
    if (!seen) {
      merged.set(id, { ...f, evidence: [...f.evidence] });
      continue;
    }
    for (const e of f.evidence) {
      if (!seen.evidence.some((x) => x.chapter === e.chapter && x.line === e.line && x.start === e.start)) seen.evidence.push(e);
    }
    if (f.confidence > seen.confidence) {
      seen.confidence = f.confidence;
      seen.claim = f.claim;
    }
  }
  return [...merged.values()];
}
