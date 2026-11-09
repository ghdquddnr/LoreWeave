// 환경설정: 테마와 글꼴(AppearanceSettings) + AI 설정 (M3-PLAN 1절: API 키 저장·삭제, 모델 선택, 연결 확인, 이 프로젝트에서 쓴 비용).
// 저장한 키는 다시 볼 수 없다 (main만 읽는다).

import { useEffect, useRef, useState } from 'react';
import type { AiStatus } from '../../preload/api.ts';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import type { AppearanceController } from './useAppearance.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { type FriendlyError, friendlyError } from './userError.ts';
import { tabStops } from './useModal.ts';

const api = window.loreweave;

interface Props {
  appearance: AppearanceController;
  /** 이 프로젝트의 AI 비용. null이면 아직 읽지 못했다 (읽는 중이거나 읽기에 실패): 0으로 보이지 않게 미확인으로 안내한다 */
  totalCostUsd: number | null;
  /** 열린 프로젝트가 있는가 (없으면 비용은 "미확인"이 아니라 해당 없음) */
  hasProject: boolean;
  onClose(): void;
  onChange(status: AiStatus): void;
}

/** 지금 열려 있는 환경설정 대화상자들의 상태 갱신기 (대화상자가 닫힌 뒤 도착한 응답을 새 대화상자에 전한다) */
const liveStatusUpdates = new Set<(next: AiStatus) => void>();

