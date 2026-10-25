// AI 설정 (M3-PLAN 1절): API 키 저장·삭제, 모델 선택, 연결 확인, 이 프로젝트에서 쓴 비용.
// 저장한 키는 다시 볼 수 없다 (main만 읽는다).

import { useEffect, useState } from 'react';
import type { AiStatus } from '../../preload/api.ts';

const api = window.loreweave;

interface Props {
  totalCostUsd: number;
  onClose(): void;
  onChange(status: AiStatus): void;
}

export function SettingsDialog({ totalCostUsd, onClose, onChange }: Props) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [key, setKey] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void api.ai.status().then(setStatus);
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
      setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  };

  if (!status) return null;
  return (
    <div className="modal-backdrop" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <section className="modal" role="dialog" aria-modal="true" aria-label="AI 설정">
        <h2>AI 설정</h2>
        <p className="muted">
          AI 분석은 작가가 버튼을 누를 때만, 그 화의 본문을 OpenAI로 보냅니다. 비용은 작가의 OpenAI 계정에 청구됩니다.
        </p>

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

        <p className="muted">이 프로젝트에서 AI에 쓴 비용: ${totalCostUsd.toFixed(4)}</p>
        <div className="row end">
          <button type="button" onClick={onClose}>
            닫기
          </button>
        </div>
      </section>
    </div>
  );
}
