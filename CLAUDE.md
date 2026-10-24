# LoreWeave

웹소설 작가를 위한 Local-first AI-assisted Writing IDE (Electron 데스크톱 앱, MIT, 오픈소스).
AI가 글을 대신 쓰는 것이 아니라, 작가가 자신이 만든 설정과 맥락을 잊지 않도록 돕는다.

## 문서

- `INTENT.md` — 프로젝트 의도와 판단 우선순위 (제품 방향 판단 시 최우선 참고)
- `docs/VISION.md` — 장기 비전과 설계 원칙 (항상 우선 참고)
- `docs/DECISIONS.md` — 확정된 기술 결정 로그
- `docs/M0-PLAN.md` — 현재 단계(M0 spike) 실험 계획

## 현재 단계

**M0: 기술 검증 spike** (제품 코드 없음)

- M0-A: AI 연속성 오류 탐지 전략 비교 → `spikes/m0a-ai-feasibility/`
- M0-B: TipTap 에디터 / Markdown round-trip 검증 → `spikes/m0b-editor-feasibility/`

이후: M1 (Electron shell + 에디터 + Markdown 저장) → M2 (SQLite 인덱스/검색) → M3 (OpenAI 연결) → M4 (연속성 탐지 E2E) = v0.1

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

Electron + TypeScript + electron-vite + React · TipTap(M0-B 검증 대상) · better-sqlite3 + Raw SQL · pnpm · OpenAI API(GPT-6) 우선 · Windows-first

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
