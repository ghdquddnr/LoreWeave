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

/**
 * 이보다 긴 화(보이는 본문 글자 수)는 나눠 추출한다 (M8-PLAN 3절).
 * 한 화를 통째로 보내면 화 길이와 상관없이 비슷한 수의 사실만 뽑혔다
 * (합성 원고 약 1,200자 화에서 1,000자당 약 10개, 실제 원고 약 5,000자 화에서 약 3개).
 * 시범에서 약 1,500자 조각으로 나누자 화당 사실이 약 2배가 되고, 빠졌던 근거 10개 중 5개가 사실로 잡혔다.
 * 합성 원고(M0-A) 화는 모두 이보다 짧아 나뉘지 않는다.
 */
export const EXTRACT_CHUNK_CHARS = 1500;

/**
 * 보이는 줄을 추출 조각으로 나눈다. 조각이 maxChars를 넘으면 다음 빈 줄에서 끊고,
 * 빈 줄 없이 두 배를 넘으면 줄 끝에서 끊는다. 짧은 화는 한 조각이다.
 */
export function splitForExtraction(lines: string[], maxChars = EXTRACT_CHUNK_CHARS): string[][] {
  if (lines.join('\n').length <= maxChars) return [lines];
  const chunks: string[][] = [];
  let current: string[] = [];
  let size = 0;
  for (const line of lines) {
    current.push(line);
    size += line.length + 1;
    if ((size >= maxChars && !line.trim()) || size >= maxChars * 2) {
      chunks.push(current);
      current = [];
      size = 0;
    }
  }
  if (current.some((l) => l.trim())) chunks.push(current);
  else if (current.length && chunks.length) chunks[chunks.length - 1]!.push(...current);
  return chunks.filter((c) => c.some((l) => l.trim()));
}

/** 조각별 추출을 합친다: 인물·대상은 이름으로 합치고 별칭을 모으며, 같은 사실은 하나만 남긴다 */
export function mergeExtractions(parts: Extraction[]): Extraction {
  const entities = new Map<string, Set<string>>();
  for (const e of parts.flatMap((p) => p.entities)) {
    const aliases = entities.get(e.name) ?? new Set<string>();
    for (const a of e.aliases) if (a !== e.name) aliases.add(a);
    entities.set(e.name, aliases);
  }
  const seen = new Set<string>();
  const facts: Fact[] = [];
  for (const f of parts.flatMap((p) => p.facts)) {
    const key = [f.entity, f.predicate, f.value, f.quote].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push(f);
  }
  return {
    summary: parts
      .map((p) => p.summary.trim())
      .filter(Boolean)
      .join(' '),
    entities: [...entities].map(([name, aliases]) => ({ name, aliases: [...aliases] })),
    facts,
  };
}
