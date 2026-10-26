// 실험 runner의 비공개 원래 응답 보존 (M10-DIAGNOSIS.md 5절 "최소 검증 1"). 기본은 꺼져 있고, runner가 켤 때만 쓴다.
// 제품 코드(checker·verify)는 바꾸지 않는다. runner의 AI 클라이언트를 한 겹 감싸, 실제로 보낸 시도마다 다음을 저장소 밖 작업 폴더에 남긴다:
//   - 회차·화·묶음·시도 번호, 요청 fingerprint(sha256), 모델, 판단 프롬프트 버전과 시스템 프롬프트 sha256
//   - 결과: response(원래 응답 JSON, 검증·합치기 전), error(응답 없음, 오류 종류만), aborted(취소로 끊김)
// 키·헤더·인증 정보는 받지 않는다 (클라이언트에 넘기는 call만 본다). 오류 메시지는 남기지 않는다 (종류만).
// 원래 응답에는 원고 인용이 들어 있으므로, 이 파일은 저장소 밖 작업 폴더에만 둔다. 공개 로그에는 쓰지 않는다.
// 기록에 실패하면 그 시도를 실패로 돌려 runner의 공유 중단이 새 요청을 멈추게 한다. 응답의 usage는 오류에 붙여 장부가 정확히 정산하게 한다.

import { closeSync, fsyncSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Usage } from '../../src/core/ai/cost.ts';
import { toAiError, type AiClient, type JsonCall, type JsonResult } from '../../src/main/ai-client.ts';
import { sha256 } from './m9-preflight.ts';

export type RawOutcome = 'response' | 'error' | 'aborted';

export interface RawAttempt {
  type: 'attempt';
  run: string;
  file: string | null;
  batch: number | null;
  /** 같은 회차·같은 요청을 보낸 차례 (재시도면 2) */
  attempt: number;
  /** 이 기록기 안에서 보낸 순서와 끝난 순서 (동시에 보낸 묶음이 거꾸로 끝나도 귀속은 요청 fingerprint로 한다) */
  seqStart: number;
  seqEnd: number;
  userSha: string;
  systemSha: string;
  model: string;
  promptVersion: string;
  outcome: RawOutcome;
  errorKind?: string;
  data?: unknown;
  usage?: Usage;
  modelVersion?: string;
}

/** 회차를 시작할 때 남기는 화별 계획 (위치 검증을 다시 할 때 근거로 받을 수 있는 앞 화 번호) */
export interface RawPlan {
  type: 'plan';
  run: string;
  file: string;
  batches: number;
  factChapters: number[];
  /** 이 검사에 쓴 입력의 본문 해시 (대상 화가 먼저, 그다음 앞 화). 재생 전에 지금 원고와 대조한다 */
  inputs: { file: string; contentHash: string }[];
}

/**
 * 이번 회차가 이 화의 검사 결과를 실제로 저장했다는 기록. 회차 복사본에는 기준 폴더의 예전 검사 기록이 그대로 있으므로,
 * 재생은 이 기록과 DB의 검사 기록(시각·프롬프트 버전·본문 해시·사실 수·결과 fingerprint)이 맞을 때만 이번 저장으로 센다
 */
export interface RawSaved {
  type: 'saved';
  run: string;
  file: string;
  createdAt: string;
  promptVersion: string;
  contentHash: string;
  factCount: number;
  findingsSha: string;
}

/** 같은 회차에 본문이 같은 요청이 둘 이상이면 그 이유. 요청 본문(fingerprint)만으로는 어느 묶음의 응답인지 가릴 수 없다 */
export function ambiguousRequests(plans: { file: string; users: string[] }[]): string | null {
  const seen = new Map<string, string>();
  for (const p of plans)
    for (const [batch, u] of p.users.entries()) {
      const k = sha256(u);
      const where = `${p.file} 묶음 ${batch + 1}`;
      if (seen.has(k)) return `본문이 같은 요청이 있어 응답을 묶음별로 가릴 수 없습니다: ${seen.get(k)}, ${where}`;
      seen.set(k, where);
    }
  return null;
}

