// OpenAI 조직의 실제 사용 비용을 Costs API(/v1/organization/costs)로 읽는다.
//   pnpm openai:costs [--since 2026-10-01]
// 이 API는 Admin API 키(sk-admin-…)가 필요하다. 앱에 저장한 일반 키로는 권한이 없다 (403, api.usage.read).
// Admin 키는 저장하지 않는다: 실행할 때마다 화면에 보이지 않게 입력받고, 파일·환경 변수·명령줄에 남기지 않는다.
// 자기 터미널에서 직접 실행한다 (입력을 받아야 하므로).

import { createInterface } from 'node:readline';
import { startOfDay, summarizeCosts, type CostBucket } from './lib/costs.ts';

const ENDPOINT = 'https://api.openai.com/v1/organization/costs';

function option(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** 입력한 글자를 화면에 보이지 않게 한 줄 읽는다 */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const muted = rl as unknown as { _writeToOutput(s: string): void };
    muted._writeToOutput = (s) => {
      if (s.includes(question)) process.stdout.write(question);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

async function fetchBuckets(key: string, since: number): Promise<CostBucket[]> {
  const buckets: CostBucket[] = [];
  let page: string | null = null;
  do {
    const params = new URLSearchParams({ start_time: String(since), bucket_width: '1d', limit: '180' });
    params.append('group_by', 'line_item');
    if (page) params.set('page', page);
    const res = await fetch(`${ENDPOINT}?${params}`, { headers: { Authorization: `Bearer ${key}` } });
    const body = (await res.json().catch(() => ({}))) as { data?: CostBucket[]; next_page?: string | null; error?: unknown };
    if (!res.ok) {
      const message = typeof body.error === 'string' ? body.error : JSON.stringify(body.error ?? {});
      throw new Error(`Costs API ${res.status}: ${message.replace(/sk-[A-Za-z0-9_-]+/g, '[키]')}`);
    }
    buckets.push(...(body.data ?? []));
    page = body.next_page ?? null;
  } while (page);
  return buckets;
}

async function main() {
  const args = process.argv.slice(2);
  const sinceDate = option(args, '--since') ?? '2026-10-01';
  const since = startOfDay(sinceDate);
  if (!process.stdin.isTTY) throw new Error('Admin 키를 입력받아야 하므로 터미널에서 직접 실행하세요');
  const key = await askHidden('OpenAI Admin API 키 (화면에 보이지 않음, 저장하지 않음): ');
  if (!key) throw new Error('키를 입력하지 않았습니다');
  if (!key.startsWith('sk-admin-')) console.log('주의: Admin 키(sk-admin-…)가 아닙니다. 권한 오류가 날 수 있습니다.');

  const summary = summarizeCosts(await fetchBuckets(key, since));
  const usd = (v: number) => `$${v.toFixed(4)}`;
  console.log(`\n${sinceDate}부터 (UTC 날짜 기준) 합계: ${usd(summary.total)} ${summary.currency.toUpperCase()}`);
  console.log('\n날짜별');
  for (const [day, v] of summary.byDay) console.log(`  ${day}  ${usd(v)}`);
  console.log('\n항목별');
  for (const [item, v] of summary.byLineItem) console.log(`  ${usd(v).padStart(10)}  ${item}`);
  console.log('\n대시보드의 금액과 하루 정도 늦게 맞춰질 수 있습니다 (최근 날짜는 집계 중일 수 있음).');
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
