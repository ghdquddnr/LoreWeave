// 외관(테마·원고 글꼴) 설정 — 디자인 확정본 (2026-10-30)
// 위치 제안: src/core/appearance.ts
// main(settings.ts)과 renderer가 함께 쓰므로 DOM·Electron에 의존하지 않는다.

/** 저장용 테마 키. 화면 이름(label)은 바뀌어도 이 키는 바꾸지 않는다. */
export type ThemeId = 'midnight' | 'daylight' | 'paper' | 'lamplight';
export type ColorScheme = 'dark' | 'light';
export type ManuscriptFont = 'theme' | 'serif' | 'sans';

export interface ThemeMeta {
  id: ThemeId;
  /** 환경설정·상태줄에 보이는 이름 */
  label: string;
  description: string;
  scheme: ColorScheme;
  /** 테마 기본 원고 글꼴 */
  manuscriptFont: 'serif' | 'sans';
  /** BrowserWindow backgroundColor — 첫 페인트 전 흰 화면 깜빡임 방지 (themes.css의 --lw-bg와 같아야 함) */
  background: string;
}

export const THEMES: readonly ThemeMeta[] = [
  { id: 'midnight', label: '심야', description: '차가운 남색 어둠 · 고딕 원고', scheme: 'dark', manuscriptFont: 'sans', background: '#121418' },
  { id: 'daylight', label: '한낮', description: '맑은 회백색 · 고딕 원고', scheme: 'light', manuscriptFont: 'sans', background: '#FFFFFF' },
  { id: 'paper', label: '미색 종이', description: '따뜻한 종이색 · 명조 원고', scheme: 'light', manuscriptFont: 'serif', background: '#F7F5F0' },
  { id: 'lamplight', label: '등잔불', description: '먹빛 바탕에 황동빛 · 명조 원고', scheme: 'dark', manuscriptFont: 'serif', background: '#1E1B17' },
];

export const DEFAULT_THEME: ThemeId = 'midnight';

export interface AppearanceSettings {
  /** followSystem이 false일 때 쓰는 테마 */
  theme: ThemeId;
  /** 운영체제 낮·밤 설정에 맞춰 dayTheme/nightTheme 중 하나를 쓴다 */
  followSystem: boolean;
  dayTheme: ThemeId;
  nightTheme: ThemeId;
  manuscriptFont: ManuscriptFont;
  /** null이면 테마 기본값 (고딕 17px, 명조 18px) */
  manuscriptSize: number | null;
  /** null이면 1.9 */
  lineHeight: number | null;
}

export const DEFAULT_APPEARANCE: AppearanceSettings = {
  theme: DEFAULT_THEME,
  followSystem: true,
  dayTheme: 'paper',
  nightTheme: 'midnight',
  manuscriptFont: 'theme',
  manuscriptSize: null,
  lineHeight: null,
};

export const MANUSCRIPT_SIZE_RANGE = { min: 14, max: 24 } as const;
export const LINE_HEIGHT_RANGE = { min: 1.4, max: 2.4 } as const;

export function isThemeId(v: unknown): v is ThemeId {
  return typeof v === 'string' && THEMES.some((t) => t.id === v);
}

export function themeMeta(id: ThemeId): ThemeMeta {
  return THEMES.find((t) => t.id === id) ?? THEMES[0]!;
}

const inRange = (v: unknown, r: { min: number; max: number }): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= r.min && v <= r.max ? v : null;

/**
 * settings.json에서 읽은 값을 검증한다. settings.ts의 readSettings와 같은 방식:
 * 이상한 값은 버리고 기본값을 쓴다 (깨진 설정 때문에 앱이 안 뜨는 일이 없도록).
 */
export function sanitizeAppearance(raw: unknown): AppearanceSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_APPEARANCE;
  return {
    theme: isThemeId(r['theme']) ? r['theme'] : d.theme,
    followSystem: typeof r['followSystem'] === 'boolean' ? r['followSystem'] : d.followSystem,
    dayTheme: isThemeId(r['dayTheme']) ? r['dayTheme'] : d.dayTheme,
    nightTheme: isThemeId(r['nightTheme']) ? r['nightTheme'] : d.nightTheme,
    manuscriptFont: r['manuscriptFont'] === 'serif' || r['manuscriptFont'] === 'sans' ? r['manuscriptFont'] : 'theme',
    manuscriptSize: inRange(r['manuscriptSize'], MANUSCRIPT_SIZE_RANGE),
    lineHeight: inRange(r['lineHeight'], LINE_HEIGHT_RANGE),
  };
}

/** 지금 적용할 테마. systemDark는 main의 nativeTheme.shouldUseDarkColors */
export function resolveTheme(a: AppearanceSettings, systemDark: boolean): ThemeId {
  if (!a.followSystem) return a.theme;
  return systemDark ? a.nightTheme : a.dayTheme;
}

const APPEARANCE_KEYS: readonly (keyof AppearanceSettings)[] = ['theme', 'followSystem', 'dayTheme', 'nightTheme', 'manuscriptFont', 'manuscriptSize', 'lineHeight'];

/**
 * renderer가 보낸 부분 변경을 엄격히 검증한다 (sanitizeAppearance와 달리 이상한 값을 기본값으로 바꾸지 않고 거절한다:
 * 저장 확인이 사용자가 고른 값과 다르게 돌아오지 않게). 모르는 키도 거절한다.
 */
export function parseAppearancePatch(raw: unknown): Partial<AppearanceSettings> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('외관 설정 형식이 올바르지 않습니다');
  const r = raw as Record<string, unknown>;
  const patch: Partial<AppearanceSettings> = {};
  for (const key of Object.keys(r)) {
    if (!(APPEARANCE_KEYS as readonly string[]).includes(key)) throw new Error(`알 수 없는 외관 설정: ${key}`);
  }
  const bad = (key: string) => new Error(`외관 설정 값이 올바르지 않습니다: ${key}`);
  for (const key of ['theme', 'dayTheme', 'nightTheme'] as const) {
    if (key in r) {
      if (!isThemeId(r[key])) throw bad(key);
      patch[key] = r[key];
    }
  }
  if ('followSystem' in r) {
    if (typeof r['followSystem'] !== 'boolean') throw bad('followSystem');
    patch.followSystem = r['followSystem'];
  }
  if ('manuscriptFont' in r) {
    const f = r['manuscriptFont'];
    if (f !== 'theme' && f !== 'serif' && f !== 'sans') throw bad('manuscriptFont');
    patch.manuscriptFont = f;
  }
  if ('manuscriptSize' in r) {
    const v = r['manuscriptSize'];
    if (v !== null && inRange(v, MANUSCRIPT_SIZE_RANGE) === null) throw bad('manuscriptSize');
    patch.manuscriptSize = v as number | null;
  }
  if ('lineHeight' in r) {
    const v = r['lineHeight'];
    if (v !== null && inRange(v, LINE_HEIGHT_RANGE) === null) throw bad('lineHeight');
    patch.lineHeight = v as number | null;
  }
  return patch;
}
