// 오류 안내: 짧은 사용자 문구 + (있다면) 힌트와 다시 시도 + 펼쳐 볼 수 있는 기술 상세.

import { useState } from 'react';
import type { FriendlyError } from './userError.ts';

interface Props {
  error: FriendlyError;
  /** 지금 상태를 정확히 말하는 한 줄 (예: 입력은 화면에 남아 있다) */
  hint?: string;
  onRetry?(): void;
  retryLabel?: string;
  /** 앞에 붙는 설명 (예: 검사 결과를 읽지 못했습니다) */
  prefix?: string;
  /** 인라인(상태줄)으로 그린다 */
  inline?: boolean;
  /** 값이 바뀌면 펼친 기술 상세만 접는다 (별개의 새 실패). key로 다시 만들지 않아 지금 포커스된 버튼이 그대로 남는다 */
  resetKey?: number;
}

/** 문장 끝에 마침표가 없으면 붙인다 (안내와 힌트가 이어 붙지 않게) */
const sentence = (text: string) => (/[.!?。…]$/.test(text) ? text : `${text}.`);

export function ErrorNote({ error, hint, onRetry, retryLabel = '다시 시도', prefix, inline = false, resetKey }: Props) {
  const [open, setOpen] = useState(false);
  // 렌더 중 상태 보정: 새 실패(resetKey 변경)면 같은 렌더에서 접는다 (펼친 채 한 프레임 보이지 않게)
  const [seenKey, setSeenKey] = useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setOpen(false);
  }
  return (
    <span className={inline ? 'error-note inline' : 'error-note'}>
      <span aria-hidden="true">✕</span> {prefix && <>{prefix}: </>}
      {sentence(error.summary)}
      {hint && <> {sentence(hint)}</>}
      {onRetry && (
        <>
          {' '}
          <button type="button" className="link" onClick={onRetry}>
            {retryLabel}
          </button>
        </>
      )}
      {error.detail && (
        <>
          {' '}
          <button type="button" className="link" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {open ? '상세 닫기' : '기술 상세'}
          </button>
          {open && (
            <code className="tech-detail" role="note">
              {error.detail}
            </code>
          )}
        </>
      )}
    </span>
  );
}
