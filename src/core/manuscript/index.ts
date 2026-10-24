// 원고 파일 열기·저장. 에디터 밖에서 바이트를 지키고(envelope), 저장 전에 다시 읽어 검사한다 (ADR 0002 결정 4·5).

import { parseC3, serializeC3 } from './c3.ts';
import { firstDifference, type Doc } from './doc.ts';
import { joinEnvelope, splitEnvelope, type Envelope } from './envelope.ts';

export type { Block, Doc, Inline, Mark, MarkType, TextNode } from './doc.ts';
export type { Envelope, LineEnding } from './envelope.ts';

export interface Manuscript {
  envelope: Envelope;
  doc: Doc;
}

export type SaveResult =
  | {
      ok: true;
      text: string;
      /**
       * 저장은 했지만 다시 열면 모양이 달라지는 첫 최상위 블록 (0부터). 없으면 null.
       * 예: 입력한 `*` 두 개 사이가 기울임이 됨. 글자는 파일에 그대로 있다 (DECISIONS "M1 `*` 입력")
       */
      changesOnReopen: number | null;
    }
  /** 에디터의 글자 일부가 파일에 들어가지 않는다. 저장하지 않는다 */
  | { ok: false; reason: 'text-loss' };

export function openManuscript(raw: string): Manuscript {
  const { envelope, body } = splitEnvelope(raw);
  return { envelope, doc: parseC3(body) };
}

/** 문서 안의 모든 글자. 변환기가 모르는 노드 안의 글자도 센다 */
function allText(node: { text?: string; content?: unknown[] }): string {
  return (node.text ?? '') + (node.content ?? []).map((n) => allText(n as typeof node)).join('');
}

/** needle의 글자가 haystack에 순서대로 모두 있는가 (UTF-16 단위로 비교) */
function isSubsequence(needle: string, haystack: string): boolean {
  let i = 0;
  for (let j = 0; j < haystack.length && i < needle.length; j++) if (haystack[j] === needle[i]) i++;
  return i === needle.length;
}

/**
 * 저장할 파일 내용을 만든다.
 * - 에디터의 글자가 직렬화 결과에 순서대로 다 들어 있지 않으면 저장하지 않는다 (글자 손실)
 * - 다시 파싱한 문서가 에디터 문서와 다르면 저장하되 그 위치를 알려 준다
 */
export function serializeManuscript({ envelope, doc }: Manuscript): SaveResult {
  const body = serializeC3(doc);
  const typed = allText(doc);
  if (!isSubsequence(typed, body)) return { ok: false, reason: 'text-loss' };
  const block = firstDifference(doc, parseC3(body));
  return { ok: true, text: joinEnvelope(envelope, body), changesOnReopen: block === -1 ? null : block };
}