/** 기록하지 못했다. 응답이 있었으면 usage를 붙여 장부가 정확히 정산한다 */
export class RawRecordError extends Error {
  constructor(
    message: string,
    readonly usage?: Usage,
  ) {
    super(`원래 응답을 기록하지 못해 멈춥니다: ${message}`);
  }
}

/** 한 줄을 덧붙이고 fsync한다 (끊겨도 앞 줄이 남는다) */
function appendLine(path: string, value: unknown) {
  const fd = openSync(path, 'a');
  try {
    writeSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export function rawRecorder(dir: string, promptVersion: string, write: (path: string, value: unknown) => void = appendLine) {
  mkdirSync(dir, { recursive: true });
  let run: string | null = null;
  let requests = new Map<string, { file: string; batch: number }>();
  let attempts = new Map<string, number>();
  let seq = 0;
  const path = () => join(dir, `${run}.jsonl`);

  /** 회차를 시작한다. requests: 이 회차에 보낼 요청(사용자 입력)의 화·묶음 */
  const startRun = (label: string, plans: { file: string; users: string[]; factChapters: number[]; inputs: { file: string; contentHash: string }[] }[]) => {
    // 본문이 같은 요청을 조용히 마지막 묶음으로 귀속하지 않는다 (runner는 연결 전 사전 대조에서 이미 거부한다)
    const ambiguous = ambiguousRequests(plans);
    if (ambiguous) throw new RawRecordError(ambiguous);
    run = label;
    requests = new Map();
    attempts = new Map();
    for (const p of plans) {
      p.users.forEach((u, batch) => requests.set(sha256(u), { file: p.file, batch }));
      write(path(), { type: 'plan', run: label, file: p.file, batches: p.users.length, factChapters: p.factChapters, inputs: p.inputs } satisfies RawPlan);
    }
  };

  const wrap = (client: AiClient): AiClient => ({
    check: (m) => client.check(m),
    async json(call: JsonCall): Promise<JsonResult> {
      if (!run) throw new RawRecordError('회차를 시작하지 않았습니다');
      const userSha = sha256(call.user);
      const where = requests.get(userSha);
      const attempt = (attempts.get(userSha) ?? 0) + 1;
      attempts.set(userSha, attempt);
      const base = {
        type: 'attempt' as const,
        run,
        file: where?.file ?? null,
        batch: where?.batch ?? null,
        attempt,
        seqStart: ++seq,
        userSha,
        systemSha: sha256(call.system),
        model: call.model,
        promptVersion,
      };
      let result: JsonResult;
      try {
        result = await client.json(call);
      } catch (e) {
        const entry: RawAttempt = { ...base, seqEnd: ++seq, outcome: call.signal?.aborted ? 'aborted' : 'error', errorKind: toAiError(e).kind };
        try {
          write(path(), entry);
        } catch (w) {
          throw new RawRecordError(w instanceof Error ? w.message : String(w), (e as { usage?: Usage }).usage);
        }
        throw e;
      }
      const entry: RawAttempt = { ...base, seqEnd: ++seq, outcome: 'response', data: result.data, usage: result.usage, modelVersion: result.modelVersion };
      try {
        write(path(), entry);
      } catch (w) {
        throw new RawRecordError(w instanceof Error ? w.message : String(w), result.usage);
      }
      return result;
    },
  });
  /** 이번 회차가 이 화를 저장했음을 남긴다 (runner가 저장 직후 DB에서 읽은 값) */
  const markSaved = (saved: Omit<RawSaved, 'type' | 'run'>) => {
    if (!run) throw new RawRecordError('회차를 시작하지 않았습니다');
    write(path(), { type: 'saved', run, ...saved } satisfies RawSaved);
  };
  return { startRun, wrap, markSaved };
}
