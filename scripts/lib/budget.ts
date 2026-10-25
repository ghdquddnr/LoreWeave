// 측정 스크립트의 비용 한도 (M5-PLAN 4절). 누적 비용이 한도에 닿으면 다음 호출을 보내지 않는다.
// 동시에 보낸 호출은 끝까지 기다리므로 한도를 호출 몇 개만큼 넘을 수 있다 (호출 하나는 $0.01 안팎).

import { costUsd } from '../../src/core/ai/cost.ts';
import type { AiClient } from '../../src/main/ai-client.ts';

export interface BudgetClient extends AiClient {
  /** 지금까지 쓴 비용 (USD) */
  spent(): number;
}

export class BudgetExceeded extends Error {
  constructor(limit: number, spent: number) {
    super(`비용 한도 $${limit.toFixed(2)}에 닿아 멈췄습니다 (지금까지 $${spent.toFixed(4)})`);
  }
}

export function withBudget(client: AiClient, model: string, limitUsd: number): BudgetClient {
  let spent = 0;
  return {
    check: (m) => client.check(m),
    spent: () => spent,
    async json(call) {
      if (spent >= limitUsd) throw new BudgetExceeded(limitUsd, spent);
      try {
        const result = await client.json(call);
        spent += costUsd(model, result.usage);
        return result;
      } catch (e) {
        const usage = (e as { usage?: Parameters<typeof costUsd>[1] }).usage;
        if (usage) spent += costUsd(model, usage);
        throw e;
      }
    },
  };
}
