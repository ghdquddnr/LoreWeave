// 세 변환기와 데모 에디터가 함께 쓰는 TipTap 스키마.
// 지원 서브셋(M0-PLAN §2): 문단, 강제 줄바꿈, 굵게/기울임, 구분선, 인용 + 제목(M0-A 챕터가 `# 1화.`로 시작).
// 입력 규칙은 에디터 옵션(enableInputRules: false)에서 끈다.

import { getSchema, type AnyExtension } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

export function baseExtensions(): AnyExtension[] {
  return [
    StarterKit.configure({
      bulletList: false,
      orderedList: false,
      listItem: false,
      listKeymap: false,
      code: false,
      codeBlock: false,
      strike: false,
      underline: false,
      link: false,
      // 마지막 블록이 문단이 아니면 빈 문단을 붙이는 플러그인. 원고를 바꾸므로 끈다.
      trailingNode: false,
    }),
  ];
}

export const schema = getSchema(baseExtensions());
