// 원고 복사본에 오류 심기 (M7-PLAN 2절). 순수 함수만 둔다 (파일은 scripts/seed-errors.ts).
// 심을 목록과 정답표에는 원문 인용이 들어가므로 저장소 밖에 둔다.

import { CATEGORIES, type Category } from '../../src/core/ai/detection.ts';

export interface Seed {
  id: string;
  /** 오류를 심을 화 번호 */
  chapter: number;
  /** 그 화에서 바꿀 글 (정확히 한 번 있어야 한다) */
  find: string;
  replace: string;
  /** 채점기가 찾을 이 화 문장. 없으면 replace */
  targetQuote?: string;
  category: Category;
  /** 앞에서 정해진 설정 (근거) */
  sources: { chapter: number; quote: string }[];
  description: string;
}

const squash = (s: string) => s.normalize('NFC').replace(/\s+/g, ' ');

/** find가 정확히 한 번 있을 때만 바꾼다 */
export function applySeed(text: string, seed: Pick<Seed, 'id' | 'find' | 'replace'>): string {
  const count = text.split(seed.find).length - 1;
  if (count !== 1) throw new Error(`${seed.id}: 바꿀 글이 ${count}번 있습니다 (정확히 한 번이어야 함)`);
  if (seed.find === seed.replace) throw new Error(`${seed.id}: 바꿀 글과 바뀐 글이 같습니다`);
  return text.replace(seed.find, seed.replace);
}

/** 심을 목록이 맞는지: 종류, 근거가 앞 화에 있는지, 같은 화에 둘 이상 심지 않았는지 */
export function validateSeeds(seeds: Seed[], chapterText: (n: number) => string): void {
  const ids = new Set<string>();
  for (const s of seeds) {
    if (ids.has(s.id)) throw new Error(`id가 겹칩니다: ${s.id}`);
    ids.add(s.id);
    if (!(CATEGORIES as readonly string[]).includes(s.category)) throw new Error(`${s.id}: 모르는 종류 ${s.category}`);
    if (!s.sources.length) throw new Error(`${s.id}: 근거가 없습니다`);
    for (const src of s.sources) {
      if (src.chapter >= s.chapter) throw new Error(`${s.id}: 근거 화(${src.chapter})가 심을 화(${s.chapter})보다 앞이어야 합니다`);
      if (!squash(chapterText(src.chapter)).includes(squash(src.quote))) throw new Error(`${s.id}: 근거 문장이 ${src.chapter}화에 없습니다`);
    }
    const target = s.targetQuote ?? s.replace;
    if (!squash(s.replace).includes(squash(target)) && !squash(target).includes(squash(s.replace))) {
      throw new Error(`${s.id}: targetQuote가 바뀐 글을 포함하거나 그 안에 있어야 합니다`);
    }
  }
}

/** M0-A 채점기 형식의 정답표 (심은 오류는 모두 test, 함정은 없음) */
export function groundTruth(seeds: Seed[]) {
  return {
    version: 1,
    notes: 'M7: 실제 장편 복사본에 직접 심은 오류. 저장소에 넣지 않는다.',
    errors: seeds.map((s) => ({
      id: s.id,
      category: s.category,
      split: 'test' as const,
      explicitness: 'L1' as const,
      distance: s.chapter - Math.max(...s.sources.map((x) => x.chapter)),
      target: { chapter: s.chapter, quotes: [s.targetQuote ?? s.replace] },
      sources: s.sources.map((x) => ({ chapter: x.chapter, quotes: [x.quote] })),
      description: s.description,
    })),
    traps: [],
  };
}