export function SettingsDialog({ appearance, totalCostUsd, hasProject, onClose, onChange }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  /** 작업 결과 한 줄. error는 run이 잡은 예외 실패(안내 + 접힌 기술 상세), 없으면 성공이거나 이미 사람이 쓴 안내(연결 확인 실패 등). seq는 새 결과마다 달라 접힌 상세가 이전 결과에서 이어지지 않게 한다 */
  const [message, setMessage] = useState<{ ok: boolean; text: string; error?: FriendlyError; seq: number } | null>(null);
  const messageSeq = useRef(0);
  const show = (ok: boolean, text: string, error?: FriendlyError) => setMessage({ ok, text, error, seq: ++messageSeq.current });
  const [busy, setBusy] = useState(false);
  /** AI 상태를 읽지 못했다 (키 없음·암호화 불가와 다르다: 아직 모른다). 다시 시도로 처음부터 읽는다 (자동 재시도 없음) */
  const [statusError, setStatusError] = useState<FriendlyError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLElement>(null);
  /** 상태 조회 다시 시도를 눌러 포커스를 대화상자로 옮겨 둔 상태 (재실패로 새 다시 시도 버튼이 나타나면 그 버튼으로 돌려준다) */
  const retried = useRef(false);
  // compositionstart~end 구간 (isComposing·229가 빠진 이벤트 경계도 덮는다). end에서 반드시 풀려 이전 조합이 일반 Escape를 막지 않는다
  const composing = useRef(false);
  /** 마지막 keydown이 조합에 속했다 (isComposing, 또는 IME가 처리한 키 keyCode 229). 그 키가 일으킨 form submit(조합 확정 Enter)을 걸러 낸다 */
  const composingKey = useRef(false);
  /** 이 대화상자가 저장·삭제 응답을 직접 적용했다 (그 뒤에는 다른 대화상자의 늦은 응답으로 덮지 않는다) */
  const touched = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  /** 마운트(또는 다시 시도) 조회 이후 더 최신 상태가 적용됐다 (직접 응답 또는 전달된 성공). 이 조회의 늦은 응답은 버린다 */
  const applied = useRef(false);

  // 대화상자를 닫거나 다시 시도하면 이전 요청의 늦은 응답은 버린다
  useEffect(() => {
    let cancelled = false;
    applied.current = false;
    api.ai.status().then(
      (next) => {
        // 이 조회가 나가 있는 동안 더 최신 상태(직접 저장·삭제 성공 또는 닫힌 대화상자의 늦은 성공)가 이미 적용됐다면 과거 조회 응답으로 덮지 않는다
        if (!cancelled && !applied.current) setStatus(next);
      },
      (e: unknown) => {
        if (cancelled || applied.current) return; // 이미 적용된 최신 상태를 늦은 조회 실패로 오류로 되돌리지 않는다
        // 쓰기 오류 문구로 바뀌지 않게 안내는 고정하고, 원래 이유는 기술 상세로 둔다
        const f = friendlyError(e);
        setStatusError({ summary: 'AI 설정을 읽지 못했습니다', detail: f.detail || f.summary });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  // 다시 시도가 다시 실패하면 새 다시 시도 버튼으로 포커스를 돌려준다. 그 사이 사용자가 다른 컨트롤로 옮겼다면(포커스가 대화상자 자체가 아니면) 건드리지 않는다
  useEffect(() => {
    if (!retried.current) return;
    if (status) {
      retried.current = false;
      return;
    }
    if (!statusError) return;
    retried.current = false;
    if (document.activeElement === dialog.current) dialog.current?.querySelector<HTMLElement>('.error-note button')?.focus();
  }, [status, statusError]);

  // 새로 열린 대화상자가 이전 대화상자의 늦은 성공 응답을 받는다 (이 대화상자가 직접 적용한 상태는 덮지 않는다)
  useEffect(() => {
    const update = (next: AiStatus) => {
      if (touched.current) return;
      applied.current = true;
      setStatus(next);
    };
    liveStatusUpdates.add(update);
    return () => {
      liveStatusUpdates.delete(update);
    };
  }, []);

  // 키보드 focus: 열 때 대화상자로 들어가고, 닫으면 연 버튼(또는 열기 전 포커스)으로 돌아간다
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const apply = (next: AiStatus) => {
    setStatus(next);
    touched.current = true;
    applied.current = true;
    // 저장·삭제 응답이 대화상자를 닫은 뒤 도착해도, 그 사이 새로 열린 대화상자(마운트 때 읽은 상태가 아직 최신인 것)의 키 상태를 맞춘다
    for (const update of liveStatusUpdates) update(next);
    onChange(next);
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await task();
    } catch (e) {
      const f = friendlyError(e);
      show(false, f.summary, f);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onCompositionStart={() => (composing.current = true)}
      onCompositionEnd={() => (composing.current = false)}
      onKeyDown={(e) => {
        // 조합 취소용 Escape는 입력기의 것이다: 닫지 않고 입력 초안도 지우지 않으며 기본 동작도 막지 않는다
        if (e.key === 'Escape') return composing.current || e.nativeEvent.isComposing || e.keyCode === 229 ? undefined : onClose();
        if (e.key !== 'Tab' || !dialog.current) return;
        // 대화상자 안에서만 Tab이 돈다
        const items = tabStops(dialog.current);
        const first = items[0];
        const last = items[items.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog.current)) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }}
    >
      <section ref={dialog} tabIndex={-1} className="modal settings" role="dialog" aria-modal="true" aria-label="환경설정">
        <AppearanceSettings controller={appearance} />

        <h2>AI 설정</h2>
        <p className="muted">
          AI 분석은 작가가 버튼을 누를 때만, 그 화의 본문을 OpenAI로 보냅니다. 비용은 작가의 OpenAI 계정에 청구됩니다.
        </p>

        {!status ? (
          statusError ? (
            <p className="error" role="alert">
              <ErrorNote
                error={statusError}
                hint="환경설정의 다른 항목과 원고는 그대로입니다."
                onRetry={() => {
                  // 눌린 다시 시도 버튼이 곧 사라지므로 포커스가 BODY로 잃어지지 않게 대화상자로 옮겨 둔다 (읽는 중·성공에서도 모달 안에 머문다)
                  if (dialog.current?.contains(document.activeElement)) {
                    dialog.current.focus();
                    retried.current = true;
                  }
                  setStatusError(null);
                  setAttempt((n) => n + 1);
                }}
              />
            </p>
          ) : (
            <p className="muted" role="status">
              AI 설정을 읽는 중…
            </p>
          )
        ) : (
          <>
            <h3>OpenAI API 키</h3>
            {!status.canEncrypt && <p className="error">이 컴퓨터에서는 키를 암호화해 저장할 수 없어 AI 분석을 쓸 수 없습니다.</p>}
            <p>{status.hasKey ? '저장됨 (암호화해 이 컴퓨터에만 보관)' : '없음'}</p>
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                // 조합을 확정하는 Enter가 만든 submit은 키 저장이 아니다. 조합이 끝난 뒤의 일반 Enter·마우스 [저장]은 이 플래그와 무관하게 정상이다
                if (composing.current || composingKey.current) {
                  composingKey.current = false;
                  return;
                }
                // 키보드로 누른 [저장]은 곧 disabled가 돼 포커스를 잃는다(BODY → Escape도 모달에 닿지 않음): 누른 버튼이 포커스를 가진 때만, 항상 살아 있는 키 입력창으로 옮긴다 (사용자가 다른 곳에 두었다면 건드리지 않고 늦은 응답은 포커스를 옮기지 않는다)
                if (e.currentTarget.querySelector('button[type="submit"]') === document.activeElement) keyInput.current?.focus();
                const submitted = key;
                void run(async () => {
                  apply(await api.ai.setKey(submitted));
                  // 응답을 기다리는 동안 새로 입력한 초안은 지우지 않는다: 제출한 값 그대로일 때만 비운다
                  setKey((current) => (current === submitted ? '' : current));
                  show(true, '키를 저장했습니다');
                });
              }}
            >
              <input
                ref={keyInput}
                type="password"
                aria-label="API 키"
                placeholder={status.hasKey ? '새 키로 바꾸기' : 'sk-…'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => (composingKey.current = e.nativeEvent.isComposing || e.keyCode === 229)}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" disabled={busy || !key.trim() || !status.canEncrypt} onPointerDown={() => (composingKey.current = false)}>
                저장
              </button>
              {status.hasKey && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={(e) => {
                    // 키보드로 누른 [삭제]는 곧 disabled가 되고 성공하면 사라진다(포커스가 BODY로 잃어져 Escape도 모달에 닿지 않음): 누른 버튼이 포커스를 가진 때만, 항상 살아 있는 키 입력창으로 옮긴다 (이동은 한 번뿐이라 늦은 응답은 포커스를 옮기지 않는다)
                    if (e.currentTarget === document.activeElement) keyInput.current?.focus();
                    void run(async () => apply(await api.ai.deleteKey()));
                  }}
                >
                  삭제
                </button>
              )}
            </form>

            <h3>모델</h3>
            <select
              aria-label="모델"
              value={status.model}
              disabled={busy}
              onChange={(e) => void run(async () => apply(await api.ai.setModel(e.target.value)))}
            >
              {status.models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>

            <div className="row">
              <button
                type="button"
                disabled={busy || !status.hasKey}
                onClick={(e) => {
                  // 키보드로 누른 [연결 확인]은 곧 disabled가 돼 포커스를 잃는다(BODY → Escape도 모달에 닿지 않음): 누른 버튼이 포커스를 가진 때만, 항상 살아 있는 키 입력창으로 옮긴다 (이동은 한 번뿐이라 늦은 응답은 포커스를 옮기지 않는다)
                  if (e.currentTarget === document.activeElement) keyInput.current?.focus();
                  void run(async () => {
                    const result = await api.ai.check();
                    if (result.ok) show(true, '연결됨: 이 키로 선택한 모델을 쓸 수 있습니다');
                    else show(false, result.message);
                  });
                }}
              >
                연결 확인
              </button>
              {busy && <span className="muted">확인 중…</span>}
            </div>
            {message && (
              <p className={message.ok ? 'notice' : 'error'} role="status">
                {message.error ? <ErrorNote key={message.seq} error={message.error} inline /> : message.text}
              </p>
            )}
          </>
        )}

        <p className="muted">
          이 프로젝트에서 AI에 쓴 비용:{' '}
          {!hasProject ? '원고 폴더를 열면 볼 수 있습니다' : totalCostUsd === null ? '아직 확인하지 못했습니다' : `$${totalCostUsd.toFixed(4)}`}
        </p>
        <div className="row end">
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </section>
    </div>
  );
}
