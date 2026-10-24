// Round-trip 검사: byte 동일, 멱등성, 한 문단 수정의 국소성 (M0-PLAN §3 1~3행).
// 변환기 3종은 모두 같은 TipTap 문서 JSON을 주고받으므로 이 인터페이스 하나로 비교한다.

import { classifyDiff, type DiffResult } from './diff.ts';
import { join, split } from './envelope.ts';

export interface PMMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface PMNode {
  type: string;
  text?: string;
  marks?: PMMark[];
  attrs?: Record<string, unknown>;
  content?: PMNode[];
}

/** Markdown 본문(LF, BOM·frontmatter·마지막 개행 제외) ⇄ TipTap 문서 JSON */
export interface Converter {
  name: string;
  parse(body: string): PMNode;
  serialize(doc: PMNode): string;
}

/** 문단 수정 시험에 붙이는 글자. 코퍼스에 나오지 않아야 한다. */
export const EDIT_MARKER = 'ⓧ';

export interface CaseResult {
  id: string;
  /** s(p(x)) == x */
  exact: boolean;
  /** s(p(s(p(x)))) == s(p(x)) */
  idempotent: boolean;
  /** 수정을 시험한 최상위 문단 수 (공백이 아닌 글자가 있는 문단만. 빈 문단에 입력하면 그 줄 자체의 표현이 바뀌므로 제외) */
  paragraphs: number;
  /** 수정했을 때 다른 곳까지 바뀐 문단 번호 (최상위 문단 기준 0부터, s(p(x))와 비교) */
  nonLocal: number[];
  /** 공백·NBSP만 들어 있는 최상위 문단 수. 빈 줄이 에디터 안에서 보이지 않는 글자로 남는지 본다 */
  whitespaceOnly: number;
  /** x와 s(p(x))의 차이 */
  diff: DiffResult;
  error?: string;
}

const paragraphsOf = (doc: PMNode) => (doc.content ?? []).filter((n) => n.type === 'paragraph');
const textOf = (n: PMNode) => (n.content ?? []).map((c) => c.text ?? '').join('');

function appendMarker(doc: PMNode, k: number): PMNode {
  const copy = structuredClone(doc);
  const content = paragraphsOf(copy)[k]!.content!;
  const last = content.at(-1);
  if (last?.type === 'text') last.text += EDIT_MARKER;
  else content.push({ type: 'text', text: EDIT_MARKER });
  return copy;
}

export function checkCase(converter: Converter, id: string, raw: string): CaseResult {
  const { envelope, body } = split(raw);
  try {
    const doc = converter.parse(body);
    const once = converter.serialize(doc);
    const saved = join(envelope, once);
    const idempotent = converter.serialize(converter.parse(once)) === once;
    const all = paragraphsOf(doc);
    const whitespaceOnly = all.filter((p) => (p.content ?? []).length > 0 && textOf(p).trim() === '').length;
    const nonLocal: number[] = [];
    let paragraphs = 0;
    for (let k = 0; k < all.length; k++) {
      if (textOf(all[k]!).trim() === '') continue;
      paragraphs++;
      const edited = join(envelope, converter.serialize(appendMarker(doc, k)));
      const markers = edited.split(EDIT_MARKER).length - 1;
      if (markers !== 1 || edited.replace(EDIT_MARKER, '') !== saved) nonLocal.push(k);
    }
    return { id, exact: saved === raw, idempotent, paragraphs, nonLocal, whitespaceOnly, diff: classifyDiff(raw, saved) };
  } catch (e) {
    return {
      id,
      exact: false,
      idempotent: false,
      paragraphs: 0,
      nonLocal: [],
      whitespaceOnly: 0,
      diff: { kinds: [], hunks: [] },
      error: e instanceof Error ? e.message : String(e),
    };
  }
}
