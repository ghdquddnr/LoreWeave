// OpenAI Costs API 응답 합치기 (scripts/openai-costs.ts). 순수 함수만 둔다.
// 응답: { data: [{ start_time, end_time, results: [{ amount: { value, currency }, line_item, project_id }] }], next_page }

export interface CostResult {
  amount: { value: number; currency: string };
  line_item?: string | null;
  project_id?: string | null;
}

export interface CostBucket {
  start_time: number;
  end_time: number;
  results: CostResult[];
}

export interface CostSummary {
  currency: string;
  total: number;
  /** 날짜(UTC, YYYY-MM-DD)별 합계. 비용이 0인 날은 뺀다 */
  byDay: [string, number][];
  /** 항목(모델·입출력 등)별 합계, 큰 순서 */
  byLineItem: [string, number][];
}

export function summarizeCosts(buckets: CostBucket[]): CostSummary {
  const day = new Map<string, number>();
  const item = new Map<string, number>();
  const currencies = new Set<string>();
  let total = 0;
  for (const b of buckets) {
    const date = new Date(b.start_time * 1000).toISOString().slice(0, 10);
    for (const r of b.results) {
      const v = Number(r.amount?.value ?? 0);
      currencies.add(r.amount?.currency ?? 'usd');
      total += v;
      day.set(date, (day.get(date) ?? 0) + v);
      const key = r.line_item ?? '(구분 없음)';
      item.set(key, (item.get(key) ?? 0) + v);
    }
  }
  if (currencies.size > 1) throw new Error(`통화가 여럿입니다: ${[...currencies].join(', ')}`);
  return {
    currency: [...currencies][0] ?? 'usd',
    total,
    byDay: [...day].filter(([, v]) => v > 0).sort(([a], [b]) => a.localeCompare(b)),
    byLineItem: [...item].filter(([, v]) => v > 0).sort(([, a], [, b]) => b - a),
  };
}

/** "2026-10-01" → 그날 0시(UTC)의 Unix 초 */
export function startOfDay(date: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new Error(`날짜는 YYYY-MM-DD 형식이어야 합니다: ${date}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000;
}
