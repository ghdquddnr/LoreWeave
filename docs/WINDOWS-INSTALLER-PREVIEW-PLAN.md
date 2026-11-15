# Windows x64 설치형 미리보기 최소 계획

상태: **계획 문서일 뿐이다. 구현·설치·다운로드·패키징·설치/제거 실행은 하나도 하지 않았다** (제품 코드·테스트·`package.json`·lock 변경 0, 새 도구 설치 0, exe/zip/7z 다운로드 0; 공식 문서·정확 태그 소스·npm 레지스트리 메타데이터의 **텍스트만 읽었다**, 2026-11-16).
이 문서는 [WINDOWS-PREVIEW-PLAN.md](WINDOWS-PREVIEW-PLAN.md) §9의 "NSIS·서명·업데이트는 별도 계획"을 설치기에 한해 구체화하라는 **감독의 선택**에 따른 것이다. **사용자가 설치 도구를 골랐다는 기록이 아니다.** 서명·자동 업데이트·공개 릴리스·새 기능·새 UI는 이 계획의 대상이 아니다.
유지하는 것: `package:win`(경로 A)·`package:win:branded`([WINDOWS-BRANDED-PREVIEW-PLAN.md](WINDOWS-BRANDED-PREVIEW-PLAN.md) §4.3)·4테마·오프라인 번들·런타임 identity(`name: loreweave`)와 기본 `userData` 정책·저장/충돌/닫기/보안 설정.

## 1. 한눈에 (결론)

1. **도입 확정 없음.** 읽은 근거로는 어떤 설치 도구도 "원고·설정·키·AI DB를 건드리지 않고, 다운로드·네이티브 실행도구·제품 코드 변경 없이" 쓸 수 있다고 입증되지 않았다 (§4).
2. 후보 중 **가장 작은 격리 검증 후보는 `electron-builder`의 `--prepackaged` + NSIS(사용자별 one-click)** 하나다. 이미 검증한 브랜드 폴더를 **그대로 입력**으로 받는 옵션이 문서화되어 있고 **제품 코드 변경이 필요하다는 증거가 없다**. 단 NSIS 실행 도구(`makensis`)를 받는 **다운로드와 네이티브 실행**이 필요하고, 제거기의 기본 동작에 **`RMDir /r $INSTDIR` 재귀 삭제**가 있어 사용자 추가 파일 보존이 보장되지 않는다 — 이는 **미해결 도입 차단 조건**이다 (§5-8).
3. 지원 근거(Electron 44.9.3과의 호환)는 **명시 문구 미확인·실행 증거 없음**이므로 구현 전에 **별도 승인된 최소 격리 검증**이 먼저다 (§7). 이번에 실험하지 않았다.
4. **삭제 경로 선행 판정(§5-1)**: `customRemoveFiles`는 `RMDir /r $INSTDIR` 블록만 공식 훅으로 대체할 수 있으나 안전성은 직접 작성한 코드에 달려 입증되지 않았고, `--delete-app-data` 분기는 훅·옵션으로 끌 수 없어 닫는 확장점이 소스로 입증되지 않았다. **현재 근거로는 설치기 도입 유보·폴더 배포 유지를 권고한다.**

## 2. 입력과 현재 상태 (실제 코드 대조)

- **입력**: `corepack pnpm package:win:branded`가 만드는 `LoreWeave.exe` 폴더(검증됨: PE 문자열·ICO 6프레임·고지·비ASAR·허용 목록·`resources/app` ≡ staging; 상세는 브랜드 계획 §4.3). 이 계획은 그 출력을 **수정하지 않고** 설치기의 입력으로만 쓴다.
- **앱 식별(identity)**: `resources/app/package.json`의 `name: loreweave`, `version: 0.1.0`. 이름이 바뀐 `LoreWeave.exe`에서 `app.getName()` = `loreweave`, `app.isPackaged` = `true`를 합성 smoke로 관측했다.
- **데이터 위치 (실제 코드 대조)**

| 데이터 | 위치 | 근거(현재 코드) | 설치/제거가 건드리면 안 되는 이유 |
|---|---|---|---|
| 앱 설정 | `app.getPath('userData')`/`settings.json` | `src/main/settings.ts:19` `settingsPath = join(userData, 'settings.json')` | 테마·마지막 프로젝트 등 사용자 상태 |
| OpenAI 키(암호화) | `userData`/`openai-key.bin` | `src/main/secrets.ts:9` `keyPath` (Electron `safeStorage`) | 사용자 비밀. 복구 불가 |
| 원고 | 사용자가 고른 프로젝트 폴더의 Markdown | CLAUDE.md "Markdown이 Source of Truth" | 원고 자체 |
| 파생 색인 | `<프로젝트>/.loreweave/index.db` | `src/main/index-db.ts:11-12` `INDEX_DIR='.loreweave'`, `index.db` | 재생성 가능하지만 프로젝트 소유 |
| AI 분석 결과 | `<프로젝트>/.loreweave/ai.db` | `src/main/ai-db.ts:18`, `ipc.ts:53` (분석할 때 생성) | 프로젝트 소유, 비용·결과 기록 |
| Chromium 프로필·캐시 | `userData`(및 `sessionData`) | Electron 기본 | 앱 소유지만 같은 `userData` 안에 있다 |

  기본 `userData`는 `appData` + `app.getName()`(=`loreweave`)으로 **유도한 추론**이다(실제 기본 프로필을 열어 확인하지 않았다 — 실제 사용자 프로필 조회 0). **개발 실행(`electron .`)도 같은 `name`이므로 같은 기본 `userData`를 쓴다**: 설치본과 개발본은 기본적으로 같은 설정·키·Chromium 프로필을 공유한다(§5 개발 프로필 충돌).
