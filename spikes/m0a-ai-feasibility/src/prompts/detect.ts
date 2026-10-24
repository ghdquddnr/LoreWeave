import { CATEGORIES } from '../schema.ts';

// Shared by every strategy. Strategies differ only in what goes into the reference section.

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
6. category: ${CATEGORIES.join(', ')}
   (first_meeting 이미 만난 인물의 첫 만남, age 나이, occupation 직업·소속·전공, name 인물·조직 이름, dead_character 사망 인물의 등장·행동, relationship 인물 관계, date_order 날짜·시간 순서, number 숫자·금액·지분, location 장소, habit 성격·습관·체질)
7. confidence: 모순이라고 판단하는 정도, 0~1.
8. 같은 모순은 한 번만 보고한다. 모순이 없으면 빈 배열을 반환한다.`;

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
};

export function detectUser(reference: string, target: number, targetText: string): string {
  return [
    '# 참고 자료 (이전 화)',
    reference.trim() || '(없음)',
    '',
    `# 검사 대상: ${target}화`,
    `<chapter n="${target}">\n${targetText.trim()}\n</chapter>`,
  ].join('\n');
}
