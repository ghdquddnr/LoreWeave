// 환경설정 › 테마와 글꼴 (DESIGN-SPEC 8절). 변경은 바로 적용되고 저장된다 (useAppearance).
// 카드는 지금 화면에 쓰이는 테마를 체크해 보여 주고(자동 전환 중이면 낮·밤 규칙이 고른 테마), 카드를 고르면 그 테마로 고정(수동)한다.

import {
  DEFAULT_APPEARANCE,
  LINE_HEIGHT_RANGE,
  MANUSCRIPT_SIZE_RANGE,
  resolveTheme,
  THEMES,
  themeMeta,
  type ManuscriptFont,
  type ThemeId,
} from '../../core/appearance.ts';
import type { AppearanceController } from './useAppearance.ts';

const FONT_CHOICES: { id: ManuscriptFont; label: string; hint?: string }[] = [
  { id: 'theme', label: '테마 기본', hint: '(심야·한낮은 고딕, 미색 종이·등잔불은 명조)' },
  { id: 'serif', label: '명조로 고정' },
  { id: 'sans', label: '고딕으로 고정' },
];

const SCHEME_LABEL = { dark: '다크', light: '라이트' } as const;

function ThemePreview({ id }: { id: ThemeId }) {
  // 테마 토큰(data-theme)을 그대로 쓰는 축소판: 액티비티 · 탐색기 · 본문 · 인스펙터 · 상태줄
  return (
    <div className="theme-preview" data-theme={id} aria-hidden="true">
      <div className="tp-title" />
      <div className="tp-body">
        <div className="tp-activity" />
        <div className="tp-explorer">
          <span />
          <span className="tp-sel" />
          <span />
        </div>
        <div className="tp-text">
          <span className="tp-head" />
          <span />
          <span />
          <span className="tp-warn" />
          <span />
        </div>
        <div className="tp-inspector">
          <div />
        </div>
      </div>
      <div className="tp-status" />
    </div>
  );
}

function ThemeSelect({ label, value, disabled, onChange }: { label: string; value: ThemeId; disabled: boolean; onChange(id: ThemeId): void }) {
  return (
    <label>
      <span className="muted">{label}</span>
      <select value={value} disabled={disabled} onChange={(e) => onChange(e.target.value as ThemeId)}>
        {THEMES.map((t) => (
          <option key={t.id} value={t.id}>
            {t.label}
          </option>
        ))}
      </select>
    </label>
  );
}

export function AppearanceSettings({ controller }: { controller: AppearanceController }) {
  const { appearance: a, systemDark, update, reset, saveError, retry } = controller;
  const current = themeMeta(resolveTheme(a, systemDark));
  const themeDefaultSize = current.manuscriptFont === 'serif' ? 18 : 17;
  const effectiveSize = a.manuscriptSize ?? themeDefaultSize;
  const effectiveLineHeight = a.lineHeight ?? 1.9;
  const isDefault = JSON.stringify(a) === JSON.stringify(DEFAULT_APPEARANCE);

  return (
    <section className="appearance" aria-labelledby="appearance-title">
      <h2 id="appearance-title">테마와 글꼴</h2>

      <fieldset className="theme-cards">
        <legend>테마</legend>
        {THEMES.map((t) => (
          <label key={t.id} className={`theme-card${t.id === current.id ? ' on' : ''}`}>
            <ThemePreview id={t.id} />
            <span className="theme-card-meta">
              <input type="radio" name="theme" value={t.id} checked={t.id === current.id} onChange={() => update({ theme: t.id, followSystem: false })} />
              <span className="theme-card-name">
                <strong>{t.label}</strong>
                <span className="muted">{t.description}</span>
              </span>
              <span className="theme-card-key">{SCHEME_LABEL[t.scheme]}</span>
            </span>
          </label>
        ))}
      </fieldset>

      <div className="follow-box">
        <label className="check">
          <input type="checkbox" checked={a.followSystem} onChange={(e) => update({ followSystem: e.target.checked })} />
          운영체제의 낮·밤 설정에 맞춰 자동 전환
        </label>
        <div className="follow-themes">
          <ThemeSelect label="낮에 쓸 테마" value={a.dayTheme} disabled={!a.followSystem} onChange={(dayTheme) => update({ dayTheme })} />
          <ThemeSelect label="밤에 쓸 테마" value={a.nightTheme} disabled={!a.followSystem} onChange={(nightTheme) => update({ nightTheme })} />
        </div>
      </div>

      <div className="manuscript-settings">
        <fieldset>
          <legend>원고 글꼴</legend>
          {FONT_CHOICES.map((f) => (
            <label key={f.id} className="check">
              <input type="radio" name="ms-font" value={f.id} checked={a.manuscriptFont === f.id} onChange={() => update({ manuscriptFont: f.id })} />
              <span>
                {f.label} {f.hint && <span className="muted">{f.hint}</span>}
              </span>
            </label>
          ))}
        </fieldset>
        <div className="sliders">
          <label>
            <span className="slider-head">
              <strong>원고 글자 크기</strong>
              <span className="mono">
                {effectiveSize}px{a.manuscriptSize === null && ' (테마 기본)'}
              </span>
            </span>
            <input
              type="range"
              aria-label="원고 글자 크기"
              min={MANUSCRIPT_SIZE_RANGE.min}
              max={MANUSCRIPT_SIZE_RANGE.max}
              step={1}
              value={effectiveSize}
              onChange={(e) => update({ manuscriptSize: Number(e.target.value) })}
            />
          </label>
          <label>
            <span className="slider-head">
              <strong>줄 간격</strong>
              <span className="mono">
                {effectiveLineHeight}
                {a.lineHeight === null && ' (기본)'}
              </span>
            </span>
            <input
              type="range"
              aria-label="줄 간격"
              min={LINE_HEIGHT_RANGE.min}
              max={LINE_HEIGHT_RANGE.max}
              step={0.1}
              value={effectiveLineHeight}
              onChange={(e) => update({ lineHeight: Math.round(Number(e.target.value) * 10) / 10 })}
            />
          </label>
        </div>
      </div>
      <p className="ms-sample">달빛이 유리숲 위로 내려앉았다. 서윤은 숨을 고르고 천천히 걸음을 옮겼다.</p>

      <div className="appearance-footer">
        <span className="muted">변경은 바로 적용되고 이 컴퓨터의 설정 파일에 저장됩니다. 원고 파일은 바뀌지 않습니다.</span>
        <button type="button" onClick={reset} disabled={isDefault}>
          기본값으로
        </button>
      </div>
      {saveError && (
        <p className="error" role="alert">
          외관 설정을 저장하지 못했습니다 (화면에는 적용되어 있습니다): {saveError}{' '}
          <button type="button" className="link" onClick={retry}>
            다시 저장
          </button>
        </p>
      )}
    </section>
  );
}
