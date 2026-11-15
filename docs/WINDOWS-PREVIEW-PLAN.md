# Windows x64 오프라인 실행본(미서명·폴더형) 최소 패키징 계획

상태: **계획만 있다.** 이 문서는 아무것도 구현하지 않았고, 설치 파일·공개 릴리스는 존재하지 않는다 (README: "아직 설치 파일은 없습니다"). 감독의 검토·승인 전에는 패키징 구현을 시작하지 않는다.
근거는 이 저장소의 실제 파일과 공식 문서(링크)뿐이며, 확인하지 못한 것은 "미확인"으로 적는다. 의존성 설치·다운로드·코드 실행 실험은 하지 않았다 (저장소·공식 문서 읽기만).

## 1. 목표와 범위

- **첫 검증 대상**: Windows x64용 **미서명 unpacked 폴더**. 폴더째 복사해서 개발용 Node/pnpm·개발 서버 없이 `.exe`를 실행하면 앱이 뜬다.
- **범위 밖(후속)**: NSIS 등 설치 프로그램, 코드 서명, 자동 업데이트, macOS/Linux, 공개 릴리스, 인증서·배포 계정·유료 서비스. 이 계획은 그것들 없이 성립한다.
- INTENT의 "로컬 데스크톱 글쓰기"가 실제로 쓸 수 있는 모양인지(개발 환경 없이 실행되는지)를 처음으로 확인하는 것이 목적이다.

## 2. 현재 배포 차단 근거 (실제 파일 기준)

| 근거 | 위치 |
|---|---|
| 설치 파일 없음, 실행법은 `pnpm install → pnpm dev` | `README.md` ("현재 상태", "개발 실행") |
| 스크립트는 `dev`/`build`/`start`(= `electron-vite preview`) 등 개발용뿐이고 패키징 스크립트·설정이 없다 | `package.json` scripts |
| 패키징 도구(electron-builder/packager/forge) 의존성·설정 파일이 없다 | `package.json`, 저장소 루트 |
| 앱 진입점은 빌드 산출물이다 (`"main": "out/main/index.js"`) | `package.json` |
| 아이콘 주석: "설치 파일 아이콘은 아직 배포 기반이 없어 이 변경의 범위가 아니다" | `src/main/index.ts` |
| `app.isPackaged`가 이미 분기에 쓰인다: 패키지된 앱은 dev 서버 URL을 무시하고 `renderer/index.html`을 `loadFile`한다 | `src/main/index.ts` |
| UI 라이브러리(react, tiptap 등)가 `devDependencies`에 있다. renderer 번들에 인라인되므로 런타임 `node_modules`가 필요한 것은 아니지만, 패키징 도구가 `devDependencies`를 어떻게 다루는지 확인해야 한다 | `package.json`, `out/renderer` |
| `out/`에는 빌드 산출물(`main`, `preload`, `renderer`) 말고 **실험 작업 폴더·로그**(`m5-work/`, `m6-run.log` 등)가 섞여 있다. `out/` 전체를 복사하면 안 된다 (`.gitignore`로 커밋은 안 되지만 폴더 복사에는 포함됨) | 로컬 `out/` 관찰 |

## 3. 패키징 방법 비교와 권고

비교 대상은 최소 후보 3개다. 호환성은 추측하지 않고, 공식 문서에 적힌 것과 적히지 않은 것을 나눈다.

