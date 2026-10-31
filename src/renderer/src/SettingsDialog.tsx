// 환경설정: 테마와 글꼴(AppearanceSettings) + AI 설정 (M3-PLAN 1절: API 키 저장·삭제, 모델 선택, 연결 확인, 이 프로젝트에서 쓴 비용).
// 저장한 키는 다시 볼 수 없다 (main만 읽는다).

import { useEffect, useRef, useState } from 'react';
import type { AiStatus } from '../../preload/api.ts';
import { AppearanceSettings } from './AppearanceSettings.tsx';
import type { AppearanceController } from './useAppearance.ts';
import { ErrorNote } from './ErrorNote.tsx';
import { type FriendlyError, friendlyError } from './userError.ts';

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

export function SettingsDialog({ appearance, totalCostUsd, hasProject, onClose, onChange }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  /** AI 상태를 읽지 못했다 (키 없음·암호화 불가와 다르다: 아직 모른다). 다시 시도로 처음부터 읽는다 (자동 재시도 없음) */
  const [statusError, setStatusError] = useState<FriendlyError | null>(null);
  const [attempt, setAttempt] = useState(0);
  const dialog = useRef<HTMLElement>(null);

  // 대화상자를 닫거나 다시 시도하면 이전 요청의 늦은 응답은 버린다
  useEffect(() => {
    let cancelled = false;
    api.ai.status().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      (e: unknown) => {
        if (cancelled) return;
        // 쓰기 오류 문구로 바뀌지 않게 안내는 고정하고, 원래 이유는 기술 상세로 둔다
        const f = friendlyError(e);
        setStatusError({ summary: 'AI 설정을 읽지 못했습니다', detail: f.detail || f.summary });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
    onChange(next);
  };

  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await task();
    } catch (e) {
      setMessage({ ok: false, text: friendlyError(e).summary });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="modal-backdrop"
      onKeyDown={(e) => {
        if (e.key === 'Escape') return onClose();
        if (e.key !== 'Tab' || !dialog.current) return;
        // 대화상자 안에서만 Tab이 돈다
        const items = Array.from(dialog.current.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled'));
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
                void run(async () => {
                  apply(await api.ai.setKey(key));
                  setKey('');
                  setMessage({ ok: true, text: '키를 저장했습니다' });
                });
              }}
            >
              <input
                type="password"
                aria-label="API 키"
                placeholder={status.hasKey ? '새 키로 바꾸기' : 'sk-…'}
                value={key}
                onChange={(e) => setKey(e.target.value)}
                autoComplete="off"
                spellCheck={false}
              />
              <button type="submit" disabled={busy || !key.trim() || !status.canEncrypt}>
                저장
              </button>
              {status.hasKey && (
                <button type="button" disabled={busy} onClick={() => void run(async () => apply(await api.ai.deleteKey()))}>
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
                onClick={() =>
                  void run(async () => {
                    const result = await api.ai.check();
                    setMessage(result.ok ? { ok: true, text: '연결됨: 이 키로 선택한 모델을 쓸 수 있습니다' } : { ok: false, text: result.message });
                  })
                }
              >
                연결 확인
              </button>
              {busy && <span className="muted">확인 중…</span>}
            </div>
            {message && (
              <p className={message.ok ? 'notice' : 'error'} role="status">
                {message.text}
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
