// 화별 추출: 프롬프트, 출력 형식, 검증 (M3-PLAN 2절, ADR 0001 B 전략).
// 시스템 프롬프트는 M0-A에서 검증한 문구를 그대로 옮겼다 (태그 spike-m0a-2026-10-24,
// spikes/m0a-ai-feasibility/src/prompts/extract.ts, sha256 앞 12자리 fa2971c6f7e8). 바꾸면 PROMPT_VERSION을 올린다.

import { chapterNumber } from '../project/chapters.ts';

/** 분석 결과에 함께 저장해 어떤 프롬프트로 뽑았는지 남긴다 */
export const PROMPT_VERSION = 'extract-1';

export const EXTRACT_SYSTEM = `당신은 장편 웹소설의 설정 기록자다. 주어진 한 화에서 나중에 다른 화와 비교해야 할 정보를 뽑는다.

- summary: 이 화의 사건을 3~5문장으로 요약한다. 날짜가 나오면 포함한다.
- entities: 이 화에 등장하거나 언급되는 인물, 조직, 장소. name은 가장 완전한 이름, aliases는 본문에 쓰인 다른 표기·호칭·약칭.
- facts: 나중에 모순이 생길 수 있는 사실. 예: 나이, 직업·소속·전공, 이름, 인물 관계, 생사, 날짜·시간·기간, 숫자·금액·지분, 장소·출신지, 성격·습관·체질·신체 특징, 누가 누구를 처음 만났는지.
  - entity: 사실의 주어 (entities의 name 중 하나)
  - predicate: 짧은 속성 이름 (예: 나이, 직업, 고향, 처음 만난 때)
  - value: 값
  - quote: 그 사실이 드러난 본문 문장을 한 글자도 바꾸지 말고 그대로 복사한다.
- 본문에 없는 것은 추측하지 않는다. 회상 장면은 회상이라고 value에 적는다.`;

/** Structured Outputs 형식 (M0-A와 같음) */
export const EXTRACT_SCHEMA = {
  name: 'chapter_extraction',
  schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      entities: {
        type: 'array',
        items: {
          type: 'object',
          properties: { name: { type: 'string' }, aliases: { type: 'array', items: { type: 'string' } } },
          required: ['name', 'aliases'],
          additionalProperties: false,
        },
      },
      facts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            entity: { type: 'string' },
            predicate: { type: 'string' },
            value: { type: 'string' },
            quote: { type: 'string' },
          },
          required: ['entity', 'predicate', 'value', 'quote'],
          additionalProperties: false,
        },
      },
    },
    required: ['summary', 'entities', 'facts'],
    additionalProperties: false,
  },
} as const;

export interface Entity {
  name: string;
  aliases: string[];
}

export interface Fact {
  entity: string;
  predicate: string;
  value: string;
  quote: string;
}

export interface Extraction {
  summary: string;
  entities: Entity[];
  facts: Fact[];
}

/** 모델에 보낼 본문. 화면에 보이는 줄(frontmatter·표시 기호 제외)을 M0-A와 같은 형식으로 감싼다 */
export function extractionInput(file: string, lines: string[]): string {
  return `<chapter n="${chapterNumber(file) ?? 0}">\n${lines.join('\n').trim()}\n</chapter>`;
}

const isString = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * 모델 응답을 확인한다. Structured Outputs가 형식을 보장하지만, 저장 전에 한 번 더 본다.
 * 형식이 다르면 예외를 던진다 (그 화는 저장하지 않는다).
 */
export function parseExtraction(value: unknown): Extraction {
  const fail = (what: string): never => {
    throw new Error(`추출 결과 형식이 다릅니다: ${what}`);
  };
  if (!isRecord(value)) return fail('객체가 아님');
  const { summary, entities, facts } = value;
  if (!isString(summary)) fail('summary');
  if (!Array.isArray(entities)) fail('entities');
  if (!Array.isArray(facts)) fail('facts');
  return {
    summary: summary as string,
    entities: (entities as unknown[]).map((e, i) => {
      if (!isRecord(e) || !isString(e['name']) || !Array.isArray(e['aliases']) || !e['aliases'].every(isString)) {
        return fail(`entities[${i}]`);
      }
      return { name: e['name'], aliases: e['aliases'] as string[] };
    }),
    facts: (facts as unknown[]).map((f, i) => {
      if (!isRecord(f) || !['entity', 'predicate', 'value', 'quote'].every((k) => isString(f[k]))) return fail(`facts[${i}]`);
      return { entity: f['entity'] as string, predicate: f['predicate'] as string, value: f['value'] as string, quote: f['quote'] as string };
    }),
  };
}
