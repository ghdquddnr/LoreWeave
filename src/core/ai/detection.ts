// 연속성 탐지: 프롬프트, 앞 화 사실 고르기, 입력, 출력 형식 (M4-PLAN 1·2절, ADR 0001 B 전략).
// 시스템 프롬프트는 M0-A에서 검증한 문구를 그대로 옮겼다 (태그 spike-m0a-2026-10-24,
// spikes/m0a-ai-feasibility/src/prompts/detect.ts, sha256 앞 12자리 53207cd406ae). 바꾸면 DETECT_PROMPT_VERSION을 올린다.

import { chapterNumber } from '../project/chapters.ts';
import type { Entity } from './extraction.ts';

/** 검사 결과에 함께 저장해 어떤 프롬프트로 찾았는지 남긴다 */
export const DETECT_PROMPT_VERSION = 'detect-1';

export const CATEGORIES = [
  'first_meeting',
  'age',
  'occupation',
  'name',
  'dead_character',
  'relationship',
  'date_order',
  'number',
  'location',
  'habit',
] as const;
export type Category = (typeof CATEGORIES)[number];

/** 화면에 보이는 종류 이름 */
export const CATEGORY_LABELS: Record<Category, string> = {
  first_meeting: '첫 만남',
  age: '나이',
  occupation: '직업·소속',
  name: '이름',
  dead_character: '사망 인물',
  relationship: '관계',
  date_order: '날짜·순서',
  number: '숫자·금액',
  location: '장소',
  habit: '성격·습관',
};

export const DETECT_SYSTEM = `당신은 장편 웹소설의 연속성 검토자다. 검사 대상 화가 참고 자료(이전 화)에서 확립된 사실과 모순되는 곳을 찾는다.

규칙
1. 참고 자료에 실제로 적힌 내용과 모순될 때만 보고한다. 참고 자료에 없는 상식이나 추측을 근거로 삼지 않는다.
2. 다음은 오류가 아니다.
   - 시간 경과에 따른 자연스러운 변화: 해가 바뀌어 나이가 늘어남, 승진, 이직, 이사, 지분 희석 등 본문에 서술되었거나 계산이 맞는 변화
   - 별명, 호칭, 직함으로 부르는 것
   - 회상 장면: 과거 시점을 다시 서술하는 것
   - 인물의 거짓말이나 착각 (본문이 그렇게 밝히는 경우)
   - 이전 내용과 충돌하지 않는 새 정보
   - 사망 전에 써 둔 편지나 유품
3. target_quote: 검사 대상 화에서 모순되는 부분을 한 글자도 바꾸지 말고 그대로 복사한다. 한 문장 이내.
4. evidence: 모순의 근거가 되는 참고 자료의 문장을 그대로 복사하고 그 화 번호를 적는다. 근거 문장을 인용할 수 없으면 보고하지 않는다.
5. claim: 무엇이 어떻게 모순되는지 한국어로 한두 문장.
6. category: first_meeting, age, occupation, name, dead_character, relationship, date_order, number, location, habit
   (first_meeting 이미 만난 인물의 첫 만남, age 나이, occupation 직업·소속·전공, name 인물·조직 이름, dead_character 사망 인물의 등장·행동, relationship 인물 관계, date_order 날짜·시간 순서, number 숫자·금액·지분, location 장소, habit 성격·습관·체질)
7. confidence: 모순이라고 판단하는 정도, 0~1.
8. 같은 모순은 한 번만 보고한다. 모순이 없으면 빈 배열을 반환한다.`;

/** Structured Outputs 형식 (M0-A와 같음) */
export const DETECT_SCHEMA = {
  name: 'continuity_findings',
  schema: {
    type: 'object',
    properties: {
      findings: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string', enum: [...CATEGORIES] },
            target_quote: { type: 'string' },
            claim: { type: 'string' },
            evidence: {
              type: 'array',
              items: {
                type: 'object',
                properties: { chapter: { type: 'integer' }, quote: { type: 'string' } },
                required: ['chapter', 'quote'],
                additionalProperties: false,
              },
            },
            confidence: { type: 'number' },
          },
          required: ['category', 'target_quote', 'claim', 'evidence', 'confidence'],
          additionalProperties: false,
        },
      },
    },
    required: ['findings'],
    additionalProperties: false,
  },
} as const;

/** 앞 화에서 저장해 둔 사실 하나 (인용은 그 화 본문에 있다고 확인된 것) */
export interface PriorFact {
  chapter: number;
  entity: string;
  predicate: string;
  value: string;
  quote: string;
}

