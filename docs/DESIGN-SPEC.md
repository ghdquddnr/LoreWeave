# LoreWeave UI 디자인 명세 (확정본)

- 확정일: 2026-10-30
- 기준 코드: PR #111 병합 main `df71a33` (현재 UI 캡처 24장)
- 디자인 원본: Claude Design 캔버스 「LoreWeave 리디자인 시안」, 사본은 `design-source/`
- 함께 넘기는 코드: `tokens/themes.css`, `tokens/appearance.ts`, `tokens/applyAppearance.ts`

이 문서는 **현재 구현된 기능의 리디자인**을 확정한다. 9절의 관계도·간트·칸반은 아직 없는 기능이며, 방향만 정한 시안이다.

---

## 1. 디자인 원칙

| 원칙 | 화면에서 지키는 방법 |
|---|---|
| 원고는 작가의 것 | 상태줄과 탐색기에 "원고는 이 컴퓨터에만 저장됩니다"를 둔다. 저장 실패·충돌이 나도 입력을 잃지 않는다는 문구를 함께 보여 준다. |
| AI 결과는 확정 오류가 아니라 **문제 가능성** | 카드 제목, 확신도, 무시 동작을 항상 함께 둔다. 단정하는 문구("오류입니다")는 쓰지 않는다. |
| 비용과 전송은 실행 전에 보인다 | 명령 팔레트와 실행 확인 창에 예상 비용 상한, 보낼 내용을 표시한다. |
| AI는 버튼을 눌렀을 때만 | 자동 실행을 암시하는 UI(자동 분석 토글 등)를 두지 않는다. |
| 상태는 색만으로 구분하지 않는다 | 모든 상태 표시는 색 + 기호/글자 조합이다 (✓, 숫자, –, STALE 등). |

---

## 2. 레이아웃 셸 (IDE형)

```
┌──────────────────────── 타이틀 바 40px (프로젝트명 · 명령 팔레트 · 모델) ────────────────────────┐
│액티비티│ 탐색기 248px   │ 탭 36px  (004.md 돌아온 기록 | 001.md)            │ 인스펙터 380px        │
│ 바     │ 원고 · [+]     ├──────────────────────────────────────────────────┤ ▾ 문제 가능성 (2)     │
│ 52px   │ 001 유리숲… ✓  │ 툴바: chapters/004.md        [이 화 분석][연속성 검사] │   카드 · 카드          │
│ 원고   │ 004 돌아온…  2 │                                                  │ ▾ 이 화에서 찾은 사실  │
│ 검색   │ 006 아직…    – │   원고 (최대 폭 760px, 문단 번호 거터)            │   인물별 속성          │
│ 관계도 │ ─────────────  │                                                  │                       │
│ 타임라인│ AI 작업        │                                                  │                       │
│ 설정   │ 남은 화 분석   │                                                  │                       │
└────────┴───────────────┴──────────────────────────────────────────────────┴───────────────────────┘
└──────────────────────── 상태줄 26px (저장 · 파일 · 글자 수 ··· 문제 n · AI 비용 · 테마) ─────────────┘
```

| 영역 | 크기 | 배경 토큰 | 비고 |
|---|---|---|---|
| 타이틀 바 | 높이 40 | `--lw-chrome` | 가운데에 명령 팔레트 버튼 (최대 420px) |
| 액티비티 바 | 폭 52, 버튼 40×40 | `--lw-chrome` | 선택 버튼은 `--lw-act-sel` + 왼쪽 2px `--lw-accent` 표시 |
| 탐색기 | 폭 248 | `--lw-panel` | 아래에 "AI 작업" 고정 영역 |
| 탭 줄 | 높이 36 | `--lw-panel` | 선택 탭은 `--lw-bg` + 위쪽 2px accent |
| 에디터 툴바 | 높이 약 44 | `--lw-bg` | 왼쪽 파일 경로(mono), 오른쪽 AI 버튼 |
| 원고 | 최대 폭 `--lw-ms-max-width` | `--lw-bg` | 3열 grid: 문단 번호 30px · 표시 점 14px · 본문 |
| 인스펙터 | 폭 360~380 | `--lw-panel` | 접을 수 있는 섹션 2개 |
| 상태줄 | 높이 26 | `--lw-accent` | 글자 `--lw-on-accent`, mono 12px |

