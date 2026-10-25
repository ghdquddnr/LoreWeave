// 검사 결과 → M0-A 채점기 입력 (M4-PLAN 5절).
// 앱이 `.loreweave/ai.db`에 저장한 검사 결과를 `predictions.json`(M0-A 형식)으로 내보내고, 검사 호출의 비용·시간을 요약한다.
// 채점은 main에 남아 있는 M0-A 채점기로 한다:
//   pnpm export:predictions <원고 폴더> <출력 폴더>
//   pnpm --dir spikes/m0a-ai-feasibility evaluate <출력 폴더>
// ai.db는 읽기만 한다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { candidateFacts, selectFacts, type Category, type PriorAnalysis, type Selection } from '../src/core/ai/detection.ts';
import type { Entity } from '../src/core/ai/extraction.ts';
import { chapterNumber } from '../src/core/project/chapters.ts';

interface Finding {
  category: Category;
  target_quote: string;
  claim: string;
  evidence: { chapter: number; quote: string }[];
  confidence: number;
}

/**
 * context(모델이 본 앞 화 사실)의 출처.
 *   - product-selection-recomputed: 내보낼 때 지금 저장된 분석에 제품의 고르기(candidateFacts + selection)를 다시 적용했다. 검사 때 보낸 것이 아니다
 *   - runner-sent: 측정 runner가 검사할 때 API 클라이언트에 넘긴 묶음 입력을 그 프로세스 안에서 관측했고, 그 입력을 만든 사실 목록을 그대로 넘겼다
 *     (네트워크 바이트를 관측한 것은 아니다)
 *   - reconstructed-from-stored-analyses: 실행이 끝난 뒤 저장된 분석으로 runner와 같은 함수를 다시 돌려 만들었다 (당시 전송을 관측한 것이 아니다)
 */
export type ContextSource = 'product-selection-recomputed' | 'runner-sent' | 'reconstructed-from-stored-analyses';

export interface Predictions {
  run_id: string;
  strategy: string;
  model: string;
  /** context의 출처 (평가기는 읽지 않는다) */
  context_source: ContextSource;
  chapters: { target_chapter: number; context: { chapter: number; text: string }[]; findings: Finding[] }[];
}

/** 제품 고르기 대신 쓸 context. 검사한 화마다 있어야 하고, 사실 수가 검사 기록(fact_count)과 같아야 한다 */
export interface ContextOverride {
  source: Exclude<ContextSource, 'product-selection-recomputed'>;
  byChapter: Map<number, { chapter: number; quote: string }[]>;
}

export interface CheckUsage {
  checks: number;
  costUsd: number;
  maxCostUsd: number;
  maxLatencyMs: number | null;
  maxInputTokens: number;
}

const rows = (db: DatabaseSync, sql: string, ...args: (string | number)[]) => db.prepare(sql).all(...args) as Record<string, unknown>[];

function analysisOf(db: DatabaseSync, file: string): { entities: Entity[]; facts: PriorAnalysis['facts'] } | null {
  const [a] = rows(db, 'SELECT id FROM analyses WHERE file = ?', file);
  if (!a) return null;
  return {
    entities: rows(db, 'SELECT name, aliases FROM entities WHERE analysis_id = ? ORDER BY ord', Number(a['id'])).map((e) => ({
      name: String(e['name']),
      aliases: JSON.parse(String(e['aliases'])) as string[],
    })),
    facts: rows(db, 'SELECT entity, predicate, value, quote FROM facts WHERE analysis_id = ? ORDER BY ord', Number(a['id'])).map((f) => ({
      entity: String(f['entity']),
      predicate: String(f['predicate']),
      value: String(f['value']),
      quote: String(f['quote']),
    })),
  };
}

/**
 * 검사마다 결과와, 모델이 본 앞 화 사실(context, M0-A의 retrieval 지표용)을 만든다.
 * context는 기본으로 지금 저장된 분석에 제품 고르기를 다시 적용해 만든다 (검사 때와 같은 selection을 줘야 한다). 검사 뒤 앞 화를 다시 분석하지 않았다면
 * 제품 검사 때와 같지만, 제품과 다른 고르기로 보낸 실험(M9 사실 더하기)에는 맞지 않는다. 그런 실험은 override로 실제로 넘긴 사실 목록을 준다.
 * override를 주면 화마다 있어야 하고 사실 수가 검사 기록과 같아야 하며, 아니면 오류를 낸다 (제품 고르기로 대신하지 않는다).
 */