- **위치 정의와 비중첩은 다르다.** 위 표는 각 데이터가 *코드에서 어디에 쓰이는지*의 정의일 뿐, 프로젝트 폴더가 `userData`·설치 경로와 **겹치지 않는다는 증명이 아니다**. 현재 코드는 사용자가 고른 폴더(`ipc.ts:356-358` 폴더 선택, `:361-363` 마지막 프로젝트 재열기)를 `openProject(path)`(`ipc.ts:175`)에 그대로 넘겨 root·감시·색인을 설정하며, **설치 경로나 `userData`와의 같음·상하위·별칭(junction/symlink) 관계를 검증하지 않는다**(검증 코드 부재는 이번에 읽은 범위의 관측이다). 따라서 `.loreweave/index.db`·`ai.db`와 원고는 사용자가 설치 폴더나 `userData` 안(또는 그 상위의 별칭)을 프로젝트로 열면 **그 아래에 생긴다**. '겹치지 않는다'는 **현재 미검증 전제**이며, 이 계획의 어떤 보존 주장도 그 전제에 기대지 않는다(§5 도입 차단 조건).

## 3. 폴더(portable) 배포와 설치기의 차이

| | 폴더/zip 배포(현재 A·B) | 설치기 |
|---|---|---|
| 하는 일 | 사용자가 폴더를 복사해 `LoreWeave.exe` 실행 | 지정 위치로 파일 복사 + 바로가기 + **제거 항목(레지스트리)** 등록 |
| 시스템 변경 | 없음 (폴더만) | 설치 경로·시작 메뉴/바탕화면 바로가기·제거 정보(레지스트리) |
| 제거 | 사용자가 폴더 삭제 | 제거기가 앱 파일을 삭제(도구 기본 동작에 따라 **재귀 삭제**) |
| 업그레이드 | 폴더 교체 | 같은 앱 식별로 덮어 설치(실행 중 파일 문제) |
| 위험 | 낮음 | **제거기·덮어쓰기가 앱 소유 범위를 넘어 지우면 사용자 데이터 위험** |

## 4. 도구 경로 비교 (읽은 근거만; 날짜 2026-11-16)

구분: **[명시]** 공식 문서/정확 태그 소스가 말함 · **[추론]** 소스에서 추론 · **[미확인]** 읽지 못함/실행 증거 없음.

| 경로 | 정확 버전·요구 | 기존 폴더 입력 | 추가 의존·스크립트·다운로드·네이티브 실행 | 제품 코드 영향 | 근거 |
|---|---|---|---|---|---|
| **A. `electron-builder` + NSIS** | `electron-builder` 26.18.0(npm 2026-10-20), `engines.node >= 14`, MIT. 직접 의존 10, `app-builder-lib` 26.18.0은 직접 의존 41(`@electron/get ^3`, `@electron/rebuild`, `@electron/asar 3.4.1` 등)·peer `dmg-builder`/`electron-builder-squirrel-windows`. 설치 라이프사이클 스크립트 없음 [명시: 메타데이터] | **[명시]** CLI 옵션 `--prepackaged`: "The path to prepackaged app (to pack in a distributable format)" (`packages/electron-builder/src/builder.ts:277-280`, `packager.ts:271`) | NSIS 대상은 **네이티브 `makensis` 실행**이 필요하고, 기본 설정에서는 **다운로드**한다: `getBinFromUrl("nsis-3.0.4.1", "nsis-3.0.4.1.7z", sha256 9877df90…ec5fa)`, `nsis-resources-3.4.1.7z`(sha256 593a9a92…03), 서명/리소스 편집용 `winCodeSign-2.6.0.7z`(sha256 cdaec715…43a4) 정의가 `toolsets/windows.ts`에 있다 [명시]. 이 중 어떤 것이 우리 사용 경로에서 실제로 받아지는지·다운로드 호스트는 **[미확인]**(옵션 주석의 URL은 `github.com/electron-userland/electron-builder-binaries/releases/download/nsis-resources-3.4.1/…`) | 필요하다는 증거 없음 **[추론]** (NSIS는 별도 프로세스가 앱을 설치만 한다). 단 설치 직후 "자동 실행"(`runAfterFinish`)은 제품 main을 시작시키므로 끈다 | `registry.npmjs.org/electron-builder`, 정확 태그 `electron-builder@26.18.0`의 `nsisOptions.ts`·`toolsets/windows.ts`·`website/docs/nsis.md` |
| **B. `electron-winstaller`(Squirrel.Windows)** | `electron-winstaller` 5.4.4(npm 2026-07-01), `engines.node >= 8`. (`@electron/windows-installer`라는 npm 이름은 레지스트리에서 404였다.) 직접 의존 6 | **[명시]** 옵션 `appDirectory`: "The folder path of your Electron app" (README v5.4.4) | **`install` 라이프사이클 스크립트가 있다**: `node ./script/select-7z-arch.js` [명시: 메타데이터] → 이 저장소의 "설치 스크립트 0·`--ignore-scripts`" 기준과 충돌. Squirrel/7z 실행 파일 포함 여부는 tarball을 받지 않아 **[미확인]** | **필요하다 [명시]**: README는 앱이 `--squirrel-install`/`--squirrel-uninstall` 등 인자로 **설치·제거 중 실행된다**며 main 맨 위에서 **일찍 처리**하라고 요구한다. 현재 제품 main(및 start 장벽)과 충돌 | `registry.npmjs.org/electron-winstaller`, 정확 태그 `electron/windows-installer@v5.4.4` README, Squirrel.Windows `docs/using/install-process.md`(설치 위치 `%LocalAppData%\<앱>\app-<버전>`) |
| **C. Electron Forge makers** | `@electron-forge/maker-squirrel` 8.0.1(npm 2026-09-29), `engines.node >= 22.13`; Squirrel maker는 `electron-winstaller ^5.3.0`을 **optionalDependency**로 둔다. `maker-wix` 8.0.1은 `electron-wix-msi ^5.1.3` 의존 | **[미확인]**: Forge CLI 문서는 `make --skip-package`("패키징 단계를 건너뜀")를 말하지만 건너뛴 뒤 어떤 위치의 패키지를 기대하는지 읽지 못했다. Forge는 프로젝트를 `import`해 설정·의존성을 추가한다("adds the required dependencies") [명시: electronforge.io/cli] → electron-vite 구조·`package:win:branded`와 맞물리는 방식이 불명확 | 하위에서 B(Squirrel) 또는 WiX(외부 WiX 도구 필요, 읽지 못함)를 쓴다 [추론] | B와 같은 제약(Squirrel) 상속 [추론] | `registry.npmjs.org/@electron-forge/maker-squirrel`, `electronforge.io/cli`, Electron v44.9.3 `docs/tutorial/application-distribution.md`("We recommend using Electron Forge") |
| **D. 외부 설치기 스크립트 직접(Inno Setup/NSIS/WiX 도구)** | **이번에 읽지 않았다 [미확인]** | — | 외부 도구 설치(다운로드)가 필요한 것으로 보이나 **[미확인]** | — | 범위 밖 |

