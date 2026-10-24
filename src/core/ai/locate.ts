// 인용문 존재 검사 (ADR 0001 결정 2, M3-PLAN 1절).
// 모델이 낸 quote를 화의 본문 줄에서 찾는다. 찾으면 줄 주소(M2)와 위치를 붙이고, 못 찾으면 그 사실을 버린다.
// 모델이 흔히 바꾸는 것만 같게 본다: NFC, 공백의 개수, 곧은·둥근 따옴표, 생략 표시(… 또는 ...)로 줄인 인용.
// 그 밖에 글자가 다르면 본문에 없는 인용으로 본다.

import type { Extraction, Fact } from './extraction.ts';

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });

function normalizeChar(segment: string): string {
  const s = segment.normalize('NFC');
  if (/^\s+$/.test(s)) return ' ';
  return s.replace(/[“”„‟″]/g, '"').replace(/[‘’‚‛′]/g, "'");
}

interface Normalized {
  text: string;
  /** text의 각 글자가 속한 원래 글자 덩어리의 시작과 끝 (UTF-16) */
  start: number[];
  end: number[];
}

function normalize(text: string): Normalized {
  const out: Normalized = { text: '', start: [], end: [] };
  for (const { segment, index } of segmenter.segment(text)) {
    const n = normalizeChar(segment);
    if (n === ' ' && out.text.endsWith(' ')) {
      out.end[out.end.length - 1] = index + segment.length;
      continue;
    }
    for (let i = 0; i < n.length; i++) {
      out.start.push(index);
      out.end.push(index + segment.length);
    }
    out.text += n;
  }
  return out;
}

export interface QuoteLocation {
  /** 본문 줄 번호 (0부터, M2 줄 주소) */
  line: number;
  /** 그 줄 안의 위치 [start, end), 원래 글자 기준 UTF-16 */
  start: number;
  end: number;
}

/** 생략 표시로 나눈 인용 조각들이 한 줄 안에 순서대로 있는 첫 위치 */
function findParts(lines: string[], parts: string[]): QuoteLocation | null {
  for (let line = 0; line < lines.length; line++) {
    const n = normalize(lines[line]!);
    let from = 0;
    let first = -1;
    let last = -1;
    for (const part of parts) {
      const at = n.text.indexOf(part, from);
      if (at === -1) {
        first = -1;
        break;
      }
      if (first === -1) first = at;
      last = at + part.length - 1;
      from = at + part.length;
    }
    if (first !== -1) return { line, start: n.start[first]!, end: n.end[last]! };
  }
  return null;
}

const splitElisions = (quote: string) =>
  quote
    .split(/\s*(?:…|\.\.\.)\s*/)
    .map((p) => p.trim())
    .filter(Boolean);

/** 인용을 본문 줄에서 찾는다. 못 찾으면 null */
export function locateQuote(lines: string[], quote: string): QuoteLocation | null {
  const q = normalize(quote).text.trim();
  if (!q) return null;
  // 1) 그대로  2) 생략 표시로 나눈 조각  3) 모델이 앞뒤에 붙인 따옴표·마침표를 뗀 것
  const stripped = q.replace(/^["'「『]+|["'」』.]+$/g, '').trim();
  for (const parts of [[q], splitElisions(q), splitElisions(stripped)]) {
    if (parts.length === 0) continue;
    const found = findParts(lines, parts);
    if (found) return found;
  }
  return null;
}

export type LocatedFact = Fact & QuoteLocation;

/** 인용이 본문에 있는 사실만 남긴다 */
export function checkQuotes(extraction: Extraction, lines: string[]): { facts: LocatedFact[]; dropped: Fact[] } {
  const facts: LocatedFact[] = [];
  const dropped: Fact[] = [];
  for (const fact of extraction.facts) {
    const at = locateQuote(lines, fact.quote);
    if (at) facts.push({ ...fact, ...at });
    else dropped.push(fact);
  }
  return { facts, dropped };
}