**반응형** (창을 줄였을 때, 디자인에서는 flex-wrap으로 구현)
- 1180px 미만: 인스펙터가 에디터 아래로 내려간다.
- 760px 미만: 한 열로 쌓고 액티비티 바를 숨긴다.

---

## 3. 테마 시스템

### 3.1 테마 4종

| 키 (저장용) | 이름 | 계열 | 원고 글꼴 | 바탕 | 강조 |
|---|---|---|---|---|---|
| `midnight` | 심야 (기본값) | 다크 | 고딕 17px | `#121418` | `#7AB8F5` |
| `daylight` | 한낮 | 라이트 | 고딕 17px | `#FFFFFF` | `#1F6FD1` |
| `paper` | 미색 종이 | 라이트 | 명조 18px | `#F7F5F0` | `#2B4C7E` |
| `lamplight` | 등잔불 | 다크 | 명조 18px | `#1E1B17` | `#D9B47A` |

- 키는 저장 형식이다. 표시 이름은 바꿔도 되지만 키는 바꾸지 않는다 (사용자 settings.json 호환).
- 컴포넌트 CSS는 `--lw-*` 의미 토큰만 쓴다. hex 직접 사용 금지.
- 기존 `app.css`의 `--line`, `--muted`, `--accent`, `--warn`, `--bad`, `--bg`는 `themes.css` 끝에서 새 토큰으로 연결해 두었다. 컴포넌트를 옮기는 동안만 쓰고 이후 지운다.

### 3.2 토큰 목록 (의미)

| 그룹 | 토큰 | 쓰임 |
|---|---|---|
| 면 | `backdrop` `bg` `panel` `chrome` `raised` `overlay` `well` | 모달 뒤 / 에디터 / 사이드 패널 / 타이틀·액티비티 / 카드 / 모달·팔레트 / 카드 안 인용 상자 |
| 선 | `line` `line-strong` | 구분선 / 입력·버튼 테두리 |
| 글자 | `text` `text-2` `body` `muted` `gutter` `link` | 기본 / 보조 / 원고 본문 / 설명 / 문단 번호(장식) / 링크 |
| 강조 | `accent` `on-accent` `sel` `sel-fg` `act-sel` | 주 버튼·상태줄 / 그 위 글자 / 선택 행 / 선택 행 글자 / 액티비티 선택 |
| 상태 | `ok` `warn` `on-warn` `warn-text` `warn-bg` `warn-line` `err` `on-err` `err-bg` `err-text` | 완료 / 경고 채움·글자·바탕·테두리 / 오류 채움·글자·바탕 |
| 차이 비교 | `add-bg` `add-fg` `del-bg` `del-fg` | 저장 충돌 비교 |
| 진행 | `prog-bg` `prog-track` | 분석 중 상태줄 |
| 향후 화면 | `entity-person/org/place/item` `relation-ai` `level` `seed` | 관계도·간트·칸반 (다크/라이트 계열별) |

### 3.3 대비 검증 (WCAG, 4.5:1 기준)

`themes.css` 값으로 계산했다. 모든 조합이 4.5:1 이상이다. 미색 종이의 `ok`는 시안 값 `#3C7A4A`(4.3)에서 `#2F6B3E`(5.4)로 조정했다.

