// 연속성 검사 실행 (M4-PLAN 1·4절). 작가가 [이 화 검사]를 눌렀을 때만 실행한다.
//   - 이 화와 앞 화(파일 이름 번호가 더 작은 화)가 모두 분석돼 있어야 한다. 아니면 먼저 분석한다 (M3)
//   - 앞 화 분석이 하나라도 실패하면 검사하지 않는다 (빠진 사실로 검사하면 놓친 오류가 "문제 없음"처럼 보인다)
//   - 이 화 문장과 근거 문장이 원고에 없는 결과는 저장하지 않는다 (ADR 0001 결정 2)
//   - 화 파일은 읽기만 한다

import { costUsd, estimateCheckCost, estimateExtractionTokens } from '../core/ai/cost.ts';
import {
  candidateFacts,
  CHECK_BATCH_SIZE,
  MIN_CONFIDENCE,
  DETECT_PROMPT_VERSION,
  DETECT_SCHEMA,
  DETECT_SYSTEM,
  detectionInput,
  parseDetection,
  selectFacts,
  type Finding,
  type PriorAnalysis,
  type Selection,
} from '../core/ai/detection.ts';
import { mergeFindings, quoteKey, verifyFindings, type PriorLines } from '../core/ai/verify.ts';
import { chapterNumber } from '../core/project/chapters.ts';
import { toAiError, type AiClient } from './ai-client.ts';
import type { AiStore } from './ai-db.ts';
import { analysisStates, analyzeChapters, chapterLines, estimate, type AnalysisState, type AnalyzeProgress } from './analyzer.ts';
import { chapterFileNames, chapterHash } from './project-files.ts';

export type CheckState = AnalysisState;

/** 화마다 검사 상태: 없음 / 검사 뒤 그대로 / 검사 뒤 바뀜 (이 화나 근거로 넘긴 앞 화의 본문이 바뀜) */
export async function checkStates(root: string, store: AiStore): Promise<Record<string, CheckState>> {
  const files = await chapterFileNames(root);
  const hashes = new Map(await Promise.all(files.map(async (f) => [f, await chapterHash(root, f)] as const)));
  const checked = store.checkedHashes();
  const states: Record<string, CheckState> = {};
  for (const file of files) {
    const c = checked.get(file);
    if (!c) states[file] = 'none';
    else states[file] = [{ file, contentHash: c.contentHash }, ...c.inputs].every((i) => hashes.get(i.file) === i.contentHash) ? 'fresh' : 'stale';
  }
  return states;
}

/** 검사할 화의 앞 화들 (화 순서). 번호가 없거나, 앞 화가 없거나, 번호가 겹치면 검사할 수 없다 */
async function priorFiles(root: string, file: string): Promise<string[]> {
  const n = chapterNumber(file);
  if (n === null) throw new Error('파일 이름에 화 번호가 없어 검사할 수 없습니다');
  const files = (await chapterFileNames(root)).filter((f) => chapterNumber(f) !== null && chapterNumber(f)! <= n);
  const byNumber = new Map<number, string[]>();
  for (const f of files) byNumber.set(chapterNumber(f)!, [...(byNumber.get(chapterNumber(f)!) ?? []), f]);
  const same = [...byNumber.values()].find((fs) => fs.length > 1);
  if (same) throw new Error(`화 번호가 같은 파일이 있어 검사할 수 없습니다: ${same.join(', ')}`);
  const priors = files.filter((f) => f !== file).sort((a, b) => chapterNumber(a)! - chapterNumber(b)!);
  if (priors.length === 0) throw new Error('앞 화가 없어 검사할 수 없습니다');
  return priors;
}

export interface CheckPlan {
  /** 검사 전에 분석할 화 (분석 안 됨 또는 분석 뒤 바뀜) */
  analyze: string[];
  priors: number;
  /** 앞 화 사실이 많아 나눠 검사할 횟수 (어림, 1이면 나누지 않음) */
  batches: number;
  /** 분석과 검사를 합친 예상 비용 (상한) */
  costUsd: number;
}

/** 앞 화 사실 한 줄이 입력에서 차지하는 글자 수 (detectionInput의 형식과 같게 센다) */
const factChars = (f: { entity: string; predicate: string; value: string; quote: string }) =>
  `- ${f.entity} | ${f.predicate} | ${f.value} | 원문: "${f.quote}"\n`.length;
