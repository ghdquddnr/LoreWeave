# Windows 실행파일 브랜드·아이콘·production 실행 경계 후속 계획

상태: **PR-1(production 시작 경계)은 구현·검증됐다**(`process.defaultApp === true && !app.isPackaged && ELECTRON_RENDERER_URL`일 때만 개발 서버를 읽음; 폴더 실행본의 `process.defaultApp`은 undefined로 관측). **PR-2는 선택형 명령 `package:win:branded`로 구현·검증됐다**(2026-11-16, 감독이 승인한 범위: 정확 `@electron/packager@20.3.0` devDependency, 이번 빌드가 새로 만든 독점 임시 루트 안에서만 packager의 삭제 호출 허용; §4.3). 기존 `package:win`(경로 A, `electron.exe` 유지)은 그대로 쓸 수 있다. 설치 프로그램·서명·자동 업데이트·배포는 없다. 아래 §4.1(읽기 전용 판정)·§4.2(합성 격리 실험)는 **그 시점(2026-11-16, 구현 전)의 판정·기록**이며, 그 안의 "실행 증거 없음"·"실험 승인 0"·"PR-2 미승인" 같은 서술은 당시 상태다. 아래는 **작성 당시(PR-1 구현 전)의 계획 원문**이다. 본문의 "현재 상태"·"구현 0"·"미승인" 서술은 그 당시 기록이며, **PR-1과 PR-2(선택형 명령)는 그 뒤 구현됐다**(§4.3). 계획 원문은 작성 당시 제품 코드·테스트·의존성·다운로드·빌드·패키징 실행 0이었다.
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
| `asar` | **문서와 구현이 어긋난다**(정확 태그 v20.3.0): `types.ts`의 주석은 "기본 false"처럼 읽히지만, `common.ts`의 `createAsarOpts()`는 `opts.asar === true` **또는 `undefined`**이면 ASAR 옵션을 만들고 `false`일 때만 끈다(그 밖의 값은 경고 후 끔). 따라서 "기본 false"를 문서만 보고 단정하지 않는다 — 현행 비ASAR 레이아웃을 유지하려면 **`asar: false`를 명시**해야 한다. 실제 실행은 미확인 | 확인(소스 대조: `types.ts` `asar`, `common.ts` `createAsarOpts`) / 실행 미확인 |
| `ignore` | 절대 경로에 대한 정규식(glob 아님) | 확인(문서) — 우리는 staging 입력만 쓰므로 의존을 줄인다 |
| `prune` | 기본 `true`(devDependencies 제외) | 확인(문서). staging에는 `openai`뿐이라 의미는 작지만 동작을 관측해야 함 |
| Electron 다운로드 | `@electron/get`으로 받는다. `electronZipDir`로 로컬 **zip**을 쓰면 다운로드를 끈다 | 확인(문서·소스). **2026-11-16 갱신: 일치하는 로컬 캐시 zip이 있고 해시가 공식 값과 같다** → `electronZipDir` 사용 시 Electron 바이너리 다운로드는 필요 없다(§4.1). *(작성 당시 "zip 없음·미확인"은 `node_modules/electron/dist`만 보고 쓴 것이며 캐시를 확인하지 않았다)* |
| 직접 의존 | `resedit`(Windows 실행파일 리소스), `@electron/get`, `@electron/asar`, `@electron/notarize`, `@electron/osx-sign`, `@electron/universal`, `@electron/windows-sign` 등 | 확인(메타데이터). 서명·macOS 의존까지 끌려와 **전이 의존 트리가 크다**; 실제 설치 크기·보안 감사는 미확인 |
| 공식 도구가 실행파일을 수정하는 경로 | **정확 태그 v20.3.0 공식 소스를 읽었다**([`src/win32.ts`](https://raw.githubusercontent.com/electron/packager/v20.3.0/src/win32.ts), [`src/resedit.ts`](https://raw.githubusercontent.com/electron/packager/v20.3.0/src/resedit.ts), [`src/types.ts`](https://raw.githubusercontent.com/electron/packager/v20.3.0/src/types.ts)). `win32.ts`: `generateReseditOptionsSansIcon()`가 `FileDescription`·`InternalName`·`ProductName`(=`opts.name`)과 `OriginalFilename`(=`newElectronName`)을 기본값으로 만들고 사용자 `win32metadata`를 마지막에 덮어쓰며, `productVersion`=`appVersion`, `fileVersion`=`buildVersion`(없으면 `appVersion`), `legalCopyright`=`appCopyright`로 매핑한다. `runResedit()`는 `needsResedit()`(icon/win32metadata/appCopyright/appVersion/buildVersion/name 중 하나라도 설정)일 때만 동작하고, `getIconPath()`(`.ico`로 정규화, 배열이면 오류)를 `iconPath`로 넘겨 `resedit(electronBinaryPath, …)`를 호출한다. 대상은 `electronBinaryPath = path.join(stagingPath, newElectronName)`, 즉 **packager가 만든 staging 안의 이름을 바꾼 exe**이고 `create()`가 `renameElectron()` 뒤에 `runResedit()`를 부른다. `resedit.ts`: `.ico`를 `Data.IconFile.from`으로 읽고 `Resource.IconGroupEntry.replaceIconsForResource`로 기존 아이콘 그룹(정확히 1개 필요)을 교체, `Resource.VersionInfo`(정확히 1개, 언어 1개)에 문자열(`CompanyName`/`FileDescription`/`InternalName`/`OriginalFilename`/`LegalCopyright`/`ProductName`/`FileVersion`/`ProductVersion`)을 쓰되 **빈 값은 지워 원래 문자열이 남는다**, `application-manifest`와 `requested-execution-level`을 함께 주면 오류, 마지막에 `res.outputResource(exe)`→`exe.generate()`→`writeFile(exePath)`로 **제자리 덮어쓴다(임시 파일·백업 없음)** | 확인(공식 소스 텍스트). 아래 "의미" 참고 |
| Electron 44.9.3 지원 | **갱신(§4.1)**: 일반 "지원 범위" 문구는 여전히 없다. 대신 정확 태그에서 Electron 44를 **인지한 명시 흔적**(README 각주, v20.0.4 릴리스 노트, `@electron/get` 5.1.0 `utils.ts`)을 찾았으나 모두 win32/ia32·linux/armv7l 산출물 중단에 관한 것이다. **44.9.3 + win32-x64 명시 지원 문구는 없음.** 실행 증거는 §4.2의 합성 격리 1회 성공(제품 아님) | 부분 확인: 인지 흔적 O / 명시 지원 없음 / 합성 앱 실행 1회 성공(§4.2) |
| `rcedit` | 같은 계열 도구지만 저장소가 2026-04-06 보관(read-only)됐고 [README](https://github.com/electron/rcedit)는 CLI만 설명 | 직접 쓰지 않는다 |
| 출력의 고지 보존 | packager가 Electron 배포본의 `LICENSE`, `LICENSES.chromium.html`을 유지하는지 | **미확인** (후속에서 산출물 파일 존재로 확인) |

**공식 도구의 PE 수정과 "임의 패치 금지"의 구분.** 공식 도구도 내부적으로 PE 리소스를 수정한다(위 소스). 이 계획이 금지하는 것은 **우리가 직접 만든 임의의 PE/바이너리 패치 코드나 비공식 도구를 쓰는 것**이다. 허용하는 것은 **공식 도구의 문서화된 옵션**(`name`, `icon`, `appVersion`, `appCopyright`, `win32metadata`)을 쓰는 것이며, 그 수정은 packager가 만든 staging의 exe 복사본에만 일어나고 저장소의 `node_modules/electron/dist/electron.exe`는 바뀌지 않는다(소스상 대상 경로 기준). 설계 시사점: 소스상 빈 값은 원래 Electron 문자열을 남기므로, 구현 PR은 `CompanyName` 등 남기고 싶지 않은 문자열을 **명시 지정**해야 하고(`package.json`에 `author`가 없다 — 문서의 `CompanyName` 기본값은 `author` 이름이며, 읽은 `generateReseditOptionsSansIcon()` 기본값 목록에는 `CompanyName`이 보이지 않아 실제 동작은 **미확인**), 산출물의 문자열을 관측으로 확인해야 한다.
**소스를 읽은 것은 Electron 44.9.3 호환이나 실행 결과의 검증이 아니다.** 아래 항목은 그대로 미확인이다.

**권고: 경로 B(엄격 staging + `@electron/packager`, 정확 버전 고정)를 *조건부*로 권고한다.** 이유: 이름·ICO·메타데이터를 우리가 직접 PE 리소스로 패치하지 않고 공식 도구의 지원 옵션에 맡길 수 있고, 우리 허용 목록·사전 검사·실제 경로 보호는 그대로 입력 단계에 남는다. 조건(구현 전 확인 게이트, 설치·실행 없이 가능한 것부터):
1. 패키지 [릴리스 노트/README](https://github.com/electron/packager)에서 Electron 44(또는 최신 stable) 지원 문구를 찾는다. 없으면 **미확인으로 두고 구현하지 않는다**. *(2026-11-16: 명시 지원 문구는 없고 44 인지 흔적만 있다 — §4.1. 조건 1은 충족되지 않았고, 실제 비호환의 증거도 아니다. 실행 증거는 격리 실험으로만 얻을 수 있다.)*
2. 새 devDependency와 lockfile 변경(전이 의존 포함)과 ~~빌드 때 Electron zip 다운로드~~가 필요하다는 점을 감독이 승인해야 한다 (이번 과제 범위 밖; "새 의존성·다운로드는 사전 질문"). *(2026-11-16: 로컬 캐시 zip이 있어 **Electron zip 다운로드는 필요 없다**. 필요한 승인은 packager 패키지와 전이 의존의 **npm 설치(패키지 다운로드)·lockfile 변경**이다. 전이 의존 트리의 크기·설치 스크립트 유무는 미확인.)*
3. 위가 모두 확인되지 않으면 경로 A를 유지하고(이름·아이콘은 그대로) 이 목표를 보류한다. 새 도구가 불필요하면 추가하지 않는다.

### 4.1 PR-2 선행 게이트 판정 (2026-11-16, 읽기 전용) — *당시 판정(구현 전)*

읽은 것: 정확 태그 [`electron/packager@v20.3.0`](https://github.com/electron/packager/tree/v20.3.0)의 `README.md`·`package.json`·`src/{packager,platform,download,unzip,common,types}.ts`, [packager 릴리스 노트](https://github.com/electron/packager/releases)(v20.0.4·v20.3.0), [`electron/get@v5.1.0`](https://github.com/electron/get/tree/v5.1.0)의 `src/{Cache,artifact-utils,index,utils}.ts`, npm 레지스트리 메타데이터(텍스트), [Electron v44.9.3 `SHASUMS256.txt`](https://github.com/electron/electron/releases/download/v44.9.3/SHASUMS256.txt)(텍스트). 로컬은 Electron 캐시 폴더의 파일명·크기·SHA-256과 설치된 `node_modules/electron/checksums.json`만 읽었다. **설치·다운로드한 zip/바이너리·빌드·패키징·캐시 수정 0**(zip은 읽어서 해시만 계산).

**게이트 1 — 호환 근거 (일반 지원 / 44 인지 흔적 / 44.9.3 명시 지원 / 실행 증거를 구분)**

| 구분 | 내용 | 결과 |
|---|---|---|
| 일반 요구 | 20.3.0(npm 게시 2026-08-11, GitHub 릴리스 노트는 `asar integrity digest` 하나), `engines.node >= 22.12.0`, 개발 Node 24.13.0 충족. `@electron/get ^5.0.0` 의존(레지스트리상 5.x는 5.0.0·5.1.0, latest 5.1.0), `resedit ^2.0.3` | 확인 |
| 지원 Electron 범위 문구 | README·`package.json`·`types.ts`에 Electron **버전 범위(최소/최대) 문구 없음** | **없음** |
| Electron 44 인지 흔적 | ① README 각주: Windows x86(ia32)·Linux armv7l 빌드는 "Electron 44.0.0-alpha.4부터 공식 제공되지 않는다". ② 릴리스 v20.0.4(2026-07-22): "add Electron 44 version gates for win32/ia32 and linux/armv7l (#1935)". ③ `@electron/get` 5.1.0 `utils.ts`: `FIRST_RELEASE_WITHOUT_32_BIT_SUPPORT = '44.0.0-alpha.4'`, `isOfficialDropped32BitDownload()` | 확인. **win32/x64는 이 게이트의 대상이 아니다**(대상은 win32/ia32·linux/armv7l) |
| 44.9.3 + win32-x64 명시 지원 | 찾지 못했다 | **없음/미확인** ("지원하지 않음"이 아니다) |
| 소스상 win32 처리 | `win32.ts`가 `renameElectron()` 뒤 `runResedit()`로 staging 안의 이름 바꾼 exe에 `resedit` 적용(앞 표). 44.9.3 `electron.exe`에 실제로 적용되는지는 소스만으로 알 수 없다 | 소스 추론만 |
| 실행 호환 증거 | *작성 당시(§4.1 판정 시점)*: 없음. **갱신: §4.2의 합성 격리 실험 1회 성공** | 합성 앱 한정 |

→ 게이트 1은 **충족되지 않았으나 차단도 아니다**: "명시 지원 없음 + 44 인지 흔적 + 실행 증거 없음"이며, 이 상태를 충족으로 처리하지 않는다.

**게이트 2 — Electron zip (네트워크 텍스트 조회와 실행 바이너리 다운로드를 구분)**

- `electronZipDir` 요구(`packager.ts` `getElectronZipPath`): 폴더가 있고 그 안에 정확히 `electron-v${version}-${platform}-${arch}.zip`(여기서는 `electron-v44.9.3-win32-x64.zip`)이 있어야 한다. 없으면 오류(자동 다운로드로 넘어가지 않는다). 이때 `download` 하위 옵션은 무시된다(`types.ts`). **packager는 이 zip의 해시를 검증하지 않는다**(`existsSync`만) → 구현은 사용 전에 해시를 직접 대조해야 한다.
- `@electron/get` 캐시(`Cache.ts`): 캐시 루트는 `env-paths('electron', {suffix: ''}).cache`, 하위 폴더는 **다운로드 URL의 디렉터리(`https://github.com/electron/electron/releases/download/v44.9.3`)의 SHA-256**, 파일명은 `electron-v44.9.3-win32-x64.zip`(`artifact-utils.ts`). 다운로드 URL 기본값은 `https://github.com/electron/electron/releases/download/`. 캐시가 있으면 쓰고 체크섬(`SHASUMS256.txt`, `sumchecker`)이 맞지 않으면 재다운로드한다(`index.ts`).
- **로컬 확인**: 위 규칙으로 계산한 캐시 폴더(`%LOCALAPPDATA%\electron\Cache\902aaaf9…9562`)에 `electron-v44.9.3-win32-x64.zip`이 **있다**(158,508,870바이트). 그 SHA-256 `41a1ffa0541cb0f2c9b9fe920dd2cef1793ad0ea2ada1a9582958880f4d1b23c`는 **공식 `SHASUMS256.txt`의 같은 파일 값과 같고, 설치된 `node_modules/electron/checksums.json` 값과도 같다**. 같은 캐시 루트에 이 작업과 무관한 다른 Electron 버전 zip들도 있다(건드리지 않았다).
- 결론: `electronZipDir`에 이 캐시 폴더(해당 zip만 들어 있는 해시 폴더)를 주면 **Electron 바이너리 다운로드는 필요 없다**. 단 이 경로는 사용자 환경의 캐시이므로 저장소에 하드코딩하지 않고, 구현은 `node_modules/electron/checksums.json`의 값과 SHA-256이 같을 때만 쓰고 다르거나 없으면 **실패**해야 한다(다운로드로 우회하지 않는다). 다른 PC·CI에서는 캐시가 없을 수 있다 — 그 경우의 확보 방법은 이번 범위 밖이다.

**소스에서 찾은 구현 제약 (실행해 보지 않았다 — 소스 관측이며 실제 기존 출력 손실을 재현한 것이 아니다; 정확 태그 v20.3.0 `src/packager.ts`·`src/platform.ts`·`src/common.ts` 기준)**
1. **재귀 삭제 호출이 두 모드 모두에 있다.**
   - 기본(`tmpdir` 미지정): `ensureTempDir()`가 시작 때 `<os tmpdir>/electron-packager`(`baseTempDir`)를 `rm {recursive, force}`한다 — **공용 임시 폴더 삭제**. 이 모드에서는 `packageForPlatformAndArchWithOpts`가 `checkOverwrite`를 거치므로 최종 폴더가 있고 `overwrite`가 없으면 "Skipping … use --overwrite"로 **오류 없이 건너뛰고**, `overwrite: true`면 최종 폴더를 `rm -rf`한다(`overwriteAndCreateApp`).
   - `tmpdir: false`: 공용 tempBase 삭제는 피한다. 그러나 `!useTempDir`이면 `packageForPlatformAndArchWithOpts`가 **`checkOverwrite` 없이 곧바로 `createApp`** 으로 가고, `platform.ts`의 `stagingPath` getter가 `tmpdir === false`일 때 `generateFinalPath(opts)`(= `<out>/<name>-win32-x64`)를 돌려주며, `initialize()`가 **`fs.promises.rm(this.stagingPath, {recursive: true, force: true})` 뒤에 템플릿 폴더를 그 경로로 `rename`** 한다. 즉 이 모드에서는 **최종 출력 경로의 재귀 삭제 호출이 남고**, `overwrite` 미설정 시 건너뛴다는 위 설명은 **적용되지 않는다**(`overwrite` 옵션이 이 경로에서는 보호가 되지 않는다). 템플릿 폴더는 `out` 안의 `win32-x64-template-*`로 만들어져(`buildDir`) `initialize()`에서 최종 이름으로 이동한다(이름 변경은 소스에서 확인됨; EXDEV 때는 복사 후 삭제). 이후 단계의 잔여물 여부는 실행하지 않아 미확인.
   - **이 계획의 "재귀 삭제 0·기존 출력 보호" 경계와 충돌한다.** 현재 제안만으로 "삭제 0"이나 "기존 출력 보호"가 충족된다고 보지 않으며, 이를 근거로 실험이 안전하다고 보지 않는다. 우리 `checkOutput`의 사전 거절은 packager 호출 **앞**의 방어일 뿐이고, 호출 시점의 경합·경로 별칭까지 막는다는 증거는 없다.
2. 출력 폴더 이름은 packager가 `<name>-win32-x64`로 정한다(README, `generateFinalPath`) — 우리 현행 출력 이름과 다르다(설계 변경 필요).
3. **`asar` 문서·구현 불일치**(위 표): 후속 설계는 `asar: false`를 **명시**해야 한다(`createAsarOpts`는 `undefined`를 ASAR 사용으로 처리). `asarIntegrityDigest`(20.3.0 신규)는 `types.ts`의 조건 문구상 `asar` 사용 + 플랫폼 `darwin`/`mas` + Electron ≥ 41 + macOS 호스트일 때만 동작하고 그 밖에는 no-op이라고 적혀 있다 → **win32 대상·`asar: false`에서는 해당 없음**(소스 문구로 좁혔을 뿐 실행 증거는 없다).
4. 미확인: 전이 의존 트리의 크기·설치 스크립트·보안 감사, 44.9.3 `electron.exe` 대상 `resedit` 실제 동작, `CompanyName` 기본값, 산출물의 `LICENSE`/`LICENSES.chromium.html` 보존, 기본 `app.name`/`userData` 불변.

**권고 (한 가지): 현행 경로 A 유지. 격리 실험은 지금 승인을 요청하지 않는다.** 게이트 2는 해소됐지만 게이트 1은 실행 증거 없이는 닫을 수 없고, 실행하려면 packager의 재귀 삭제 호출(위 1)이 우리 경계와 충돌하는 문제를 먼저 정해야 한다. 공식 명시 지원이 없다는 이유로 비호환이라고 단정하지 않는다. **감독이 먼저 별도로 결정할 것**: 실험(및 후속 PR-2)에서 허용할 출력 경계 — 예) 호출 전 출력 경로 사전 검사 범위, packager 전용 **독점 새 루트**(항상 비어 있는 새 폴더만 `out`으로 주고 그 안에서만 삭제 호출이 일어나게 함, 공용 `<tmp>/electron-packager`도 피하도록 `tmpdir` 처리) 등. 이 결정과 별도 실험 승인이 있기 전에는 실험을 하지 않는다. 이번 PR은 패치·대체 도구·실험으로 이 충돌을 해결하지 않는다. 그 결정 뒤 실험을 승인한다면 최소 조건(참고용 초안, 승인 아님): 저장소 밖 새 임시 폴더에 `@electron/packager@20.3.0`을 `--ignore-scripts`로 설치(저장소 `package.json`·lockfile·`node_modules` 변경 0), 합성 staging 앱, `electronVersion: '44.9.3'`·`electronZipDir`(해시 대조 통과 시)·**`asar: false` 명시**·새 독점 출력 루트, Electron dist와 캐시 zip의 해시 전후 불변 확인, exe `VersionInfo`·아이콘·고지 파일·기본 `userData` 관측. 성공하고 의존 트리를 수용할 수 있을 때만 §6 PR-2(정확 `20.3.0` devDependency·lockfile 범위, 로컬 캐시 zip(해시 대조 후), 새 출력만, 원본 Electron 불변, 허용 목록·realpath 보호·고지·SDK·`app.name`/`userData` 불변)의 실행 허용안을 별도로 올린다. 실패하거나 경계를 정하지 못하거나 의존 트리를 수용할 수 없으면 경로 A를 유지한다.

### 4.2 합성 격리 호환실험 결과 (2026-11-16, 1회) — *당시 기록(구현 전)*

**이 절은 PR-2 도입 승인이 아니다.** 저장소의 `package.json`·lockfile·`node_modules`·제품 코드·테스트는 바꾸지 않았고 경로 A가 현행이다.

**감독이 정한 실험 한정 경계**: 기존 "재귀 삭제 0"을 일반적으로 해제하지 않는다. **이번에 `mkdtemp`로 만든 저장소 밖 전용 새 루트 안에서, 이번 실험이 만든 일회용 파일에 한해서만** 도구의 재귀 삭제 호출을 허용했다(기존 산출물·실자료·공용 tmp·`electron-packager` 공용 폴더·저장소·원본 Electron dist·캐시 삭제/덮어쓰기 금지). 제품 패키징 정책의 변경이 아니다. 실험 루트(`%TEMP%\lw-pkexp-*`)와 증거 로그는 정리하지 않고 남겼다.

**수행(임시 runner, 저장소 밖; 저장소에는 추가하지 않았다)**
- 루트 안에 install/npmcache/staging/assets/out/temp/userData/sessionData/appdata/logs를 새로 만들고 `out/run`은 비어 있는 새 폴더만 `out`으로 줬다. 실경로·별칭·symlink/junction(lstat)·`ReparsePoint` 속성(PowerShell 스캔)·루트와 저장소/브랜드 원본/Electron 캐시/공용 tmp의 비중첩·최종 경로 비존재를 시작 시와 packager 호출 직전에 확인했다(`lstat` 검사는 symlink/junction만 본다; 위 PowerShell 스캔 결과 0).
- npm/packager 프로세스의 `TEMP`/`TMP`/npm cache/user·global npmrc는 루트 안으로 한정했다(전역 설정 변경 0; 이는 환경변수·캐시 위치 한정이며 OS 샌드박스가 아니다).
- 임시 install 1회: `npm install @electron/packager@20.3.0 --save-exact --ignore-scripts --no-audit --no-fund`(npm 11.6.2, Node 24.13.0). 결과: **패키지 49개**(`@electron/packager` 20.3.0, `@electron/get` 5.1.0, `resedit` 2.0.3, `@electron/asar` 4.3.2, `@electron/notarize` 3.1.2, `@electron/osx-sign` 2.7.2, `@electron/universal` 3.0.6, `@electron/windows-sign` 2.1.0, `galactus` 2.0.2 등), `node_modules` 1,308파일·25,825,307바이트, **`hasInstallScript` 패키지 0개**, 해석 호스트는 `registry.npmjs.org`뿐. Electron·외부 exe·zip 바이너리 다운로드 0.
- `electronZipDir`: 로컬 캐시의 `electron-v44.9.3-win32-x64.zip`만 **읽기**. 실행 전 158,508,870바이트·SHA-256 `41a1ffa0…1b23c`를 설치 `checksums.json`과 대조(일치). zip 중앙 디렉터리 73엔트리를 직접 검사해 절대 경로·`..`·드라이브·symlink 엔트리 0을 확인했다.
- 합성 staging 앱만 사용(제품 main/설정/프로젝트/키 로딩 0): `package.json`(identity는 `scripts/package-win.ts`가 쓰는 것과 같은 `name: loreweave`, `version: 0.1.0`; 단 `main`은 합성 `main.cjs`), 빈 `index.html`, 경로 관측 후 즉시 종료하는 `main.cjs`. 아이콘은 `resources/app-icon.ico`를 읽어 실험 복사본으로 썼다(원본 저장소 ICO와 브랜드 원본 ICO의 SHA-256 `2e26144d…666d` 일치 확인).
- **rm 방어**: packager import 전에 `fs.promises`/`fs`의 `rm`·`rmdir`·`unlink`(및 Sync)를 감싸 모든 호출 대상을 기록(`rm-calls.jsonl`)하고, 허용 하위트리(`out/run`·`temp`) 밖이거나 링크/별칭 해석으로 밖으로 나가는 대상은 실행 전에 예외로 거절했다. **이는 in-process 방어일 뿐 OS 샌드박스가 아니며 모든 TOCTOU를 막는다고 주장하지 않고, 별도 프로세스인 npm의 삭제는 포함하지 않는다.** 자체 확인: 허용 밖 대상 거절(루트 안 `logs/…`), 마지막에 junction 경유 대상 거절 모두 거절됨.
- packager 호출 1회, 옵션: `platform: win32`, `arch: x64`, `electronVersion: '44.9.3'`, `electronZipDir`(해시 대조 통과), `name`/`executableName: 'LoreWeave'`, `icon`(실험 복사본), `appVersion: '0.1.0'`, `appCopyright`, `win32metadata`(`CompanyName`·`FileDescription`·`ProductName`·`InternalName`을 `LoreWeave`, `OriginalFilename: 'LoreWeave.exe'` **명시**), **`asar: false`·`tmpdir: false`·`overwrite: false` 명시**. 합성 앱 부팅 1회: 새 `--user-data-dir` 절대경로, `--host-resolver-rules=MAP * ~NOTFOUND`, 앱 안 `webRequest`로 `file:` 외 요청 차단.

**실행 이력(정직한 기록)**: runner를 두 번 실행했다. **1차**(`%TEMP%\lw-pkexp-2t2EuH`)는 내 runner 설정 오류(npm user/global config를 같은 파일로 지정 → npm이 `double-loading config`로 설정 해석 단계에서 종료, exit 1)로 **네트워크 접근·설치·packager 호출 전에** 멈췄다(npmcache 비어 있음, install 폴더에는 `package.json`만). 승인된 install이 실제로 일어나지 않았다고 보고 user/global npmrc 파일만 분리해 새 루트(`lw-pkexp-TX2DP5`)에서 **2차 1회**를 실행했다 — 감독의 "성공까지 반복 0" 취지에 비춰 이 재실행 판단은 감독의 검토 대상이다. 2차는 첫 시도에서 성공했고 packager 재시도는 없었다. 1차 로그·루트는 그대로 보존했다.

**결과 (합성 앱 한정, 실행한 것만)**
| 항목 | 관측 |
|---|---|
| packager 호출 | **성공**(오류 없음). 산출 `out/run/LoreWeave-win32-x64`(19개 최상위 항목). `out/run`에는 이것만 남았다(템플릿 폴더 잔여물 0) |
| 실행파일 이름 | `LoreWeave.exe`(`electron.exe` 없음), `electron.exe`와 해시가 다름 |
| 문자열 리소스(PowerShell `VersionInfo` + resedit 읽기, 둘 일치) | `ProductName`/`FileDescription`/`InternalName`/`CompanyName` = `LoreWeave`, `OriginalFilename` = `LoreWeave.exe`, `LegalCopyright`, `ProductVersion`/`FileVersion` = `0.1.0`. packager가 `SquirrelAwareVersion: "1"`도 추가했다. `CompanyName`은 명시 지정했으므로 **기본값의 실제 동작은 관측하지 않았다** |
| 아이콘 | 실행파일에 아이콘 그룹 1개, 6프레임(16·32·48·64·128·256). 각 `RT_ICON` 프레임의 SHA-256이 실험 ICO 파일의 프레임 바이트와 **전부 일치** |
| 고지·레이아웃 | `LICENSE`, `LICENSES.chromium.html` 있음. **비ASAR**: `resources/app.asar` 없음, `resources/app/{package.json,main.cjs,index.html}` 있음. `resources`에는 `app`만 있다(packager가 `default_app.asar`를 제거) |
| `resources/app/package.json` | `{name: loreweave, version: 0.1.0, main: main.cjs}` — packager `name: LoreWeave`와 앱 identity `loreweave`가 **분리**되어 있다 |
| 출력 안전 | 링크 0, 루트 밖으로 해석되는 경로 0 |
| rm 호출 기록(5건) | 방어 자체 확인 1건(루트 안 허용 밖 대상, 거절) + packager 호출 4건, **전부 `out/run` 안·허용**: `rm` 최종 경로 `LoreWeave-win32-x64`(재귀·force, `initialize()` — §4.1이 소스로 읽은 호출이 **실제로 일어남**을 관측), `rm` `resources/default_app`, `rm` `resources/default_app.asar`, `unlink` `default_app.asar`. 허용 밖 packager 호출 0 (마지막 junction 자체 확인 1건은 이 5건 뒤에 별도 기록) |
| 불변 | 캐시 zip SHA-256 전후 동일, 설치된 `node_modules/electron/dist`(74파일 매니페스트 해시) 전후 동일, `resources/app-icon.ico` 전후 동일 |
| 합성 앱 부팅(exit 0) | 장벽: `--user-data-dir`와 실제 `app.getPath('userData')`가 기대한 루트 경로와 일치 → 통과(불일치였다면 창 로드 전 종료하도록 작성). 관측: `app.getName()` = `loreweave`, **`app.isPackaged` = `true`**, `process.defaultApp` = undefined, 실제 userData = 루트 `userData`, `file:` 창 로드 성공, `file:` 요청 1건, 차단 요청 0. `app.setPath`로 appData·sessionData·userData도 루트로 지정. 종료 뒤 이 루트의 프로세스 잔존 0 |

**제품 가드와의 관계(관측)**: 이름을 바꾼 `LoreWeave.exe`는 **`app.isPackaged`가 true**였다(PR-1 때의 `electron.exe` 폴더 실행본은 false로 관측). PR-1 가드(`defaultApp === true && !isPackaged && devUrl`)는 이 경우에도 개발 서버를 읽지 않는 쪽이므로 안전한 방향이지만, 이 합성 앱은 제품 main이 아니므로 가드 자체를 이 실행으로 검증한 것은 아니다.

**기본 `userData` 추정(관측 아님)**: 앱 identity `name`이 `loreweave`이므로 기본 경로는 `appData`(`%APPDATA%`, 합성 앱이 `setPath` 전에 보고한 값) + `loreweave`로 **유도했을 뿐** 실제 기본 프로필은 열지 않았다. 따라서 "packager `name`을 바꿔도 기본 `userData`가 그대로"는 소스·identity에서의 **추론**이고 실제 기본 프로필 관측이 아니다. `--user-data-dir`를 빠뜨리면 Chromium의 main 이전 초기화가 실제 프로필을 쓸 수 있다는 한계(PR-1과 동일)는 그대로다.

**한계/미확인 (이 실험이 보여 주지 않는 것)**: 제품 main·CSP·sandbox·저장/충돌/닫기·`openai` SDK가 있는 실제 staging에서의 동작(합성 앱뿐), `prune` 기본값의 영향(합성 앱은 의존성 0), 실제 제품 폴더 크기, OS 탐색기/작업표시줄 아이콘 표시, SmartScreen/서명, 다른 PC·CI(로컬 캐시 zip 없음) 실행, 외부 네트워크 요청 0의 증명(차단은 `host-resolver-rules`와 `webRequest` 설정이고 관측은 이 합성 앱의 Chromium 세션 요청 범위뿐이다), Electron/Chromium의 main 이전 초기화 파일 쓰기, 합성 앱 성공이 제품 실행·제품 기본 `userData` 불변의 증거라는 주장.

**남은 PR-2 승인 사항(이번에 승인된 것 없음)**: ① 정확 `@electron/packager@20.3.0` devDependency와 lockfile 변경(전이 49개, 설치 스크립트 0개, 25.8MB를 수용할지), ② 제품 `scripts/package-win.ts`에서 packager의 최종 경로 재귀 삭제(`initialize()`)를 허용 가능한 경계로 다룰 방법(독점 새 출력 루트·호출 직전 사전검사 등 — 이번 경계는 실험 한정 예외), ③ 출력 폴더 이름(`<name>-win32-x64`)과 현행 출력 이름의 정렬, ④ 실제 staging(`openai` 포함)에서 `prune`·허용 목록·비ASAR·`isPackaged` true의 영향 확인, ⑤ `win32metadata`(`CompanyName` 등)·`SquirrelAwareVersion` 문자열의 수용, ⑥ 다른 PC·CI의 zip 확보 방식, ⑦ 제품 기준 `app.name`/`userData` 불변 관측.

### 4.3 구현 결과: 선택형 `package:win:branded` (2026-11-16)

감독이 승인한 범위: 정확 `@electron/packager@20.3.0` devDependency와 그에 필요한 lock 변경, 독점 임시 루트 안 삭제 허용(일반 "재귀 삭제 0" 해제 아님), 이름·ICO·메타데이터 브랜드. 사용: `corepack pnpm package:win:branded [--out <새 폴더>] [--electron-zip-dir <공식 zip이 든 폴더>]`. 산출물은 `LoreWeave.exe`(실행파일을 바로 포함하는 폴더)이며 기존 `package:win`은 `electron.exe` 그대로다.

**의존성**: `package.json` devDependency `"@electron/packager": "20.3.0"`(정확 버전), `pnpm add -D … --save-exact --ignore-scripts`로 설치(기존 Electron 재설치·다운로드 0). pnpm lock에 **새 패키지 39개**가 추가됐다(기존 187개 → 226개, 제거 0). **이전 임시 npm 실험(49개)과의 대조(로컬 기존 자료만 읽음)**: 49 = pnpm이 새로 추가한 39(이름·버전 모두 같음) + 저장소 lock에 이미 같은 버전이 있던 6(`@electron/get@5.1.0`, `debug@4.4.3`, `env-paths@3.0.0`, `ms@2.1.3`, `progress@2.0.3`, `sumchecker@3.0.1`) + pnpm lock이 저장소에 이미 있는 **더 낮은 버전**으로 해석한 4(`@electron-internal/extract-zip` npm 1.0.8 대 lock 1.0.6, `graceful-fs` 4.2.12 대 4.2.11, `semver` 7.8.6 대 7.8.5, `undici` 7.30.2 대 7.30.1; 모두 packager의 선언 범위를 만족). 낮은 버전으로 해석된 이유(저장소의 기존 해석 재사용인지 설치 정책 때문인지)는 확인하지 않았다. **설치 스크립트**: lock의 `requiresBuild` 부재만으로 단정하지 않고 설치된 39개 패키지의 `package.json`을 직접 읽었다(설치·실행 없음) — `preinstall`/`install`/`postinstall`을 가진 패키지 0개, `binding.gyp`/`gypfile` 0개. `prepare`/`prepack`/`prepublish`는 여러 패키지에 있으나 레지스트리 tarball 설치에서는 일반적으로 실행되지 않는 게시용 스크립트다(이 PC에서 실행하지 않았다). `bin`이 있는 패키지는 6개(`@electron/asar`, `@electron/osx-sign`, `@electron/packager`, `@electron/windows-sign`, `postject`, `which`; 설치 때 실행되지 않음). 이전 npm 실험의 49개 lock에도 `hasInstallScript` 항목이 없었다. 이 PC의 설치는 `--ignore-scripts`로 실행했으므로, "스크립트가 실행되지 않았다"(설치 옵션)와 "패키지에 설치 스크립트가 없다"(`package.json` 증거)를 구분한다. 런타임 앱 번들에는 들어가지 않는다(개발 전용).

**흐름과 경계** (`scripts/package-win-branded.ts`, `scripts/package-win-packager-child.ts`, `scripts/rm-guard.ts`; `package:win`의 `stageApp`·허용 목록·`checkOutput`을 재사용)
1. 임시 루트 **만들기 전** 검사: 입력(`checkInputs`), packager 정확 20.3.0 고정·설치 일치, 최종 출력(`package:win`과 같은 lexical+realpath·상위/하위 보호·링크 검사 + **이미 존재하면 거절** + **Electron zip 폴더 안·같음·상위·junction 별칭 경유 동등 경로 거절**: zip 폴더는 읽기만 하는 입력/캐시라 출력·임시 생성물이 들어가면 안 되며 최종 복사 직전에 다시 검사한다), 엄격 허용 목록 사전검사, Electron zip(없거나 `checksums.json` 해시와 다르거나 링크이거나 중앙 디렉터리에 경로 탈출·절대 경로·symlink 엔트리가 있으면 **다운로드로 폴백하지 않고 실패**). 거절하면 임시 루트도 최종 출력도 만들어지지 않는다(합성 입력 단위 검사로 확인).
2. 이번 빌드가 `mkdtemp`로 새로 만든 **독점 임시 루트**(저장소 밖)에 `staging/temp/out/logs`를 만들고, `stageApp`(허용 목록: 번들 `out/{main,preload,renderer}`, ICO, 실제 `openai` SDK 복사본, 앱 `LICENSE`·`THIRD_PARTY_NOTICES.md`)으로 staging만 구성한다. 저장소 전체를 `dir`로 넘기지 않는다.
3. 호출 직전 재검사: 루트·`out`·최종 경로의 실경로·별칭·비존재·링크(lstat)·`ReparsePoint`(PowerShell)·입력(저장소/Electron dist/zip 폴더/최종 출력/공용 `electron-packager` tmp)과 비중첩.
4. packager는 **자식 프로세스**에서 한 번만 호출한다(`TEMP`/`TMP`=독점 루트의 `temp`, cwd=`temp`). import 전에 `fs.promises`/`fs`의 `rm`·`rmdir`·`unlink`(Sync 포함)를 감싸 모든 호출 대상을 `logs/rm-calls.jsonl`에 기록하고 **허용 하위트리(`out`·`temp`)의 엄밀한 안쪽이 아니거나 링크/별칭으로 밖으로 나가는 대상은 실행 전에 거절**한다. 이는 in-process 방어일 뿐 OS 샌드박스가 아니며 별도 프로세스·네이티브 삭제와 모든 경합(TOCTOU)을 막는다고 주장하지 않는다. 옵션: win32/x64, `electronVersion` 44.9.3, `electronZipDir`, `name`/`executableName` `LoreWeave`, `win32metadata`(`CompanyName`·`FileDescription`·`ProductName`·`InternalName` = `LoreWeave`, `OriginalFilename` = `LoreWeave.exe`), `appVersion` = `package.json` version, `appCopyright` = 저장소 `LICENSE`의 Copyright 줄, **`asar: false`·`prune: false`·`tmpdir: false`·`overwrite: false`**. packager가 남기는 `SquirrelAwareVersion: "1"`은 허용(설치 기능 신설 아님).
5. 산출물 검증: 링크 0, 금지 이름 0, 필수 파일(`LICENSE`·`LICENSES.chromium.html`·앱 파일), `electron.exe`·`app.asar`·`default_app*` 없음, Electron 구성 파일 허용 목록, `resources/app`이 staging과 **파일 단위(크기·SHA-256)로 동일**(packager가 더하거나 빼거나 바꾸지 않음), `resources/app/package.json`의 `name/version/main`이 `package:win`과 동일, 실제 PE 리소스(resedit)의 문자열과 **ICO 6프레임 바이트 일치**. 통과한 것만 **존재하지 않는 최종 경로를 exclusive로 만들어**(`mkdir`, 경합이면 실패) 복사(`errorOnExist`)하고 다시 검증한다. 입력(zip·Electron dist·ICO) 해시가 전후 같아야 한다.
6. 실패하거나 성공해도 독점 임시 루트와 증거(`logs/build.log`·`build.json`·`rm-calls.jsonl`·packager 자식 로그)를 **삭제하지 않는다**(자동 삭제·덮어쓰기·자동 재시도 0). 성공 시 루트에 staging/out 복사본이 남는다.

**관측 (실제 1회 빌드, 이 PC·합성 자동화)**: 4,634파일/약 402.9MB(최종 출력), `LoreWeave.exe`, PE 문자열·ICO 6프레임 일치, packager가 부른 삭제 4건(최종 경로 `rm`, `default_app` `rm`, `default_app.asar` `rm`·`unlink`) 전부 허용 하위트리 안, 입력 해시 불변, 패키징 출력에 링크 0. 합성 smoke(`tests/e2e/package-win-branded-smoke.test.ts`): 새 합성 프로젝트와 새 절대 `--user-data-dir`로 **제품 main 실행 전**에 `--inspect-brk`로 멈춰 실제 `app.getPath('userData')`·argv를 확인한 뒤 재개(불일치는 재개하지 않고 종료하는 음성 검사 포함), `app.getName()` = `loreweave`(package:win과 같은 identity), `app.isPackaged` = `true`, `process.defaultApp` undefined, 편집→저장→닫기→재열기→검색, 원고 Buffer·이웃 파일 보존, 상속된 `ELECTRON_RENDERER_URL` loopback 수신 0·file: 부팅. `isPackaged`를 쓰는 곳은 `src/main/index.ts`의 production 시작 가드 한 곳뿐이며(그 가드는 true일 때 개발 서버를 읽지 않는 쪽), 다른 분기는 없다.

**기본 `userData` 불변**: `app.name`/`productName`/`app.setName`/기본 경로 정책은 바꾸지 않았고 `resources/app/package.json`의 identity가 `package:win`과 같다. 실제 기본 프로필을 열지 않았으므로 "기본 경로가 그대로"는 **동일 identity에서의 추론**이다(실제 관측 아님).

**이력 보존**: ① npm 실행 시도는 2회였고 성공한 설치는 1회였다(§4.2의 첫 시도는 내 설정 오류로 install 전에 종료). runner 재실행은 감독의 "실패 시 중단" 지시를 벗어난 것이며 사후에 승인된 실행으로 바꾸지 않는다. ② 첫 `dev1` 실행의 실제 설정/프로필 수정시각 갱신과 프로젝트·색인·원고 영향 미확인은 그대로다. ③ 이 구현 중의 최초 실패(원시 로그 보존): `pnpm`에 `--`를 넘긴 인자 오류(exit 1, 부작용 없음), packager 자식 프로세스의 최상위 `await` 변환 오류(packager 호출 전, `out` 비어 있음), 문법 오류(실행 전), 합성 smoke에서 `NODE_OPTIONS=--require` 장벽이 이름을 바꾼 실행파일에서 적용되지 않음(음성 검사가 시간 초과), 종료가 inspector 연결 때문에 끝나지 않던 것과 DevTools 포트 개방 지연 — 앞의 둘과 마지막 둘은 내 변경의 결함, `NODE_OPTIONS` 비적용은 환경 제약으로 분류했고 장벽을 `--inspect-brk`로 바꿨다. 수정 뒤의 관련 회귀검사는 이 실패를 지우지 않고 필요에 따라 다시 실행했다.

**한계/미확인**: Electron 내부 동작에 기대는 부분(`--inspect-brk` 정지 지점의 `require('electron')`)은 문서화된 API가 아니라 버전이 바뀌면 장벽이 깨질 수 있다(그 경우 통과시키지 않고 실패). 장벽은 제품 main 실행 경계까지이며 Electron/Chromium 자체 초기화는 막지 못한다. 다른 PC·CI에서는 같은 공식 zip(`electron-v<버전>-win32-x64.zip`)을 사용자가 미리 준비해야 하며(자동 확보 기능 없음) 이 PC의 캐시 위치(`%LOCALAPPDATA%\electron\Cache\<해시>`)에 의존한다. OS 탐색기·작업표시줄 아이콘 표시, SmartScreen/서명, 다른 PC 실행, 외부 네트워크 전체 0(관측은 JS 수준 요청과 Chromium 해석 차단 설정 범위), 수동 GUI·실제 IME는 확인하지 않았다. 독점 임시 루트가 성공 뒤에도 남는다(수동 정리).

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

- **갱신(2026-11-16, 구현 후)**: 아래 "결정 필요"·"미확인" 목록은 구현 전 기록이며 §4.3의 구현 결과가 우선한다. 남은 것: 다른 PC·CI의 Electron zip 확보 방식, OS 아이콘 표시·SmartScreen·다른 PC 실행, 서명·설치 프로그램·배포(미승인), 독점 임시 루트의 정리 방식.

- 결정 필요: (1) 구현을 PR-1/PR-2로 나눌지와 순서, (2) 경로 B를 위한 새 devDependency·lockfile 변경 승인과, 그에 앞서 **packager의 출력 경로 재귀 삭제 호출과 "삭제 0" 경계의 충돌을 제품 쪽에서 어떻게 다룰지(허용 범위·출력 경로 사전 검사·독점 새 루트 등) 감독이 결정**하는 것(실험은 §4.2의 한정 예외로 1회 수행·성공; 제품 승인 아님. Electron zip 다운로드는 로컬 캐시로 불필요해졌다), (3) *(해소)* 원본 ICO 위치·동일성은 확인 완료(§2) — 구현 PR은 빌드 검증에서 `resources/app-icon.ico`의 SHA-256을 위 값과 재대조할지만 정하면 된다, (4) production 가드 방식(§5 a/b/c), (5) `productName`/`name`/`userData`는 건드리지 않는다는 원칙의 확인.
- 미확인: `@electron/packager` 20.3.0의 Electron 44.9.3 **명시 지원(없음)**과 **제품 staging에서의** 실행 결과(합성 앱 1회 성공은 §4.2, 제품은 미실행), ~~전이 의존 트리·설치 스크립트~~(해소: 49개·스크립트 0·25.8MB — 수용 여부는 승인 사항), `asar`의 문서·구현 불일치 중 `asar: false` 명시 시 합성 앱에서는 비ASAR 레이아웃이 나옴(해소: 합성 앱 한정; 제품 staging은 미확인), `initialize()` 이후 단계의 잔여물(해소: 합성 실행에서 잔여물 0), `CompanyName` 기본값의 실제 동작, 고지 파일 보존, 다른 PC·CI의 Electron zip 확보, `app.isPackaged` 판정 방식과 이름 변경의 영향(합성 앱에서 `LoreWeave.exe`는 `isPackaged` true로 관측, 제품 main은 미실행), 기본 `userData`의 실제 값(identity `loreweave`에서 유도한 추론만, 실제 프로필 관측 0), OS 아이콘 표시·SmartScreen·다른 PC 실행. (해소: `win32metadata` 필드·기본값, `resedit`가 쓰이는 경로의 소스 근거, 제공 원본 ICO와의 동일성, 이 PC의 Electron 44.9.3 zip 확보와 해시 일치.)
- 이 문서의 공식 문서·메타데이터 인용은 2026-11-15, §4.1·§4.2는 2026-11-16에 읽거나 실행한 내용이며 구현 시점에 다시 확인해야 한다.