**지원 범위 구분**: Electron 44.9.3에 대한 `electron-builder` 26.18.0·`electron-winstaller` 5.4.4·Forge 8.0.1의 **명시 지원 문구는 이번에 찾지 못했다**(일반 설치기 도구가 앱 폴더를 포장하는 방식이라 Electron 버전과 직접 결합이 약하다는 것은 **[추론]**이며 증거 아님). **실행 호환 증거는 없다.** 문서에서 못 찾았다는 사실이 비호환의 증거는 아니다.

**Electron 공식 권고(읽음)**: v44.9.3 `application-distribution.md`는 "We recommend using Electron Forge"라고 한다. 이 계획은 그 권고를 따르지 않는다고 결론낸 것이 아니라, Forge 경로가 현재 스크립트·구조와 어떻게 맞물리는지 **읽은 근거로는 불명확**해 가장 작은 후보로 고르지 않았다는 뜻이다 (감독 결정 사항).

## 5. 경계 (명시)

1. **설치 위치**: **사용자별·관리자 권한 없는 설치를 우선**한다. A안 문서: `oneClick`은 기본 `true`, `perMachine`은 기본 `false`(= 사용자별)이고, `oneClick: false`에서 `allowElevation`(기본 `true`)·`allowToChangeInstallationDirectory`(기본 `false`)가 있다 [명시: `nsisOptions.ts`]. 설치 경로를 사용자가 바꾸게 하지 않는다(`allowToChangeInstallationDirectory: false` 유지). 기본 설치 경로의 실제 값은 이번에 읽지 않았다 **[미확인]**(Squirrel은 `%LocalAppData%\<앱>` [명시]).
2. **앱 식별·바로가기**: 앱 식별은 `appId`/제품 이름으로 정해지며(이번에 읽은 범위에서 값 미정) 바꾸면 **다른 앱으로 설치되어 업그레이드가 아니라 병존**한다. 바로가기(시작 메뉴/바탕화면)와 제거 정보(레지스트리)는 설치기가 만드는 **시스템 변경**이다. 설치 직후 자동 실행(`runAfterFinish` 옵션 [명시: `options/CommonWindowsInstallerConfiguration.ts:18`])은 제품 main이 첫 실행되므로 **끄고**, 검증은 별도 `--user-data-dir`로만 시작한다.
3. **개발 프로필 충돌**: 설치본·개발본·폴더 빌드는 모두 `name: loreweave` 때문에 **같은 기본 `userData`**(추론)를 쓴다 — 설정·키·마지막 프로젝트·Chromium 프로필이 공유된다. 정책(`app.name`/`productName`/기본 경로)은 바꾸지 않는다. 분리할지는 **감독 결정**(데이터 경로를 바꾸는 결정이라 별도 승인; 프로젝트의 `.loreweave/*`는 어느 쪽이든 분리되지 않는다).
4. **업그레이드·실행 중 파일·재설치**: 같은 식별로 덮어 설치할 때 실행 중인 `LoreWeave.exe`가 잠겨 있으면 설치기가 실패하거나 재시도한다(도구별 동작은 이번에 읽은 범위에서 **[미확인]**; NSIS 템플릿에는 `atomicRMDir`로 설치 폴더를 **임시로 옮겼다가 복구하는 로직**이 있다 [명시: `templates/nsis/uninstaller.nsh`]). 사용자 데이터가 설치 폴더 밖에 있어야 한다는 전제는 **§2에서 보았듯 현재 코드로 보장되지 않는 미검증 전제**다(§5 도입 차단 조건).
5. **실패 산출물**: 설치 실패 시 부분 설치물이 남을 수 있다. 검증에서 "실패해도 기존 파일(합성 기존 설치 폴더·합성 사용자 데이터)이 그대로"임을 확인해야 하며, 도구가 자동으로 정리하는 범위는 **[미확인]**.
6. **제거 정책(최소)**: 설치/제거는 **앱 소유 바이너리(설치 폴더·바로가기·제거 항목)만 대상**으로 한다. **원고·프로젝트·`.loreweave/*`·`settings.json`·`openai-key.bin`·AI DB·`userData`·공유 캐시를 삭제·이전·초기화하지 않는다.** 이 계획은 일반 "재귀 삭제 0" 정책을 해제하지 않는다.
7. **도구 기본 동작과의 충돌 (그대로 지적, 감독 결정 필요)**:
   - NSIS 제거기는 `customRemoveFiles` 매크로가 없으면 설치 폴더를 **`RMDir /r $INSTDIR`로 재귀 삭제**한다 [명시: `uninstaller.nsh`, 감독 직접 조회 `:154-180`]. 이것은 "앱이 설치한 파일만" 지우는 동작이 **아니라 디렉터리 전체 삭제**다. **고정 설치 경로·독점 신규 루트·`deleteAppDataOnUninstall: false`만으로는 사용자 데이터 보존이 보장되지 않는다**: 사용자가(또는 설치 뒤 어떤 과정이) 설치 폴더 아래에 `chapters/001.md`·`.loreweave`·무관한 파일을 두었거나, 설치 폴더·`userData`·프로젝트가 같음/상하위/별칭 관계이거나(§2), 업그레이드(`atomicRMDir` 이동·복구 로직이 폴더 전체를 다룬다)·제거가 그 폴더를 대상으로 하면 사용자 파일이 함께 삭제되거나 이동될 수 있다. 소스 기반 반례이며 실제 데이터 생성·삭제 실험은 하지 않았다. 이 재귀 삭제를 "앱 전용 고정 폴더 한정 예외"로 **승인받은 적이 없다**.
   - NSIS 제거기는 `--delete-app-data` 인자 또는 `deleteAppDataOnUninstall`(기본 `false`)이면 **`$APPDATA\<APP_FILENAME>`, `<productFilename>`, `<package.json name>`을 재귀 삭제**한다 [명시: `uninstaller.nsh`, `nsisOptions.ts`]. `<package.json name>` = `loreweave`는 우리 기본 `userData`(설정·키)다. **옵션은 끄고 제거 시 그 인자가 쓰이지 않게** 해야 하며, 사용자가 인자를 주는 경로를 막을 수 있는지는 **[미확인]**(필요하면 커스텀 NSIS 스크립트 — 감독 결정).
