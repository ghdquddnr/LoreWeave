# M1 계획: Electron 셸 + 에디터 + Markdown 저장

> **완료 (2026-10-24)**. 결과: [`M1-REPORT.md`](M1-REPORT.md)

M1은 **AI 없이도 쓸 수 있는 최소 집필 앱**이다. 원고 폴더를 열고, 화 목록을 보고, 한 화를 편집하면 자동으로 저장된다. 원고 파일을 망가뜨리지 않는 것이 이 단계의 전부다.

- 근거: [ADR 0002](decisions/0002-editor-and-manuscript-format.md) (TipTap, C3 원고, 변환기 직접 작성), [M0-B 보고서](spikes/M0B-REPORT.md)
- 확정한 선택 (2026-10-24, 사용자): 자동 저장, 화 순서는 파일 이름 번호, 범위는 최소(열기·목록·편집·저장)

## 1. 범위

**포함**

- 프로젝트 폴더 열기 (폴더 선택 창). 마지막으로 연 폴더를 다음 실행 때 다시 연다.
- 화 목록: `chapters/*.md`를 파일 이름의 번호 순으로 보여 준다. 표시 이름은 frontmatter `title`, 없으면 첫 `# ` 제목, 없으면 파일 이름.
- 새 화 만들기: 다음 번호의 파일(`chapters/016.md`)과 최소 frontmatter(`id`, `title`)를 만든다.
- 한 화 편집 (TipTap, ADR 0002의 스키마와 입력 설정)
- 자동 저장: 입력이 멈추고 1.5초 뒤, 다른 화로 이동할 때, 창이 포커스를 잃을 때, 앱을 끌 때. Ctrl+S는 즉시 저장.
- 저장 상태 표시: 저장됨 / 저장 중 / 저장 실패(이유).
- 외부 변경 감지: 열린 화 파일이 다른 프로그램에서 바뀌면 알린다 (아래 4절).

**제외 (M1 이후)**

화 이름 바꾸기·삭제·순서 변경, 검색, SQLite 인덱스(M2), AI(M3), 설정 화면, 여러 창, 설치 파일 만들기, 테마, 다국어, 툴바(굵게·기울임은 단축키만).

## 2. 구조

CLAUDE.md의 계획 구조를 따른다. 저장소 루트가 앱 패키지다 (`spikes/`는 독립 패키지로 그대로 둔다).

```text
LoreWeave/
├── package.json, electron.vite.config.ts, tsconfig*.json
├── src/
│   ├── core/          # 순수 TypeScript. Electron·React·Node fs에 의존하지 않는다
│   │   ├── manuscript/    # envelope(BOM·줄바꿈·frontmatter), C3 변환기, 저장 전 검사
│   │   └── project/       # 화 파일 이름 규칙, 번호 매기기, frontmatter 읽기, id
│   ├── main/          # Electron main: 창, 파일 입출력(원자적 쓰기), 감시, IPC 처리
│   ├── preload/       # contextBridge로 좁은 API만 노출
│   └── renderer/      # React: 탐색기(화 목록) + 에디터 + 상태 표시줄
└── tests/
    ├── core/          # node:test. M0-B 코퍼스와 round-trip 검사를 옮겨 온다
    └── e2e/           # Playwright로 Electron 앱 조작 (smoke)
```

- **core를 분리하는 이유**: 원고 형식 규칙은 M2(인덱서)와 M4(근거로 이동)도 같은 것을 써야 한다(H-B6). Electron 없이 테스트할 수 있어야 한다.
- **IPC는 작게 둔다**: `project.open()`, `project.reopenLast()`, `chapters.list()`, `chapter.read(file)`, `chapter.write(file, text, expectedHash)`, `chapter.create()`, `onChapterChangedOutside` 정도. renderer는 파일 경로를 직접 다루지 않고 main이 프로젝트 폴더 밖 경로를 거부한다.
- **보안 기본값**: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, 원격 콘텐츠 로드 없음, CSP 설정.

## 3. 원고 형식 (core/manuscript)

ADR 0002를 구현한다. spike 코드는 쓰지 않고 테스트부터 작성한다.

1. **envelope**: BOM, 줄바꿈(CRLF/LF), frontmatter 원문, 마지막 개행을 떼었다 붙인다. frontmatter는 원문 그대로 보존하고, 읽을 때는 최상위 `key: value`만 해석한다 (YAML 라이브러리를 넣지 않는다).
2. **C3 변환기**: 한 줄 = 한 문단. `# ` 제목, `---`, `> ` 인용, `***`·`**`·`*` 강조만 알아본다.
3. **dirty flag**: 수정하지 않은 화는 저장하지 않는다 (원본 바이트 유지).
4. **저장 전 검사** (ADR 0002 결정 5): 에디터의 글자가 파일에 다 들어가지 않으면 저장하지 않는다. 직렬화한 글을 다시 파싱해 문서가 달라지면(예: `*`가 강조로 읽힘) 저장하고 위치를 알린다 (DECISIONS "M1 저장 전 검사와 `*` 입력").
5. **M1 중 정할 것** (테스트를 쓰면서 선택지를 비교해 제안한다):
   - ~~작가가 입력한 `*`가 다시 열면 강조로 읽히는 경우~~ → 저장하고 경고 (2026-10-24 결정)
   - Shift+Enter: C3에서는 Enter와 같아지므로 막는 것을 기본으로 한다
   - 혼합 줄바꿈 파일: LF로 통일하고 처음 저장할 때 한 번 알린다