/** 앞 화 하나의 분석 결과 */
export interface PriorAnalysis {
  chapter: number;
  entities: Entity[];
  facts: { entity: string; predicate: string; value: string; quote: string }[];
}

/** 인물·대상의 이름과 별칭 (2글자 이상) */
export function entityNames(entities: Entity[]): string[] {
  const names = entities.flatMap((e) => [e.name, ...e.aliases]).map((s) => s.trim());
  return [...new Set(names.filter((s) => s.length >= 2))];
}

/** 느슨한 이름 맞추기: "민수" ~ "김민수" (M0-A와 같음) */
export const sameEntity = (a: string, b: string) => a.length >= 2 && b.length >= 2 && (a.includes(b) || b.includes(a));

/** 검사할 화에 나오는 인물·대상의 앞 화 사실. 화 순서, 화 안의 순서를 지킨다 */
export function candidateFacts(targetEntities: Entity[], priors: PriorAnalysis[]): PriorFact[] {
  const names = entityNames(targetEntities);
  const out: PriorFact[] = [];
  for (const prior of [...priors].sort((a, b) => a.chapter - b.chapter)) {
    for (const f of prior.facts) {
      const record = prior.entities.find((e) => e.name === f.entity);
      const factNames = [f.entity, ...(record?.aliases ?? [])];
      if (factNames.some((a) => names.some((b) => sameEntity(a, b)))) {
        out.push({ chapter: prior.chapter, entity: f.entity, predicate: f.predicate, value: f.value, quote: f.quote });
      }
    }
  }
  return out;
}

function factBlocks(facts: PriorFact[]): string {
  const byChapter = new Map<number, string[]>();
  for (const f of facts) {
    byChapter.set(f.chapter, [...(byChapter.get(f.chapter) ?? []), `- ${f.entity} | ${f.predicate} | ${f.value} | 원문: "${f.quote}"`]);
  }
  return [...byChapter].map(([n, lines]) => `<facts chapter="${n}">\n${lines.join('\n')}\n</facts>`).join('\n\n');
}

/** 모델에 보낼 입력: 앞 화 사실(참고 자료)과 검사할 화의 보이는 줄. M0-A B 전략과 같은 형식 */
export function detectionInput(file: string, lines: string[], facts: PriorFact[]): string {
  const n = chapterNumber(file) ?? 0;
  return [
    '# 참고 자료 (이전 화)',
    factBlocks(facts).trim() || '(없음)',
    '',
    `# 검사 대상: ${n}화`,
    `<chapter n="${n}">\n${lines.join('\n').trim()}\n</chapter>`,
  ].join('\n');
}

export interface Evidence {
  chapter: number;
  quote: string;
}

export interface Finding {
  category: Category;
  /** 검사한 화에서 모순되는 문장 */
  target_quote: string;
  claim: string;
  /** 앞 화의 근거 문장 */
  evidence: Evidence[];
  /** 0~1, 보조 정보 */
  confidence: number;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isCategory = (v: unknown): v is Category => (CATEGORIES as readonly unknown[]).includes(v);

/** 모델 응답을 확인한다. 형식이 다르면 예외를 던진다 (검사 결과를 저장하지 않는다) */
export function parseDetection(value: unknown): Finding[] {
  const fail = (what: string): never => {
    throw new Error(`검사 결과 형식이 다릅니다: ${what}`);
  };
  if (!isRecord(value) || !Array.isArray(value['findings'])) return fail('findings');
  return (value['findings'] as unknown[]).map((f, i) => {
    if (!isRecord(f)) return fail(`findings[${i}]`);
    const { category, target_quote, claim, evidence, confidence } = f;
    if (!isCategory(category)) return fail(`findings[${i}].category`);
    if (!isString(target_quote) || !isString(claim)) return fail(`findings[${i}]`);
    if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return fail(`findings[${i}].confidence`);
    if (!Array.isArray(evidence)) return fail(`findings[${i}].evidence`);
    return {
      category,
      target_quote,
      claim,
      confidence: Math.min(1, Math.max(0, confidence)),
      evidence: evidence.map((e, j) => {
        if (!isRecord(e) || !Number.isInteger(e['chapter']) || !isString(e['quote'])) return fail(`findings[${i}].evidence[${j}]`);
        return { chapter: e['chapter'] as number, quote: e['quote'] };
      }),
    };
  });
}
