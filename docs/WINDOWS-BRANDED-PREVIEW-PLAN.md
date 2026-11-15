# Windows 실행파일 브랜드·아이콘·production 실행 경계 후속 계획

상태: **계획만 있다.** 이 문서는 아무것도 구현하지 않았다 (제품 코드·테스트·의존성·다운로드·빌드·패키징 실행 0). 감독의 검토·승인 전에는 구현을 시작하지 않는다.
앞선 계획 [WINDOWS-PREVIEW-PLAN.md](WINDOWS-PREVIEW-PLAN.md)의 A안(수동 폴더 배포)은 PR #219에서 **구현·검증됐다**(`corepack pnpm package:win`, 합성 Electron 자동 검증까지). 이 문서는 그 다음 단계다.
근거는 저장소의 실제 파일과 공식 문서·레지스트리 메타데이터(읽기 전용 조회)뿐이며, 확인하지 못한 것은 "미확인"이다. 현재 실제 유출·원고 손상·환경변수 재현 결함은 관측하지 않았다.

## 1. 첫 목표와 범위

- **첫 목표(제한)**: Windows x64 **미서명 unpacked** 폴더의 ① 실행파일 이름이 `LoreWeave`, ② 제공 v2 ICO가 실행파일 아이콘으로 임베딩, ③ 최소 앱 메타데이터(제품명·버전·저작권), ④ **개발 서버 없는 production 시작**이 환경과 무관하게 보장되는 경계.
- **하지 않는다**: 설치 프로그램, 서명, 자동 업데이트, 공개 릴리스, 새 기능, 4테마·환영·브랜드 화면의 재구현(이미 적용·검증됨), 기본 데이터 경로 변경·자동 이관·기존 데이터 삭제.
- **이미 있는 것(반복하지 않는다)**: 창 아이콘 `resources/app-icon.ico`(`BrowserWindow.icon`), 환영 화면·로고·4테마(DESIGN-SPEC §12.7), 폴더형 패키징(PR #219).

## 2. 현재 상태 (실제 파일·관측)

| 사실 | 근거 |
|---|---|
| 산출물의 실행파일은 `electron.exe`이고 임베디드 아이콘·메타데이터는 Electron 기본이다 (이름·ICO·메타데이터를 바꾸지 않는 것이 현 설계) | `scripts/package-win.ts` 머리말, README 한계 |
| `resources/app-icon.ico`는 6프레임(16·32·48·64·128·256px, 모두 32bpp), 87,776바이트다 | 파일 헤더를 읽어 확인 |
| DESIGN-SPEC은 원본 에셋(`LoreWeave-assets-v2.0`)을 "그대로 두고" `resources/`에 복사한 정적 파일만 쓴다고 하고, 설치 파일 아이콘은 "설치본을 만들 때 `app-icon.ico`를 배포 리소스에 연결해야 한다"고 적었다 | `docs/DESIGN-SPEC.md` §12.7 |
| **원본 에셋 위치와 동일성(확인)**: 사용자가 지정한 제공 원본은 `D:/DEV/LoreWeave-assets-v2.0/`(저장소 밖 로컬 폴더, 하위 `brand/ icons/ placeholders/ splash/ welcome/`)이고, `icons/app-icon.ico`와 저장소의 `resources/app-icon.ico`는 **각각 87,776바이트, SHA-256이 모두 `2E26144D3C526223BCAA7941EB15DD6900FF6377DC772EA2D061EFDAB6B2666D`로 같다**. 두 파일을 읽기 전용으로 직접 확인했다 (원본은 바꾸지 않았다). 이 로컬 경로는 **추적 가능한 출처 설명일 뿐 런타임·빌드가 참조하는 경로가 아니다**(앱은 저장소에 복사된 `resources/app-icon.ico`만 쓴다) | 파일 직접 읽기(SHA-256·크기), DESIGN-SPEC §12.7 |
| `package.json`에는 `name: "loreweave"`, `version`, `main`, `description`, `license`만 있고 `productName`·`author`·저작권이 없다. `scripts/package-win.ts`가 쓰는 산출물 `package.json`은 `name/version/main`뿐이다 | `package.json`, `scripts/package-win.ts` |
| smoke 관측(`PACKAGED_FACTS`): 산출물 실행 시 `app.isPackaged === false`, 앱 경로는 `resources/app`, `execPath`는 산출물의 `electron.exe` | `tests/e2e/package-win-smoke.test.ts`가 남긴 로그 |
| main은 `!app.isPackaged && process.env['ELECTRON_RENDERER_URL']`일 때만 `loadURL(devUrl)`, 아니면 `loadFile(renderer/index.html)`이다 | `src/main/index.ts` |
| smoke는 `ELECTRON_RENDERER_URL`을 **지우고** 실행한다 | `tests/e2e/package-win-smoke.test.ts` (`delete env['ELECTRON_RENDERER_URL']`) |

→ 따라서 smoke 성공은 "그 환경변수가 없을 때 production처럼 뜬다"만 보여 준다. `isPackaged`가 false인 실행본이 환경변수를 **상속받으면** 외부 개발 서버를 읽는 경로가 열려 있다 (이번에 재현하지 않았고, 결함으로 단정하지 않는다).

## 3. 이름·`isPackaged`·데이터 경로의 관계

| 항목 | 근거 | 확인/미확인 |
|---|---|---|
| 앱 이름 `app.name`은 `package.json`의 `productName`이 있으면 그것, 없으면 `name` | Electron [app API](https://www.electronjs.org/docs/latest/api/app) ("productName ... preferred over name") | 확인(문서). 현재 `productName` 없음 → `loreweave` |
| 기본 `userData`는 `appData`에 앱 이름을 붙인 폴더(Windows `%APPDATA%`) | 같은 문서 | 확인(문서). 이 앱의 실제 값은 이 계획에서 실행하지 않아 **미확인** |
| 실행파일 이름이 `app.name`을 결정하는지 | 문서에 그런 언급 없음 (이름은 `package.json`에서) | 이름만 바꿔 `userData`가 바뀐다고 **추측하지 않는다**. 후속에서 `app.name`과 `app.getPath('appData')`로 기대 경로를 계산해 변하지 않음을 관측한다 (기본 경로 자체를 만들거나 쓰지 않는다) |
| `app.isPackaged`: "패키지된 앱이면 true" | Electron app API (읽은 구간에서 판정 방식은 설명되지 않음) | **판정 방식 미확인.** 현재 `electron.exe`+`resources/app`에서 false를 관측. 실행파일 이름을 바꾸면 true가 되는지는 **미확인** — 가정하지 않고 후속에서 관측한다 |
| 설정·키·최근 프로젝트 | `settings.json`(`lastProject` 포함, `src/main/settings.ts`)과 `openai-key.bin`(`src/main/secrets.ts`)은 `userData` | 유지. 개발과 실행본의 기본 `userData`가 같으면 최근 프로젝트·키·설정이 공유될 수 있으므로 검증은 항상 `--user-data-dir` 격리 |
| 색인·AI 결과 | `<프로젝트>/.loreweave/index.db`, `ai.db` (`src/main/index-db.ts`, `ai-db.ts`) | 유지. `userData`·이름 변경과 무관. 검증은 별도 합성 프로젝트 |

**원칙**: `productName` 추가·`name` 변경·`userData` 정책 변경·자동 이관·기존 데이터 삭제는 이 계획의 범위 밖이며 별도 승인 사항이다. 후속 구현은 `app.name`/기본 `userData` 경로가 **현재와 같음**을 관측으로 보여야 한다 (바뀌면 데이터가 갈라지므로 중단하고 질문).

## 4. 도구 경로 비교와 권고

| 경로 | 설명 | 확인/미확인 |
|---|---|---|
| **A. 현행 수동 배포 유지 (이름·아이콘 그대로)** | 새 의존성 0. 실행파일은 `electron.exe` | 이 목표(이름·ICO·메타데이터)를 달성하지 못한다. 대안이 불가능할 때의 안전한 후퇴선 |
| **B. `@electron/packager`를 엄격 staging 폴더에 적용** | 우리 허용 목록·사전 검사로 만든 `resources/app` 내용(staging)만 packager 입력으로 쓴다. `name`, `icon`(.ico), `appVersion`, `appCopyright`, `asar:false`로 이름·아이콘·메타데이터 처리 | 아래 표 |
| **C. `electron-builder --dir`** | 설정 표면이 가장 넓다. 이후 NSIS·서명·업데이트와 연결 | 이번 목표에는 과하다. 설치 프로그램 단계의 별도 계획 |

`@electron/packager`에 대해 읽은 것 ([Options](https://electron.github.io/packager/main/interfaces/Options.html), [npm 레지스트리 메타데이터](https://registry.npmjs.org/@electron/packager/latest) 2026-11-15 조회):

| 항목 | 내용 | 상태 |
|---|---|---|
| 최신 버전·Node 요구 | 20.3.0, `engines.node >= 22.12.0`, BSD-2-Clause | 확인(메타데이터). 개발 Node 24.13.0 충족 |
| `name` | 생략하면 `productName`/`name`. 파일명에 못 쓰는 문자는 하이픈 | 확인(문서) |
| `icon` | Windows는 `.ico` 로컬 경로 | 확인(문서) |
| `appVersion`/`appCopyright` | 각각 `ProductVersion`/`LegalCopyright`로 매핑 | 확인(문서) |
| `win32metadata` | 필드와 기본값은 링크된 [Win32MetadataOptions](https://electron.github.io/packager/main/interfaces/Win32MetadataOptions.html)에 있다: `CompanyName`(기본: `package.json`의 `author` 이름), `FileDescription`·`InternalName`·`ProductName`(기본: `productName` 또는 `name`), `OriginalFilename`(기본: 이름을 바꾼 `.exe`), `requested-execution-level`(`asInvoker`/`highestAvailable`/`requireAdministrator`, 기본 값은 문서에 없음), `application-manifest`(로컬 매니페스트 경로). v20.3.0 `src/types.ts`의 `win32metadata`/`Win32MetadataOptions` 설명과 일치 | 확인(공식 문서·소스 텍스트) |
| `asar` | 기본 `false` | 확인(문서) |
| `ignore` | 절대 경로에 대한 정규식(glob 아님) | 확인(문서) — 우리는 staging 입력만 쓰므로 의존을 줄인다 |
| `prune` | 기본 `true`(devDependencies 제외) | 확인(문서). staging에는 `openai`뿐이라 의미는 작지만 동작을 관측해야 함 |
| Electron 다운로드 | `@electron/get`으로 받는다. `electronZipDir`로 로컬 **zip**을 쓰면 다운로드를 끈다 | 확인(문서). 현재 로컬엔 압축 해제된 `node_modules/electron/dist`만 있고 zip은 없다 → **빌드 때 네트워크 다운로드 필요 여부는 미확인**(캐시 위치·zip 확보 방법 확인 필요) |
| 직접 의존 | `resedit`(Windows 실행파일 리소스), `@electron/get`, `@electron/asar`, `@electron/notarize`, `@electron/osx-sign`, `@electron/universal`, `@electron/windows-sign` 등 | 확인(메타데이터). 서명·macOS 의존까지 끌려와 **전이 의존 트리가 크다**; 실제 설치 크기·보안 감사는 미확인 |
| 공식 도구가 실행파일을 수정하는 경로 | **정확 태그 v20.3.0 공식 소스를 읽었다**([`src/win32.ts`](https://raw.githubusercontent.com/electron/packager/v20.3.0/src/win32.ts), [`src/resedit.ts`](https://raw.githubusercontent.com/electron/packager/v20.3.0/src/resedit.ts), [`src/types.ts`](https://raw.githubusercontent.com/electron/packager/v20.3.0/src/types.ts)). `win32.ts`: `generateReseditOptionsSansIcon()`가 `FileDescription`·`InternalName`·`ProductName`(=`opts.name`)과 `OriginalFilename`(=`newElectronName`)을 기본값으로 만들고 사용자 `win32metadata`를 마지막에 덮어쓰며, `productVersion`=`appVersion`, `fileVersion`=`buildVersion`(없으면 `appVersion`), `legalCopyright`=`appCopyright`로 매핑한다. `runResedit()`는 `needsResedit()`(icon/win32metadata/appCopyright/appVersion/buildVersion/name 중 하나라도 설정)일 때만 동작하고, `getIconPath()`(`.ico`로 정규화, 배열이면 오류)를 `iconPath`로 넘겨 `resedit(electronBinaryPath, …)`를 호출한다. 대상은 `electronBinaryPath = path.join(stagingPath, newElectronName)`, 즉 **packager가 만든 staging 안의 이름을 바꾼 exe**이고 `create()`가 `renameElectron()` 뒤에 `runResedit()`를 부른다. `resedit.ts`: `.ico`를 `Data.IconFile.from`으로 읽고 `Resource.IconGroupEntry.replaceIconsForResource`로 기존 아이콘 그룹(정확히 1개 필요)을 교체, `Resource.VersionInfo`(정확히 1개, 언어 1개)에 문자열(`CompanyName`/`FileDescription`/`InternalName`/`OriginalFilename`/`LegalCopyright`/`ProductName`/`FileVersion`/`ProductVersion`)을 쓰되 **빈 값은 지워 원래 문자열이 남는다**, `application-manifest`와 `requested-execution-level`을 함께 주면 오류, 마지막에 `res.outputResource(exe)`→`exe.generate()`→`writeFile(exePath)`로 **제자리 덮어쓴다(임시 파일·백업 없음)** | 확인(공식 소스 텍스트). 아래 "의미" 참고 |
| Electron 44.9.3 지원 | 읽은 문서·메타데이터에 지원 범위 언급 없음 | **미확인** |
| `rcedit` | 같은 계열 도구지만 저장소가 2026-04-06 보관(read-only)됐고 [README](https://github.com/electron/rcedit)는 CLI만 설명 | 직접 쓰지 않는다 |
| 출력의 고지 보존 | packager가 Electron 배포본의 `LICENSE`, `LICENSES.chromium.html`을 유지하는지 | **미확인** (후속에서 산출물 파일 존재로 확인) |

**공식 도구의 PE 수정과 "임의 패치 금지"의 구분.** 공식 도구도 내부적으로 PE 리소스를 수정한다(위 소스). 이 계획이 금지하는 것은 **우리가 직접 만든 임의의 PE/바이너리 패치 코드나 비공식 도구를 쓰는 것**이다. 허용하는 것은 **공식 도구의 문서화된 옵션**(`name`, `icon`, `appVersion`, `appCopyright`, `win32metadata`)을 쓰는 것이며, 그 수정은 packager가 만든 staging의 exe 복사본에만 일어나고 저장소의 `node_modules/electron/dist/electron.exe`는 바뀌지 않는다(소스상 대상 경로 기준). 설계 시사점: 소스상 빈 값은 원래 Electron 문자열을 남기므로, 구현 PR은 `CompanyName` 등 남기고 싶지 않은 문자열을 **명시 지정**해야 하고(`package.json`에 `author`가 없다 — 문서의 `CompanyName` 기본값은 `author` 이름이며, 읽은 `generateReseditOptionsSansIcon()` 기본값 목록에는 `CompanyName`이 보이지 않아 실제 동작은 **미확인**), 산출물의 문자열을 관측으로 확인해야 한다.
**소스를 읽은 것은 Electron 44.9.3 호환이나 실행 결과의 검증이 아니다.** 아래 항목은 그대로 미확인이다.

**권고: 경로 B(엄격 staging + `@electron/packager`, 정확 버전 고정)를 *조건부*로 권고한다.** 이유: 이름·ICO·메타데이터를 우리가 직접 PE 리소스로 패치하지 않고 공식 도구의 지원 옵션에 맡길 수 있고, 우리 허용 목록·사전 검사·실제 경로 보호는 그대로 입력 단계에 남는다. 조건(구현 전 확인 게이트, 설치·실행 없이 가능한 것부터):
1. 패키지 [릴리스 노트/README](https://github.com/electron/packager)에서 Electron 44(또는 최신 stable) 지원 문구를 찾는다. 없으면 **미확인으로 두고 구현하지 않는다**.
2. 새 devDependency와 lockfile 변경(전이 의존 포함)과 **빌드 때 Electron zip 다운로드**가 필요하다는 점을 감독이 승인해야 한다 (이번 과제 범위 밖; "새 의존성·다운로드는 사전 질문").
3. 위가 모두 확인되지 않으면 경로 A를 유지하고(이름·아이콘은 그대로) 이 목표를 보류한다. 새 도구가 불필요하면 추가하지 않는다.

## 5. production 시작 경계 (후속 수용기준 제안)

- **문제**: 현재 판정은 `!app.isPackaged && ELECTRON_RENDERER_URL`이다. 이름을 바꿔도 `isPackaged`가 true가 된다는 보장이 없고(§3), smoke는 환경변수를 지운 경우만 본다.
- **수용기준(구현 PR)**: 개발 흐름(`electron-vite dev`, `ELECTRON_RENDERER_URL` 사용)은 **유지**하되, **배포본(폴더형 실행본)은 상속된 `ELECTRON_RENDERER_URL`이 있어도 그 URL을 읽지 않는다.** 검증: 합성 loopback(127.0.0.1) 수신 서버를 띄워 요청을 기록하고, 산출물을 그 변수를 **설정한 채** 실행해 ① 수신 서버가 받은 요청 0, ② 창이 `file:` renderer로 열림, ③ 기존 smoke(편집·저장·재열기·검색)가 통과함을 본다. 이 계획에서는 재현하지 않는다.
- **구현 선택지(이 계획이 결정하지 않는다)**: (a) 이름 변경 뒤 `isPackaged`가 true로 관측되면 현행 분기를 유지하고 관측만 추가, (b) 실행 레이아웃(`resources/app` 존재·`process.defaultApp`)에 근거한 명시 가드, (c) 빌드 타임 상수. 각각 `isPackaged` 판정 방식 미확인·복잡도·개발 흐름 영향의 장단이 있으므로 구현 전 감독이 고른다. 어느 쪽이든 CSP·sandbox·`will-navigate`/`setWindowOpenHandler` 정책은 변경하지 않는다.

## 6. 후속 구현 PR 범위 제안 (작은 PR, 순서 포함)

위험이 다른 두 변경이라 **두 개의 작은 PR**을 권고한다 (감독이 하나로 묶을지 정한다).

**PR-1 production 시작 경계** (새 의존성 0): 예상 변경 — `src/main/index.ts`(분기 최소 수정, 개발 흐름 유지), `tests/e2e/`에 환경변수 설정·loopback 기록 검사 1개, 필요하면 `tests/e2e/package-win-smoke.test.ts` 보강. 제품 정책(CSP/sandbox/저장·충돌·닫기)은 불변.

**PR-2 실행파일 이름·아이콘·메타데이터** (§4의 조건이 충족될 때만): 예상 변경 — `package.json`/`pnpm-lock.yaml`(정확 버전 devDependency), `scripts/package-win.ts`(엄격 staging → packager 호출 → 산출물 검증), `tests/core/package-win.test.ts`(경계 검사 갱신), `tests/e2e/package-win-smoke.test.ts`(실행파일 이름 `LoreWeave.exe`로 실행), README.
공통 수용기준:
1. 기존 보호 유지: **엄격 허용 목록·복사 전 사전 검사·실제 경로 출력 보호·덮어쓰기/삭제 0**, 링크 0, `LICENSE`·`LICENSES.chromium.html`·SDK·앱 고지·로컬 글꼴·브랜드 보존(산출물 파일 존재로 확인).
2. 분리된 복사본을 **별도 `--user-data-dir`와 새로 만든 합성 프로젝트(BOM+CRLF+frontmatter)**로 실행: 오프라인 편집→저장→재열기→검색, 원고 Buffer·이웃 불변, 기존 AI DB·키·실제 프로젝트 접근 0.
3. (PR-2) 실행파일 이름·아이콘·메타데이터 확인은 새 의존성 없이 가능한 방법을 먼저 쓴다 — 예: PowerShell `(Get-Item <exe>).VersionInfo`의 `ProductName`/`FileDescription`/`OriginalFilename`/`ProductVersion`, 아이콘은 `System.Drawing.Icon.ExtractAssociatedIcon`으로 추출해 `app-icon.ico`의 해당 프레임과 비교. **이 방법들이 실제로 동작하는지는 미확인**이며 구현 PR에서 먼저 확인한다. `app.name`·`app.getPath('appData')`로 기본 `userData` 경로가 현재와 같음을 관측한다.
4. 자동 검사의 한계를 구분해 보고한다: 실제 OS 탐색기·작업표시줄 아이콘 표시, 다른 PC 실행, SmartScreen/서명 경고, 수동 GUI는 자동 검사로 확인되지 않는다.
5. 전체 E2E·96장 캡처·IME campaign은 하지 않는다. 최소 묶음: 단위 + 패키지 smoke + 기존 저장/충돌/닫기 관련 최소 검사.

## 7. 남은 결정과 미확인

- 결정 필요: (1) 구현을 PR-1/PR-2로 나눌지와 순서, (2) 경로 B를 위한 새 devDependency·lockfile 변경·Electron zip 다운로드 승인, (3) *(해소)* 원본 ICO 위치·동일성은 확인 완료(§2) — 구현 PR은 빌드 검증에서 `resources/app-icon.ico`의 SHA-256을 위 값과 재대조할지만 정하면 된다, (4) production 가드 방식(§5 a/b/c), (5) `productName`/`name`/`userData`는 건드리지 않는다는 원칙의 확인.
- 미확인: `@electron/packager` 20.3.0의 Electron 44.9.3 지원과 실제 실행 결과(소스를 읽었을 뿐 호환·산출물 검증이 아니다), `CompanyName` 기본값의 실제 동작, 고지 파일 보존, Electron zip 확보 방식, `app.isPackaged` 판정 방식과 이름 변경의 영향, 기본 `userData`의 실제 값, OS 아이콘 표시·SmartScreen·다른 PC 실행. (해소: `win32metadata` 필드·기본값, `resedit`가 쓰이는 경로의 소스 근거, 제공 원본 ICO와의 동일성.)
- 이 문서의 공식 문서·메타데이터 인용은 2026-11-15에 읽은 내용이며 구현 시점에 다시 확인해야 한다.
