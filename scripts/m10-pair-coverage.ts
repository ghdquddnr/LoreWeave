// M10 계획의 오프라인 계산 (M10-PLAN.md 3절). API를 부르지 않는다. 저장된 ai.db는 읽기 전용으로만 연다 (복사본에서 돌린다).
//   pnpm tsx scripts/m10-pair-coverage.ts <프로젝트 폴더> <정답표 폴더> [--json <출력 파일>]
//   - 프로젝트 폴더: .loreweave/ai.db에 분석과 검사 기록이 있는 폴더 (M9 작업 폴더 snapshot의 복사본)
//   - 정답표 폴더: ground-truth.json과 chapters/가 있는 폴더 (M4는 spikes/m0a-ai-feasibility/benchmark, 실제 원고는 M8 복사본)
// 오류마다 "검사할 화에서 뽑힌 사실"과 "제품이 넘긴 앞 화 사실 중 지정 근거"가 같은 대상·같은 속성 이름·다른 값의 짝을 이루는지 센다.
// 짝이 있으면 코드가 그 짝을 미리 찾아 판단 단계에 따로 보여 줄 수 있다 (M10 후보). 화마다 그런 짝이 몇 개 생기는지(부담)도 센다.
// 출력은 오류 ID·화 번호·수만 담는다 (원문·인물명·속성 이름·값·인용 없음). 실제 원고 경로는 출력에 남기지 않는다.

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { candidateFacts, sameEntity, type PriorAnalysis, type PriorFact } from '../src/core/ai/detection.ts';
import { chapterNumber } from '../src/core/project/chapters.ts';
import { loadChapters, loadGroundTruth } from '../spikes/m0a-ai-feasibility/src/benchmark.ts';
import { locate, normalize, type Span } from '../spikes/m0a-ai-feasibility/src/evaluate.ts';
import { predicateKey } from './lib/predicate-addition.ts';
import { loadProject } from './m9-predicate-retrieval.ts';

type Fact = { entity: string; predicate: string; value: string; quote: string };
const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;
/** 같은 대상(느슨한 이름 맞추기), 같은 속성 이름(괄호·공백 제외), 다른 값 */
const conflictPair = (t: Fact, s: Fact) =>
  sameEntity(t.entity, s.entity) && predicateKey(t.predicate) === predicateKey(s.predicate) && normalize(t.value) !== normalize(s.value);

export interface ErrorCoverage {
  id: string;
  split: string;
  targetChapter: number;
  /** 지정 근거 문장이 제품이 넘긴 앞 화 사실에 있다 (평가기 retrieval과 같은 정의) */
  retrieved: boolean;
  /** 검사할 화의 지정 문장이 이 화 분석의 사실로 뽑혔다 */
  targetFactExtracted: boolean;
  /** 그 사실과 지정 근거 사실이 같은 대상·같은 속성 이름·다른 값 */
  pairSameAttribute: boolean;
  /** 같은 대상이기만 하다 (속성 이름은 다를 수 있음) */
  pairSameEntity: boolean;
}

export interface ChapterBurden {
  chapter: number;
  priorFacts: number;
  targetFacts: number;
  /** 이 화 사실 × 넘긴 앞 화 사실 중 conflictPair인 짝 수 */
  pairs: number;
  /** 짝에 들어간 서로 다른 앞 화 사실 수 */
  pairedPriorFacts: number;
}