8. **미해결 도입 차단 조건 (이 항목이 풀리기 전에는 설치/제거 실행도 제품 도입도 승인되지 않았다)**: ① 제거(와 덮어쓰기 업그레이드)가 **앱 소유 파일만** 제거한다는 보장이 없다 — `RMDir /r $INSTDIR`는 사용자 추가 파일까지 삭제할 수 있다. ② `--delete-app-data`(및 `deleteAppDataOnUninstall`)가 `$APPDATA\<package name>`(= 기본 `userData`)을 삭제할 수 있고, 사용자가 인자를 주는 경로를 막을 방법은 **미해결**이다. ③ 앱이 설치 폴더·`userData`를 프로젝트로 여는 것을 막는 경계가 현재 없다(§2). 아래는 **실행 전 설계 판정 후보일 뿐 어느 것도 승인·채택된 것이 아니다**: (a) 설치 때 **앱 소유 파일 manifest**를 만들고 제거가 manifest에 있는 파일만 지우며 manifest 밖 파일이 있으면 폴더를 남기고 거절/보존, (b) `customRemoveFiles` 같은 도구 훅으로 위 동작을 구현(도구가 그 훅을 `RMDir /r` 없이 쓸 수 있는지 **미확인**), (c) 제품 쪽에서 설치 폴더·`userData`와 겹치는 프로젝트 열기를 거절하는 경계(**제품 코드 변경이 되므로 별도 승인**; 이번에 제품 정책·코드·기본 경로 변경 0), (d) 다른 도구/설치 방식. 기본 경로 변경도 이 계획의 범위가 아니다.
   - Squirrel(B)은 설치·제거 중 앱을 `--squirrel-*` 인자로 실행하므로 제품 코드 변경과 start 장벽 재설계가 필요하다.
   - A의 NSIS 도구는 **다운로드**(고정 sha256)와 **네이티브 `makensis` 실행**을 요구한다 — 새 의존성·다운로드·네이티브 실행 승인이 필요하다.

## 5-1. 두 삭제 경로의 선행 판정 (정확 태그 소스 텍스트, 2026-11-16)

감독이 "설치기를 더 늘리거나 실험하기 전에, 이미 확인된 두 삭제 경로를 닫을 수 있는지부터 판정"하라고 선택한 조사다(사용자가 도구를 고른 것이 아니다). **소스를 읽었을 뿐 실행·설치·makensis·설치기 실행은 하지 않았다.** 읽은 소스(정확 태그 `electron-builder@26.18.0`, `https://raw.githubusercontent.com/electron-userland/electron-builder/electron-builder%4026.18.0/…`, 줄 번호는 그 파일 기준): `packages/app-builder-lib/templates/nsis/{uninstaller.nsh, installer.nsi, installSection.nsh}`, `…/nsis/include/{installUtil.nsh, installer.nsh}`, `website/docs/nsis.md`, `…/src/targets/nsis/nsisOptions.ts`(7개).