| 방법 | 공식 문서가 말하는 것 | 이 프로젝트에서 확인/미확인 |
|---|---|---|
| **A. Electron 공식 수동 배포** (prebuilt 바이너리 + `resources/app` 폴더) | Electron [Application Distribution](https://www.electronjs.org/docs/latest/tutorial/application-distribution): 바이너리를 받아 `electron/resources/app`에 `package.json`·앱 파일을 두고 `electron.exe`를 실행하면 그 `electron` 폴더가 배포물이다. asar는 선택(성능 이점, `app.asar`로 이름을 바꿔 둠). 같은 문서가 권장 도구로 Electron Forge를 든다 | 새 의존성 0. Electron 44.9.3 바이너리는 이미 `node_modules/electron/dist`에 있다(pnpm 설치 시 받음). 확인: 이 방식은 버전 비의존(바이너리+폴더). 미확인: exe 이름·아이콘·버전 메타데이터는 바뀌지 않는다(Electron 기본) |
| **B. `@electron/packager`** | [문서](https://electron.github.io/packager/main/): 소스와 이름을 바꾼 Electron 실행 파일을 폴더로 묶는다. 대상 `win32` x64 지원, Node.js 16.13.0 이상 필요, 기본으로 `devDependencies` 제외(`prune`), `--ignore`는 정규식 | 확인: 개발 환경 Node 24.13.0은 요구를 만족. **미확인**: Electron 44 지원 범위(문서에 명시 없음), pnpm 심볼릭 `node_modules` 처리(문서에 언급 없음), asar 옵션(이 페이지에 없음), 설치할 패키지 버전 |
| **C. `electron-builder`** (`--dir`) | [CLI](https://www.electron.build/docs/cli/): `--dir`은 설치 파일 없이 unpacked 디렉터리만 만든다(테스트용). [Application Contents](https://www.electron.build/docs/contents/): asar 기본 켜짐, `files`에 패턴을 추가하면 기본 `**/*`이 빠지므로 전부 명시해야 하며 `package.json`과 프로덕션 `node_modules`는 항상 포함, `extraResources`는 asar 밖(`process.resourcesPath`). 공식 사이트는 현재 안정판이 v26이고 v27은 미출시라고 표기 | **미확인**: Electron 44 호환, pnpm 처리(검색 결과에 언급 없음), v26/v27 중 선택. 설정 표면이 가장 넓다. 장점은 이후 NSIS·서명·업데이트로 같은 도구를 이어 쓸 수 있다는 점 |

**권고: 첫 PR은 A(수동 배포 + 작은 스크립트)로 한다.** 이유:
1. 의존성 추가·버전 호환 추측이 없다 (B, C는 Electron 44 지원 범위가 문서에서 확인되지 않았다).
2. 이 프로젝트의 런타임 의존이 사실상 `electron` + `openai` 하나뿐이라 수동 복사 대상이 작다 (§5).
3. 첫 목적이 "개발 환경 없이 뜨는가"의 확인이라 exe 이름·아이콘 임베딩은 필수가 아니다.
A로 실행 가능성이 확인된 뒤, exe 이름·아이콘·메타데이터·prune이 필요하면 B를, 설치 프로그램이 필요해지면 C를 **별도 계획**으로 다룬다(그때 지원 범위를 공식 문서·릴리스 노트로 먼저 확인). 스크립트는 `scripts/`에 둔다(저장소 규칙).

## 4. 산출물 포함·제외표 (폴더 `LoreWeave-win-x64/` 기준)

| 구분 | 항목 | 근거 |
|---|---|---|
| 포함 | Electron 44.9.3 win32-x64 런타임 전체(`electron.exe`, `resources/`, `.pak`, `.dll`, 로케일 등) | `node_modules/electron/dist` (369MB; `debug.log` 같은 부산물은 구현 PR에서 점검) |
| 포함 | `resources/app/package.json` (최소화한 사본: `name`, `version`, `main`) | `main: out/main/index.js` |
| 포함 | `resources/app/out/main`, `out/preload`, `out/renderer` (renderer에 로컬 글꼴 woff2·브랜드 SVG·PNG 포함, 약 15MB) | `out/renderer/assets`, `src/renderer/src/fonts.css`는 `@fontsource` 파일을 번들로 가져옴 |
| 포함 | `resources/app/resources/app-icon.ico` | `src/main/index.ts`: `join(__dirname, '../../resources/app-icon.ico')` = 앱 루트의 `resources/` |
| 포함 | `resources/app/node_modules/openai` (실제 디렉터리로 복사, 약 31MB) | §5 |
| 포함 | 앱의 `THIRD_PARTY_NOTICES.md`, `LICENSE` (글꼴 OFL·앱 MIT 고지) | `THIRD_PARTY_NOTICES.md` |
| 포함 | **복사한 Electron 런타임이 이미 갖고 있는 고지 파일을 지우지 않고 그대로 보존**: 설치된 `node_modules/electron/dist` 루트에 실제로 있는 `LICENSE`, `LICENSES.chromium.html` (이 두 파일만 확인했다). 앱의 MIT/글꼴 고지가 런타임·SDK 고지를 대체하지 않는다. `openai` 디렉터리를 복사할 때도 그 안의 라이선스 파일을 그대로 둔다 (법률 검토가 아니라 "원래 있던 고지를 빼지 않는다"는 규칙이다) | `node_modules/electron/dist` 목록 |
| 제외 | `out/m5-work`, `out/*.log`, `out/*.txt` 등 `out/{main,preload,renderer}` 밖의 모든 것 | §2 |
| 제외 | `.env`, `.env.*`, `spikes/`(원시 API 응답·`.cache`), `tests/`, `scripts/`, `docs/`(원하면 별도 문서만), `node_modules` 나머지 전부, `.git`, `.claude`·감독 훅·메모리·WATCHDOG 류 | `.gitignore`, `package.json` |
| 제외 | 어떤 사용자 데이터도 넣지 않는다: 원고 프로젝트 폴더와 그 안의 `.loreweave/index.db`·`.loreweave/ai.db`, `userData`의 `settings.json`·`openai-key.bin` | §6 |

## 5. 런타임 의존 처리 근거

- **`node:sqlite`**: Node 내장 모듈이다. `out/main/index.js`에 `require("node:sqlite")`로 남아 있고(`src/main/ai-db.ts`, `index-db.ts`만 사용), 번들 대상도 별도 네이티브 모듈도 아니다. Electron 런타임이 제공한다(개발 실행에서 이미 동작). 패키징에서 네이티브 모듈 재빌드가 **필요 없다**는 것은 `package.json`에 네이티브 의존이 없다는 사실로 확인했다. 미확인: 패키지된 환경에서의 실제 동작(구현 PR의 검증 항목).
- **OpenAI SDK**: `electron-vite`는 `build.externalizeDeps` 기본값이 `true`라(설치된 6.0.0의 타입 선언) `openai`가 번들되지 않고 `out/main/index.js`에서 `require("openai")`로 남는다. 따라서 패키지에 `node_modules/openai`가 **반드시** 있어야 한다(없으면 앱 시작 시 main이 실패). `openai@7.43.0`의 `dependencies`는 비어 있고 peer 의존(`undici`, `ws`, `zod` 등)은 모두 `peerDependenciesMeta`에서 optional이므로, 수동 복사 시 `openai` 디렉터리 하나로 충분하다고 **파일 근거로 판단**한다. 미확인: 이 코드 경로가 optional peer를 실제로 요구하지 않는지의 런타임 확인(구현 PR에서 키 없이 AI 화면 진입까지로 확인, 네트워크 호출 0).
- **preload**: `out/preload/index.js`는 `require("electron")`만 쓴다(sandbox 호환). 다른 `node_modules`가 필요 없다.
- **pnpm 심볼릭 링크 위험**: `node_modules/openai`는 `node_modules/.pnpm/openai@7.43.0_undici@7.30.1/node_modules/openai`로의 링크다(저장소 구조). 폴더를 그대로 복사하면 링크가 깨지거나 링크만 복사될 수 있으므로 **링크를 따라간 실제 파일을 복사**해야 한다. 이는 A에서 스크립트가 처리하고, B/C를 쓸 때는 각 도구의 pnpm 처리가 문서에서 확인되지 않았으므로(§3) 따로 검증한다.
- **asar**: 첫 PR은 **asar를 쓰지 않는다**(`resources/app` 폴더). 이유: 아이콘 경로(`../../resources/app-icon.ico`)처럼 asar 안의 경로를 네이티브 쪽이 읽는지 문서로 확인하지 못했고(미확인), 첫 목적이 "뜨는가"이기 때문이다. Electron 문서는 asar가 Windows 읽기 성능에 도움이 될 수 있다고 하므로 후속 최적화로 둔다.

## 6. 경로·보안 설정 (현재 코드에서 유지해야 하는 것)

- **보안**: `app.enableSandbox()`, `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`, `webSecurity: true`, CSP `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'` (`src/main/index.ts`, `src/renderer/index.html`). 패키징은 이 값을 바꾸지 않는다. renderer는 외부 URL을 읽지 않으므로(`connect-src 'self'`) 글꼴은 로컬 woff2(`assetsInlineLimit: 0`, `electron.vite.config.ts`)여야 한다.
- **데이터 경로(두 곳으로 나뉜다)**:
  - `userData`: 설정 `settings.json`(`src/main/settings.ts`)과 API 키 `openai-key.bin`(Electron `safeStorage`, `src/main/secrets.ts`).
  - **열린 원고 프로젝트 폴더 안 `<프로젝트>/.loreweave/`**: 원고 색인 `index.db`(`src/main/index-db.ts`: `INDEX_DIR = '.loreweave'`, `INDEX_FILE = 'index.db'`)와 AI 결과 `ai.db`(`src/main/ai-db.ts`: `AiStore.open(root)`가 `join(root, INDEX_DIR, AI_FILE)`을 연다, `AI_FILE = 'ai.db'`; `src/main/ipc.ts`의 `openAiStore(path, …)`도 열린 프로젝트의 `path/.loreweave/ai.db`를 본다). 즉 `ai.db`는 `userData`가 아니라 프로젝트 폴더에 있다.
- **주의(데이터 안전)**: 첫 실행본의 `package.json` `name`이 개발 때와 같으면 기본 `userData` 위치가 개발 환경과 **같을 수 있다**(앱 이름에서 파생되는 Electron 기본 동작; 이 계획에서 실제 값은 미확인). 그러면 검증 중 실행이 개발자의 실제 **설정·키**(`settings.json`, `openai-key.bin`)를 건드릴 수 있다. 따라서 검증은 **항상 `--user-data-dir`로 격리**한다(기존 `tests/e2e/launch.ts`가 같은 방식을 이미 쓴다).
- **격리는 두 가지가 모두 필요하다**: `--user-data-dir`(그리고 `name` 변경)은 **설정·키 경로만** 분리한다. 원고 색인과 AI DB는 프로젝트 폴더의 `.loreweave/`에 있으므로 userData 격리로는 보호되지 않는다. 검증은 (1) 별도 `userData`와 (2) **검증용으로 새로 만든 합성 원고 프로젝트 폴더**(실제 작품 폴더·기존 `.loreweave/ai.db`를 열지 않음)를 **둘 다** 써야 한다. 실제 프로젝트를 열면 그 프로젝트의 `index.db`/`ai.db`가 생성·변경될 수 있다.
- `.env`와 `OPENAI_ADMIN_KEY`는 `scripts/`의 개발 도구용이며 앱 런타임 코드(`src/`)는 `.env`를 읽지 않는다 (`src/`에서 `process.env`는 `ELECTRON_RENDERER_URL` 하나뿐). 그래도 산출물에 `.env*`를 넣지 않는다.

## 7. 빌드 때와 실행 때의 네트워크

- **빌드(준비) 때**: `pnpm install`이 Electron 바이너리를 내려받는다(이미 설치된 환경에서는 `node_modules/electron/dist`를 재사용). 이 PR에서는 다운로드를 하지 않았다. 구현 PR에서 새 다운로드가 필요하면 그 사실과 이유를 먼저 밝힌다.
- **실행 때**: 편집·자동 저장·원고 검색·4테마·충돌/닫기 보호는 AI 없이 **오프라인**에서 동작해야 한다(CLAUDE.md: "AI 없이도 에디터는 완전히 동작"). AI 기능은 사용자가 키를 넣고 버튼을 누를 때만 OpenAI로 나간다(선택 기능이며 이 검증 범위 밖).

## 8. 후속 구현 PR (작은 1개) 수용기준

1. 한 명령(예: `corepack pnpm package:win`)으로 `build` 뒤 §4의 폴더를 만든다. 새 의존성 없음, 새 다운로드 없음(있으면 사전 질문).
2. 산출물을 **개발 폴더와 무관한 깨끗한 폴더로 복사**해, 개발 서버·pnpm·`node_modules`(복사한 `openai` 제외) 없이 `electron.exe`가 뜬다 (복사본 검사).
3. 격리 `--user-data-dir`**와 별도의 합성 원고 프로젝트 폴더(둘 다 필수; 실제 프로젝트·기존 AI DB를 열지 않음)**에서 합성 BOM+CRLF+frontmatter 원고로: 폴더 열기 → 입력 → 저장 → 닫기 → 재열기 → 검색이 동작하고 파일 바이트가 보존된다. 아이콘과 4테마 대표 화면을 확인한다. 실제 사용자 키·원고·기존 AI DB는 건드리지 않는다.
4. 불필요한 네트워크 요청 0(AI 버튼을 누르지 않은 동안 외부 연결 없음)과 기존 저장/충돌/창 닫기 관련 최소 E2E를 같은 방식(패키지 실행본 대상 또는 동일 빌드)으로 통과한다.
5. 필요 없는 것: 인증서, 배포 계정, 유료 서비스, 자동 업데이트, 설치 프로그램. 미서명이므로 SmartScreen 등 OS 경고는 **확인하지 못한 상태**로 문서에 남긴다(실제 OS에서의 첫 실행 경험은 미확인).

## 9. 남은 결정과 후속 예상 범위

- 결정 필요: (1) 권고 A를 받아들일지, (2) 산출물 폴더 이름·위치(저장소 밖 출력 권장, `out/`와 분리), (3) `package.json` `name`/`productName`을 바꿔 기본 `userData`(설정·키)를 분리할지(데이터 경로가 바뀌는 결정이라 별도 승인 필요; **프로젝트의 `.loreweave/index.db`·`ai.db`는 이 변경으로 분리되지 않는다**), (4) asar 사용 시점.
- 후속 예상: ① A의 스크립트 PR(위 8절), ② exe 이름·아이콘·메타데이터가 필요하면 B 계획, ③ NSIS·서명·업데이트는 C와 함께 별도 계획(도구 지원 범위는 그때 공식 문서로 확인).

## 10. 이 문서가 확인하지 않은 것

- 어떤 패키징 도구도 설치·실행하지 않았다. Electron 44.9.3과 B/C의 호환, pnpm 처리, `electron.exe` 실제 실행, asar 아이콘 동작, 기본 `userData` 위치의 실제 값, OS 서명 경고는 모두 미확인이다.
- 공식 문서의 인용은 2026-11-15에 읽은 페이지의 요약이며, 후속 구현 시점에 다시 확인해야 한다.
