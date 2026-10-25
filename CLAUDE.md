# LoreWeave

웹소설 작가를 위한 Local-first AI-assisted Writing IDE (Electron 데스크톱 앱, MIT, 오픈소스).
AI가 글을 대신 쓰는 것이 아니라, 작가가 자신이 만든 설정과 맥락을 잊지 않도록 돕는다.

## 문서

- `INTENT.md` — 프로젝트 의도와 판단 우선순위 (제품 방향 판단 시 최우선 참고)
- `docs/VISION.md` — 장기 비전과 설계 원칙 (항상 우선 참고)
- `docs/DECISIONS.md` — 확정된 기술 결정 로그
- `docs/M0-PLAN.md` — M0 spike 실험 계획 (완료)
- `docs/M1-PLAN.md`, `docs/M1-REPORT.md` — M1 계획과 결과 (완료)
- `docs/M2-PLAN.md`, `docs/M2-REPORT.md` — M2 계획과 결과 (완료)
- `docs/M3-PLAN.md`, `docs/M3-REPORT.md` — M3 계획과 결과 (완료)
- `docs/M4-PLAN.md`, `docs/M4-REPORT.md` — M4 계획과 결과 (완료, v0.1)
- `docs/M5-PLAN.md` — 현재 단계(M5, 긴 연재 대응) 계획

## 현재 단계

**v0.1 완료 (M4)**: 연속성 오류 탐지 (`docs/M4-REPORT.md`). M1(Electron 셸 + 에디터 + Markdown 저장), M2(SQLite 색인과 원고 검색), M3(OpenAI 연결과 화별 사실 추출)도 완료. 다음은 M5(긴 연재 대응: 검사 입력 상한, `docs/M5-PLAN.md`).

M0 기술 검증 spike는 완료:

- M0-A: AI 연속성 오류 탐지 전략 비교 → **완료** (`docs/spikes/M0A-REPORT.md`, ADR 0001, 코드는 태그 `spike-m0a-2026-10-24`)
- M0-B: TipTap 에디터 / Markdown round-trip 검증 → **완료** (`docs/spikes/M0B-REPORT.md`, ADR 0002, 코드는 태그 `spike-m0b-2026-10-24`)

M1~M4 = v0.1

## 실행

```bash
corepack pnpm install
corepack pnpm dev        # 개발 실행 (electron-vite)
corepack pnpm typecheck
corepack pnpm test       # core 단위 테스트 (node:test)
corepack pnpm test:e2e   # 빌드 후 Electron 앱 E2E (Playwright)
```

## 디렉터리 구조 (계획)

```text
LoreWeave/
├── CLAUDE.md
├── docs/            # 비전, 결정 로그, 계획, spike 보고서, ADR
├── spikes/          # M0 실험 (독립 패키지, 제품 코드와 결합 금지)
│   ├── m0a-ai-feasibility/
│   └── m0b-editor-feasibility/
└── (M1 이후) src/{main,preload,renderer,core}, tests/
```

## 기술 스택 (확정)

Electron + TypeScript + electron-vite + React · TipTap(원고: 한 줄 = 한 문단 Markdown, 변환기 직접 작성) · node:sqlite(Electron 내장) + Raw SQL · pnpm · OpenAI API(GPT-6) 우선 · Windows-first

## 핵심 원칙

- **Markdown 파일이 원고의 Source of Truth.** SQLite는 재생성 가능한 파생 정보만 저장한다.
- 서버/계정/클라우드 없음. Vector DB, Graph DB, Agent 프레임워크 도입 금지 (필요성이 증명되기 전까지).
- AI 없이도 에디터는 완전히 동작해야 한다. AI 결과는 항상 suggestion이며 사용자가 최종 판단한다.
- API Key는 평문 저장 금지 (Electron `safeStorage` 사용). `.env`는 커밋하지 않는다.
- YAGNI / KISS / 구현이 2개 이상 생기기 전에는 추상화하지 않는다.
- Windows-first지만 불필요한 Windows 종속 코드는 피한다 (경로, 줄바꿈 등).

## 작업 규칙

- 사용자가 명시적으로 요청하기 전에는 구현하지 말고, 먼저 분석하고 선택지를 제시한다.
- 현재 요구보다 큰 구현이 필요해 보이면 먼저 알린다.
- 새 라이브러리 추가 시 **왜 LoreWeave에 필요한지** 설명한다.
- 작업 후 주요 변경 사항과 설계 이유를 설명한다.
- 모든 작업은 브랜치에서 한다: `spike/*`, `feat/*`, `fix/*`, `docs/*`. main에 직접 작업하지 않는다.
- spike 코드는 제품 코드로 승격하지 않는다. 결과(데이터, 보고서, 결정)만 남긴다.
- 문서와 UI 문구는 한국어를 기본으로 한다.
