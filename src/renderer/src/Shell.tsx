// IDE 셸의 작은 부품: 활동 막대와 열린 화 탭 (DESIGN-SPEC 2절, 5절). 상태는 App이 갖고 여기는 그리기만 한다.
// 탭은 "열린 파일 이름"만 안다. 에디터는 지금 화 하나만 마운트되고, 저장·충돌·저장 실패 보호는 App의 기존 경로(leave/flush)가 맡는다.

import { type KeyboardEvent, type ReactNode, useEffect, useRef } from 'react';

function Icon({ children }: { children: ReactNode }) {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

interface ActivityProps {
  /** 검색 결과를 보는 중인가 (탐색기 자리를 검색이 대신한다) */
  searching: boolean;
  onExplorer(): void;
  onSearch(): void;
  onSettings(): void;
}

/** 실제로 동작하는 보기만 둔다: 원고(탐색기) · 검색 · 설정 */
export function ActivityBar({ searching, onExplorer, onSearch, onSettings }: ActivityProps) {
  return (
    <nav className="activitybar" aria-label="보기">
      <button type="button" className={searching ? '' : 'on'} aria-label="원고 화 목록" aria-pressed={!searching} title="원고 화 목록" onClick={onExplorer}>
        <Icon>
          <path d="M6 3h9l4 4v14H6z" />
          <path d="M14 3v5h5" />
        </Icon>
      </button>
      <button type="button" className={searching ? 'on' : ''} aria-label="검색 보기" aria-pressed={searching} title="원고 검색 (Ctrl+Shift+F)" onClick={onSearch}>
        <Icon>
          <circle cx="11" cy="11" r="6" />
          <path d="m20 20-4.2-4.2" />
        </Icon>
      </button>
      <button type="button" className="bottom" aria-label="설정" title="환경설정" onClick={onSettings}>
        <Icon>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
        </Icon>
      </button>
    </nav>
  );
}

interface TabsProps {
  tabs: string[];
  current: string | null;
  titleOf(file: string): string;
  /** 원고 조작 중(프로젝트 전환·새 화)에는 탭 조작을 막는다 */
  disabled: boolean;
  onSelect(file: string): void;
  onClose(file: string): void;
}

/**
 * 포커스된 탭 닫기 버튼의 탭이 사라져 포커스가 BODY로 잃어졌다면 남은 알맞은 컨트롤로 되돌린다: 현재 탭 버튼, 없으면 화 목록, 없으면 검색창.
 * 이미 다른 곳(검색창·편집기 등)에 포커스가 있으면 건드리지 않는다: 뒤늦은 복구가 사용자가 옮긴 포커스를 빼앗지 않는다
 */
function restoreFocusIfLost() {
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected) return;
  const target =
    document.querySelector<HTMLElement>('.tabs [role="tab"][aria-selected="true"]:not([disabled])') ??
    document.querySelector<HTMLElement>('.tabs [role="tab"]:not([disabled])') ??
    document.querySelector<HTMLElement>('nav[aria-label="화 목록"]:not([hidden]) button:not([disabled])') ??
    document.querySelector<HTMLElement>('input[aria-label="원고 검색"]');
  target?.focus();
}

export function ChapterTabs({ tabs, current, titleOf, disabled, onSelect, onClose }: TabsProps) {
  /** 포커스된 탭 닫기 버튼으로 닫은 탭의 파일 이름 (포커스 복구용) */
  const closing = useRef<string | null>(null);
  // 포커스된 닫기 버튼의 탭이 목록에서 빠져 포커스가 BODY로 사라졌다면, 남은 알맞은 컨트롤로 되돌린다.
  // 닫기가 거절돼 탭이 남았거나, 그 사이 사용자가 다른 곳으로 포커스를 옮겼다면(BODY가 아니면) 건드리지 않는다: 뒤늦은 복구가 포커스를 빼앗지 않는다
  useEffect(() => {
    const closed = closing.current;
    if (closed === null || tabs.includes(closed)) return;
    closing.current = null;
    restoreFocusIfLost();
  }, [tabs, current]);
  // 마지막 탭을 닫으면 App이 탭 줄 자체를 내려 위 효과가 돌지 않는다: 내려갈 때 같은 복구를 한다
  useEffect(
    () => () => {
      if (closing.current !== null) restoreFocusIfLost();
    },
    [],
  );
  // 방향키는 탭 사이로 포커스만 옮긴다 (활성화는 Enter/Space: 탭을 바꾸면 현재 화를 저장하므로 포커스 이동만으로 바꾸지 않는다)
  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const list = Array.from(e.currentTarget.parentElement!.parentElement!.querySelectorAll<HTMLElement>('[role="tab"]'));
    const at = list.indexOf(e.currentTarget);
    const next = e.key === 'ArrowRight' ? at + 1 : e.key === 'ArrowLeft' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (next === null) return;
    e.preventDefault();
    list[(next + list.length) % list.length]?.focus();
  };
  return (
    <div className="tabs" role="tablist" aria-label="열린 화">
      {tabs.map((f) => {
        const title = titleOf(f);
        const on = f === current;
        return (
          <div key={f} className={on ? 'tab current' : 'tab'} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={on}
              tabIndex={on ? 0 : -1}
              title={`chapters/${f}`}
              disabled={disabled}
              onClick={() => onSelect(f)}
              onKeyDown={onKeyDown}
              onAuxClick={(e) => e.button === 1 && onClose(f)}
            >
              {title}
            </button>
            <button type="button" className="tab-close" aria-label={`탭 닫기: ${title}`} title="탭 닫기" disabled={disabled}
              onClick={(e) => {
                // 포커스된 이 버튼에서 닫을 때만 기억한다 (가운데 클릭·팔레트 닫기는 포커스를 건드리지 않는다)
                if (document.activeElement === e.currentTarget) closing.current = f;
                onClose(f);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
