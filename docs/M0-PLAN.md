# M0 Spike 계획

M0는 제품 구현이 아니라 **기술적 불확실성을 제거하기 위한 실험**이다.

## 공통 원칙

- 각 spike는 `spikes/` 아래 독립 패키지. pnpm workspace나 제품 코드와 연결하지 않는다.
- 브랜치: `spike/m0a-ai-feasibility`, `spike/m0b-editor-feasibility`
- 성공/실패 기준은 **실행 전에 고정**한다. 결과를 본 뒤 기준을 바꾸지 않는다.
- 두 spike는 독립이며 병렬 진행 가능. 종료 조건은 "기준 충족 또는 명시적 실패 선언".
- 연결점: M0-A의 합성 챕터를 M0-B round-trip 샘플로 재사용. M0-A의 근거 인용문을 에디터에서 찾아갈 수 있는지 M0-B에서 확인 (M4 대비).

## 디렉터리 구조 (저장소 루트 기준)

```text
LoreWeave/
├── CLAUDE.md
├── docs/
│   ├── VISION.md
│   ├── DECISIONS.md
│   ├── M0-PLAN.md                  # 이 문서
│   ├── decisions/                  # ADR (spike 결과로 생성)
│   └── spikes/                     # spike 최종 보고서 사본
└── spikes/
    ├── m0a-ai-feasibility/
    │   ├── README.md               # 가설·기준 (실행 전 고정)
    │   ├── package.json
    │   ├── .env.example            # OPENAI_API_KEY (실제 .env는 gitignore)
    │   ├── benchmark/
    │   │   ├── world-bible.md      # 작성용 설정집 (평가 입력 아님)
    │   │   ├── chapters/ch01.md … ch15.md
    │   │   ├── ground-truth.json
    │   │   └── split.json          # dev / test
    │   ├── src/
    │   │   ├── schema.ts           # Finding / GroundTruth 타입
    │   │   ├── llm.ts              # OpenAI 호출 + 캐시 + 토큰 로깅
    │   │   ├── strategies/         # full-context, target-only, a, b, c, d
    │   │   ├── prompts/
    │   │   ├── run.ts
    │   │   └── evaluate.ts
    │   ├── results/<run-id>/       # config / predictions / metrics (raw/는 gitignore)
    │   └── REPORT.md
    └── m0b-editor-feasibility/
        ├── README.md
        ├── package.json
        ├── corpus/                 # round-trip 샘플 + 성능용 텍스트 생성 스크립트
        ├── src/
        │   ├── App.tsx             # 에디터 + diff 패널
        │   ├── editor/             # TipTap 설정 (입력 규칙 비활성화 등)
        │   └── serializers/        # official.ts, community.ts, custom.ts
        ├── electron/               # IME/성능 재확인용 최소 Electron 창
        ├── tests/                  # roundtrip / perf / paste (Playwright)
        ├── manual/IME-CHECKLIST.md
        └── REPORT.md
```

---

# M0-A: AI Feasibility Spike

## 1. 가설

- **H-A1** 합성 벤치마크에서 최소 한 전략이 연속성 오류의 상당수를 검증 가능한 근거와 함께 찾는다.
- **H-A2** 구조화 Fact 추출(B)이 항상 최선은 아니다. 원문 기반 전략(A, D)이 비슷하거나 더 나을 수 있다.
- **H-A3** 실패 원인이 retrieval(근거가 컨텍스트에 없음)인지 reasoning(있는데 못 찾음)인지 분리할 수 있다.
- **H-A4** False Positive가 사용자가 견딜 만한 수준이다 (정당한 변화를 오류로 보지 않음).
- **H-A5** 오류 유형별 난이도 차이가 커서 MVP 지원 범위를 유형별로 좁힐 수 있다.

## 2. 최소 구현 범위

- TypeScript 스크립트(`tsx`) + OpenAI API (GPT-6, Structured Outputs). 캐시와 토큰/지연 로깅이 있는 얇은 호출 래퍼.
- 공통 인터페이스: `detect(targetChapter, priorChapters) → Finding[]`
  - Finding: `category`, `target_quote`, `claim`, `evidence[{chapter, quote}]`, `confidence`
