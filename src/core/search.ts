// 검색 일치 규칙 (M2-PLAN 4절).
//   - 부분 문자열 일치. 2글자 이름도 찾는다
//   - 원고와 검색어를 NFC로 맞춘다 (macOS에서 온 원고는 한글이 NFD로 저장돼 있을 수 있다)
//   - 영문 대소문자는 무시한다. 공백은 그대로 비교한다
// 찾은 위치는 원래 글자 기준으로 돌려준다. 그래야 NFD 원고에서도 에디터가 정확히 선택한다.

const segmenter = new Intl.Segmenter('ko', { granularity: 'grapheme' });
const lowerAscii = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** 색인과 검색어에 쓰는 비교용 글자 */
export function normalizeForSearch(text: string): string {
  return lowerAscii(text.normalize('NFC'));
}

export interface MatchRange {
  /** 원래 글자 기준 UTF-16 위치 [from, to) */
  from: number;
  to: number;
}

/**
 * text 안에서 query가 나오는 모든 위치 (겹치지 않게 앞에서부터).
 * 글자 덩어리(grapheme) 단위로 정규화해 정규화 전후 위치를 대응시킨다.
 */
export function findMatches(text: string, query: string): MatchRange[] {
  const needle = normalizeForSearch(query);
  if (!needle) return [];
  let normalized = '';
  // normalized의 각 글자가 속한 원래 덩어리의 시작과 끝
  const segStart: number[] = [];
  const segEnd: number[] = [];
  for (const { segment, index } of segmenter.segment(text)) {
    const n = normalizeForSearch(segment);
    for (let i = 0; i < n.length; i++) {
      segStart.push(index);
      segEnd.push(index + segment.length);
    }
    normalized += n;
  }

  const out: MatchRange[] = [];
  for (let at = normalized.indexOf(needle); at !== -1; at = normalized.indexOf(needle, at + needle.length)) {
    // 덩어리 중간에서 시작하거나 끝나면 그 덩어리 전체를 포함한다
    out.push({ from: segStart[at]!, to: segEnd[at + needle.length - 1]! });
  }
  return out;
}

/** 결과 목록에 보일 앞뒤 문맥. 한 줄로 잘려 보이므로 찾은 글자가 앞쪽에 오도록 앞 문맥을 짧게 둔다 */
export function snippet(
  text: string,
  match: MatchRange,
  { before = 12, after = 40 }: { before?: number; after?: number } = {},
): { before: string; hit: string; after: string } {
  const start = Math.max(0, match.from - before);
  const end = Math.min(text.length, match.to + after);
  return {
    before: (start > 0 ? '…' : '') + text.slice(start, match.from),
    hit: text.slice(match.from, match.to),
    after: text.slice(match.to, end) + (end < text.length ? '…' : ''),
  };
}
