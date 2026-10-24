// Per-chapter extraction shared by strategies B, C and D: summary + entities + facts.
// Facts keep the verbatim quote so the judge always sees original text (INTENT §5).

export const EXTRACT_SYSTEM = `당신은 장편 웹소설의 설정 기록자다. 주어진 한 화에서 나중에 다른 화와 비교해야 할 정보를 뽑는다.

- summary: 이 화의 사건을 3~5문장으로 요약한다. 날짜가 나오면 포함한다.
- entities: 이 화에 등장하거나 언급되는 인물, 조직, 장소. name은 가장 완전한 이름, aliases는 본문에 쓰인 다른 표기·호칭·약칭.
- facts: 나중에 모순이 생길 수 있는 사실. 예: 나이, 직업·소속·전공, 이름, 인물 관계, 생사, 날짜·시간·기간, 숫자·금액·지분, 장소·출신지, 성격·습관·체질·신체 특징, 누가 누구를 처음 만났는지.
  - entity: 사실의 주어 (entities의 name 중 하나)
  - predicate: 짧은 속성 이름 (예: 나이, 직업, 고향, 처음 만난 때)
  - value: 값
  - quote: 그 사실이 드러난 본문 문장을 한 글자도 바꾸지 말고 그대로 복사한다.
- 본문에 없는 것은 추측하지 않는다. 회상 장면은 회상이라고 value에 적는다.`;

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
};

export interface Extraction {
  summary: string;
  entities: { name: string; aliases: string[] }[];
  facts: { entity: string; predicate: string; value: string; quote: string }[];
}