/** 화마다 붙는 <facts chapter="N"> 줄 */
const FACT_BLOCK_CHARS = 40;
/** 분석 전인 화의 사실 수를 어림할 때 사실 한 줄의 글자 수 */
const FACT_CHARS_GUESS = 60;

export async function planCheck(root: string, store: AiStore | null, file: string, model: string): Promise<CheckPlan> {
  const priors = await priorFiles(root, file);
  const states = store ? await analysisStates(root, store) : {};
  const analyze = [...priors, file].filter((f) => states[f] !== 'fresh');
  const extraction = analyze.length ? (await estimate(root, analyze, model)).costUsd : 0;
  // 검사 입력 상한: 앞 화 사실 전부 (분석 전인 화는 추출 출력 상한만큼) + 나눠 검사하는 묶음마다 이 화 본문
  let factCount = 0;
  let factTotal = 0;
  for (const prior of priors) {
    const a = analyze.includes(prior) ? null : store!.analysis(prior);
    const chars = a
      ? a.facts.reduce((n, f) => n + factChars(f), 0)
      : estimateExtractionTokens((await chapterLines(root, prior)).lines.join('\n').length).output;
    factTotal += FACT_BLOCK_CHARS + chars;
    factCount += a ? a.facts.length : Math.ceil(chars / FACT_CHARS_GUESS);
  }
  const batches = Math.max(1, Math.ceil(factCount / CHECK_BATCH_SIZE));
  const chapterChars = (await chapterLines(root, file)).lines.join('\n').length + 200;
  // 묶음마다 출력 상한도 따로 든다
  const check = estimateCheckCost(model, factTotal + batches * chapterChars) + (batches - 1) * estimateCheckCost(model, 0);
  return { analyze, priors: priors.length, batches, costUsd: extraction + check };
}

export interface CheckOutcome {
  /** 검사 전에 분석했으면 그 결과 */
  analysis: AnalyzeProgress | null;
  checked: boolean;
  /** 패널에 보이는 결과 수 (확신도가 MIN_CONFIDENCE 이상) */
  findings: number;
  /** 확신도가 낮아 숨긴 결과 수 */
  lowConfidence: number;
  dropped: number;
  /** 분석과 검사에 쓴 비용 */
  costUsd: number;
  /** 검사하지 못했으면 그 이유 */
  stopped: string | null;
}

export interface CheckOptions {
  root: string;
  store: AiStore;
  client: AiClient;
  model: string;
  signal: AbortSignal;
  onProgress?(progress: AnalyzeProgress): void;
  now?(): Date;
  /** 앞 화 사실을 줄이는 방법 (M5 측정용, 기본은 줄이지 않음) */
  selection?: Selection;
  /** 사실이 이보다 많으면 나눠 검사한다 (기본 CHECK_BATCH_SIZE, Infinity면 나누지 않음) */
  batchSize?: number;
}

/** 나눈 묶음을 동시에 보내는 수 */
const BATCH_CONCURRENCY = 2;

