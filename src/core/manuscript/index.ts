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
  | { ok: true; text: string }
  /** 저장하면 다시 열 때 문서가 달라진다. block은 처음 달라지는 최상위 블록 번호 (0부터) */
  | { ok: false; reason: 'changes-on-reopen'; block: number };

export function openManuscript(raw: string): Manuscript {
  const { envelope, body } = splitEnvelope(raw);
  return { envelope, doc: parseC3(body) };
}

/**
 * 저장할 파일 내용을 만든다. 직렬화한 본문을 다시 파싱해 문서 전체를 비교하고,
 * 글자가 사라지거나 구조가 바뀌면(예: 입력한 `*`가 강조로 읽힘) 저장하지 않는다.
 */
export function serializeManuscript({ envelope, doc }: Manuscript): SaveResult {
  const body = serializeC3(doc);
  const block = firstDifference(doc, parseC3(body));
  if (block !== -1) return { ok: false, reason: 'changes-on-reopen', block };
  return { ok: true, text: joinEnvelope(envelope, body) };
}
