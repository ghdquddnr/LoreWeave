// OpenAI 조직의 실제 사용 비용을 Costs API(/v1/organization/costs)로 읽는다.
//   pnpm openai:costs [--since 2026-10-01]                         (키를 화면에 보이지 않게 입력)
//   pnpm openai:costs --env-file spikes/m0a-ai-feasibility/.env       (그 파일의 OPENAI_ADMIN_KEY)
//   --json: 요약을 JSON으로 (키는 들어가지 않는다)
// 이 API는 Admin API 키(sk-admin-…)가 필요하다. 앱에 저장한 일반 키로는 권한이 없다 (403, api.usage.read).
// 키는 출력하지 않는다. --env-file은 Git이 무시하는 파일만 읽는다 (키가 커밋되지 않게).
// 이 스크립트가 실제 비용의 기준이다 (DECISIONS 2026-10-25): 토큰으로 계산한 비용은 어림으로만 쓴다.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { readEnvValue, startOfDay, summarizeCosts, type CostBucket } from './lib/costs.ts';

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

/** Git이 무시하는 .env 파일의 OPENAI_ADMIN_KEY */
function keyFromEnvFile(path: string): string {
  const file = resolve(path);
  if (spawnSync('git', ['check-ignore', '-q', file]).status !== 0) throw new Error(`Git이 무시하지 않는 파일이라 읽지 않습니다 (키가 커밋될 수 있음): ${file}`);
  const key = readEnvValue(readFileSync(file, 'utf8'), 'OPENAI_ADMIN_KEY');
  if (!key) throw new Error(`${file}에 OPENAI_ADMIN_KEY가 없습니다`);
  return key;
}

async function askKey(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Admin 키를 입력받아야 하므로 터미널에서 직접 실행하거나 --env-file을 쓰세요');
  return askHidden('OpenAI Admin API 키 (화면에 보이지 않음, 저장하지 않음): ');
}

async function main() {
  const args = process.argv.slice(2);
  const sinceDate = option(args, '--since') ?? '2026-10-01';
  const since = startOfDay(sinceDate);
  const envFile = option(args, '--env-file');
  const key = envFile ? keyFromEnvFile(envFile) : await askKey();
  if (!key) throw new Error('키를 입력하지 않았습니다');
  if (!key.startsWith('sk-admin-')) console.log('주의: Admin 키(sk-admin-…)가 아닙니다. 권한 오류가 날 수 있습니다.');

  const summary = summarizeCosts(await fetchBuckets(key, since));
  if (args.includes('--json')) {
    console.log(JSON.stringify({ since: sinceDate, ...summary }, null, 1));
    return;
  }
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