**A. 제거 흐름과 훅 순서 [명시: `uninstaller.nsh`]**

| 순서 | 위치 | 하는 일 | 훅 |
|---|---|---|---|
| 1 | `un.onInit` `:5-36` | `/S`면 무음, 일반 제거는 확인창, 앱 실행 중 검사, 다중 사용자 초기화 | **`customUnInit`** `:33-34` (맨 끝) |
| 2 | `Section "un.…"` `:145-259` | 바로가기 변수 설정 | **`customUnInstall`** `:156-157` (파일 삭제·앱 데이터 삭제보다 **앞**) |
| 3 | `:161-188` | 설치 파일 삭제. `customRemoveFiles`가 **정의되어 있으면 그 매크로만 실행**(`:161-162`), 없으면 `isUpdated`일 때 `un.atomicRMDir`로 폴더 전체 내용을 `$PLUGINSDIR\old-install`로 **이동**(`:164-`) 후 `RMDir /r $INSTDIR`(`:187`) | **`customRemoveFiles`**: 3번 블록(이동+`RMDir /r`)**만** 대체 |
| 4 | `:190-214` | 바로가기·레지스트리 정리 등 | (`customRemoveFiles`와 무관하게 실행) |
| 5 | `:216-247` | `--delete-app-data`를 `${GetParameters}`/`${GetOptions}`로 **별도 해석**: 인자가 있으면 `isDeleteAppData=1`, 인자가 없고 `DELETE_APP_DATA_ON_UNINSTALL`이 정의되고 `isUpdated`가 아니면 `1`. `1`이면 `RMDir /r "$APPDATA\<APP_FILENAME>"`·`<productFilename>`·`<package name>` | 이 분기를 끄거나 대체하는 훅은 **읽은 범위에 없다** |
| 6 | `:250-258` | 제거 레지스트리 키 삭제 | `customUnInstallSection`(`:261-263`)은 그 뒤 |

- **`customRemoveFiles`가 대체하는 범위** = 3번(설치 폴더 이동·재귀 삭제)뿐이다. 4·5·6번은 그대로다 [명시]. 특히 **5번의 `--delete-app-data` 분기는 `customRemoveFiles`·`deleteAppDataOnUninstall: false`와 무관하게 남는다**: 옵션이 `false`여도 제거기에 `--delete-app-data`가 주어지면 `isDeleteAppData=1`이 된다 [명시 `:219-229`]. 따라서 `false` 옵션만으로 차단이 보장되지 않는다.
- **삭제보다 앞서는 훅**: `customUnInit`(1)과 `customUnInstall`(2)은 3·5번보다 먼저 실행된다 [명시: 매크로 삽입 위치]. 여기에 명령행(`${GetParameters}`)을 읽어 `--delete-app-data`를 발견하면 제거를 중단하는 코드를 넣는다는 아이디어가 구조상 가능해 보이나, **NSIS 언어에서 `un.onInit`/섹션 안의 `Abort`/`Quit`이 실제로 제거를 변경 전에 중단하는지, 그리고 이 템플릿의 `GetOptions` 해석과 정확히 같은 규칙으로 인자를 잡아낼 수 있는지는 NSIS 공식 문서를 읽지 않았고 실행도 하지 않아 [미확인]이다** (이번 범위는 electron-builder 정확 태그 소스로 한정).
- **훅이 중단할 수 있는 범위(추론)**: 1·2번은 3~6번보다 앞이라 이론상 변경 전 중단 지점이다. 중단 시 `RMDir /r`·앱 데이터 삭제는 실행되지 않을 것으로 **추론**되나 입증되지 않았다.

**B. 업그레이드·재설치 경로 [명시: `installer.nsi`, `installUtil.nsh`, `installSection.nsh`]**
- 새 설치기는 파일을 쓰기 **전에** `uninstallOldVersion`으로 **이미 설치된 옛 제거기**를 복사해 실행한다: `ExecWait '"…old-uninstaller.exe" /S /KEEP_APP_DATA <인자> _?=<설치 경로>'` (`installUtil.nsh:224,230`). 인자는 `--delete-app-data`(설치기 쪽 `isDeleteAppData`가 참일 때) 또는 `--updated`(`:202-206`, "`--updated`를 항상 넘겨 `DELETE_APP_DATA_ON_UNINSTALL`이 정의돼도 사용자 데이터를 지우지 않게 한다"는 주석)다. 설치기 쪽 `isDeleteAppData`/`isUpdated`가 설치기 명령행의 무엇에서 오는지는 정의를 읽은 범위에서 찾지 못했다 **[미확인]**.
- 따라서 **업그레이드의 삭제는 새 제거기가 아니라 이미 설치된 옛 제거기의 코드가 한다.** 안전한 제거 로직은 **첫 설치본부터** 들어 있어야 하고, 기본 제거기로 설치된 적이 있는 환경에는 소급 적용할 수 없다(현재 설치본이 없으므로 새로 시작할 때만 해당) [추론: 위 흐름에서].
- 설치 파일 쓰기: `installApplicationFiles`/`customInstall`(`installSection.nsh:60-82`)이 `$INSTDIR`에 앱 파일을 푼다. 덮어쓰기·기존 파일 처리의 세부 동작은 `extractAppPackage.nsh` 등을 읽지 않아 **[미확인]**이다. `customInstall`(`:81-82`)은 앱 파일을 푼 **뒤**, 바로가기 등록 후에 실행되므로 설치 시점 manifest 기록에 쓸 수는 있어 보이나 **[추론]**이다.

