// 화별 사실 추출 실행 (M3-PLAN 1·4절). 작가가 버튼을 눌렀을 때만 실행한다.
//   - 한 번에 한 화씩, 취소하면 다음 화를 보내지 않는다 (끝난 화는 저장돼 있다)
//   - 키·모델·한도 문제는 나머지 화도 실패할 것이므로 멈추고, 그 밖의 실패는 그 화만 실패로 남긴다
//   - 인용이 본문에 없는 사실은 버린다 (ADR 0001 결정 2)
//   - 화 파일은 읽기만 한다

import { costUsd, estimateExtractionCost, type Usage } from '../core/ai/cost.ts';
import { EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractionInput, parseExtraction, PROMPT_VERSION } from '../core/ai/extraction.ts';
import { checkQuotes } from '../core/ai/locate.ts';
import { parseC3 } from '../core/manuscript/c3.ts';
import { splitEnvelope } from '../core/manuscript/envelope.ts';
import { visibleLines } from '../core/manuscript/lines.ts';
import { AiError, toAiError, type AiClient } from './ai-client.ts';
import type { AiStore } from './ai-db.ts';
import { chapterFileNames, chapterHash, readChapter } from './project-files.ts';

export type AnalysisState = 'none' | 'fresh' | 'stale';

/** 화마다 분석 상태: 없음 / 분석 뒤 그대로 / 분석 뒤 바뀜 */
export async function analysisStates(root: string, store: AiStore): Promise<Record<string, AnalysisState>> {
  const analyzed = store.analyzedHashes();
  const states: Record<string, AnalysisState> = {};
  for (const file of await chapterFileNames(root)) {
    const hash = analyzed.get(file);
    states[file] = !hash ? 'none' : hash === (await chapterHash(root, file)) ? 'fresh' : 'stale';
  }
  return states;
}

async function chapterLines(root: string, file: string): Promise<{ lines: string[]; hash: string }> {
  const { text, hash } = await readChapter(root, file);
  return { lines: visibleLines(parseC3(splitEnvelope(text).body)), hash };
}

/** 여러 화를 분석하기 전에 보여 줄 예상 비용 (상한) */
export async function estimate(root: string, files: string[], model: string): Promise<{ chars: number; costUsd: number }> {
  let chars = 0;
  let cost = 0;
  for (const file of files) {
    const n = (await chapterLines(root, file)).lines.join('\n').length;
    chars += n;
    cost += estimateExtractionCost(model, n);
  }
  return { chars, costUsd: cost };
}

export interface AnalyzeProgress {
  total: number;
  done: number;
  current: string | null;
  failed: { file: string; message: string }[];
  costUsd: number;
  /** 키·모델·한도 문제로 멈췄거나 취소했으면 그 이유 */
  stopped: string | null;
}

export interface AnalyzeOptions {
  root: string;
  store: AiStore;
  client: AiClient;
  model: string;
  signal: AbortSignal;
  onProgress?(progress: AnalyzeProgress): void;
  now?(): Date;
}

const STOP_KINDS = new Set<AiError['kind']>(['auth', 'model', 'rate-limit']);

export async function analyzeChapters(files: string[], o: AnalyzeOptions): Promise<AnalyzeProgress> {
  const now = o.now ?? (() => new Date());
  const progress: AnalyzeProgress = { total: files.length, done: 0, current: null, failed: [], costUsd: 0, stopped: null };
  const report = () => o.onProgress?.({ ...progress, failed: [...progress.failed] });
  const log = (file: string, ok: boolean, usage: Usage) => {
    const cost = costUsd(o.model, usage);
    progress.costUsd += cost;
    o.store.logCall({ at: now().toISOString(), file, model: o.model, ok, usage, costUsd: cost });
    return cost;
  };

  for (const file of files) {
    if (o.signal.aborted) {
      progress.stopped = '취소했습니다';
      break;
    }
    progress.current = file;
    report();
    try {
      const { lines, hash } = await chapterLines(o.root, file);
      const result = await o.client.json({
        model: o.model,
        system: EXTRACT_SYSTEM,
        user: extractionInput(file, lines),
        schema: EXTRACT_SCHEMA,
        signal: o.signal,
      });
      const cost = log(file, true, result.usage);
      const extraction = parseExtraction(result.data);
      const { facts, dropped } = checkQuotes(extraction, lines);
      o.store.saveAnalysis({
        file,
        contentHash: hash,
        model: o.model,
        modelVersion: result.modelVersion,
        promptVersion: PROMPT_VERSION,
        summary: extraction.summary,
        droppedQuotes: dropped.length,
        costUsd: cost,
        createdAt: now().toISOString(),
        entities: extraction.entities,
        facts,
      });
    } catch (e) {
      const usage = (e as { usage?: Usage }).usage;
      if (usage) log(file, false, usage);
      if (o.signal.aborted) {
        progress.stopped = '취소했습니다';
        break;
      }
      const error = toAiError(e);
      progress.failed.push({ file, message: error.message });
      if (STOP_KINDS.has(error.kind)) {
        progress.stopped = error.message;
        break;
      }
    }
    progress.done++;
  }
  progress.current = null;
  report();
  return progress;
}
