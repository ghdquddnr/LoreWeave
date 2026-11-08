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

/**
 * 대화상자 안에서 실제로 Tab이 멈추는 요소들 (DOM 순서). disabled·숨김은 빼고, 라디오 그룹은 선택된 하나(없으면 첫째)만 정지점이다:
 * 모든 라디오를 넣으면 선택된 라디오가 DOM의 첫 라디오가 아닐 때 "첫 요소"가 실제 Tab 진입점과 달라져 Shift+Tab이 대화상자 밖으로 샌다
 */
export function tabStops(root: HTMLElement): HTMLElement[] {
  const candidates = Array.from(root.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'));
  const usable = candidates.filter(
    (el) => !el.hasAttribute('disabled') && !el.closest('[hidden]') && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden',
  );
  const chosen = new Map<string, HTMLInputElement>();
  for (const el of usable) {
    if (el instanceof HTMLInputElement && el.type === 'radio' && el.name) {
      const group = usable.filter((o): o is HTMLInputElement => o instanceof HTMLInputElement && o.type === 'radio' && o.name === el.name);
      chosen.set(el.name, group.find((o) => o.checked) ?? group[0]!);
    }
  }
  return usable.filter((el) => !(el instanceof HTMLInputElement && el.type === 'radio' && el.name) || chosen.get(el.name) === el);
}

export function modalKeyDown(dialog: HTMLElement | null, onClose: () => void) {
  return (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      return onClose();
    }
    if (e.key !== 'Tab' || !dialog) return;
    const items = tabStops(dialog);
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