export function coverage(root: string, gtDir: string) {
  const { analyses, checked } = loadProject(root);
  const files = [...analyses.keys()].filter((f) => chapterNumber(f) !== null).sort((a, b) => chapterNumber(a)! - chapterNumber(b)!);
  const gt = loadGroundTruth(gtDir);
  const texts = loadChapters(gtDir);
  const spans = (ch: number, quotes: string[]) => quotes.map((q) => locate(texts.get(ch) ?? '', q)).filter((s): s is Span => s !== null);
  const spanOf = (ch: number, quote: string) => locate(texts.get(ch) ?? '', quote);

  const contextOf = new Map<number, { target: Fact[]; context: PriorFact[] }>();
  const burden: ChapterBurden[] = [];
  for (const file of checked) {
    const n = chapterNumber(file)!;
    const target = analyses.get(file)!;
    const priors: PriorAnalysis[] = files.filter((f) => chapterNumber(f)! < n).map((f) => ({ chapter: chapterNumber(f)!, ...analyses.get(f)! }));
    const context = candidateFacts(target.entities, priors);
    contextOf.set(n, { target: target.facts, context });
    let pairs = 0;
    const paired = new Set<number>();
    context.forEach((s, i) => {
      for (const t of target.facts) {
        if (conflictPair(t, s)) {
          pairs++;
          paired.add(i);
        }
      }
    });
    burden.push({ chapter: n, priorFacts: context.length, targetFacts: target.facts.length, pairs, pairedPriorFacts: paired.size });
  }

  const errors: ErrorCoverage[] = [];
  for (const e of gt.errors) {
    const c = contextOf.get(e.target.chapter);
    if (!c) continue;
    const targetSpans = spans(e.target.chapter, e.target.quotes);
    const targetFacts = c.target.filter((f) => {
      const s = spanOf(e.target.chapter, f.quote);
      return s !== null && targetSpans.some((t) => overlaps(s, t));
    });
    const sourceFacts = c.context.filter((f) =>
      e.sources.some((src) => src.chapter === f.chapter && spans(src.chapter, src.quotes).some((t) => {
        const s = spanOf(f.chapter, f.quote);
        return s !== null && overlaps(s, t);
      })),
    );
    errors.push({
      id: e.id,
      split: e.split,
      targetChapter: e.target.chapter,
      retrieved: sourceFacts.length > 0,
      targetFactExtracted: targetFacts.length > 0,
      pairSameAttribute: targetFacts.some((t) => sourceFacts.some((s) => conflictPair(t, s))),
      pairSameEntity: targetFacts.some((t) => sourceFacts.some((s) => sameEntity(t.entity, s.entity))),
    });
  }
  errors.sort((a, b) => a.id.localeCompare(b.id));
  burden.sort((a, b) => a.chapter - b.chapter);
  const sum = (k: keyof ChapterBurden) => burden.reduce((s, b) => s + b[k], 0);
  return {
    chapters: burden.length,
    totals: { priorFacts: sum('priorFacts'), pairs: sum('pairs'), pairedPriorFacts: sum('pairedPriorFacts') },
    errors,
    burden,
  };
}

if (require.main === module) {
  const [root, gtDir] = process.argv.slice(2);
  const i = process.argv.indexOf('--json');
  if (!root || !gtDir) {
    console.error('사용: pnpm tsx scripts/m10-pair-coverage.ts <프로젝트 폴더> <정답표 폴더> [--json <출력 파일>]');
    process.exit(1);
  }
  const r = coverage(resolve(root), resolve(gtDir));
  const ids = (f: (e: ErrorCoverage) => boolean) => r.errors.filter(f).map((e) => e.id).join(',') || '없음';
  console.log(`검사한 화 ${r.chapters}개, 넘긴 앞 화 사실 ${r.totals.priorFacts}개, 같은 속성 짝 ${r.totals.pairs}개 (앞 화 사실 ${r.totals.pairedPriorFacts}개)`);
  console.log(`retrieval: ${ids((e) => e.retrieved)}`);
  console.log(`검사할 화 지정 문장이 사실로 뽑힘: ${ids((e) => e.targetFactExtracted)}`);
  console.log(`같은 대상·같은 속성 이름·다른 값 짝: ${ids((e) => e.pairSameAttribute)}`);
  console.log(`같은 대상 짝 (속성 이름 무관): ${ids((e) => e.pairSameEntity)}`);
  if (i !== -1 && process.argv[i + 1]) writeFileSync(process.argv[i + 1]!, JSON.stringify(r, null, 1) + '\n');
}