**C. 설계 후보 (1~2개; 어느 것도 승인·채택 아님)**

| | 후보 1: manifest 제한 제거 (`customRemoveFiles`) | 후보 2: 사용자 파일이 있으면 변경 전 거절 (후보 1 + 사전 검사) |
|---|---|---|
| 내용 | 빌드 때 우리 스크립트가 **앱 소유 파일 목록(manifest, 상대 경로)**을 만들어 설치기에 넣고, 제거 때 `customRemoveFiles`가 manifest에 **있는 파일만** 지우고 폴더는 **비재귀 `RMDir`**(비어 있을 때만 성공)로 정리한다 | `customUnInit`/`customUnInstall`에서 설치 폴더를 `FindFirst`(템플릿이 이미 쓰는 열거 방식, `uninstaller.nsh:44-`)로 훑어 manifest에 없는 항목·링크가 있으면 **아무것도 바꾸기 전에 제거를 거절**한다 |
| 보존 | manifest 밖 사용자 추가 파일·폴더는 지워지지 않고 남는다(폴더는 안 비어서 남음) | 변경 자체를 하지 않는다 |
| 한계 | 같은 이름의 앱 소유 파일을 사용자가 바꿨다면 그대로 삭제될 수 있다(내용 해시 검증은 NSIS 기본 기능에 없고 추가 플러그인 필요 여부 **[미확인]**); manifest가 없거나 변조되거나 구버전이면 **제거를 거절**하도록 해야 하며 그 코드는 직접 써야 한다; 점검과 삭제 사이의 변경(TOCTOU)은 막지 못한다; 설치 경로나 하위가 junction/symlink(별칭)일 때 NSIS가 그것을 어떻게 다루는지 **[미확인]** | 후보 1의 한계 + 거절이 사용자에게 "제거 불가"로 보일 수 있고 열거·판정 코드가 길어진다 |
| 공식 확장점으로 입증? | `customRemoveFiles`는 문서화된 훅이고 3번 블록만 대체함은 **[명시]**. 그러나 manifest 읽기·삭제 로직의 안전성은 **직접 작성한 NSIS 코드의 정확성**에 달려 있고 **소스 읽기만으로 입증되지 않는다** | 같음 |

**D. 판정**
1. **경로 1(`RMDir /r $INSTDIR`)**: `customRemoveFiles`가 공식 확장점으로 이 블록을 통째로 대체할 수 있음은 소스로 확인했다(**명시**). 그러나 대체 코드(manifest 기반 제한 제거와 거절)는 **직접 작성해야 하고 실행 검증 없이는 보존을 보장할 수 없다.** 같은 이름·변경 파일·manifest 변조/누락/구버전·TOCTOU·별칭은 위 한계 그대로이며 "설치 폴더 전체 삭제 예외"는 승인되지 않았다.
2. **경로 2(`--delete-app-data`)**: 이 분기는 템플릿에 **고정**되어 있고 `customRemoveFiles`·옵션으로 끌 수 없다(**명시**). 막으려면 앞선 훅(`customUnInit`/`customUnInstall`)에서 인자를 읽어 중단하거나, NSIS `script` 옵션으로 **템플릿 전체를 대체**(문서가 "일반적으로 불필요, 이슈가 해결되리라 기대하지 말라"고 권하지 않음 [명시: `nsis.md`])해야 한다. 앞선 훅이 변경 전에 중단하는지는 **[미확인]**. 인자 주입(사용자가 제거기를 직접 실행하며 인자 전달)·옛 제거기가 새 설치기의 `--delete-app-data`를 받는 업그레이드·수동 제거 세 경우 모두에서 데이터를 만지기 전에 거절된다는 소스 근거는 **없다** → **계속 도입 차단**.
3. 프로젝트 경계(앱이 설치 폴더·`userData`와 겹치는 프로젝트를 열지 못하게 함, §2·§5-8의 ③)를 제품에 추가해도 **설치 뒤 사용자가 설치 폴더에 파일을 넣는 경우와 제거기 명령행 인자 문제는 해결되지 않는다.** 그 둘은 제거기 쪽 설계로만 닫힌다.
4. **결론(공식 확장점 범위의 판정)**: 경로 1은 확장점이 있으나 안전성 입증이 안 되고, 경로 2는 소스상 닫는 확장점이 입증되지 않았다. 따라서 **현재 근거로는 두 삭제 경로를 닫는다고 입증하지 못했다 → 설치기 도입 유보, 현행 폴더 배포(A·B) 유지**를 권고한다. 위 판정은 소스 텍스트 읽기이며 실행 증거가 아니다.