- Baseline
  - **Full-context**: 이전 챕터 전부 입력. 상한선(ceiling).
  - **Target-only**: 대상 챕터만 입력. hallucination 바닥선.
- 전략
  - **A. 원문 검색 + LLM**: 이전 챕터를 문단 단위로 SQLite FTS5(trigram)에 색인 → 대상 문단으로 top-k 검색 → LLM. 한국어 trigram 실효성도 함께 확인.
  - **B. 구조화 Fact + 원문 근거**: 챕터별 `{entity, predicate, value, quote}` 추출(메모리/JSON) → 같은 entity의 이전 Fact 후보 → 원문 quote와 함께 LLM 판정.
  - **C. Summary + Fact + 원문**: B + 챕터별 요약 + 검색된 원문 문단.
  - **D. Entity 기반 관련 챕터 검색 + LLM**: 대상 챕터 등장 entity 추출 → 그 entity가 나오는 이전 챕터/발췌 입력.
- 평가기(`evaluate.ts`)는 결정론적: 예측 `target_quote`가 정답 오류 구간과 겹치면 매칭. 애매한 건 수동 판정 목록.
- 제외: DB 영속화, UI, 프로바이더 추상화, Ollama.

## 3. 성공/실패 기준 (test split, 확정)

| 지표 | 기준 |
|---|---|
| 최고 전략 Recall | ≥ 60% |
| 최고 전략 Precision | ≥ 50% |
| 챕터당 FP (선택한 confidence 임계값) | ≤ 1 |
| 인용문 실재율 (문자열 일치) | ≥ 98% |
| TP 중 근거 챕터 정확도 | ≥ 90% |
| 함정(정당한 변화) 오탐률 | ≤ 25% |
| 3회 반복 Recall 편차 | ≤ 10%p |

- **실패 선언**: 모든 전략 Recall < 40% 또는 챕터당 FP > 3 → 핵심 가치 미증명. 결정론적 유형(이름/나이/숫자)으로 축소하거나 사람이 Fact를 확정하는 방식을 검토.
- **부분 성공**: 유형별 Recall ≥ 70%, Precision ≥ 60%인 유형만 MVP 지원 범위로.
- 오류 표본이 약 30개라 신뢰구간이 넓다. 10%p 미만 차이는 결론에 쓰지 않는다.

## 4. 테스트 데이터

- 가상 세계 1개, 15화 (화당 1,200~2,000자)
- 정답 오류 약 30개 (10유형 × 3)
  - 유형: 이미 만난 인물의 첫 만남 / 나이 / 직업 / 이름 / 사망 인물 등장 / 관계 / 날짜·시간 순서 / 숫자·지분·금액 / 장소 설정 / 성격·습관
  - 축: 거리(근접 1~2화 / 원거리 5화 이상), 명시도(L1 직접 / L2 표현 변형 / L3 추론 필요)
  - 모든 유형에 원거리 1개, 암시적(L2/L3) 1개 이상
- 함정(정당한 변화) 약 8개: 생일로 인한 나이 증가, 별명·호칭 변형, 승진, 회상 장면, 인물의 거짓말 등
- `ground-truth.json` 항목: `id`, `category`, `type`(error/trap), `target_chapter`, `target_span`, `source_chapter`, `source_span`, `distance`, `explicitness`, `split`
- 작성: Claude가 설정집 → 화별 플롯 → 본문 → 오류 삽입. **사용자가 15화를 읽고 ground truth 검수.** 설정집은 평가 입력에 넣지 않는다.
- 분할: 오류를 유형별로 균형 있게 dev 약 40% / test 약 60%. test 실행 전에 프롬프트 동결.
- 미라벨 발견물: LLM이 찾은 라벨 밖 불일치는 자동 FP 처리하지 않고 검수 큐 → ground truth 편입 또는 FP 확정.

## 5. 측정 지표

- TP / FP / FN, Recall, Precision, 챕터당 FP
- 단계별 귀속: retrieval recall (근거가 입력에 포함됐나) / judge recall (포함됐을 때 찾았나) / B·C의 Fact 추출 커버리지
- 유형·거리·명시도별 분해
- 인용문 위조율, 근거 챕터 정확도
- Confidence 임계값별 Precision/Recall
- 토큰 수, 호출 수, 챕터당 비용, 지연
- 3회 반복 분산
- (선택) Scale probe: 무관한 필러 챕터로 60~100화까지 확장해 retrieval recall과 토큰 증가 추이만 측정