export function toPredictions(
  dbPath: string,
  runId: string,
  selection: Selection = 'all',
  override?: ContextOverride,
): { predictions: Predictions; usage: CheckUsage } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const checks = rows(db, 'SELECT * FROM checks ORDER BY file');
    if (override) {
      // 출처를 확인할 수 없으면 제품 고르기로 대신하지 않고 멈춘다
      const checked = new Set(checks.map((c) => chapterNumber(String(c['file']))!));
      for (const c of checks) {
        const n = chapterNumber(String(c['file']))!;
        const given = override.byChapter.get(n);
        if (!given) throw new Error(`${n}화의 context 출처가 없습니다 (${override.source})`);
        if (given.length !== Number(c['fact_count'])) throw new Error(`${n}화의 context 사실 수 ${given.length} ≠ 검사 기록 ${Number(c['fact_count'])}`);
      }
      for (const n of override.byChapter.keys()) if (!checked.has(n)) throw new Error(`검사 기록이 없는 ${n}화의 context가 있습니다`);
    }
    const chapters = checks
      .map((c) => {
        const id = Number(c['id']);
        const file = String(c['file']);
        const target = analysisOf(db, file);
        const priors: PriorAnalysis[] = rows(db, 'SELECT file FROM check_inputs WHERE check_id = ?', id).flatMap((i) => {
          const a = analysisOf(db, String(i['file']));
          return a ? [{ chapter: chapterNumber(String(i['file']))!, ...a }] : [];
        });
        const evidence = rows(db, 'SELECT finding_ord, chapter, quote FROM finding_evidence WHERE check_id = ? ORDER BY finding_ord, ord', id);
        return {
          target_chapter: chapterNumber(file)!,
          context: override
            ? override.byChapter.get(chapterNumber(file)!)!.map((f) => ({ chapter: f.chapter, text: f.quote }))
            : selectFacts(candidateFacts(target?.entities ?? [], priors), selection).map((f) => ({ chapter: f.chapter, text: f.quote })),
          findings: rows(db, 'SELECT * FROM findings WHERE check_id = ? ORDER BY ord', id).map((f) => ({
            category: String(f['category']) as Category,
            target_quote: String(f['target_quote']),
            claim: String(f['claim']),
            confidence: Number(f['confidence']),
            evidence: evidence
              .filter((e) => Number(e['finding_ord']) === Number(f['ord']))
              .map((e) => ({ chapter: Number(e['chapter']), quote: String(e['quote']) })),
          })),
        };
      })
      .sort((a, b) => a.target_chapter - b.target_chapter);
    const models = [...new Set(checks.map((c) => String(c['model'])))];
    const calls = rows(db, "SELECT cost_usd, latency_ms, input_tokens FROM calls WHERE kind = 'check' AND ok = 1");
    const latencies = calls.map((r) => r['latency_ms']).filter((v) => v !== null).map(Number);
    return {
      predictions: { run_id: runId, strategy: 'product-b', model: models.join('+'), context_source: override?.source ?? 'product-selection-recomputed', chapters },
      usage: {
        checks: calls.length,
        costUsd: calls.reduce((n, r) => n + Number(r['cost_usd']), 0),
        maxCostUsd: Math.max(0, ...calls.map((r) => Number(r['cost_usd']))),
        maxLatencyMs: latencies.length ? Math.max(...latencies) : null,
        maxInputTokens: Math.max(0, ...calls.map((r) => Number(r['input_tokens']))),
      },
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  const [project, out] = process.argv.slice(2);
  if (!project || !out) {
    console.error('사용: pnpm export:predictions <원고 폴더> <출력 폴더>');
    process.exit(1);
  }
  const runId = `product-${new Date().toISOString().slice(0, 10)}`;
  const { predictions, usage } = toPredictions(join(resolve(project), '.loreweave', 'ai.db'), runId);
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'predictions.json'), JSON.stringify(predictions, null, 2) + '\n');
  writeFileSync(join(out, 'usage.json'), JSON.stringify(usage, null, 2) + '\n');
  const findings = predictions.chapters.reduce((n, c) => n + c.findings.length, 0);
  console.log(`검사한 화 ${predictions.chapters.length}개 (${predictions.chapters.map((c) => c.target_chapter).join(', ')}), 결과 ${findings}개, 모델 ${predictions.model}`);
  console.log(
    `검사 호출 ${usage.checks}회 · 합계 $${usage.costUsd.toFixed(4)} · 최대 $${usage.maxCostUsd.toFixed(4)} · 최대 ${usage.maxLatencyMs ?? '?'}ms · 최대 입력 ${usage.maxInputTokens}토큰`,
  );
}
