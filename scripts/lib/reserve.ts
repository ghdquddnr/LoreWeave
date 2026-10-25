// 측정 스크립트의 호출 전 예약 예산 (M9-PLAN 5절).
// budget.ts는 호출이 끝난 뒤 비용을 더하므로 동시에 보낸 호출만큼 한도를 넘을 수 있다. 여기서는 보내기 전에 상한 비용을 예약한다.
//   - 예약 = 입력 토큰 상한 × 입력 단가 중 가장 비싼 값 + 출력 토큰 상한(요청에 그대로 건다) × 출력 단가
//   - 입력 토큰 상한은 UTF-8 바이트 수로 잡는다. 토큰 하나는 1바이트 이상이므로 평균 비율과 달리 넘지 않는다.
//     시스템·사용자 입력과 스키마 JSON, 메시지 형식 몫(MESSAGE_OVERHEAD_TOKENS)을 모두 더한다
//   - 예약과 진행 중 합계 확인은 await 없이 한 번에 한다 (동시에 부른 호출끼리 같은 남은 금액을 나눠 쓰지 않는다)
//   - 끝나면 usage로 정산한다. usage가 상한보다 크면 usage를 쓴다. 실패했는데 usage를 모르거나 취소했으면 예약액을 쓴 것으로 남긴다
//   - SDK 재시도는 끄고(maxRetries 0) 여기서 시도마다 따로 예약한다. 한 번 거절하면 그 뒤 호출은 모두 보내지 않는다

import { costUsd, type Usage } from '../../src/core/ai/cost.ts';
import { modelInfo } from '../../src/core/ai/models.ts';
import { AiError, MAX_OUTPUT_TOKENS, toAiError, type AiClient, type JsonCall, type JsonResult } from '../../src/main/ai-client.ts';

/** 메시지 두 개의 형식 토큰과 Structured Outputs가 붙이는 안내 몫. 실제보다 넉넉히 잡는다 */
export const MESSAGE_OVERHEAD_TOKENS = 1_000;

const bytes = (s: string) => Buffer.byteLength(s, 'utf8');

/** 호출 한 번의 입력 토큰 상한 */
export function inputTokenBound(call: Pick<JsonCall, 'system' | 'user' | 'schema'>): number {
  return bytes(call.system) + bytes(call.user) + bytes(JSON.stringify(call.schema)) + MESSAGE_OVERHEAD_TOKENS;
}

/** 호출 한 번의 비용 상한 (USD). 입력은 일반·캐시 쓰기·캐시 읽기 단가 중 가장 비싼 값으로 매긴다 */
export function callCostBound(model: string, call: Pick<JsonCall, 'system' | 'user' | 'schema'>, maxOutputTokens: number): number {
  const p = modelInfo(model).price;
  return (inputTokenBound(call) * Math.max(p.input, p.cacheWrite, p.cachedInput) + maxOutputTokens * p.output) / 1e6;
}

export class BudgetRefused extends Error {
  constructor(readonly limitUsd: number, readonly committedUsd: number, readonly neededUsd: number) {
    super(`비용 한도 $${limitUsd.toFixed(2)} 안에서 이 호출의 상한 $${neededUsd.toFixed(4)}를 예약할 수 없어 멈췄습니다 (확정·예약 합계 $${committedUsd.toFixed(4)})`);
  }
}

export interface ReservedLedger {
  /** usage로 정산했거나, 모르면 예약액으로 남긴 지출 */
  spent: number;
  /** 지금 진행 중인 호출의 예약 합계 */
  inFlight: number;
  /** 보낸 시도 수 (재시도 포함) */
  attempts: number;
  /** usage를 몰라 예약액을 지출로 남긴 시도 수 */
  unknownUsage: number;
  /** 한 번이라도 거절했으면 그 이유 */
  refused: string | null;
}

export interface ReservedClient extends AiClient {
  ledger(): ReservedLedger;
}

export interface ReserveOptions {
  model: string;
  limitUsd: number;
  /** 요청에 거는 출력 토큰 상한 (기본 MAX_OUTPUT_TOKENS) */
  maxOutputTokens?: number;
  /** 같은 호출을 다시 보내는 최대 횟수 (기본 0). 네트워크·한도(429) 오류일 때만 다시 보낸다 */
  retries?: number;
}

const RETRY_KINDS = new Set<AiError['kind']>(['network', 'rate-limit']);

/** client는 SDK 재시도를 끈 것(maxRetries 0)이어야 한다. 아니면 보이지 않는 재시도 비용을 예약하지 못한다 */
export function withReservation(client: AiClient, o: ReserveOptions): ReservedClient {
  const maxOutputTokens = o.maxOutputTokens ?? MAX_OUTPUT_TOKENS;
  const ledger: Omit<ReservedLedger, 'inFlight'> = { spent: 0, attempts: 0, unknownUsage: 0, refused: null };
  /** 진행 중인 예약. 합계를 빼기로 셈하면 부동소수 찌꺼기가 남으므로 남은 예약을 매번 더한다 */
  const open = new Set<{ usd: number }>();
  const inFlight = () => [...open].reduce((n, r) => n + r.usd, 0);

  /** 예약에 성공하면 예약액을 돌려준다. await 없이 확인과 예약을 한 번에 한다 */
  const reserve = (call: JsonCall): { usd: number } => {
    const need = callCostBound(o.model, call, maxOutputTokens);
    const committed = ledger.spent + inFlight();
    if (ledger.refused) throw new BudgetRefused(o.limitUsd, committed, need);
    if (committed + need > o.limitUsd) {
      const refused = new BudgetRefused(o.limitUsd, committed, need);
      ledger.refused = refused.message;
      throw refused;
    }
    const reservation = { usd: need };
    open.add(reservation);
    ledger.attempts++;
    return reservation;
  };
  const settle = (reservation: { usd: number }, usage: Usage | undefined) => {
    open.delete(reservation);
    if (usage) ledger.spent += Math.max(costUsd(o.model, usage), 0);
    else {
      ledger.spent += reservation.usd;
      ledger.unknownUsage++;
    }
  };

  return {
    check: (m) => client.check(m),
    ledger: () => ({ ...ledger, inFlight: inFlight() }),
    async json(call): Promise<JsonResult> {
      if (call.model !== o.model) throw new Error(`예약한 모델(${o.model})과 다른 모델로 부를 수 없습니다: ${call.model}`);
      for (let attempt = 0; ; attempt++) {
        const reserved = reserve(call);
        try {
          const result = await client.json({ ...call, maxOutputTokens });
          settle(reserved, result.usage);
          return result;
        } catch (e) {
          const usage = (e as { usage?: Usage }).usage;
          settle(reserved, usage);
          const kind = toAiError(e).kind;
          if (call.signal?.aborted || attempt >= (o.retries ?? 0) || !RETRY_KINDS.has(kind)) throw e;
        }
      }
    },
  };
}
