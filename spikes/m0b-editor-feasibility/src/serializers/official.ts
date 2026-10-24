// (a) TipTap 공식 Markdown 확장. MarkdownManager는 에디터 없이 문서 JSON ⇄ Markdown을 변환한다.

import { MarkdownManager } from '@tiptap/markdown';
import { baseExtensions } from '../editor/extensions.ts';
import type { Converter, PMNode } from '../roundtrip.ts';

export function officialConverter(): Converter {
  const manager = new MarkdownManager({ extensions: baseExtensions() });
  return {
    name: 'official',
    parse: (body) => manager.parse(body) as PMNode,
    serialize: (doc) => manager.serialize(doc),
  };
}
