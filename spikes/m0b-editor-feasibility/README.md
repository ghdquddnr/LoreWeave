# M0-B: Editor Feasibility Spike

TipTap 에디터가 웹소설 원고(Markdown)를 깨뜨리지 않고 열고 저장하는지, 한글 입력과 긴 챕터에서 쓸 만한지 검증하는 실험.
**제품 코드가 아니다.** 결과(코퍼스, round-trip 테스트, 체크리스트, 보고서, ADR)만 남긴다.

가설, 범위, 성공/실패 기준: [`docs/M0-PLAN.md`](../../docs/M0-PLAN.md#m0-b-editor-feasibility-spike) (실행 전 고정)

## 진행 상태

CodeRabbit 파일 수 제한 때문에 PR을 세 번에 나눈다.

- [x] **PR ①** 코퍼스 + round-trip 하네스 (이 PR)
  - [x] 코퍼스 50개: 직접 작성 35개 + M0-A 챕터 15개 (`corpus/cases.ts`)
  - [x] 성능 측정용 원고 생성 (5천 / 2만 / 10만 / 50만 자)
  - [x] 원고 envelope: BOM, 줄바꿈, frontmatter, 마지막 개행을 에디터 밖에서 분리·복원 (`src/envelope.ts`)
  - [x] 검사: byte 동일, 멱등성, 한 문단 수정의 국소성 (`src/roundtrip.ts`), diff 유형 분류 (`src/diff.ts`)
  - [x] 성능 수치 점검 절차 (M0-PLAN §5)
- [ ] **PR ②** 변환기 3종 (공식 확장 / `tiptap-markdown` / 직접 작성) × 빈 줄 규약 3종 비교, Vite + React + TipTap 데모와 검증 패널
- [ ] **PR ③** 최소 Electron 창, 입력 지연·로드 측정, IME·붙여넣기 체크리스트, `REPORT.md`, ADR

## 코퍼스

| 그룹 | 수 | 내용 |
|---|---|---|
| `blank` | 6 | 빈 줄 규약 C1 / C2 / C3, 연속 빈 줄, 앞뒤 빈 줄 |
| `special` | 4 | 문장 중 `*` `_` `~`, `[ ]` `< >` `&` `\`, 줄 시작 `#` `1.` `-` `>`, 날짜 `2007. 3. 2.`, 백틱, `|` |
| `scene` | 3 | 장면 전환 5종, 빈 줄 없는 `---`/`===`(setext 제목 함정), 시스템창 |
| `emphasis` | 3 | 정상 강조, 닫히지 않은 강조, 한국어 조사·따옴표에 붙은 강조 |
| `chars` | 5 | 따옴표·말줄임표, 전각 공백·NBSP·ZWSP·이모지, URL, 줄 끝 공백·들여쓰기, HTML·작가 메모 주석 |
| `eol` | 5 | CRLF, 마지막 개행 없음/여러 개, 혼합 줄바꿈(예외), BOM + CRLF |
| `frontmatter` | 4 | 알 수 없는 키·주석, 한국어 키 + BOM + CRLF, `---`로 시작하는 본문, 애매한 경우 |
| `structure` | 3 | 인용, 강제 줄바꿈, 제목 |
| `edge` | 2 | 빈 파일, 개행만 있는 파일 |
| `m0a` | 15 | M0-A 합성 챕터 (`../m0a-ai-feasibility/benchmark/chapters/`를 직접 읽음) |

- 코퍼스를 파일 50개가 아니라 TypeScript 한 파일로 둔 이유: CRLF·BOM·NBSP 같은 바이트를 git이나 편집기가 바꾸지 못하게 이스케이프로 적기 위해서다. 리뷰할 때 보이지 않는 문자가 보이는 장점도 있다. PR 파일 수도 줄어든다.
- 문서화된 예외: 혼합 줄바꿈은 LF로 정규화한다. 보존할지는 REPORT에서 정한다.
- 범위 밖: UTF-8이 아닌 파일 (예: CP949로 저장된 원고).

## 검사 정의

변환기는 envelope을 뗀 본문(LF)만 받고 TipTap 문서 JSON을 주고받는다. 변환기 3종이 같은 인터페이스(`Converter`)를 쓴다.

| 검사 | 정의 | M0-PLAN §3 |
|---|---|---|
| byte 동일 | `s(p(x)) == x` (dirty flag 없이) | 1행 |
| 국소성 | 최상위 문단 하나 끝에 표식 글자를 붙여 저장하고 표식을 지우면 `s(p(x))`와 같다. 모든 문단에 대해 시험 | 2행 |
| 멱등성 | `s(p(s(p(x)))) == s(p(x))` | 3행 |
| diff 유형 | `bom` / `eol` / `blank-lines` / `escape` / `whitespace` / `text-loss` / `other` | 4행 |

dirty flag(수정하지 않았으면 원본 바이트를 그대로 저장)가 있으면 무수정 저장은 항상 byte 동일이다. 그래서 위 검사는 dirty flag 없이 변환기 자체를 잰다.

## 실행

```bash
corepack pnpm install
corepack pnpm test        # 하네스와 코퍼스 테스트
corepack pnpm typecheck
corepack pnpm corpus      # out/corpus/<그룹>/<id>.md, out/perf/perf-<자수>.md 생성 (VS Code·Obsidian 비교용)
```