## 6. 기술적 위험

- LLM이 쓴 소설의 균질한 문체, 인위적으로 깔끔한 오류 → 결과 해석에 명시. 이후 실제 글 소량 sanity check 권장.
- 작은 표본으로 인한 약한 통계적 힘
- 정답 구간 매칭의 모호함, 미라벨 발견물
- 열린 predicate로 인한 B의 추출 일관성 문제
- 비결정성 → 낮은 temperature, 3회 반복, 모델 버전 기록
- FTS5 trigram의 한국어 한계 (조사, 어형 변화)
- 비용: 상한 미정. 실행 전 결정 필요.

## 7. 유지 / 폐기

- **유지**: 벤치마크 챕터 + `ground-truth.json` (M3/M4 테스트 fixture), 평가기와 지표 정의, `REPORT.md`, Finding/Fact JSON 스키마 초안
- **폐기**: 전략 구현, 러너, 호출 래퍼, 원시 API 응답. spike 브랜치는 태그로 보존.

---

# M0-B: Editor Feasibility Spike

## 1. 가설

- **H-B1** 수정하지 않고 열고 저장하면 byte 단위로 동일하다.
- **H-B2** 한 문단만 수정하면 diff는 그 문단에만 생긴다.
- **H-B3** 한글 IME(MS Korean IME)에서 입력 손상(음절 중복/누락)이 없다.
- **H-B4** 긴 챕터에서 입력 지연이 허용 범위다.
- **H-B5** Undo/Redo와 붙여넣기가 집필 UX를 해치지 않는다.
- **H-B6** (보너스) 인덱서(Markdown 텍스트 기반)와 에디터가 같은 방식으로 문단 위치를 셀 수 있다.

### 핵심 쟁점: 빈 줄 규약

| 규약 | 설명 | 장점 | 단점 |
|---|---|---|---|
| C1 | 표준 CommonMark (빈 줄 = 문단 구분) | 모든 도구에서 일관 | 연속 빈 줄·의도적 여백 소실 |
| C2 | C1 + 의도적 빈 문단 토큰 (`<br>`, `&nbsp;` 등) | 표준 호환 | 본문에 토큰 노출 |
| C3 | 한 줄 = 한 문단, 빈 줄 = 빈 문단 | 웹소설 원고 관행과 일치 | CommonMark 렌더러에서 문단 병합 가능 |

같은 파일을 VS Code 미리보기, Obsidian에서 열어 실제 렌더링을 비교한다.

## 2. 최소 구현 범위

- Vite + React + `@tiptap/react` 단일 페이지 + Playwright(Chromium)
- Markdown 변환기 3종 비교 (구현 시 현재 버전/API를 공식 문서로 확인, 유료 Pro 확장 제외)
  - (a) TipTap 공식 Markdown 확장
  - (b) 커뮤니티 `tiptap-markdown`
  - (c) 직접 작성한 최소 serializer/parser (paragraph, hard break, bold/italic, hr, blockquote)
- dirty flag: 수정하지 않았으면 원본 바이트 그대로 저장
- frontmatter는 에디터 밖에서 분리 처리, 원본 바이트 보존
- StarterKit 입력 규칙(`1. `, `> `, `# `, `- ` 등) 비활성화
- 수동 검증 패널: 원본 / 에디터 / 재직렬화 / diff
- **최소 Electron 창**에서 IME와 성능 재확인 (확정)
- 제외: 파일 시스템 연동, 자동 저장, 앱 셸, 툴바

## 3. 성공/실패 기준 (확정)