| 조합 | 심야 | 한낮 | 미색 종이 | 등잔불 |
|---|---|---|---|---|
| text / bg | 14.8 | 16.3 | 15.4 | 13.8 |
| body / bg | 12.9 | 13.4 | 13.6 | 12.4 |
| muted / panel | 6.8 | 5.4 | 4.8 | 6.2 |
| link / raised | 8.8 | 6.2 | 8.6 | 9.0 |
| on-accent / accent | 8.7 | 4.9 | 8.6 | 8.8 |
| warn-text / warn-bg | 10.1 | 5.7 | 6.0 | 7.7 |
| on-warn / warn | 9.9 | 6.5 | 6.8 | 7.9 |
| err-text / err-bg | 11.2 | 7.7 | 8.8 | 9.4 |
| on-err / err | 7.5 | 5.2 | 7.0 | 6.8 |
| ok / panel | 8.9 | 4.7 | 5.4 | 8.5 |

`gutter`(문단 번호)는 장식이므로 `aria-hidden` 처리하고 대비 기준에서 뺀다. 구현 뒤에는 axe 등으로 실제 화면을 다시 검사한다.

### 3.4 자동 전환과 저장

`Settings`(src/main/settings.ts)에 `appearance` 필드를 더한다.

```ts
// src/main/settings.ts
import { type AppearanceSettings, DEFAULT_APPEARANCE, sanitizeAppearance } from '../core/appearance.ts';

export interface Settings {
  lastProject: string | null;
  aiModel: string;
  aiSendConsent: boolean;
  appearance: AppearanceSettings;
}
// readSettings 안에서
appearance: sanitizeAppearance(raw['appearance']),
```

main 프로세스에서 OS 낮·밤 변화를 전달하고, 첫 페인트 깜빡임을 막는다.

```ts
// src/main/index.ts
import { nativeTheme } from 'electron';
import { resolveTheme, themeMeta } from '../core/appearance.ts';

const settings = await readSettings(userData);
const theme = themeMeta(resolveTheme(settings.appearance, nativeTheme.shouldUseDarkColors));
const win = new BrowserWindow({ /* 기존 옵션 */ backgroundColor: theme.background });

nativeTheme.on('updated', () => {
  win.webContents.send('appearance:system-dark', nativeTheme.shouldUseDarkColors);
});
ipcMain.handle('appearance:get-system-dark', () => nativeTheme.shouldUseDarkColors);
```

```ts
// renderer (App 시작 시)
const [systemDark, setSystemDark] = useState(false);
useEffect(() => { void window.api.getSystemDark().then(setSystemDark); return window.api.onSystemDark(setSystemDark); }, []);
useEffect(() => { applyAppearance(settings.appearance, systemDark); }, [settings.appearance, systemDark]);
```

`window.api`의 메서드 이름은 preload/api.ts 관례에 맞춰 정하면 된다.

---

## 4. 타이포그래피

| 용도 | 글꼴 | 크기·굵기 |
|---|---|---|
| UI 기본 | IBM Plex Sans KR | 13px / 400 |
| 섹션 라벨 (원고, 문제 가능성…) | IBM Plex Sans KR | 11px / 600, 자간 0.08em, `muted` |
| 파일명·비용·줄 번호·단축키 | JetBrains Mono | 11~12px |
| 대화상자 제목 | IBM Plex Sans KR | 16px / 600 |
| 화 제목 | 원고 글꼴 | 28px / 700 |
| 원고 본문 | 고딕: IBM Plex Sans KR 17px · 명조: Noto Serif KR 18px | 줄 간격 1.9, 문단 간격 18px |

- **폰트는 앱에 번들한다.** 시안은 Google Fonts를 썼지만, 로컬 우선 앱은 오프라인에서도 같아 보여야 한다. `@fontsource/ibm-plex-sans-kr`, `@fontsource/noto-serif-kr`, `@fontsource/jetbrains-mono`처럼 패키지로 넣거나 woff2를 `src/renderer/assets/fonts`에 둔다. 세 글꼴 모두 SIL OFL이므로 LICENSE에 고지를 추가한다.
- 한글 웹폰트는 용량이 크다. 실제 사용하는 굵기만 넣는다(Plex 400/500/600, Noto Serif 400/700, Mono 400/500).
- 환경설정에서 원고 글꼴(테마 기본/명조 고정/고딕 고정), 글자 크기(14~24px), 줄 간격(1.4~2.4)을 바꿀 수 있다.

