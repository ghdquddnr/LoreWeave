// AI 분석·검사 컨트롤러 (M3-PLAN 1절, M4-PLAN 1절, DESIGN P4). 작가가 시킬 때만 실행한다. 도구줄·탐색기·명령 팔레트가 모두 이 컨트롤러 하나를 거친다.
//   - 모든 실행은 "AI 실행 확인" 하나로 먼저 보여 준다: 보낼 내용의 범위, 현재 모델, main이 계산한 예상 비용(상한). 비용 확인은 실행마다 한다.
//   - 전송 동의는 처음 필요한 실행에서만 같은 창에 함께 묻는다. 취소하면 아무것도 보내지 않고 기존 동의 상태도 그대로다 (동의는 [동의하고 실행]을 누를 때 저장한다).
//   - 진행: n/전체, 지금까지 비용, [취소]. 일부 실패한 화는 [다시 분석]으로 같은 확인을 거쳐 다시 시킨다.
//   - 확인 창을 띄우는 동안 늦게 온 계획·프로젝트 변경은 request 번호로 버린다. 확인·실행 중에는 새 실행을 시작하지 않는다 (중복 실행 0).

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { AnalysisState, AnalyzeProgress, CheckOutcome, CheckPlan } from '../../preload/api.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { modalKeyDown, useModalFocus } from './useModal.ts';
import { type FriendlyError, friendlyError } from './userError.ts';

const api = window.loreweave;

interface Props {
  file: string | null;
  /** 이 막대를 띄운 프로젝트의 token. 분석·검사 요청에 함께 보낸다 (그사이 프로젝트가 바뀌면 main이 거절한다) */
  projectToken: number;
  states: Record<string, AnalysisState>;
  consent: boolean;
  /** 분석 전에 현재 화를 저장한다 (분석은 저장된 파일을 읽는다) */
  beforeAnalyze(): Promise<unknown>;
  onAnalyzed(): void;
  onNeedKey(): void;
  /** 입력을 잠그고, 한 번만 푸는 함수를 돌려준다 (확인 뒤 마지막 저장·재계산·전송 사이에 새 입력이 범위·비용 확인을 우회하지 못하게) */
  lockInput(): () => void;
  /**
   * 버튼을 놓을 자리 두 곳. 컨트롤러는 이 컴포넌트 하나뿐이고, 같은 컴포넌트가 portal로 두 자리에 그린다
   * (에디터 도구줄: 이 화 분석·이 화 검사 / 탐색기 "AI 작업": 남은 화 분석과 진행·결과). 자리가 없으면 그 버튼은 그리지 않는다.
   */
  toolbarSlot: HTMLElement | null;
  explorerSlot: HTMLElement | null;
}

/** 명령 팔레트가 같은 컨트롤러를 부르는 입구 */
export interface AnalysisBarHandle {
  analyzeCurrent(): void;
  analyzePending(): void;
  checkCurrent(): void;
  /** 확인 중·계산 중·실행 중이면 새 실행을 시작하지 않는다 */
  isBusy(): boolean;
}

type Plan =
  | { kind: 'analysis'; files: string[]; chars: number; costUsd: number }
  | { kind: 'check'; file: string; plan: CheckPlan };

interface ConfirmDialog {
  plan: Plan;
  /** 지금 설정된 모델 이름 */
  model: string;
  /** 처음 필요한 실행이라 같은 창에서 전송 동의도 받는다 */
  needsConsent: boolean;
}

type Result = { kind: 'analysis'; progress: AnalyzeProgress } | { kind: 'check'; outcome: CheckOutcome };

