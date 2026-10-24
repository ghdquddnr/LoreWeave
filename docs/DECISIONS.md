# 결정 로그

확정된 기술/설계 결정을 기록한다. 결정을 바꿀 때는 기존 항목을 지우지 말고 "변경됨" 표시와 함께 새 항목을 추가한다.

## 2026-10-23 · 초기 기술 결정

| 영역 | 결정 | 비고 |
|---|---|---|
| Desktop | Electron | |
| Language | TypeScript | |
| Build | electron-vite | |
| UI | React | |
| Editor | TipTap 우선 후보 | M0-B spike로 검증. 실패 시 ProseMirror 직접 / CodeMirror 6 검토 |
| Database | better-sqlite3 + Raw SQL | 번호 붙은 SQL 마이그레이션. ORM 미사용 |
| Package Manager | pnpm | |
| OS | Windows-first | 불필요한 Windows 종속 코드는 피함 |
| UI Language | 한국어 | i18n은 필요해질 때 |
| License | MIT | 의존성도 MIT 호환이어야 함 (TipTap Pro 확장 제외) |
| Source of Truth | Markdown 파일 | SQLite는 파생 정보 |
| Chapter Metadata | 최소 frontmatter | |
| AI Provider | OpenAI API (baseline) | Ollama/Local LLM은 이후 비교 |
| Backend Server | 없음 | |
| Vector DB | 사용하지 않음 | semantic search 필요성이 확인된 이후 재검토 |
| Graph/Timeline Library | 미결정 | 데이터 모델 확정 이후 |

## 2026-10-24 · Chapter ID

- **UUID v4** (`crypto.randomUUID()`), frontmatter `id` 필드에 저장.
- 이유: 의존성 없음, 표준. 챕터 순서는 ID가 아니라 별도 필드로 표현하므로 ULID의 정렬성은 불필요.
- 주의 (M1): 파일 복사로 인한 중복 ID를 로드 시 감지해 재발급하는 규칙이 필요하다.

## 2026-10-24 · M0 진행 방식

- M0-A(AI)와 M0-B(Editor)를 독립 spike로 진행. 계획: `docs/M0-PLAN.md`
- 성공/실패 임계값은 M0-PLAN의 제안값으로 확정. 실행 전 고정하고 결과를 본 뒤 변경하지 않는다.
- M0-A 평가 모델: GPT-6 (정확한 model ID와 가격은 구현 시 공식 문서로 확인). 비용 상한: 미정.
- M0-A 벤치마크: Claude가 초안 작성 + 오류 삽입, 사용자가 ground truth 검수.
- M0-B IME: 사용자가 직접 수동 검증, Electron 창에서도 재확인.
- 작업은 `spike/*` 브랜치에서 진행.

## 2026-10-24 · M0-A 실행 조건

- 평가 모델: `gpt-6.1-sol`, `gpt-6-luna` 두 개로 제한 (API 키 권한도 이 두 모델로 제한됨). "GPT-6 미정" 항목을 대체한다.
- 가격 (Standard, 1M 토큰, ≤272K 입력, 2026-10-24 공식 가격표 확인): sol 입력 $2.00 / 캐시 입력 $0.10 / 출력 $10.00, luna 입력 $0.10 / 캐시 입력 $0.01 / 출력 $0.50.
- 비용 상한: **$10** (선불 충전 + OpenAI 측 사용 한도). 호출 래퍼도 누적 비용을 기록하고 상한 전에 중단한다.
- 챕터 분량: 화당 약 1,050~1,350자를 그대로 유지한다 (계획 1,200~2,000자). 분량 영향은 scale probe로 본다.
- Ground truth 확정: blind cold-read 검수 결과 정답 30/30 일치, 라벨 밖 오류 0, 함정 오탐 0.
