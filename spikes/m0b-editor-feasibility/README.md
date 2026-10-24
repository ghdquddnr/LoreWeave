# M0-B: Editor Feasibility Spike

TipTap 에디터가 웹소설 원고(Markdown)를 깨뜨리지 않고 열고 저장하는지, 한글 입력과 긴 챕터에서 쓸 만한지 검증하는 실험.
**제품 코드가 아니다.** 결과(코퍼스, round-trip 테스트, 체크리스트, 보고서, ADR)만 남긴다.

가설, 범위, 성공/실패 기준: [`docs/M0-PLAN.md`](../../docs/M0-PLAN.md#m0-b-editor-feasibility-spike) (실행 전 고정)

## 진행 상태

CodeRabbit 파일 수 제한 때문에 PR을 나눈다. 수동 검증 결과가 있어야 결론을 낼 수 있어서 보고서는 마지막 PR로 분리했다.

- [x] **PR ①** 코퍼스 + round-trip 하네스
  - [x] 코퍼스 50개: 직접 작성 35개 + M0-A 챕터 15개 (`corpus/cases.ts`)
  - [x] 성능 측정용 원고 생성 (5천 / 2만 / 10만 / 50만 자)
  - [x] 원고 envelope: BOM, 줄바꿈, frontmatter, 마지막 개행을 에디터 밖에서 분리·복원 (`src/envelope.ts`)
  - [x] 검사: byte 동일, 멱등성, 한 문단 수정의 국소성 (`src/roundtrip.ts`), diff 유형 분류 (`src/diff.ts`)
  - [x] 성능 수치 점검 절차 (M0-PLAN §5)
- [x] **PR ②** 변환기 3종 × 빈 줄 규약 비교 (`results/roundtrip.md`), Vite + React + TipTap 데모와 검증 패널
- [x] **PR ③** 최소 Electron 창, 성능 자동 측정 (`results/perf.md`), 수동 검증 체크리스트 (`manual/CHECKLIST.md`), 검증 패널 IME 검사 모드
- [ ] 수동 검증 (사용자): IME 30분 입력, Undo·붙여넣기, VS Code·Obsidian 렌더링
- [ ] **PR ④** `REPORT.md`, ADR (에디터 선택·빈 줄 규약)

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

## 변환기 × 빈 줄 규약 (PR ②)

| 변환기 | 구현 | 비고 |
|---|---|---|
| (a) 공식 | `@tiptap/markdown` 3.32 `MarkdownManager` | 에디터 없이 변환. marked 기반 |
| (b) 커뮤니티 | `tiptap-markdown` 0.9 | markdown-it → HTML → 에디터 스키마. **작성자가 유지보수 중단을 공지함** (README) |
| (c) 직접 작성 | `src/serializers/custom.ts` | C3 전용. 알아보는 문법(제목, `---`, `> `, `*` 강조)만 노드로, 나머지는 글자 그대로. 이스케이프 없음 |

- (a)(b)는 CommonMark라 C1이 기본이다. C2(빈 문단 = `&nbsp;` 한 줄), C3(한 줄 = 한 문단)은 변환기 앞뒤 변환으로 만들었다 (`src/serializers/index.ts`). (c)의 C1·C2는 CommonMark 파서를 다시 만드는 셈이라 만들지 않았다.
- 모든 조합은 변환 결과를 실제 TipTap 에디터에 넣었다 꺼낸 문서로 검사한다 (열기 → 편집 → 저장 경로).
- 공통 스키마: StarterKit에서 목록, 코드, 취소선, 밑줄, 링크, trailingNode를 끔. 입력 규칙·붙여넣기 규칙 끔.

결과 (비예외 49개, 상세: [`results/roundtrip.md`](results/roundtrip.md)):

| 조합 | byte 동일 | 멱등 | 국소성 |
|---|---|---|---|
| (a) 공식 · C1 / C2 / C3 | 49% / 45% / 57% | 94% / 94% / 96% | 100% |
| (b) 커뮤니티 · C1 / C2 / C3 | 41% / 39% / 59% | 100% / 100% / 98% | 100% |
| (c) 직접 작성 · C3 | **100%** | 100% | 100% |

관찰 (REPORT에서 결론을 낸다):

- **(a)(b) 모두 M0-A 챕터 15개 중 6개를 바꾼다.** 문자 메시지·시스템창 `[대사]`의 대괄호를 `\[대사\]`로 이스케이프한다. 웹소설에서 흔한 표기다.
- **(a)는 스키마에 없는 문법의 글자를 지운다.** `1. 첫째…` 목록 줄, 탭·공백 4칸 들여쓴 줄, `` `sudo` ``의 `sudo`가 저장 결과에서 사라진다. (b)는 기호만 빼고 글자는 남긴다.
- **(b)는 C1에서 줄바꿈 하나를 공백으로 합친다** (한 줄 = 한 문단 원고가 한 문단이 됨). C3 변환을 붙이면 빈 줄이 에디터 안에서 NBSP 글자가 든 문단이 된다 (공백 문단 541개).
- 공통: `***`·`* * *` → `---`, 닫히지 않은 `**` → `\*\*`, `<b>` → `**`, 빈 줄 없는 `---`는 제목(setext)으로 바뀐다.
- 국소성: byte 동일이 아닌 파일은 어느 문단을 고쳐도 위 차이가 함께 저장된다. 그래서 "원본 대비 나머지 문단 100% 동일" 기준은 byte 동일 비율과 같다. 국소성 열은 변환기가 편집을 다른 문단으로 퍼뜨리는지만 본다.
- (c)의 100%는 설계상 당연하다. 대신 의미 해석의 위험이 있다: `# 해시태그로…` 줄은 제목이 되고 `5*5=25, 그리고 2*3` 사이는 기울임이 된다 (bytes는 그대로). C3 파일은 다른 Markdown 뷰어에서 문단이 합쳐져 보인다. 이 트레이드오프는 수동 렌더링 비교와 REPORT에서 다룬다.

## 성능 (PR ③)

`pnpm perf`: production 빌드를 미리보기 서버로 띄우고, 설치된 Chrome과 Electron 44에서 같은 측정 페이지(`perf.html`)를 번갈아 5회씩 잰다. M0-PLAN §5 "성능 수치 점검" 질문에 맞췄다.

- 입력 지연: keydown 시각 → 다음 프레임이 그려진 직후. 문서 시작·중간·끝에서 40키 (영문, Backspace, Enter)
- 로드: 파싱 + 에디터 생성 + 첫 화면 (화면의 블록 수가 문서와 같은지 확인)
- 붙여넣기 2만 자 → 다음 프레임, 실행 취소, 스크롤 프레임 간격, JS 힙, 저장 직렬화 시간
- 검증: 입력한 글자 수만큼 문서가 바뀌었는지, 붙여넣기·실행 취소가 정확한지, 페이지 오류 수
- 병목: 50만 자에서 CPU 프로파일 (별도 실행)
- 한글 IME 조합 입력은 자동화할 수 없어 수동 체크리스트로 본다.

결과 ([`results/perf.md`](results/perf.md), Ryzen 9 3900X, 5회 중앙값): 모든 기준 충족, 검증 불일치 0건.

| 기준 | Chrome | Electron |
|---|---|---|
| 입력 지연 p95 < 50ms (5천 / 2만 자) | 5.0 / 5.4ms | 3.3 / 5.0ms |
| 입력 지연 p95 < 100ms (10만 자) | 18ms | 16ms |
| 로드 < 1초 (2만 자) | 36ms | 34ms |
| 참고: 50만 자 입력 지연 p95 / 로드 | 98ms / 370ms | 92ms / 374ms |

- 입력 지연은 문서 크기(블록 수)에 거의 비례해 늘어난다 (5천 자 3ms → 50만 자 약 90ms).
- 병목 (50만 자 프로파일): 키 20개 동안 JS 실행은 159ms(키당 약 8ms)이고 대부분 ProseMirror 화면 갱신(`findNodeMatch`, `preMatch`)이다. 나머지 지연은 JS 밖의 브라우저 작업(스타일·레이아웃·그리기, 1,239ms)으로 보인다. 레이아웃 비용을 따로 나눠 재지는 않았다.
- 한계: 빠른 데스크톱 한 대에서 측정했다. 측정 중 대기 상태의 Vite 개발 서버 하나가 떠 있었다. 저사양 노트북에서는 다시 재야 한다.

## 실행

```bash
corepack pnpm install
corepack pnpm test        # 하네스와 코퍼스 테스트
corepack pnpm typecheck
corepack pnpm corpus      # out/corpus/<그룹>/<id>.md, out/perf/perf-<자수>.md 생성 (VS Code·Obsidian 비교용)
corepack pnpm roundtrip   # results/roundtrip.{md,json} 생성
corepack pnpm dev         # 검증 패널 http://localhost:5173 (원본 / 에디터 / 저장 결과 / 차이, IME 검사 모드)
corepack pnpm electron    # 같은 패널을 Electron 창으로 (dev 서버가 떠 있어야 함)
corepack pnpm perf        # results/perf.md 생성 (약 15분, 창이 열린다. 다른 무거운 작업은 멈출 것)
```