---

## 5. 컴포넌트 명세

### 5.1 현재 컴포넌트 → 새 구조

| 현재 | 새 위치 | 변경 내용 |
|---|---|---|
| `App.tsx` 사이드바 헤더 ([열기][설정]) | 타이틀 바 프로젝트명 + 액티비티 바 설정 | 프로젝트 전환은 프로젝트명 클릭(최근 목록) |
| `App.tsx` 화 목록 | 탐색기 | 파일 번호(mono) + 제목 + 상태 배지 |
| `AnalysisBar.tsx` | 에디터 툴바 · 탐색기 "AI 작업" · 명령 팔레트 · 상태줄 진행 | 진행/취소는 상태줄로 이동 |
| `SearchPanel.tsx` | 액티비티 바 "검색" 보기 | 지금처럼 탐색기 자리를 대신한다 |
| `IssuesPanel.tsx` | 인스펙터 › 문제 가능성 | 카드형, 인용 2줄(이 화/앞 화) |
| `FactsPanel.tsx` | 인스펙터 › 이 화에서 찾은 사실 | 대상별 그룹, 속성-값 2열 |
| `SettingsDialog.tsx` | 환경설정 모달 | 왼쪽 탭: 테마와 글꼴 · 편집기 · AI·API 키 · 단축키 · 원고 폴더 |
| 충돌 경고 (`.conflict`) | 에디터 위 충돌 패널 | 좌우 차이 비교 + 선택 버튼 |
| 상태줄 | 상태줄 | 4가지 변형(6절) |

### 5.2 탐색기 › 화 행

- 높이 30, 모서리 5. 구성: `001`(mono 11px, muted) · 제목(줄임표) · 상태 배지(mono 11px).
- 배지 매핑 (`ai.states`):

| 상태 | 배지 | 색 |
|---|---|---|
| 분석·검사 최신 (`fresh`) | ✓ | `ok` |
| 문제 가능성 있음 | 개수 (예: 2) | `warn-text` |
| 분석 후 본문 변경 (`stale`) | ◐ | `warn-text` |
| 분석 전 | – | `muted` |

- 현재 화: 배경 `sel`, 글자 `sel-fg`, 굵기 600, `aria-current="page"`.

### 5.3 원고

- TipTap `.ProseMirror` 안 문단마다 거터 번호를 단다. 문단 번호는 CSS counter로 그리고 `aria-hidden`으로 처리한다.
- 문제 가능성 대상 문장: `text-decoration: underline wavy var(--lw-warn)`, 오프셋 6px. 거터에 6px 점(`warn`)을 함께 표시한다.
- 인스펙터 인용을 누르면 해당 문장을 선택하고 스크롤한다(현재 `jump.ts` 동작 유지).

### 5.4 문제 가능성 카드

```
┌─────────────────────────────────────────┐  bg: raised, border: line-strong, radius 8, padding 12
│ ■ 나이   확신 0.9                  무시 │  ■ = warn 8px, 확신 = mono 11px warn-text
│ 1화의 열아홉 살과 다릅니다. 의도한     │  text-2, 줄 간격 1.6
│ 거짓말인지 확인해 보세요.              │
│ ┌─────────────────────────────────────┐ │  well, border line, radius 6
│ │004:3  “저는 스물두 살입니다.”        │ │  이 화 = warn-text
│ │001:2  서윤은 올해 열아홉 살이었다.   │ │  앞 화 = link (누르면 그 화로 이동)
│ └─────────────────────────────────────┘ │
└─────────────────────────────────────────┘
+ 확신 낮은 결과 1 · 무시한 결과 0            ← 펼침 버튼, muted
```

- 인용 줄은 `<a>` 또는 `<button>`으로 키보드 접근이 가능해야 한다.
- 섹션 머리: "문제 가능성" + 개수 배지(`warn` 바탕, `on-warn` 글자) + 오른쪽에 "앞 3화 · 사실 8".

### 5.5 명령 팔레트 (신규)

