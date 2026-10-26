// 화별 사실 추출 실행 (M3-PLAN 1·4절). 작가가 버튼을 눌렀을 때만 실행한다.
//   - 두 화씩 동시에 보낸다 (M3 실측에서 한 화씩은 15화에 약 3분). 취소하면 다음 화를 보내지 않는다 (끝난 화는 저장돼 있다)
//   - 키·모델·한도 문제는 나머지 화도 실패할 것이므로 멈추고, 그 밖의 실패는 그 화만 실패로 남긴다
//   - 취소했거나 멈춘 뒤에 늦게 온 성공 응답은 저장하지 않는다 (기존 분석을 덮어쓰지 않는다)
//   - 인용이 본문에 없는 사실은 버린다 (ADR 0001 결정 2)
//   - 화 파일은 읽기만 한다

import { costUsd, estimateExtractionCost, type Usage } from '../core/ai/cost.ts';
import {
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  extractionInput,
  mergeExtractions,
  parseExtraction,
  PROMPT_VERSION,
  splitForExtraction,
  type Extraction,
} from '../core/ai/extraction.ts';
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

/** 화의 보이는 본문 줄 (분석·검사 입력과 인용 위치의 기준)과 파일 해시 */
export async function chapterLines(root: string, file: string): Promise<{ lines: string[]; hash: string }> {
  const { text, hash } = await readChapter(root, file);
  return { lines: visibleLines(parseC3(splitEnvelope(text).body)), hash };
}

/** 여러 화를 분석하기 전에 보여 줄 예상 비용 (상한) */
export async function estimate(root: string, files: string[], model: string): Promise<{ chars: number; costUsd: number }> {
  let chars = 0;
  let cost = 0;
  for (const file of files) {
    const { lines } = await chapterLines(root, file);
    chars += lines.join('\n').length;
    // 나눠 추출하면 조각마다 프롬프트가 붙는다
    for (const chunk of splitForExtraction(lines)) cost += estimateExtractionCost(model, chunk.join('\n').length);
  }
  return { chars, costUsd: cost };
}

export interface AnalyzeProgress {
  total: number;
  done: number;
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
  /** 동시에 보내는 화 수 (기본 CONCURRENCY). 측정 스크립트가 많은 화를 분석할 때 늘린다 */
  concurrency?: number;
}

const STOP_KINDS = new Set<AiError['kind']>(['auth', 'model', 'rate-limit']);

/** 동시에 보내는 화 수. 한도(429)에 걸리지 않도록 작게 둔다 */
export const CONCURRENCY = 2;

export async function analyzeChapters(files: string[], o: AnalyzeOptions): Promise<AnalyzeProgress> {
  const now = o.now ?? (() => new Date());
  const progress: AnalyzeProgress = { total: files.length, done: 0, failed: [], costUsd: 0, stopped: null };
  const report = () => o.onProgress?.({ ...progress, failed: [...progress.failed] });
  const log = (file: string, ok: boolean, usage: Usage, latencyMs: number) => {
    const cost = costUsd(o.model, usage);
    progress.costUsd += cost;
    o.store.logCall({ at: now().toISOString(), file, model: o.model, ok, usage, costUsd: cost, latencyMs });
    return cost;
  };
  /** 다음 화를 보내도 되는가. 취소했거나 멈췄으면 보내지 않는다 */
  const mayContinue = () => {
    if (o.signal.aborted) progress.stopped ??= '취소했습니다';
    return progress.stopped === null;
  };

  const queue = [...files];
  const worker = async () => {
    for (let file = queue.shift(); file !== undefined && mayContinue(); file = queue.shift()) {
      await analyzeOne(file);
      report();
    }
  };

  const analyzeOne = async (file: string) => {
    let started = performance.now();
    try {
      const { lines, hash } = await chapterLines(o.root, file);
      // 화 파일을 읽는 동안 취소했거나 다른 화가 멈췄을 수 있다
      if (!mayContinue()) return;
      // 긴 화는 조각마다 따로 추출해 합친다 (M8). 인용 확인과 줄 주소는 화 전체 기준이다
      const chunks = splitForExtraction(lines);
      const parts: Extraction[] = [];
      let cost = 0;
      let modelVersion = '';
      for (const chunk of chunks) {
        // 조각마다 공유 중단을 확인한다: 취소했거나 다른 화가 키·모델·한도 문제로 멈췄으면 다음 조각을 보내지 않고,
        // 이 화는 저장하지 않는다 (일부 조각만 합친 분석을 완성본으로 남기지 않는다). 이미 보낸 조각의 호출 기록은 남아 있다
        if (!mayContinue()) return;
        started = performance.now();
        const result = await o.client.json({
          model: o.model,
          system: EXTRACT_SYSTEM,
          user: extractionInput(file, chunk),
          schema: EXTRACT_SCHEMA,
          signal: o.signal,
        });
        cost += log(file, true, result.usage, Math.round(performance.now() - started));
        modelVersion = result.modelVersion;
        parts.push(parseExtraction(result.data));
      }
      // 마지막 조각을 기다리는 동안 취소했거나 다른 화가 멈췄을 수 있다. 늦게 온 성공 응답으로 기존 분석을 덮어쓰지 않는다
      // (이 화는 저장하지 않고 완료로 세지 않는다. 보낸 조각의 호출 기록과 비용은 위에서 남겼다)
      if (!mayContinue()) return;
      const extraction = mergeExtractions(parts);
      const { facts, dropped } = checkQuotes(extraction, lines);
      o.store.saveAnalysis({
        file,
        contentHash: hash,
        model: o.model,
        modelVersion,
        promptVersion: PROMPT_VERSION,
        chunks: chunks.length,
        summary: extraction.summary,
        droppedQuotes: dropped.length,
        costUsd: cost,
        createdAt: now().toISOString(),
        entities: extraction.entities,
        facts,
      });
    } catch (e) {
      const usage = (e as { usage?: Usage }).usage;
      if (usage) log(file, false, usage, Math.round(performance.now() - started));
      if (o.signal.aborted) {
        progress.stopped ??= '취소했습니다';
        return;
      }
      const error = toAiError(e);
      progress.failed.push({ file, message: error.message });
      if (STOP_KINDS.has(error.kind)) {
        progress.stopped ??= error.message;
        return;
      }
    }
    progress.done++;
  };

  report();
  await Promise.all(Array.from({ length: Math.min(o.concurrency ?? CONCURRENCY, files.length) }, worker));
  report();
  return progress;
}
