// 검사 결과 → M0-A 채점기 입력 (M4-PLAN 5절).
// 앱이 `.loreweave/ai.db`에 저장한 검사 결과를 `predictions.json`(M0-A 형식)으로 내보내고, 검사 호출의 비용·시간을 요약한다.
// 채점은 main에 남아 있는 M0-A 채점기로 한다:
//   pnpm export:predictions <원고 폴더> <출력 폴더>
//   pnpm --dir spikes/m0a-ai-feasibility evaluate <출력 폴더>
// ai.db는 읽기만 한다.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { candidateFacts, type Category, type PriorAnalysis } from '../src/core/ai/detection.ts';
import type { Entity } from '../src/core/ai/extraction.ts';
import { chapterNumber } from '../src/core/project/chapters.ts';

interface Finding {
  category: Category;
  target_quote: string;
  claim: string;
  evidence: { chapter: number; quote: string }[];
  confidence: number;
}

export interface Predictions {
  run_id: string;
  strategy: string;
  model: string;
  chapters: { target_chapter: number; context: { chapter: number; text: string }[]; findings: Finding[] }[];
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
 * context는 지금 저장된 분석으로 다시 고른다. 검사 뒤 앞 화를 다시 분석하지 않았다면 검사 때와 같다.
 */
export function toPredictions(dbPath: string, runId: string): { predictions: Predictions; usage: CheckUsage } {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const checks = rows(db, 'SELECT * FROM checks ORDER BY file');
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
          context: candidateFacts(target?.entities ?? [], priors).map((f) => ({ chapter: f.chapter, text: f.quote })),
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
      predictions: { run_id: runId, strategy: 'product-b', model: models.join('+'), chapters },
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
