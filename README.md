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
- **[이 화 검사]**: 그 화가 앞 화에서 정한 설정과 부딪히는 곳을 근거 문장과 함께 "문제 가능성"으로 보여 주고, 근거 화로 이동합니다.
- 원고는 버튼을 누를 때만 OpenAI로 전송됩니다. 앱은 무료이고 구독이 없지만, AI 기능을 쓰면 사용자 자신의 API 키로 OpenAI 사용료가 따로 듭니다.
- **저장에 실패하면**: 입력은 화면에 남고 상태줄에 "저장 실패"가 표시됩니다. [본문 복사]를 직접 누르면 그 순간 화면의 본문 글자만 클립보드에 복사합니다. 저장이 된 것도, 파일 내보내기나 자동 백업도 아니며, 복사해도 저장 실패는 그대로 남습니다. frontmatter·BOM 등 Markdown 파일 전체를 보존하는 기능이 아닙니다.

### 연속성 검사의 현재 성능 (실제 장편에서는 보장되지 않음)

⚠️ 아래 첫 번째 수치는 **합성 벤치마크**(문체가 균질하고 오류가 깔끔하게 들어간 시험 원고) 결과입니다. 실제 장편의 성능이 아닙니다.

- 합성 벤치마크: 15화 규모에서 정답 오류의 90%를 오탐 없이 찾았고 (1회 측정, [M4 결과](docs/M4-REPORT.md)), 150화 규모에서는 80~85%를 찾았습니다 (2회 측정: 1회차 85%, 2회차 80%, [M5 결과](docs/M5-REPORT.md)).
- **실제 장편** (오류를 직접 심어 측정, [M8 결과](docs/M8-REPORT.md)): 심은 오류 20개 중 9개(45%)를 찾았고 화당 오탐은 0.45개였습니다. 작품 하나·모델 하나·1회 측정이며, 목표(50%)에는 못 미쳤습니다. 이 판정은 사용자 확인을 거친 것으로 기록되어 있지 않습니다 (M8 보고서에 판정자가 명시되어 있지 않고, 이후 M10의 실제 원고 판정은 Claude의 1차 판정이며 사용자 확인은 0개입니다).
- 같은 입력을 다시 검사하면 결과가 달라질 수 있습니다. 놓치는 오류도, 틀린 지적(오탐)도 있으니 **근거 원문을 직접 확인**하세요.
- 성능을 올리려는 시도는 채택되지 않았습니다. 판단 프롬프트 detect-2 후보는 합성 회귀 기준 미달로 중단했고 ([M9 결과](docs/M9-REPORT.md)), 같은 입력을 두 번 검사해 합치는 방법은 실제 원고에서 M8이 찾던 9개 중 6개만 남아 기준(8개 이상)에 미달해 채택하지 않았습니다 ([M10 결과](docs/M10-REPORT.md), 회별 수치는 [정정이 반영된 진단](docs/M10-DIAGNOSIS.md) 기준). 제품은 기존 방식(detect-1) 그대로이며, 합친 결과의 수치는 제품 성능이 아닙니다.

→ [M1 결과](docs/M1-REPORT.md), [M2 결과](docs/M2-REPORT.md), [M3 결과](docs/M3-REPORT.md), [M4 결과](docs/M4-REPORT.md), 이후 [M5](docs/M5-REPORT.md)~[M10](docs/M10-REPORT.md) 결과

개발 실행: `corepack pnpm install` → `corepack pnpm dev`.

**Windows x64 폴더형 실행본 (미서명, 설치 프로그램 아님).** 두 가지 폴더 빌드가 구현되어 있고, 합성 자료로 자동 검증했습니다.

| 명령 | 실행 파일 | 비고 |
| --- | --- | --- |
| `corepack pnpm package:win` | `electron.exe` | 기본. 이미 설치된 Electron 런타임을 복사. 이름·exe 아이콘은 Electron 그대로 |
| `corepack pnpm package:win:branded` | `LoreWeave.exe` | 선택형. 이름·아이콘·정보를 `LoreWeave`로 바꾼 빌드 |

설치 프로그램, 코드 서명, 자동 업데이트, 공개 배포는 제공하지 않고 검증하지도 않았습니다. 설치기는 도입을 유보했습니다([설치기 계획](docs/WINDOWS-INSTALLER-PREVIEW-PLAN.md)). SmartScreen 경고, OS의 exe 아이콘 표시, 다른 PC에서의 실행은 확인하지 못했습니다.

**처음 시험하기 (PowerShell 예시, 형식만 소스로 확인했고 이 문서를 쓰며 실행하지는 않았습니다).** `C:\lw-test`는 저장소·실제 작품 폴더·실제 프로필 밖에 **새로 만들** 시험 루트의 예입니다. 이미 있는 경로면 아무것도 쓰기 전에 중단하고, 앱 출력 폴더(`app`)는 빌더가 만들며, `userdata`와 `novel\chapters`는 루트 안에 따로 만듭니다. 빌드 명령은 저장소 폴더에서 실행하고, 빌드(A 또는 B)와 실행 파일은 **하나만** 고르세요.