| 항목 | 기준 |
|---|---|
| 무수정 open→save (지원 서브셋) | 100% byte 동일 |
| 한 문단 수정 시 나머지 문단 | 100% byte 동일 |
| 직렬화 멱등성 `s(p(s(p(x)))) == s(p(x))` | 100% |
| 텍스트 손실·원치 않는 이스케이프 | 0건 (문서화된 예외 제외) |
| IME 체크리스트 (약 30분 입력 포함) | 데이터 손상 0건 |
| 입력 지연 p95 (5천~2만 자) | < 50ms |
| 입력 지연 p95 (10만 자) | < 100ms (200ms 초과 시 실패) |
| 로드 (2만 자) | < 1초 |
| Undo/Redo, 붙여넣기 체크리스트 | 전 항목 통과 |

- 1~3행 미달 시 TipTap 우선 후보 철회.
- 대안: ProseMirror 직접 사용 / 일반 텍스트 문단 모델 + 최소 서식 / CodeMirror 6 기반 집필 모드

## 4. 테스트 데이터

- Round-trip 코퍼스 40개 이상
  - 빈 줄 1개 / 여러 개 / 한 줄=한 문단 / 혼합
  - 특수문자: 문장 중 `*` `_` `~` `~~` `[ ]` `< >` `&` `\`, 줄 시작 `#` `1.` `-` `>`, 백틱, `|`
  - 장면 전환: `---` `***` `* * *` `◇◆◇`
  - 시스템창 `[시스템 메시지]` 블록, 강조(정상 / 닫히지 않은 `**`)
  - 따옴표 `“ ”` `「 」` `『 』`, `…` vs `...`, 전각 공백, NBSP, ZWSP, 이모지, URL, 줄 끝 공백, 탭
  - CRLF / LF / 혼합, BOM, 마지막 개행 유무
  - frontmatter: 알 수 없는 키, 키 순서, 주석
  - M0-A 합성 챕터 15개
- 붙여넣기 샘플: 웹페이지 HTML, Word, 한글(HWP), 일반 텍스트
- 성능용: 5천 / 2만 / 10만 / 50만 자
- IME 시나리오(수동): 조합 중 Enter, 조합 중 Backspace, 줄 시작·강조 끝에서 조합, 조합 직후/중 Undo, 선택 영역 덮어쓰기, 방향키, 한자 변환, 붙여넣기 직후 입력

## 5. 측정 지표

- byte 동일 비율, diff 유형 분류(이스케이프 / 공백 / 빈 줄 소실 / 줄바꿈 변환), 멱등성
- 변환기 3종 × 규약 3종 비교표
- 로드 시간, 키 입력→다음 프레임 지연 p50/p95/p99 (문서 시작/중간/끝), 스크롤 프레임 드롭, 대량 붙여넣기 후 Undo 시간, JS 힙
- IME 시나리오별 통과/실패 + 재현 방법 (브라우저 / Electron 각각)
- Undo 단위(조합 단위인지), `setContent` 후 히스토리, 붙여넣기 Undo 단일 단계 여부
- 붙여넣기: 서식 제거, CRLF·다중 빈 줄 처리, `*` `_` 리터럴 유지
- H-B6: 인덱서 문단 번호와 에디터 문단 번호 일치율, 인용문으로 위치 찾기 성공률

## 6. 기술적 위험

- 변환기의 텍스트 변형 (이스케이프, 줄 시작 `1.`의 목록 해석)
- 빈 줄 규약과 "다른 에디터 호환성" 원칙의 충돌 → 트레이드오프를 보고서에 명시하고 사용자가 결정
- ProseMirror 계열 IME 조합 버그. 자동화로 재현이 어려워 수동 검증 필수
- React 재렌더 비용 (`shouldRerenderOnTransaction` 등 확인)
- CRLF/BOM 보존 정책 (원본 유지 vs LF 정규화)
- TipTap v3 API 변화와 확장 생태계 불안정성

## 7. 유지 / 폐기

- **유지**: 코퍼스 + round-trip 테스트(회귀 테스트로 재사용), IME/붙여넣기 체크리스트와 결과표, `REPORT.md`, 에디터 선택·빈 줄 규약 ADR
- **폐기**: 데모 UI, Vite 앱, Electron 창, 탈락한 변환기. (c)가 채택돼도 M1에서 테스트 기준으로 새로 작성.

---

## 미결 사항

- M0-A 비용 상한
- GPT-6 정확한 model ID와 가격 (구현 시 확인)
- 보조(소형) 모델 비교 여부