- `Ctrl+K`로 연다. 오버레이 `overlay`, 테두리 `line-strong`, 그림자 `shadow`, 모서리 10.
- 항목 구성: 명령 이름 · 대상(muted) · 예상 비용(mono) · 단축키(kbd).
- 기본 명령: 이 화 분석, 남은 화 분석, 이 화 연속성 검사, 분석 결과 다시 읽기, 새 화, 원고 검색, 테마 바꾸기.

### 5.6 단축키 (제안)

| 동작 | 키 | 비고 |
|---|---|---|
| 명령 팔레트 | Ctrl+K | 신규 |
| 원고 전체 검색 | Ctrl+Shift+F | 현재와 같음 |
| 이 화 분석 | Ctrl+Alt+A | 신규 제안 |
| 이 화 연속성 검사 | Ctrl+Alt+C | 신규 제안 |

---

## 6. 상태 명세

| 상태 | 표시 위치 | 모양 | 문구 | 동작 |
|---|---|---|---|---|
| 저장됨 | 상태줄 | `accent` 바탕 | ● 저장됨 | – |
| 분석 중 | 상태줄 | `prog-bg` 바탕 + 진행 막대(`prog-track`/`accent`) | ◐ 분석 중 2/6 · $0.0032 | 취소 링크 |
| 저장 멈춤 (외부 수정) | 상태줄 + 에디터 위 충돌 패널 | `warn` 바탕 / 패널 `warn-bg`, 테두리 `warn-line` | 002.md가 다른 프로그램에서 바뀌었습니다 · 자동 저장 멈춤 | 내 것 유지 · 디스크 것 불러오기 (차이 비교 표시) |
| 저장 실패 | 상태줄 | `err` 바탕 | ✕ 저장 실패 · 입력은 메모리에 보존됨 | 다시 시도 |
| 오래된 결과 | 인스펙터 섹션 위 | `raised` + 배지 STALE(`muted` 바탕) | 검사 뒤 본문이 바뀌었습니다. 결과는 이전 원고 기준입니다. | 다시 검사 |
| 인용 없음 | 해당 카드·사실 위 | 배지 MISSING(`warn`) | 인용 “…”를 본문에서 찾을 수 없습니다. | – |
| 근거 이동 | 이동 후 알림 | 배지 MOVED(`line-strong`) | 근거 문장이 바뀌어 위치만 표시합니다. | – |
| 결과 읽기 실패 | 인스펙터 | `err-bg`, `role="alert"` | AI 결과를 읽지 못했습니다. 원고는 안전합니다. | 다시 읽기 |
| 첫 실행 | 전체 화면 | 시작 화면 | 당신이 만든 세계를 잊지 않도록. | 원고 폴더 열기 · 최근 프로젝트 |

### 6.1 실행 확인 창 (동의 + 비용 통합)

- 지금의 "원고 전송 안내" 모달과 "비용 확인" 모달을 하나로 합친다.
- 보낼 내용을 mono 목록으로 표시한다: 보냄 ▸ 본문 n자 / 보냄 ▸ 앞 화 사실 n개 / 먼저 ▸ 분석이 필요한 화 / 비용 ▸ 최대 $x.
- 동의 체크박스는 `aiSendConsent`가 false일 때만 보인다(처음 한 번).
- 확인 문구: "결과는 문제 가능성입니다. 확정된 오류가 아닙니다."
- 기본 포커스는 실행 버튼, Esc는 취소.

---

## 7. 접근성

- 상태줄은 `role="status"`(지금처럼), 오류 알림은 `role="alert"`.
- 아이콘만 있는 버튼(액티비티 바, 새 화, 닫기)에는 `aria-label`을 단다.
- 탭(열린 화, 인스펙터 보기)은 `role="tablist"`/`tab` + `aria-selected`.
- 모든 상태 구분은 색 + 기호/글자 조합이다(1절).
- 포커스 링: `outline: 2px solid var(--lw-accent); outline-offset: 2px`. 모든 테마에서 보여야 한다.

---