```powershell
$ErrorActionPreference = 'Stop'
$root = 'C:\lw-test'                      # 새 경로로 바꿔도 됩니다. 상위 폴더는 미리 있어야 합니다
if (Test-Path -LiteralPath $root) { throw "이미 있는 경로입니다. 다른 새 경로를 쓰세요: $root" }
New-Item -ItemType Directory -Path $root | Out-Null

# 1) 빌드: 둘 중 하나만. --out 폴더(app)는 빌더가 만들며, 비어 있지 않거나 저장소 안이면 거절합니다
corepack pnpm package:win --out "$root\app";          $exe = 'electron.exe'
# corepack pnpm package:win:branded --out "$root\app"; $exe = 'LoreWeave.exe'   # B: 정확한 Electron zip이 미리 있어야 함(아래)
if ($LASTEXITCODE -ne 0) { throw "빌드가 실패했습니다 (종료 코드 $LASTEXITCODE)" }

# 2) 루트 안에 빈 userData와 합성 원고 폴더를 따로 만든다 (실제 원고를 쓰지 마세요)
New-Item -ItemType Directory -Path "$root\userdata", "$root\novel\chapters" | Out-Null
Set-Content -LiteralPath "$root\novel\chapters\001.md" -Value '첫 줄입니다.' -Encoding utf8

# 3) 실행: 빌드가 만든 app 폴더 전체를 그대로 두고 실행합니다
& "$root\app\$exe" --user-data-dir="$root\userdata"
```

앱에서 `C:\lw-test\novel` 폴더를 열면 `chapters\001.md`, `002.md` … 를 화로 읽습니다. 빌드가 끝나면 만든 위치와 실행 명령이 출력됩니다.

- **격리의 범위:** `--user-data-dir`는 앱 설정 위치만 옮깁니다. 원고 색인·AI 결과(`.loreweave/index.db`, `.loreweave/ai.db`)는 userData가 아니라 **연 원고 폴더 안**에 생기므로 실제 작품 폴더를 열지 마세요. API 키·일부 설정은 기본 위치를 공유할 수 있어 완전한 격리나 portable 동작은 보장하지 않습니다. 이 앱은 실행 중 네트워크를 쓰는 AI 기능이 있으므로 전체 네트워크 차단도 보장하지 않습니다.
- **네트워크:** 빌드 준비에는 `pnpm install`(Electron 다운로드 포함)이 필요하고, 만들어진 실행본은 실행 자체에 개발 서버·pnpm·인터넷이 필요하지 않습니다(AI 기능만 사용자가 설정한 OpenAI 연결을 씁니다). 환경에 `ELECTRON_RENDERER_URL`이 있어도 실행본은 빌드된 화면을 엽니다.
- **`package:win` 안전장치:** 출력 위치를 실제 경로로 검사해(junction/symlink 별칭 포함) 저장소·입력의 안·상위·같은 위치, 링크, 비어 있지 않은 폴더를 거절하고, 복사 전에 입력을 엄격 허용 목록으로 검사해 목록 밖 파일(원고·로그·키 등)이 있으면 아무것도 복사하지 않고 실패합니다. 기존 출력을 덮어쓰지 않습니다. 자세한 설계: [docs/WINDOWS-PREVIEW-PLAN.md](docs/WINDOWS-PREVIEW-PLAN.md).
- **`package:win:branded` 전제:** 정확 `@electron/packager@20.3.0`(개발 전용)을 쓰며, **이미 받아 둔 공식 Electron zip**(`electron-v44.9.3-win32-x64.zip`)이 있어야 합니다. 기본 위치 `%LOCALAPPDATA%\electron\Cache\<해시>` 또는 `--electron-zip-dir <폴더>`를 **읽기만** 하고 다운로드·정리하지 않으며, 없거나 설치된 electron의 `checksums.json`과 해시가 다르면 실패합니다(다른 PC·CI는 같은 zip을 미리 준비). 출력 보호는 위와 같고, 작업은 저장소 밖의 독점 임시 루트에서만 하며(OS 샌드박스 아님) 실패해도 성공해도 그 임시 루트와 증거(`logs`)를 지우지 않으니 필요하면 직접 정리하세요. 자세한 내용: [docs/WINDOWS-BRANDED-PREVIEW-PLAN.md](docs/WINDOWS-BRANDED-PREVIEW-PLAN.md) §4.3.
- 폴더는 Git·릴리스에 올리지 않습니다. asar를 쓰지 않습니다.

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
