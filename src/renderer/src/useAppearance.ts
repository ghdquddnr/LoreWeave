// 외관 설정의 renderer 쪽 상태. 화면에는 바로 적용하고 저장은 main에 맡긴다.
// 저장 요청은 한 번에 하나만 보내고(빠른 슬라이더 입력은 마지막 값으로 합친다), 실패한 변경은 `unsaved`에 남겨 다음 저장 때 함께 다시 보낸다.
// 에디터 컴포넌트는 이 상태와 무관하다: <html>의 속성·CSS 변수만 바뀌므로 문서·선택·undo·미저장 입력이 그대로다.

import { useCallback, useEffect, useRef, useState } from 'react';
import { type AppearanceSettings, DEFAULT_APPEARANCE } from '../../core/appearance.ts';
import type { AppearanceBootstrap } from '../../preload/api.ts';
import { applyAppearance } from './applyAppearance.ts';

export interface AppearanceController {
  appearance: AppearanceSettings;
  systemDark: boolean;
  /** 바로 적용하고 저장한다 */
  update(patch: Partial<AppearanceSettings>): void;
  /** 기본값으로 되돌린다 (외관 설정 전부) */
  reset(): void;
  /** 저장하지 못한 변경이 있으면 오류 문구. 편집은 막지 않는다 */
  saveError: string | null;
  /** 저장하지 못한 변경을 다시 저장한다 */
  retry(): void;
}

export function useAppearance(boot: AppearanceBootstrap): AppearanceController {
  const api = window.loreweave.appearance;
  const [appearance, setAppearance] = useState(boot.appearance);
  const [systemDark, setSystemDark] = useState(boot.systemDark);
  const [saveError, setSaveError] = useState<string | null>(null);
  /** 아직 저장이 확인되지 않은 변경 (키별 최신 값) */
  const unsaved = useRef<Partial<AppearanceSettings>>({});
  const sending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    applyAppearance(appearance, systemDark);
  }, [appearance, systemDark]);

  useEffect(() => api.onSystemDarkChange(setSystemDark), [api]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const flush = useCallback(async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      while (Object.keys(unsaved.current).length > 0) {
        const sent = { ...unsaved.current };
        try {
          await api.update(sent);
        } catch (e) {
          if (mounted.current) setSaveError(e instanceof Error ? e.message : String(e));
          return;
        }
        // 보내는 동안 같은 키가 또 바뀌었다면 그 값은 다음 반복에서 보낸다
        const current = unsaved.current as Record<string, unknown>;
        for (const [key, value] of Object.entries(sent)) if (current[key] === value) delete current[key];
        if (mounted.current) setSaveError(null);
      }
    } finally {
      sending.current = false;
    }
  }, [api]);

  const update = useCallback(
    (patch: Partial<AppearanceSettings>) => {
      setAppearance((a) => ({ ...a, ...patch }));
      unsaved.current = { ...unsaved.current, ...patch };
      void flush();
    },
    [flush],
  );

  const reset = useCallback(() => update({ ...DEFAULT_APPEARANCE }), [update]);
  const retry = useCallback(() => void flush(), [flush]);

  return { appearance, systemDark, update, reset, saveError, retry };
}