## 8. 환경설정 › 테마와 글꼴

- 테마 카드 2×2: 미니 미리보기(액티비티·탐색기·본문·인스펙터·상태줄 축소판) + 라디오 + 이름 + 설명 + 다크/라이트 표시.
- "운영체제의 낮·밤 설정에 맞춰 자동 전환" 체크 → 낮에 쓸 테마 / 밤에 쓸 테마 선택(기본: 미색 종이 / 심야).
- 원고 글꼴: 테마 기본(미색 종이·등잔불 명조, 심야·한낮 고딕) / 명조로 고정 / 고딕으로 고정.
- 원고 글자 크기 슬라이더, 줄 간격 슬라이더. 변경은 즉시 적용·저장하고, "기본값으로" 버튼을 둔다.

---

## 9. 향후 화면 (방향 시안 · 미구현)

### 9.1 인물 관계도 — 게임 스테이터스 창 스타일

- 캔버스 위 노드 카드(180×132): 초상(이니셜) · 이름 · `Lv`(등장한 화 수) · 등장 게이지 · 확정 게이지 · 상태 이상 배지.
- 관계선: 작가 확정 = 실선, AI 추정 = 점선(`relation-ai`). 선 위에 관계 라벨과 화 번호를 단다.
- 오른쪽 스테이터스 창: 초상 + Lv + EXP(첫 등장~현재) / 능력치 4칸(등장·관계·확정·복선) / 상태 이상(충돌 근거 + 해결 버튼) / 소지품·표식 슬롯 / 특성.
- 필터: 종류, 관계 출처, 상태 이상만, **화 시점 슬라이더**(그 화까지의 상태로 다시 그림).
- 구현 후보: React Flow(노드 드래그·줌), 레이아웃은 elkjs.

```ts
interface Entity { id: string; kind: 'person' | 'org' | 'place' | 'item'; name: string; firstChapter: string; appearances: string[]; attributes: Attribute[]; }
interface Attribute { key: string; value: string; source: 'ai' | 'author'; quotes: QuoteLocation[]; conflict?: { values: string[]; quotes: QuoteLocation[] } }
interface Relation { from: string; to: string; label: string; since: string; source: 'ai' | 'author'; }
// Lv = appearances.length, 확정 게이지 = author 속성 수 / 전체 속성 수
```

### 9.2 이야기 간트 + 복선 칸반

- 간트: 가로축은 화(현재 집필 화 강조, 이후 화는 빗금으로 "계획"). 행 그룹은 인물 흐름 / 복선 / 사건·문제 가능성.
- 막대 위 ◆ 표시: 주요 이벤트(크게, `level` 색 + 빛 번짐) · 이벤트 · 복선 · 문제 가능성 · 계획.
- 주요 이벤트가 있는 화는 세로줄 전체를 옅게 강조하고, 열 머리에 이벤트 이름을 단다.
- ◆에 호버하거나 포커스하면 툴팁이 뜬다(화 · 종류 · 제목 · 요약 · "클릭하면 본문으로 이동"). 위치 계산은 Floating UI(`flip`, `shift`)로 한다.
- 칸반 열: 심음 / 진행 중 / 회수 예정 / 회수됨. 카드: 제목, 방치 경고, 설명, 원문 인용, 심음·마지막 언급·회수 화, 경과 막대, 관련 인물 칩.
- 회수 예정 화를 정해 두면, 그 화를 연속성 검사할 때 해당 복선도 함께 확인한다(검사 프롬프트 확장).

```ts
interface StoryThread { id: string; kind: 'arc' | 'seed' | 'event'; label: string; from: string; to: string; plannedPayoff?: string; markers: Marker[]; }
interface Marker { id: string; chapter: string; kind: 'major' | 'event' | 'seed' | 'warn' | 'plan'; title: string; summary: string; quote?: QuoteLocation; }
type SeedStatus = 'planted' | 'active' | 'scheduled' | 'paid';
```

---

## 10. 구현 순서 제안

