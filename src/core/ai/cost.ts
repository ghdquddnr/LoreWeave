// 비용 계산 (M3-PLAN 4절).

import { modelInfo } from './models.ts';

/** OpenAI 응답의 사용량 */
export interface Usage {
  /** 전체 입력 토큰. 캐시에서 읽은 토큰과 캐시에 쓴 토큰을 포함한다 */
  inputTokens: number;
  cachedTokens: number;
  cacheWriteTokens: number;
  /** 추론 토큰을 포함한다 */
  outputTokens: number;
}

/**
 * 호출 한 번의 비용 (USD).
 * 캐시 토큰은 inputTokens에 이미 들어 있으므로 일반 입력에서 빼고 따로 매긴다.
 * (M0-A에서 캐시 쓰기 토큰을 두 번 더해 비용을 크게 잡은 실수가 있었다)
 */
export function costUsd(model: string, usage: Usage): number {
  const p = modelInfo(model).price;
  const plain = Math.max(0, usage.inputTokens - usage.cachedTokens - usage.cacheWriteTokens);
  return (
    (plain * p.input + usage.cachedTokens * p.cachedInput + usage.cacheWriteTokens * p.cacheWrite + usage.outputTokens * p.output) /
    1e6
  );
}

// 예상 비용은 상한이다. M0-A 추출 호출 45회(화당 약 1,150자)의 최댓값을 넘도록 잡았다:
//   입력 최대 1,255토큰 ≤ 600 + 1.0×글자 수, 출력 최대 2,269토큰 ≤ 400 + 2.0×글자 수
const PROMPT_TOKENS = 600;
const INPUT_PER_CHAR = 1.0;
const OUTPUT_BASE = 400;
const OUTPUT_PER_CHAR = 2.0;

export function estimateExtractionTokens(chars: number): { input: number; output: number } {
  return {
    input: Math.ceil(PROMPT_TOKENS + INPUT_PER_CHAR * chars),
    output: Math.ceil(OUTPUT_BASE + OUTPUT_PER_CHAR * chars),
  };
}

/** 본문 글자 수로 계산한 추출 비용 상한 (USD). 캐시 할인은 계산하지 않는다 */
export function estimateExtractionCost(model: string, chars: number): number {
  const { input, output } = estimateExtractionTokens(chars);
  return costUsd(model, { inputTokens: input, cachedTokens: 0, cacheWriteTokens: 0, outputTokens: output });
}
