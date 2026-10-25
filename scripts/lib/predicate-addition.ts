// M9 후속 가설 (M9-FOLLOWUP.md): 이름으로 고른 앞 화 사실(candidateFacts)에, 이 화 사실과 속성 이름이 같은 앞 화 사실을 더한다.
// 오프라인 retrieval 계산에만 쓴다. 제품의 사실 고르기는 바꾸지 않는다.
//   - 지금 고른 사실은 하나도 빼지 않는다 (M5에서 실패한 줄이기와 다르다)
//   - 속성 이름은 attributeKey와 같이 괄호 안 내용과 공백을 빼고 비교한다. 같은 사실(화·인물·속성·값·인용)은 한 번만 넣는다
//   - 화 순서를 지킨다 (같은 화 안에서는 이름으로 고른 사실이 먼저, 더한 사실이 뒤)

import { candidateFacts, type PriorAnalysis, type PriorFact } from '../../src/core/ai/detection.ts';
import type { Entity } from '../../src/core/ai/extraction.ts';

export const predicateKey = (p: string) => p.normalize('NFC').replace(/\([^)]*\)/g, '').replace(/\s+/g, '');
const factKey = (f: PriorFact) => JSON.stringify([f.chapter, f.entity, f.predicate, f.value, f.quote]);

export function withPredicateMatches(
  target: { entities: Entity[]; facts: { predicate: string }[] },
  priors: PriorAnalysis[],
): { facts: PriorFact[]; base: number; added: number } {
  const base = candidateFacts(target.entities, priors);
  const want = new Set(target.facts.map((f) => predicateKey(f.predicate)));
  const seen = new Set(base.map(factKey));
  const added: PriorFact[] = [];
  for (const prior of [...priors].sort((a, b) => a.chapter - b.chapter)) {
    for (const f of prior.facts) {
      const fact = { chapter: prior.chapter, entity: f.entity, predicate: f.predicate, value: f.value, quote: f.quote };
      if (want.has(predicateKey(f.predicate)) && !seen.has(factKey(fact))) {
        seen.add(factKey(fact));
        added.push(fact);
      }
    }
  }
  // 안정 정렬: 같은 화에서는 base가 앞에 남는다
  const facts = [...base, ...added].sort((a, b) => a.chapter - b.chapter);
  return { facts, base: base.length, added: added.length };
}