| 단계 | 내용 | 완료 기준 |
|---|---|---|
| P1 | `themes.css`·`appearance.ts` 도입, 폰트 번들, 설정 저장, nativeTheme 연동 | 4개 테마 전환·자동 전환, 첫 페인트 깜빡임 없음 |
| P2 | 셸 레이아웃(타이틀·액티비티·탐색기·탭·인스펙터·상태줄), `app.css` 하드코딩 색 제거 | 기존 e2e 통과, 기존 기능 동작 동일 |
| P3 | 문제 카드·사실 섹션·원고 거터/밑줄 | 캡처 13~21번 상태 재현 |
| P4 | 명령 팔레트, 실행 확인 창 통합, 상태줄 변형, 충돌 차이 비교 | 캡처 09~12, 22~23번 상태 재현 |
| P5 | 9절 향후 화면 (별도 마일스톤) | 데이터 모델 확정 후 |

캡처 검수(제품 적용 시 확정): **각 단계(P1~P3)는 그 단계에서 바뀐 대표 상태를 4개 테마로 찍어 비교**하고, **최종 단계(P4) 병합 뒤에 24개 상태 × 4개 테마 = 96장** 전체와 새로 생긴 상태(명령 팔레트·환경설정 등)를 검수한다. 단계마다 96장을 기계적으로 반복하지 않는다 (원문은 "각 단계가 끝나면 24개 상태를 4개 테마로 96장"이었다). 12.6절 참고.

---

## 11. 디자인 원본 아트보드

| 파일 (`design-source/project/`) | 내용 |
|---|---|
| `B-Workspace.dc.html` | 집필 + AI 검토 기본 화면 (`theme` 값으로 4종 전환) |
| `Theme-B2/A1/A2.dc.html` | 위 화면을 한낮·미색 종이·등잔불로 불러온 것 |
| `B-Settings.dc.html` | 환경설정 › 테마와 글꼴 |
| `B-States.dc.html`, `States-*.dc.html` | 상태와 모달 시트 (테마 4종) |
| `F-Characters.dc.html` | 향후 · 인물 관계도 |
| `F-Timeline.dc.html` | 향후 · 간트 + 복선 칸반 (호버 동작 포함) |
| `Main.dc.html`, `A-States.dc.html` | 보관 · 채택하지 않은 A 레이아웃 |

시안 파일의 테마 키는 `b1/b2/a1/a2`이며 코드의 `midnight/daylight/paper/lamplight`와 순서대로 대응한다. 원고·인물·복선 데이터는 합성 원고 「유리숲의 계약」 기반 예시다.

---

## 12. 제품 구현 기록 (LoreWeave 쪽 확정 해석)

이 절은 디자인 원본에 없고, 제품에 가져오면서 정한 해석과 현재 구현 상태를 적는다. 위 본문과 어긋나면 이 절이 우선한다.

### 12.1 채택 범위

- 채택 레이아웃은 **B안** (`B-Workspace`·`B-Settings`·`B-States`)과 **4테마**다. A안(`Main`·`A-States`)은 비채택 보관본이다.
- 9절(관계도·간트·칸반)과 `F-Characters`·`F-Timeline`은 **향후 방향일 뿐 구현 대상이 아니다.** 메뉴나 버튼으로 미리 노출하지 않는다.
- 시안 HTML(x-dc 템플릿)·Google Fonts 링크·샘플 데이터는 제품에 넣지 않는다. 원본은 저장소 밖에 보관한다.
- 구현은 4단계로 나눈다: P1 외관 기반과 테마 설정 → P2 IDE 셸·탭 → P3 AI 카드·사실·원고 표시 → P4 명령 팔레트·동의/비용 통합·충돌 비교.

### 12.2 기본 테마 해석 (P1)