export async function checkChapter(file: string, o: CheckOptions): Promise<CheckOutcome> {
  const now = o.now ?? (() => new Date());
  const outcome: CheckOutcome = { analysis: null, checked: false, findings: 0, lowConfidence: 0, dropped: 0, costUsd: 0, stopped: null };
  const stop = (reason: string) => ({ ...outcome, stopped: reason });

  const plan = await planCheck(o.root, o.store, file, o.model);
  if (plan.analyze.length) {
    const progress = await analyzeChapters(plan.analyze, o);
    outcome.analysis = progress;
    outcome.costUsd += progress.costUsd;
    if (progress.stopped) return stop(progress.stopped);
    if (progress.failed.length) return stop(`분석하지 못한 화가 있어 검사하지 않았습니다: ${progress.failed.map((f) => f.file).join(', ')}`);
  }
  if (o.signal.aborted) return stop('취소했습니다');

  const priors = await priorFiles(o.root, file);
  const target = await chapterLines(o.root, file);
  const targetAnalysis = o.store.analysis(file);
  if (!targetAnalysis || targetAnalysis.contentHash !== target.hash) return stop('분석한 뒤 본문이 바뀌었습니다. 다시 검사하세요');
  const priorAnalyses: PriorAnalysis[] = [];
  const inputs: { file: string; contentHash: string }[] = [];
  for (const prior of priors) {
    const a = o.store.analysis(prior);
    if (!a) return stop(`분석하지 않은 앞 화가 있습니다: ${prior}`);
    priorAnalyses.push({ chapter: chapterNumber(prior)!, entities: a.entities, facts: a.facts });
    inputs.push({ file: prior, contentHash: a.contentHash });
  }
  const facts = selectFacts(candidateFacts(targetAnalysis.entities, priorAnalyses), o.selection ?? 'all');
  // 사실이 많으면 batchSize개씩 나눠 따로 검사하고 결과를 합친다 (M5: 입력이 길면 모델이 모순을 덜 알아본다)
  const size = o.batchSize ?? CHECK_BATCH_SIZE;
  const batches = facts.length > size ? Array.from({ length: Math.ceil(facts.length / size) }, (_, i) => facts.slice(i * size, (i + 1) * size)) : [facts];

  /** 묶음 하나를 검사한다. 실패하면 그 이유를 돌려준다 */
  const detect = async (batch: typeof facts): Promise<{ findings: Finding[]; modelVersion: string } | string> => {
    const started = performance.now();
    try {
      const result = await o.client.json({
        model: o.model,
        system: DETECT_SYSTEM,
        user: detectionInput(file, target.lines, batch),
        schema: DETECT_SCHEMA,
        signal: o.signal,
      });
      const cost = costUsd(o.model, result.usage);
      outcome.costUsd += cost;
      checkCost += cost;
      o.store.logCall({ at: now().toISOString(), file, model: o.model, ok: true, usage: result.usage, costUsd: cost, latencyMs: Math.round(performance.now() - started), kind: 'check' });
      try {
        return { findings: parseDetection(result.data), modelVersion: result.modelVersion };
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    } catch (e) {
      const usage = (e as { usage?: Parameters<typeof costUsd>[1] }).usage;
      if (usage) {
        const cost = costUsd(o.model, usage);
        outcome.costUsd += cost;
        checkCost += cost;
        o.store.logCall({ at: now().toISOString(), file, model: o.model, ok: false, usage, costUsd: cost, latencyMs: Math.round(performance.now() - started), kind: 'check' });
      }
      return o.signal.aborted ? '취소했습니다' : toAiError(e).message;
    }
  };
  let checkCost = 0;
  const results: Awaited<ReturnType<typeof detect>>[] = [];
  const queue = [...batches.entries()];
  await Promise.all(
    Array.from({ length: Math.min(BATCH_CONCURRENCY, queue.length) }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) results[next[0]] = await detect(next[1]);
    }),
  );
  const failed = results.find((r): r is string => typeof r === 'string');
  if (failed) return stop(failed);
  const done = results as { findings: Finding[]; modelVersion: string }[];

  // 근거로 들 수 있는 화는 사실을 넘긴 앞 화뿐이다
  const priorLines: PriorLines = new Map();
  for (const n of new Set(facts.map((f) => f.chapter))) {
    const prior = priors.find((f) => chapterNumber(f) === n)!;
    priorLines.set(n, { file: prior, lines: (await chapterLines(o.root, prior)).lines });
  }
  const verified = verifyFindings(
    done.flatMap((d) => d.findings),
    target.lines,
    priorLines,
  );
  const keyed = verified.findings.map((f) => ({ ...f, key: quoteKey(target.lines[f.target.line]!.slice(f.target.start, f.target.end)) }));
  const findings = mergeFindings(keyed);
  o.store.saveCheck({
    file,
    contentHash: target.hash,
    model: o.model,
    modelVersion: done[0]!.modelVersion,
    promptVersion: DETECT_PROMPT_VERSION,
    factCount: facts.length,
    dropped: verified.dropped.length,
    costUsd: checkCost,
    createdAt: now().toISOString(),
    inputs,
    findings,
  });
  const shown = findings.filter((f) => f.confidence >= MIN_CONFIDENCE).length;
  return { ...outcome, checked: true, findings: shown, lowConfidence: findings.length - shown, dropped: verified.dropped.length };
}
