// OpenAI 호출 (M3-PLAN 2·4절). Responses API + Structured Outputs.
// 재시도·시간 제한·취소는 SDK에 맡긴다. 오류는 작가가 읽을 수 있는 문구로 바꾼다.

import OpenAI, { APIConnectionError, APIError } from 'openai';
import type { Usage } from '../core/ai/cost.ts';

export interface JsonCall {
  model: string;
  system: string;
  user: string;
  schema: { name: string; schema: Record<string, unknown> };
  signal?: AbortSignal;
}

export interface JsonResult {
  data: unknown;
  usage: Usage;
  /** 실제로 응답한 모델 버전 */
  modelVersion: string;
  latencyMs: number;
}

export interface AiClient {
  /** 키가 맞고 모델을 쓸 수 있는지 확인한다 (생성 호출 없음, 비용 없음) */
  check(model: string): Promise<void>;
  json(call: JsonCall): Promise<JsonResult>;
}

/** 작가에게 보일 오류. kind로 분석을 멈출지(키 문제) 다음 화로 넘어갈지 정한다 */
export class AiError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'model' | 'network' | 'rate-limit' | 'incomplete' | 'other',
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_TOKENS = 16_000;

export function toAiError(e: unknown): AiError {
  if (e instanceof AiError) return e;
  if (e instanceof APIConnectionError) return new AiError('OpenAI에 연결할 수 없습니다. 인터넷 연결을 확인하세요.', 'network');
  if (e instanceof APIError) {
    if (e.status === 401) return new AiError('API 키가 올바르지 않습니다. 설정에서 키를 확인하세요.', 'auth');
    if (e.status === 403 || e.status === 404) return new AiError('이 API 키로는 선택한 모델을 쓸 수 없습니다.', 'model');
    if (e.status === 429) return new AiError('요청 한도나 잔액을 넘었습니다. 잠시 뒤 다시 하거나 OpenAI 결제 상태를 확인하세요.', 'rate-limit');
    return new AiError(`OpenAI 오류 (${e.status ?? '알 수 없음'}): ${e.message}`, 'other');
  }
  return new AiError(e instanceof Error ? e.message : String(e), 'other');
}

/** fetch를 바꿔 끼울 수 있게 둔다 (테스트에서 네트워크 없이 확인) */
export function createOpenAiClient(apiKey: string, options: { fetch?: typeof fetch; maxRetries?: number } = {}): AiClient {
  const client = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 3, ...options });
  return {
    async check(model) {
      try {
        await client.models.retrieve(model);
      } catch (e) {
        throw toAiError(e);
      }
    },
    async json({ model, system, user, schema, signal }) {
      const started = performance.now();
      let res: OpenAI.Responses.Response;
      try {
        res = await client.responses.create(
          {
            model,
            input: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            text: { format: { type: 'json_schema', name: schema.name, schema: schema.schema, strict: true } },
            reasoning: { effort: 'low' },
            max_output_tokens: MAX_OUTPUT_TOKENS,
          },
          { signal },
        );
      } catch (e) {
        throw toAiError(e);
      }
      const u = res.usage;
      const usage: Usage = {
        inputTokens: u?.input_tokens ?? 0,
        cachedTokens: u?.input_tokens_details?.cached_tokens ?? 0,
        cacheWriteTokens: (u?.input_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens ?? 0,
        outputTokens: u?.output_tokens ?? 0,
      };
      if (res.status !== 'completed') {
        throw Object.assign(new AiError(`응답이 끝나지 않았습니다 (${res.incomplete_details?.reason ?? res.status})`, 'incomplete'), { usage });
      }
      let data: unknown;
      try {
        data = JSON.parse(res.output_text);
      } catch {
        throw Object.assign(new AiError('응답을 JSON으로 읽을 수 없습니다', 'incomplete'), { usage });
      }
      return { data, usage, modelVersion: res.model, latencyMs: Math.round(performance.now() - started) };
    },
  };
}