**E. 해소되기 전까지 도입 차단인 선행조건 (순서)**
① NSIS 공식 문서/소스로 `un.onInit`·섹션의 `Abort`/`Quit`·`GetOptions` 의미를 확인(읽기), ② `--delete-app-data`를 변경 전에 거절하는 훅 코드의 설계(읽기 판정) — 불가하면 `script` 대체 여부는 **감독 결정**(유지보수 부담), ③ manifest 방식의 한계(해시·변경 파일·별칭)를 받아들일지 결정, ④ 위 설계가 합성 환경에서 §7 음성 기준을 만족하는지의 실행 검증(**별도 승인된 격리 환경이 있을 때만**; 이번 미실행), ⑤ 제품 쪽 프로젝트 경계는 별개(§5-8 ③). 다음 감독 결정은 둘 중 하나다: **(a) 폴더 배포 유지(설치기 보류)** 또는 **(b) 위 ①부터 읽기 조사 한 단계만 승인**.

## 6. 권고 (하나)

**설치형 도입을 지금 확정하지 않는다. 가장 작은 다음 단계는 `electron-builder@26.18.0`(정확 버전)의 `--prepackaged` + NSIS(사용자별 one-click, `runAfterFinish`·`deleteAppDataOnUninstall` 끔, 설치 경로 고정)를 저장소 밖 독점 격리 루트에서 1회 검증하는 것**이다 — 단 아래 §7의 **별도 승인**이 있어야 한다. 이유: 기존 폴더 입력이 문서화되어 있고, 제품 코드 변경 증거가 없으며(B와의 차이), 의존이 Squirrel의 `install` 스크립트 같은 라이프사이클 스크립트를 갖지 않는다. 이유가 되지 않는 것: 지원 근거 충분성(미확인), 안전한 제거(조건부), 다운로드 불필요(아님). 근거가 부족하면 **구현이 아니라 이 격리 검증만** 진행하고, 검증이 막히면 현행 폴더 배포(A·B)를 유지한다. **I0 설치/제거 실행과 I1 제품 도입은 승인되지 않았고**, §5-8의 차단 조건에 대한 안전 설계(또는 격리 환경)가 확정되기 전에는 요청하지도 않는다. **§5-1의 선행 판정 결과, 두 삭제 경로를 닫는다는 입증이 없어 현재 권고는 "폴더 배포(A·B) 유지, 설치기 도입 유보"**이며 위 격리 검증 후보는 §5-1-E의 선행조건이 해소된 뒤에만 의미가 있다.

## 7. 후속 작업 분할 (이번 실행 아님; 모두 별도 승인 필요)

**I0. 격리 검증 1회** (문서 결과 PR만; 저장소 `package.json`·lock·제품 코드 변경 0)
- 입력: 이미 검증한 `package:win:branded` 출력 1개(새로 빌드하거나 기존 임시 산출물), 저장소 밖 독점 임시 루트(`mkdtemp`)에 `electron-builder@26.18.0` 임시 install(`--ignore-scripts`, 루트 안 캐시·TEMP), 합성 설정 파일(저장소 밖)로 `--prepackaged`·NSIS·사용자별·one-click·`runAfterFinish: false`·`deleteAppDataOnUninstall: false`·고정 경로.
- 승인 필요: ① 전이 의존 설치(메타데이터상 `app-builder-lib` 직접 의존 41 등), ② NSIS 도구 **다운로드**(§4 A의 7z들; 실제 필요한 것과 호스트는 실행 전에 소스로 재확인) 및 **네이티브 `makensis` 실행**, ③ 재귀 삭제 호출의 범위(독점 루트 안으로 한정하는 방어를 둘지), ④ **설치/제거를 격리할 수 없는 시스템 변경**: NSIS 설치는 경로를 지정하더라도 사용자 레지스트리(제거 항목)와 시작 메뉴/바탕화면 바로가기를 **실제 사용자 환경에 만들 수 있다** — 이 PC에서 안전하게 격리하는 방법(별도 Windows 계정/VM/샌드박스 등)이 없으면 설치·제거 실행은 **확인하지 못함으로 남기고** 설치기 생성(`makensis` 출력물)까지만 검증한다 **[미확인: 실제로 격리 가능한지]**.
- 합성 검증 기준(증거 종류): (a) 설치기 파일의 PE 문자열·아이콘(resedit 읽기), (b) 설치기 안에 들어간 앱 파일 목록이 입력 브랜드 폴더와 동일(해시 매니페스트), (c) 격리 설치가 가능할 때만: 설치 후 첫 실행은 **새 `--user-data-dir`·새 합성 프로젝트로** 제품 main 이전 `--inspect-brk` 장벽 통과(실제 기본 프로필 실행 0), 오프라인 편집→저장→재열기→검색, 바로가기 대상·아이콘(WScript.Shell 읽기), 고지 파일 존재, (d) **제거 뒤** 합성 프로젝트·합성 `userData`(합성 `settings.json`/`openai-key.bin` 대역 파일, 실제 키 아님)·`.loreweave` 합성 파일의 **해시 불변**과 설치 폴더만 사라졌음, (e) 설치 중단/실패 주입 시 합성 기존 설치 폴더·합성 데이터 보존. 하나라도 확인하지 못하면 그 항목을 "확인 못함"으로 보고한다.
- **음성 기준(향후; 이번에 실행하지 않았다)**: 합성 환경에서 ⓐ 설치 **뒤** 설치 트리 내부에 합성 원고(`chapters/*.md`)·합성 `.loreweave/*`·무관한 합성 파일을 추가하고 **업그레이드와 제거를 실행했을 때 그 파일들이 보존되거나 작업이 거절**되는지, ⓑ 설치 폴더·합성 `userData`·합성 프로젝트가 같음/상하위/별칭(junction)인 구성에서 설치·업그레이드·제거가 **거절되거나 해당 파일을 보존**하는지, ⓒ `--delete-app-data` 인자와 `deleteAppDataOnUninstall`이 합성 `userData`를 지우지 않는지를 해시 불변으로 확인한다. 이 기준을 충족하는 안전 설계(§5-8)나 격리 환경이 정해지지 않으면 **I0의 설치/제거 실행과 I1은 승인되지 않은 상태로 남는다**. 하나라도 확인하지 못하면 "확인 못함"으로 보고한다.

