// 모달 대화상자의 키보드 처리: 열 때 대화상자가 포커스를 받고, 닫으면 연 요소로 돌려주며, Tab이 안에서만 돈다. Esc는 onClose.
// (원고 편집기·검색창 등 대화상자 밖의 상태는 건드리지 않는다.)

import { type KeyboardEvent, type RefObject, useEffect } from 'react';

export function useModalFocus(dialog: RefObject<HTMLElement | null>, ready = true): void {
  useEffect(() => {
    if (!ready) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.focus();
    return () => {
      if (opener?.isConnected) opener.focus();
    };
  }, [dialog, ready]);
}

export function modalKeyDown(dialog: HTMLElement | null, onClose: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      return onClose();
    }
    if (e.key !== 'Tab' || !dialog) return;
    const items = Array.from(dialog.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter((el) => !el.hasAttribute('disabled'));
    const first = items[0];
    const last = items[items.length - 1];
    if (!first || !last) return;
    if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
}
