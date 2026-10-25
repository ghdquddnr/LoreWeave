// M9 후보 판단 프롬프트 detect-2 (M9-PLAN 2절). 측정 스크립트에서만 쓴다. 제품 기본값은 detect-1(DETECT_SYSTEM) 그대로다.
// detect-1과 다른 곳은 규칙 2뿐이다: "자연스러운 변화"를 한 줄로 허용하던 것을 변화 판단 절차(가·나·다)로 바꾸고,
// 나머지 제외(별명·호칭, 회상, 거짓말·착각, 새 정보, 유품)는 규칙 3으로 옮겨 그대로 둔다. 출력 형식(DETECT_SCHEMA)은 바꾸지 않는다.

import { DETECT_SYSTEM } from '../../src/core/ai/detection.ts';

export const DETECT2_VERSION = 'detect-2-candidate';

const RULE2_DETECT1 = `2. 다음은 오류가 아니다.
   - 시간 경과에 따른 자연스러운 변화: 해가 바뀌어 나이가 늘어남, 승진, 이직, 이사, 지분 희석 등 본문에 서술되었거나 계산이 맞는 변화
   - 별명, 호칭, 직함으로 부르는 것
   - 회상 장면: 과거 시점을 다시 서술하는 것
   - 인물의 거짓말이나 착각 (본문이 그렇게 밝히는 경우)
   - 이전 내용과 충돌하지 않는 새 정보
   - 사망 전에 써 둔 편지나 유품
3. target_quote:`;

const RULE2_DETECT2 = `2. 값이 달라 보이면 보고하기 전에 다음 순서로 판단한다.
   가. 검사 대상 화 전체와 참고 자료에서 그 차이를 설명하는 서술을 찾는다: 시간 경과(해가 바뀜, 날짜가 지남), 성장·승급·승진·이직·이사, 일부러 숨김·거짓말·착각·변장, 가상현실·꿈·회상처럼 다른 시점이나 장면. 본문이 그렇게 밝히면 보고하지 않는다. 본문에 없는 설명을 짐작해 만들지 않는다.
   나. 같은 대상의 같은 속성(이름·코드네임, 직책·소속, 학년·나이, 등급·단계, 수량)의 값이 다르고 가의 설명이 본문에 없으면, 시간이 흘렀거나 바뀌었으리라고 짐작하지 말고 보고한다.
   다. 참고 자료의 비율·단위·기간으로 계산해야 하는 값은 계산해서 비교하고, 맞지 않으면 보고한다.
3. 다음은 오류가 아니다.
   - 별명, 호칭, 직함으로 부르는 것
   - 회상 장면: 과거 시점을 다시 서술하는 것
   - 인물의 거짓말이나 착각 (본문이 그렇게 밝히는 경우)
   - 이전 내용과 충돌하지 않는 새 정보
   - 사망 전에 써 둔 편지나 유품
4. target_quote:`;

/** detect-1의 규칙 2를 바꾸고 뒤 규칙 번호를 하나씩 민다. detect-1 문구가 바뀌었으면 만들지 않는다 */
export function buildDetect2(detect1: string = DETECT_SYSTEM): string {
  if (detect1.split(RULE2_DETECT1).length !== 2) throw new Error('detect-1 문구가 예상과 달라 detect-2를 만들 수 없습니다');
  const [head, tail] = detect1.split(RULE2_DETECT1) as [string, string];
  const renumbered = tail.replace(/^(\d+)\. /gm, (_m, n: string) => `${Number(n) + 1}. `);
  return head + RULE2_DETECT2 + renumbered;
}

export const DETECT2_SYSTEM = buildDetect2();