**I1. `package:win:installer` 스크립트 PR** (I0이 성공하고 감독이 도입을 승인한 뒤에만)
- 예상 변경: `package.json`/`pnpm-lock.yaml`(정확 버전 devDependency), `scripts/package-win-installer.ts`(브랜드 출력 → 독점 루트에서 설치기 생성 → 검증 → 새 최종 출력 복사; 브랜드 빌드와 같은 독점 루트·rm 방어·exclusive 출력 패턴 재사용), `tests/core/package-win-installer.test.ts`(합성 입력 거절 검사), `tests/e2e/…`(위 검증 기준 중 격리 가능한 것), README/계획 링크.
- 입출력: 입력 = 브랜드 폴더, 출력 = 새 폴더 안의 설치기 파일. 서명·업데이트 메타데이터(`latest.yml`)·공개 업로드 없음.

**I2. 설치형 smoke/문서 정합 PR** (필요하면; 격리 설치가 가능한 경우)

공통 금지: 실제 기본 프로필 실행, 실제 원고·키·AI DB 접근, 유료 API·Costs, 자동 업데이트·서명·공개 릴리스, 새 UI·기능.

## 8. 감독 결정이 필요한 것

(1) 설치형 도입을 계속할지(현행 폴더 배포 유지 포함) · (2) A안(electron-builder+NSIS)을 격리 검증 후보로 승인할지, Forge/B/D를 더 조사할지 · (3) 전이 의존 설치와 NSIS 도구 다운로드·네이티브 실행 승인 · (4) NSIS 제거기의 `RMDir /r $INSTDIR`를 "앱 전용 고정 설치 폴더 한정 예외"로 받을지, `--delete-app-data`/`deleteAppDataOnUninstall`을 구조적으로 막을 방법 · (5) 설치/제거를 실제 사용자 환경과 격리할 수 있는 실행 환경이 있는지 · (6) 설치본·개발본의 기본 `userData` 공유를 그대로 둘지. · (7) **§5-8 도입 차단 조건**(제거가 앱 소유 파일만 지우도록 하는 설계, `--delete-app-data` 차단, 설치 폴더·`userData`와 겹치는 프로젝트 열기 경계)을 어떻게 풀지 — 풀기 전에는 I0 설치/제거 실행·I1 도입 승인 없음 · (8) **§5-1-D 결론에 따라 폴더 배포 유지(설치기 보류)로 갈지, §5-1-E ①(NSIS 공식 문서 읽기)만 승인할지** — 어느 쪽이든 I0 설치/제거 실행·I1 도입 승인 없음

## 9. 이 문서가 확인하지 않은 것

- Electron 44.9.3과 `electron-builder` 26.18.0/`electron-winstaller` 5.4.4/Forge 8.0.1의 **명시 지원 문구와 실행 호환**, NSIS가 우리 사용 경로에서 실제로 내려받는 도구와 호스트, 기본 설치 경로의 실제 값, 앱 식별 값(`appId`)의 영향 범위, 실행 중 파일·재설치·중단 때의 실제 동작, 설치기 생성·설치·제거 결과, 바로가기·제거 항목이 만들어지는 실제 위치, D(외부 설치기 도구)의 요구사항, `@electron/windows-installer` 외 다른 Squirrel 래퍼.
- 실제 기본 `userData`의 값과 내용(조회 0), 설치/제거가 사용자 데이터에 미치는 실제 영향(실행 0).
- 읽은 자료의 URL: `registry.npmjs.org/{electron-builder, electron-winstaller, @electron-forge/maker-squirrel, @electron-forge/maker-wix}`, `raw.githubusercontent.com/electron-userland/electron-builder/electron-builder%4026.18.0/{website/docs/nsis.md, packages/app-builder-lib/src/targets/nsis/nsisOptions.ts, packages/app-builder-lib/src/toolsets/windows.ts, packages/app-builder-lib/src/options/CommonWindowsInstallerConfiguration.ts, packages/app-builder-lib/templates/nsis/uninstaller.nsh, packages/electron-builder/src/builder.ts, packages/app-builder-lib/src/packager.ts}`, `raw.githubusercontent.com/electron/windows-installer/v5.4.4/README.md`, `raw.githubusercontent.com/Squirrel/Squirrel.Windows/master/docs/using/install-process.md`, `raw.githubusercontent.com/electron/electron/v44.9.3/docs/tutorial/application-distribution.md`, `www.electronforge.io/cli`. 모두 2026-11-16에 읽었고 구현 시점에 다시 확인해야 한다. §5-1에서 추가로 읽은 정확 태그 소스: `…/templates/nsis/{uninstaller.nsh, installer.nsi, installSection.nsh}`, `…/templates/nsis/include/{installUtil.nsh, installer.nsh}`(모두 `electron-builder%4026.18.0`, 2026-11-16, 텍스트만). 못 읽은 것: NSIS 언어 문서, `extractAppPackage.nsh`, 설치기 쪽 `isDeleteAppData`/`isUpdated` 정의, `script` 옵션 상세.