## 4. 파일 안전

원고를 잃지 않는 것이 M1의 핵심 기준이다.

- **원자적 쓰기**: 같은 폴더에 임시 파일을 쓰고 fsync 후 이름을 바꿔 덮는다. 백신·OneDrive 같은 프로그램이 파일을 잡고 있어 이름 바꾸기가 실패하면(Windows `EPERM`/`EBUSY`) 짧게 재시도한다. 계속 실패하면 원본은 두고 오류를 표시한다.
- **외부 변경 감지**: 읽을 때의 해시를 기억하고, 쓰기 직전에 디스크의 해시와 비교한다. 폴더 감시(`fs.watch`)는 알림을 빨리 주는 보조 수단으로 쓴다 (Windows에서 이벤트가 중복·누락될 수 있어 해시 비교가 기준이다).
  - 에디터에 저장 안 된 변경이 없으면: 디스크 내용을 다시 읽고 "다른 프로그램에서 바뀌어 다시 불러왔습니다"를 표시한다.
  - 저장 안 된 변경이 있으면: 자동 저장을 멈추고 "내 것으로 덮어쓰기 / 디스크 내용 불러오기"를 묻는다.
- **새 화 id**: 새로 만드는 화에만 `id`(UUID v4)를 넣는다. id가 없는 기존 파일은 M1에서 건드리지 않는다 (인덱싱이 필요한 M2에서 정한다). 중복 id는 목록을 읽을 때 감지해 경고만 한다. DECISIONS(Chapter ID)는 M1에서 재발급 규칙을 두라고 적었지만, id를 실제로 쓰는 곳은 M2 인덱스라서 **재발급은 M2로 미루는 것을 제안**한다.
- **번호**: 파일 이름 앞의 숫자로 정렬한다 (`9.md` < `010.md`). 새 화는 가장 큰 번호 + 1, 3자리 0 채움 (1000화부터는 4자리).

## 5. 성공 기준

| 항목 | 기준 |
|---|---|
| 원고 보존 | M0-B 코퍼스 + M0-A 챕터를 core 변환기로 byte 동일·멱등·국소성 100% (자동 테스트) |
| 열기만 하고 닫기 | M0-A 벤치마크 폴더를 열고 화를 모두 열어 본 뒤 닫아도 파일 바이트 변화 0 (E2E) |
| 자동 저장 | 입력 후 3초 안에 디스크 반영. 입력 중 앱 프로세스를 강제로 죽여도 잃는 것은 마지막 저장 이후 최대 약 2초 분량 (E2E) |
| 외부 변경 | 다른 프로그램이 바꾼 내용을 덮어쓰지 않는다 (E2E: 외부 수정 → 앱에서 입력 → 충돌 안내) |
| 성능 | M0-B 수준 유지: 2만 자 화 열기 < 1초, 입력 지연 p95 < 50ms (같은 측정 방법) |
| IME | M0-B 체크리스트 중 핵심 시나리오(1·2·3·9·11)를 실제 앱에서 다시 확인 (수동) |
| 시작 | 300화 폴더를 열고 목록 표시 < 1초 |

## 6. 진행 순서 (작은 PR)

CodeRabbit 파일 수 제한에 맞춰 PR 하나에 한 단계씩 올린다.

1. **골격**: electron-vite + React + TypeScript, 빈 창, 보안 기본값, 테스트 실행 설정
2. **core/manuscript**: envelope, C3 변환기, 저장 전 검사. M0-B 코퍼스와 검사를 `tests/core`로 옮긴다
3. **main/파일**: 프로젝트 열기, 목록, 읽기, 원자적 쓰기, 새 화, IPC + preload
4. **renderer**: 화 목록 + 에디터 + 자동 저장 + 상태 표시
5. **외부 변경·마무리**: 해시 비교, 충돌 안내, E2E smoke, 성능 재측정, 수동 IME 확인

## 7. 추가할 라이브러리

| 패키지 | 이유 |
|---|---|
| `electron`, `electron-vite`, `vite`, `@vitejs/plugin-react` | DECISIONS의 확정 스택. electron-vite가 main·preload·renderer 빌드를 한 설정으로 묶는다 |
| `react`, `react-dom` | 확정 스택 (UI) |
| `@tiptap/core`, `@tiptap/pm`, `@tiptap/react`, `@tiptap/starter-kit` | ADR 0002 |
| `typescript`, `tsx`, `@types/*` | 타입과 `node:test` 실행 (spike와 같은 방식, 테스트 프레임워크를 따로 넣지 않는다) |
| `playwright` | Electron E2E. M0-B에서 `_electron` 조작을 검증했다 |

넣지 않는 것: YAML 파서(최상위 `key: value`만 읽음), 상태 관리 라이브러리(React 상태로 충분), UI 컴포넌트 라이브러리, ESLint 외 도구 체인은 필요할 때.

## 8. 위험

- Windows 파일 잠금(백신, OneDrive, 다른 편집기)으로 저장 실패 → 재시도와 명확한 오류 표시, 원본 보존
- `fs.watch` 이벤트 신뢰성 → 해시 비교가 기준
- 자동 저장과 외부 변경이 겹치는 경쟁 상태 → 쓰기를 한 번에 하나씩, 쓰기 직전 해시 확인
- C3의 `*` 해석 문제 (3절 5) → 정할 때까지 저장 전 검사가 안전망
- electron-vite·Electron 버전 변화 → 버전 고정, 업그레이드는 별도 PR