export const AnalysisBar = forwardRef<AnalysisBarHandle, Props>(function AnalysisBar(
  { file, projectToken, states, consent, beforeAnalyze, onAnalyzed, onNeedKey, lockInput, toolbarSlot, explorerSlot },
  ref,
) {
  const [dialog, setDialog] = useState<ConfirmDialog | null>(null);
  const [planning, setPlanning] = useState(false);
  /** 확인 뒤 동의 저장·저장·재계산을 기다리는 중 */
  const [starting, setStarting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [running, setRunning] = useState<'analysis' | 'check' | null>(null);
  const [error, setError] = useState<FriendlyError | null>(null);
  /** 실패한 시작을 처음부터(계획 → 확인) 다시 한다 */
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const unlock = () => {
    releaseRef.current?.();
    releaseRef.current = null;
  };
  const requestSeq = useRef(0);
  const consentRef = useRef(consent);
  consentRef.current = consent;
  const busyRef = useRef(false);
  busyRef.current = planning || starting || running !== null || dialog !== null;
  const dialogEl = useRef<HTMLElement>(null);
  const pending = Object.entries(states)
    .filter(([, s]) => s !== 'fresh')
    .map(([f]) => f);

  useEffect(() => api.ai.onProgress(setProgress), []);
  // 프로젝트가 바뀌면 이전 프로젝트의 계획·확인 창은 버린다 (늦게 온 계획이 새 프로젝트에서 열리지 않게)
  useEffect(() => {
    requestSeq.current++;
    unlock();
    setDialog(null);
    setPlanning(false);
    setStarting(false);
  }, [projectToken]);
  useEffect(
    () => () => {
      requestSeq.current++;
      unlock();
    },
    [],
  );
  useModalFocus(dialogEl, dialog !== null);

  const execute = async (kind: 'analysis' | 'check', work: () => Promise<Result>, unsavedText: string) => {
    setDialog(null);
    setRunning(kind);
    setError(null);
    setRetry(null);
    setProgress(null);
    setResult(null);
    try {
      // 저장하지 못했으면(충돌·저장 거절) 보내지 않는다: 승인한 범위·비용은 저장된 원고 기준이다
      if ((await beforeAnalyze()) === false) throw new Error(unsavedText);
      const sending = work(); // 요청은 여기서 바로 나간다
      unlock(); // 보낸 뒤에는 입력을 다시 받는다 (이후의 입력은 이미 보낸 요청에 들어가지 않는다)
      setResult(await sending);
    } catch (e) {
      setError(friendlyError(e));
    } finally {
      unlock();
      setRunning(null);
      onAnalyzed();
    }
  };

  const analyze = (files: string[], unsavedText: string) =>
    execute('analysis', async () => ({ kind: 'analysis', progress: await api.ai.analyze(files, projectToken) }), unsavedText);
  const check = (target: string, unsavedText: string) =>
    execute('check', async () => ({ kind: 'check', outcome: await api.ai.runCheck(target, projectToken) }), unsavedText);

  /** 키를 확인하고, main이 계산한 계획(범위·비용 상한)을 받아 확인 창을 연다. 아무것도 보내지 않는다 */
  const begin = async (build: () => Promise<Plan>) => {
    if (busyRef.current) return;
    const mine = ++requestSeq.current;
    setError(null);
    setNotice(null);
    setRetry(null);
    setPlanning(true);
    try {
      const status = await api.ai.status();
      if (mine !== requestSeq.current) return;
      if (!status.hasKey) return onNeedKey();
      const plan = await build();
      if (mine !== requestSeq.current) return;
      const model = status.models.find((m) => m.id === status.model)?.label ?? status.model;
      setDialog({ plan, model, needsConsent: !consentRef.current });
    } catch (e) {
      if (mine === requestSeq.current) {
        setError(friendlyError(e));
        setRetry(() => () => void begin(build));
      }
    } finally {
      if (mine === requestSeq.current) setPlanning(false);
    }
  };

  /** 확인 창의 범위·비용은 저장된 원고 기준이다 (분석은 저장된 파일을 읽는다). 그래서 계획을 계산하기 전에 먼저 저장하고, 저장할 수 없으면 계획도 전송도 하지 않는다 */
  const unsavedMessage = (p: Plan) => `저장하지 못해 ${p.kind === 'check' ? '검사를' : '분석을'} 시작하지 않았습니다. 작성한 내용은 화면에 그대로 있습니다.`;
  const startAnalysis = (files: string[]) => {
    if (files.length === 0) return;
    void begin(async () => {
      if ((await beforeAnalyze()) === false) throw new Error(unsavedMessage({ kind: 'analysis', files, chars: 0, costUsd: 0 }));
      return { kind: 'analysis', files, ...(await api.ai.estimate(files, projectToken)) };
    });
  };

  const startCheck = (target: string) =>
    void begin(async () => {
      if ((await beforeAnalyze()) === false) throw new Error(unsavedMessage({ kind: 'check', file: target, plan: { analyze: [], priors: 0, batches: 1, costUsd: 0 } }));
      return { kind: 'check', file: target, plan: await api.ai.planCheck(target, projectToken) };
    });

  useImperativeHandle(ref, () => ({
    analyzeCurrent: () => file && startAnalysis([file]),
    analyzePending: () => startAnalysis(pending),
    checkCurrent: () => file && startCheck(file),
    isBusy: () => busyRef.current,
  }));

  /** 확인 창을 연 뒤 원고·모델이 달라졌는지 본다: 범위·비용 상한이나 모델이 다르면 보내지 않고 새 값으로 다시 확인받는다 */
  const replan = async (p: Plan): Promise<Plan> =>
    p.kind === 'analysis'
      ? { kind: 'analysis', files: p.files, ...(await api.ai.estimate(p.files, projectToken)) }
      : { kind: 'check', file: p.file, plan: await api.ai.planCheck(p.file, projectToken) };
  const samePlan = (a: Plan, b: Plan) =>
    a.kind === 'analysis' && b.kind === 'analysis'
      ? a.chars === b.chars && a.costUsd === b.costUsd
      : a.kind === 'check' && b.kind === 'check' && a.plan.costUsd === b.plan.costUsd && a.plan.priors === b.plan.priors && a.plan.batches === b.plan.batches && a.plan.analyze.join() === b.plan.analyze.join();

  const confirmRun = async () => {
    const d = dialog;
    if (!d) return;
    // 동의 저장·저장·재계산을 기다리는 동안에도 새 실행을 시작하지 못하게 starting으로 막고, 그 사이 프로젝트가 바뀌면(request 번호) 보내지 않는다.
    // 또 이 구간의 새 입력이 승인한 범위·비용을 우회하지 못하게 입력을 잠근다: 마지막 저장 → 재계산 → 요청을 보내는 순간까지 (이미 받아들인 입력은 저장·재계산에 반영되고, 실패·취소·프로젝트 전환·요청 전송 뒤에는 풀린다)
    const mine = requestSeq.current;
    setDialog(null);
    setStarting(true);
    setRetry(null);
    releaseRef.current = lockInput();
    try {
      if (d.needsConsent && !consentRef.current) {
        await api.ai.setConsent(true);
        if (mine !== requestSeq.current) return;
        onAnalyzed();
      }
      // 확인한 범위·비용은 저장된 원고 기준이다: 보내기 직전에 다시 저장하고, 저장할 수 없으면 보내지 않는다
      if ((await beforeAnalyze()) === false) throw new Error(unsavedMessage(d.plan));
      const [fresh, status] = await Promise.all([replan(d.plan), api.ai.status()]);
      if (mine !== requestSeq.current) return;
      const model = status.models.find((m) => m.id === status.model)?.label ?? status.model;
      if (!samePlan(d.plan, fresh) || model !== d.model) {
        // 확인 뒤 원고나 모델이 달라졌다: 보내지 않고 새 값으로 다시 확인받는다
        setError(null);
        setNotice('확인한 뒤 원고 내용이나 모델이 달라져 범위와 비용을 다시 확인합니다. 아직 아무것도 보내지 않았습니다.');
        setDialog({ plan: fresh, model, needsConsent: false });
        return;
      }
      // 같은 값이 확인됐다: 요청을 보내는 순간까지 잠금을 유지하고(execute가 보낸 직후 푼다) 실행한다
      if (d.plan.kind === 'analysis') await analyze(d.plan.files, unsavedMessage(d.plan));
      else await check(d.plan.file, unsavedMessage(d.plan));
    } catch (e) {
      // 확인 뒤의 어떤 단계가 실패해도 조용히 닫지 않는다: 사용자용 안내와 기술 상세, 다시 시도. (프로젝트가 바뀐 뒤의 늦은 오류는 보이지 않는다)
      if (mine === requestSeq.current) {
        setError(friendlyError(e));
        setRetry(() => () => (d.plan.kind === 'analysis' ? startAnalysis(d.plan.files) : startCheck(d.plan.file)));
      }
    } finally {
      unlock();
      setStarting(false);
    }
  };

  const cancelConfirm = () => {
    // 취소: 아무것도 보내지 않고 동의 상태도 그대로 둔다
    requestSeq.current++;
    setDialog(null);
  };

  const idle = !planning && !starting && !running && !dialog;
  const plan = dialog?.plan;

  return (
    <>
      {toolbarSlot &&
        createPortal(
          <div className="row">
            <button type="button" disabled={!idle || !file} onClick={() => file && startAnalysis([file])}>
              이 화 분석
            </button>
            <button type="button" disabled={!idle || !file} onClick={() => file && startCheck(file)}>
              이 화 검사
            </button>
          </div>,
          toolbarSlot,
        )}
      {explorerSlot &&
        createPortal(
          <div className="analysis">
            <div className="row">
              <button type="button" disabled={!idle || pending.length === 0} onClick={() => startAnalysis(pending)}>
                남은 화 분석 ({pending.length})
              </button>
            </div>
            {notice && (
              <p className="warning" role="status">
                {notice}
              </p>
            )}
            {(planning || starting) && !running && (
              <p className="muted" role="status">
                {planning ? '실행 계획을 계산하는 중… (아직 아무것도 보내지 않았습니다)' : '실행을 준비하는 중… (저장하고 확인합니다)'}
              </p>
            )}
            {running && (
              <p className="muted" role="status">
                {running === 'check' && (!progress || progress.done === progress.total)
                  ? '검사 중…'
                  : `${running === 'check' ? '검사 전 분석' : '분석'} 중 ${progress?.done ?? 0}/${progress?.total ?? '…'}`}
                {progress && ` · $${progress.costUsd.toFixed(4)}`}{' '}
                <button type="button" className="link" onClick={() => void api.ai.cancel()}>
                  취소
                </button>
              </p>
            )}
            {!running && result?.kind === 'analysis' && (
              <>
                <p className={result.progress.stopped || result.progress.failed.length ? 'warning' : 'muted'} role="status">
                  화 {result.progress.done}개 분석 · ${result.progress.costUsd.toFixed(4)}
                  {result.progress.stopped && ` · 멈춤: ${friendlyError(result.progress.stopped).summary}`}
                  {result.progress.failed.length > 0 && ` · 실패 ${result.progress.failed.map((f) => `${f.file} (${friendlyError(f.message).summary})`).join(', ')}`}
                </p>
                {result.progress.failed.length > 0 && idle && (
                  <button type="button" className="link" onClick={() => startAnalysis(result.progress.failed.map((f) => f.file))}>
                    실패한 화 {result.progress.failed.length}개 다시 분석
                  </button>
                )}
              </>
            )}
            {!running && result?.kind === 'check' && (
              <p className={result.outcome.stopped ? 'warning' : 'muted'} role="status">
                {result.outcome.checked
                  ? `검사 완료: 문제 가능성 ${result.outcome.findings}개${result.outcome.lowConfidence ? ` (확신이 낮아 숨긴 것 ${result.outcome.lowConfidence}개)` : ''}`
                  : `검사하지 못함: ${friendlyError(result.outcome.stopped).summary}`}
                {` · $${result.outcome.costUsd.toFixed(4)}`}
                {result.outcome.analysis && ` · 먼저 분석한 화 ${result.outcome.analysis.done}개`}
              </p>
            )}
            {error && (
              <p className="error" role="alert">
                <ErrorNote
                  error={error}
                  hint="작성한 원고는 그대로입니다."
                  onRetry={retry ? () => retry() : undefined}
                />
              </p>
            )}
          </div>,
          explorerSlot,
        )}

      {dialog && plan && (
        <div className="modal-backdrop" onKeyDown={modalKeyDown(dialogEl.current, cancelConfirm)}>
          <section ref={dialogEl} tabIndex={-1} className="modal run-confirm" role="dialog" aria-modal="true" aria-label="AI 실행 확인">
            <h2>
              {plan.kind === 'check'
                ? `이 화를 앞 화 ${plan.plan.priors}개와 비교할까요?`
                : plan.files.length === 1
                  ? '이 화를 분석할까요?'
                  : `화 ${plan.files.length}개를 분석할까요?`}
            </h2>
            <dl className="plan">
              <dt>보낼 내용</dt>
              <dd>
                {plan.kind === 'analysis' ? (
                  <>
                    화 {plan.files.length}개의 본문 {plan.chars.toLocaleString()}자
                    <span className="muted"> ({plan.files.join(', ')})</span>
                  </>
                ) : (
                  <>
                    {plan.plan.analyze.length > 0 && (
                      <>
                        먼저 분석할 화 {plan.plan.analyze.length}개의 본문 <span className="muted">({plan.plan.analyze.join(', ')})</span>
                        <br />
                      </>
                    )}
                    이 화와 앞 화 {plan.plan.priors}개에서 뽑은 사실(원문 인용 포함)
                  </>
                )}
              </dd>
              <dt>모델</dt>
              <dd>{dialog.model}</dd>
              <dt>예상 비용</dt>
              <dd>
                최대 ${(plan.kind === 'analysis' ? plan.costUsd : plan.plan.costUsd).toFixed(4)}
                <span className="muted"> 넉넉하게 잡은 상한입니다. 실제 비용은 끝난 뒤 보여 줍니다.</span>
              </dd>
            </dl>
            {plan.kind === 'check' && plan.plan.batches > 1 && <p className="muted">앞 화 사실이 많아 약 {plan.plan.batches}번에 나눠 검사하고 결과를 합칩니다.</p>}
            {plan.kind === 'check' && <p className="muted">결과는 "문제 가능성"입니다. 의도한 설정 변화일 수 있으니 근거를 보고 판단하세요.</p>}
            {dialog.needsConsent ? (
              <p className="consent-box">
                <strong>원고가 OpenAI로 전송됩니다.</strong> 위 내용이 OpenAI로 전송되고 비용은 작가의 OpenAI 계정에 청구됩니다. 버튼을 누를 때만 보내며, 이 동의는 처음 한 번만 묻습니다. 취소하면 아무것도 보내지 않습니다.
              </p>
            ) : (
              <p className="muted">[실행]을 누를 때만 위 내용을 OpenAI로 보냅니다. 취소하면 아무것도 보내지 않습니다.</p>
            )}
            <div className="row end">
              <button type="button" onClick={cancelConfirm}>
                취소
              </button>
              <button type="button" className="primary" onClick={() => void confirmRun()}>
                {dialog.needsConsent ? '동의하고 실행' : '실행'}
              </button>
            </div>
          </section>
        </div>
      )}
    </>
  );
});
