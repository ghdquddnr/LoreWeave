// 변환기 × 빈 줄 규약 조합 (M0-PLAN §1 핵심 쟁점).
// (a)(b)는 CommonMark 변환기라 C1이 기본이고, C2·C3는 변환기 앞뒤에 붙이는 변환으로 만든다.
// (c)는 C3 전용이다. C1·C2를 직접 구현하면 CommonMark 파서를 다시 만드는 셈이라 (a)(b)가 그 역할을 맡는다.

import { Editor } from '@tiptap/core';
import { baseExtensions } from '../editor/extensions.ts';
import type { Converter, PMNode } from '../roundtrip.ts';
import { communityConverter } from './community.ts';
import { customConverter } from './custom.ts';
import { officialConverter } from './official.ts';

export type Convention = 'C1' | 'C2' | 'C3';

export interface Combo {
  id: string;
  label: string;
  convention: Convention;
  create(): Converter;
}

const EMPTY_TOKEN = '&nbsp;';
const isBlankBlock = (block: string) => block.trim() === '';

/** C2: 빈 문단을 `&nbsp;` 한 줄로 쓴다. 읽을 때는 변환기가 `&nbsp;` 문단을 그대로 해석한다. */
function withEmptyToken(inner: Converter): Converter {
  return {
    name: `${inner.name}+C2`,
    parse: inner.parse,
    serialize: (doc) =>
      inner
        .serialize(doc)
        .split('\n\n')
        .map((b) => (isBlankBlock(b) ? EMPTY_TOKEN : b))
        .join('\n\n'),
  };
}

/** C3: 줄마다 문단으로 읽게 빈 줄을 끼워 넣고, 쓸 때 다시 뺀다. 빈 줄은 `&nbsp;` 문단으로 보낸다. */
function withLineParagraphs(inner: Converter): Converter {
  return {
    name: `${inner.name}+C3`,
    parse: (body) => inner.parse(body.split('\n').map((l) => (l === '' ? EMPTY_TOKEN : l)).join('\n\n')),
    serialize: (doc) =>
      inner
        .serialize(doc)
        .split('\n\n')
        .map((b) => (isBlankBlock(b) || b === EMPTY_TOKEN ? '' : b))
        .join('\n'),
  };
}

/**
 * 변환 결과를 실제 TipTap 에디터에 넣었다가 꺼낸다 (제품의 열기 → 편집 → 저장 경로).
 * 스키마에 없는 노드·속성은 여기서 사라지고, 빈 문서에는 에디터가 빈 문단을 채운다.
 * Node에서는 DOM이 필요하다 (src/dom.ts).
 */
export function throughEditor(inner: Converter): Converter {
  const editor = new Editor({ extensions: baseExtensions(), enableInputRules: false, enablePasteRules: false });
  const load = (doc: PMNode): PMNode => {
    editor.commands.setContent(doc, { emitUpdate: false });
    return editor.getJSON() as PMNode;
  };
  return {
    name: inner.name,
    parse: (body) => load(inner.parse(body)),
    serialize: (doc) => inner.serialize(load(doc)),
  };
}

export const COMBOS: Combo[] = [
  { id: 'official-c1', label: '(a) 공식 · C1', convention: 'C1', create: officialConverter },
  { id: 'official-c2', label: '(a) 공식 · C2', convention: 'C2', create: () => withEmptyToken(officialConverter()) },
  { id: 'official-c3', label: '(a) 공식 · C3', convention: 'C3', create: () => withLineParagraphs(officialConverter()) },
  { id: 'community-c1', label: '(b) 커뮤니티 · C1', convention: 'C1', create: communityConverter },
  { id: 'community-c2', label: '(b) 커뮤니티 · C2', convention: 'C2', create: () => withEmptyToken(communityConverter()) },
  { id: 'community-c3', label: '(b) 커뮤니티 · C3', convention: 'C3', create: () => withLineParagraphs(communityConverter()) },
  { id: 'custom-c3', label: '(c) 직접 작성 · C3', convention: 'C3', create: customConverter },
];
