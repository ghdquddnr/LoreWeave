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

🚧 **초기 설계 단계입니다. 아직 사용할 수 있는 앱은 없습니다.**

현재는 핵심 기술의 실현 가능성을 검증하는 실험(M0 spike)을 진행하고 있습니다.

- **M0-A** — AI가 연속성 오류를 얼마나 정확하게 찾을 수 있는가?
- **M0-B** — 한글 입력과 Markdown 원고 보존이 가능한 에디터를 만들 수 있는가?

자세한 내용은 [`docs/M0-PLAN.md`](docs/M0-PLAN.md)를 참고하세요.

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

## 기술 스택 (예정)

Electron · TypeScript · React · TipTap · SQLite (better-sqlite3)

## 문서

- [`docs/VISION.md`](docs/VISION.md) — 프로젝트 비전과 설계 원칙
- [`docs/DECISIONS.md`](docs/DECISIONS.md) — 기술 결정 로그
- [`docs/M0-PLAN.md`](docs/M0-PLAN.md) — 현재 실험 계획

## License

[MIT](LICENSE)