- 제공 코드와 설정 시안의 체크 상태를 따른다: `followSystem = true`, 낮 `paper` / 밤 `midnight`, 수동 선택(`theme`)의 기본은 `midnight`.
- 따라서 **밝은 OS의 첫 실행은 미색 종이(paper)**, 어두운 OS는 심야(midnight)다. 3.1절의 "심야 (기본값)"은 수동 기본값과 다크 fallback을 뜻하며, OS 상태와 무관하게 심야를 강제한다는 뜻이 아니다.
- 카드(환경설정)는 지금 화면에 쓰이는 테마를 체크해 보여 준다. 카드를 고르면 그 테마로 **고정(수동)** 되어 자동 전환이 꺼지고 OS가 바뀌어도 유지된다. 자동 전환을 다시 켜면 낮·밤 규칙을 따른다.

### 12.3 원고 글꼴·크기·줄 간격 (P1)

- `manuscriptSize = null`은 **테마 기본**(고딕 테마 17px, 명조 테마 18px)이다. 글꼴을 "명조로 고정/고딕으로 고정"해도 **family만 바뀌고** 크기는 바뀌지 않는다 (null이면 그 테마의 기본 크기, 명시한 크기는 그대로).
- 줄 간격 `null`은 1.9. 범위는 글자 크기 14~24px, 줄 간격 1.4~2.4이며 범위 밖 값은 읽을 때 버리고, IPC로 저장할 때는 거절한다.

### 12.4 저장과 첫 화면 (P1)

- 외관은 사용자 데이터의 `settings.json`의 `appearance`에만 저장한다. 원고·frontmatter·AI DB에 저장하지 않는다. 기존 `lastProject`·`aiModel`·`aiSendConsent`는 보존한다.
- 설정 읽기·쓰기는 폴더별 대기열에서 한 번에 하나씩 한다 (슬라이더 즉시 저장과 모델·프로젝트 저장이 겹쳐도 서로를 되돌리지 않음). 임시 파일에 쓴 뒤 바꿔치기하고, 실패한 쓰기는 호출자에게만 오류를 돌려주며 대기열은 막히지 않는다.
- 저장이 실패해도 화면에는 적용하고 편집은 막지 않는다. 환경설정에 오류와 "다시 저장"을 보이며, 실패한 변경은 다음 저장 때 함께 다시 보낸다.
- 첫 화면: main이 창을 숨긴 채 만들고(배경색은 설정·OS 낮·밤의 테마색), renderer가 `appearance.bootstrap`으로 설정을 받아 `<html>`에 적용한 뒤 React를 그리고, 글꼴까지 그린 첫 화면을 `rendererReady`로 알려야 창이 보인다 (5초 안에 알리지 않으면 어쨌든 보인다).
- 글꼴(IBM Plex Sans KR 400/500/600, Noto Serif KR 400/700, JetBrains Mono 400/500 라틴)은 `@fontsource/*` 패키지의 woff2를 로컬 번들한다. 출처·OFL 원문은 `THIRD_PARTY_NOTICES.md`. CSP는 그대로이며 글꼴 파일은 data: URL로 끼우지 않는다.
- 4절의 "LICENSE에 고지를 추가한다"는 저장소의 MIT `LICENSE`를 건드리지 않고 `THIRD_PARTY_NOTICES.md`로 한다.

### 12.5 구현 상태

| 단계 | 상태 |
|---|---|
| P1 외관 기반·테마 설정 | 구현 (이 문서와 함께 들어감) |
| P2 IDE 셸·탭 | 미구현 |
| P3 AI 카드·사실·원고 표시 | 미구현 |
| P4 명령 팔레트·동의/비용 통합·충돌 비교 | 미구현 |

### 12.6 캡처 검수 방식

- 단계별: 바뀐 대표 상태 × 4테마 (P1: 집필·검색·환경설정(위/아래)·동의·검사 확인·문제/사실·근거 이동·좁은 창·**원고 충돌 안내·외관 저장 실패/다시 저장**).
- 최종(P4 병합 뒤): 원래 24개 상태 × 4테마 = 96장 + 신규 상태. 캡처는 저장소 밖에 보관하고 각 이미지의 커밋·테마·상태·글꼴·viewport·배율을 manifest에 남긴다. 기존 baseline은 덮어쓰지 않는다.
