// IDE 셸의 작은 부품: 활동 막대와 열린 화 탭 (DESIGN-SPEC 2절, 5절). 상태는 App이 갖고 여기는 그리기만 한다.
// 탭은 "열린 파일 이름"만 안다. 에디터는 지금 화 하나만 마운트되고, 저장·충돌·저장 실패 보호는 App의 기존 경로(leave/flush)가 맡는다.

import type { KeyboardEvent, ReactNode } from 'react';

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

export function ChapterTabs({ tabs, current, titleOf, disabled, onSelect, onClose }: TabsProps) {
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
            <button type="button" className="tab-close" aria-label={`탭 닫기: ${title}`} title="탭 닫기" disabled={disabled} onClick={() => onClose(f)}>
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
