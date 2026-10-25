# LoreWeave

> Your writing belongs to you.

**LoreWeave**는 웹소설·장편소설 작가를 위한 **Local-first AI-assisted Writing IDE**입니다.

AI가 글을 대신 쓰는 도구가 아닙니다. 장기 연재를 하다 보면 생기는 설정 오류 — 바뀐 인물 이름, 맞지 않는 나이, 이미 만난 인물의 "첫 만남", 죽은 인물의 재등장, 어긋난 사건 순서 — 를 작가가 놓치지 않도록 돕는 것이 목표입니다.

```text
Possible continuity error

302화에서 김민수와 이지현이 처음 만나는 것으로 묘사되어 있습니다.
하지만 두 인물은 72화에서 이미 만났습니다.

[72화로 이동]
```

## 현재 상태

🚧 **v0.1 (개발 버전)입니다. 아직 설치 파일은 없습니다.**

핵심 기술의 실현 가능성을 검증하는 실험(M0)을 마쳤습니다.

- **M0-A** — AI가 연속성 오류를 얼마나 정확하게 찾을 수 있는가? → [보고서](docs/spikes/M0A-REPORT.md)
- **M0-B** — 한글 입력과 Markdown 원고 보존이 가능한 에디터를 만들 수 있는가? → [보고서](docs/spikes/M0B-REPORT.md)

앱 단계 M1~M4를 마쳐 v0.1이 됐습니다.

- 원고 폴더를 열고, 화를 편집하고, 자동 저장하고, 원고 전체를 검색해 그 줄로 이동합니다 (AI 없이 동작).
- 자신의 OpenAI API 키를 넣으면, 버튼을 누른 화에서 인물과 사실을 원문 인용과 함께 뽑아 보여 줍니다.
- **[이 화 검사]**: 그 화가 앞 화에서 정한 설정과 부딪히는 곳을 근거 문장과 함께 "문제 가능성"으로 보여 주고, 근거 화로 이동합니다. 합성 벤치마크에서 정답 오류의 90%를 오탐 없이 찾았습니다. 150화 규모에서도 앞 화 사실을 나눠 검사해 80~85%를 찾습니다 ([M5 결과](docs/M5-REPORT.md)).
- 원고는 버튼을 누를 때만 OpenAI로 전송됩니다.

→ [M1 결과](docs/M1-REPORT.md), [M2 결과](docs/M2-REPORT.md), [M3 결과](docs/M3-REPORT.md), [M4 결과](docs/M4-REPORT.md)

개발 실행: `corepack pnpm install` → `corepack pnpm dev`. 원고 폴더 안의 `chapters/001.md`, `002.md` … 를 화로 읽습니다.

## 원칙

- **No account, no subscription, no mandatory cloud** — 서버도 회원가입도 없는 데스크톱 앱
- **Markdown-based** — 원고는 일반 Markdown 파일로 저장됩니다. LoreWeave 없이도 VS Code, Obsidian 등에서 열 수 있습니다.
- **Bring your own AI** — 사용자가 원하는 LLM과 자신의 API Key를 사용합니다. Local LLM도 지원 예정입니다.
- **AI is optional** — AI 없이도 에디터는 온전히 동작합니다.
- **Human controlled** — AI의 분석은 제안일 뿐이며, 최종 판단은 작가가 합니다.

## 로드맵

| 단계 | 내용 |
|---|---|
| M0 | 기술 검증 spike (AI 탐지 전략, 에디터) |
| M1 | 데스크톱 앱 기본 골격, 프로젝트/챕터 관리, 에디터, Markdown 저장 |
| M2 | 챕터 인덱싱, 검색, 기본 인물 관리 |
| M3 | AI Provider 연결, 챕터 분석 |
| M4 | 연속성 오류 탐지 + 근거 회차로 이동 → **v0.1** |

인물 관계 그래프, 타임라인, 복선 관리 등은 v0.1 이후에 검토합니다.

## 기술 스택

Electron · TypeScript · React · TipTap · SQLite (`node:sqlite`) · OpenAI API

## 문서

- [`docs/VISION.md`](docs/VISION.md) — 프로젝트 비전과 설계 원칙
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — 기술 결정 로그
- 단계별 계획과 결과: [`docs/`](docs/) 의 `M*-PLAN.md`, `M*-REPORT.md`

## License

[MIT](LICENSE)
