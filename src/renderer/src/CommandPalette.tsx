// 명령 팔레트 (Ctrl+K, DESIGN-SPEC 5.5). 지금 실제로 구현된 동작만 나열한다. 새 기능을 만들지 않고 기존 경로를 부른다.
// 키보드: ↑↓ 이동, Enter 실행, Esc 닫기. 입력란이 포커스를 가지므로 입력은 원고로 들어가지 않고, 팔레트 안의 키는 바깥(전역 단축키·에디터)으로 번지지 않는다.
// 한글 조합 중의 Enter는 조합 확정이므로 실행하지 않는다.

import { useEffect, useMemo, useRef, useState } from 'react';

export interface PaletteCommand {
  id: string;
  label: string;
  /** 보조 설명 (대상) */
  hint?: string;
  /** 지금 실제로 있는 단축키만 적는다 */
  shortcut?: string;
  /** 지금 실행할 수 없는 이유 (있으면 선택·실행되지 않는다) */
  disabled?: string;
  run(): void;
}

interface Props {
  commands: PaletteCommand[];
  /** 실행하지 않고 닫는다 */
  onCancel(): void;
  /** 명령을 골랐다: 닫은 뒤 실행한다 (실행이 포커스를 옮기므로 닫기가 먼저다) */
  onRun(command: PaletteCommand): void;
}

export function CommandPalette({ commands, onCancel, onRun }: Props) {
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => !q || `${c.label} ${c.hint ?? ''}`.toLowerCase().includes(q));
  }, [commands, query]);
  const enabled = list.filter((c) => !c.disabled);
  const current = enabled[Math.min(active, Math.max(enabled.length - 1, 0))];

  useEffect(() => input.current?.focus(), []);
  useEffect(() => setActive(0), [query]);

  const move = (delta: number) => {
    if (enabled.length === 0) return;
    setActive((a) => (Math.min(a, enabled.length - 1) + delta + enabled.length) % enabled.length);
  };

  return (
    <div
      className="modal-backdrop palette-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onCancel()}
      onKeyDown={(e) => {
        // 팔레트 안의 키는 바깥(전역 단축키, 에디터)으로 번지지 않는다
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
        // 모달 밖(헤더 버튼 등)으로 Tab이 새지 않는다: 입력란이 유일한 조작 대상이므로 Tab·Shift+Tab 모두 입력란에 머문다
        if (e.key === 'Tab') {
          e.preventDefault();
          input.current?.focus();
        }
      }}
    >
      <section className="palette" role="dialog" aria-modal="true" aria-label="명령 팔레트">
        <input
          ref={input}
          type="text"
          role="combobox"
          aria-label="명령 검색"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={current ? `palette-${current.id}` : undefined}
          placeholder="명령 찾기 (예: 새 화, 분석, 설정)"
          value={query}
          autoComplete="off"
          spellCheck={false}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              move(1);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              move(-1);
            } else if (e.key === 'Enter') {
              e.preventDefault();
              if (current) onRun(current);
            }
          }}
        />
        <ul id="palette-list" role="listbox" aria-label="명령 목록">
          {list.length === 0 && (
            <li className="palette-empty" role="presentation">
              맞는 명령이 없습니다
            </li>
          )}
          {list.map((c) => (
            <li
              key={c.id}
              id={`palette-${c.id}`}
              role="option"
              aria-selected={c === current}
              aria-disabled={c.disabled ? true : undefined}
              className={`${c === current ? 'on' : ''}${c.disabled ? ' off' : ''}`}
              onMouseMove={() => !c.disabled && setActive(Math.max(0, enabled.indexOf(c)))}
              onClick={() => !c.disabled && onRun(c)}
            >
              <span className="palette-label">{c.label}</span>
              {c.hint && <span className="muted palette-hint">{c.hint}</span>}
              {c.disabled && <span className="muted palette-hint">{c.disabled}</span>}
              {c.shortcut && <kbd>{c.shortcut}</kbd>}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
