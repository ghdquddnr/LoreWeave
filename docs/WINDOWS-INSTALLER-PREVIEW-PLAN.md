# Windows x64 설치형 미리보기 최소 계획

상태: **계획 문서일 뿐이다. 구현·설치·다운로드·패키징·설치/제거 실행은 하나도 하지 않았다** (제품 코드·테스트·`package.json`·lock 변경 0, 새 도구 설치 0, exe/zip/7z 다운로드 0; 공식 문서·정확 태그 소스·npm 레지스트리 메타데이터의 **텍스트만 읽었다**, 2026-11-16).
이 문서는 [WINDOWS-PREVIEW-PLAN.md](WINDOWS-PREVIEW-PLAN.md) §9의 "NSIS·서명·업데이트는 별도 계획"을 설치기에 한해 구체화하라는 **감독의 선택**에 따른 것이다. **사용자가 설치 도구를 골랐다는 기록이 아니다.** 서명·자동 업데이트·공개 릴리스·새 기능·새 UI는 이 계획의 대상이 아니다.
유지하는 것: `package:win`(경로 A)·`package:win:branded`([WINDOWS-BRANDED-PREVIEW-PLAN.md](WINDOWS-BRANDED-PREVIEW-PLAN.md) §4.3)·4테마·오프라인 번들·런타임 identity(`name: loreweave`)와 기본 `userData` 정책·저장/충돌/닫기/보안 설정.

## 1. 한눈에 (결론)

1. **도입 확정 없음.** 읽은 근거로는 어떤 설치 도구도 "원고·설정·키·AI DB를 건드리지 않고, 다운로드·네이티브 실행도구·제품 코드 변경 없이" 쓸 수 있다고 입증되지 않았다 (§4).
2. 후보 중 **가장 작은 격리 검증 후보는 `electron-builder`의 `--prepackaged` + NSIS(사용자별 one-click)** 하나다. 이미 검증한 브랜드 폴더를 **그대로 입력**으로 받는 옵션이 문서화되어 있고 **제품 코드 변경이 필요하다는 증거가 없다**. 단 NSIS 실행 도구(`makensis`)를 받는 **다운로드와 네이티브 실행**이 필요하고, 제거기의 기본 동작에 **재귀 삭제**가 있어 감독 결정 사항이 남는다 (§5).
3. 지원 근거(Electron 44.9.3과의 호환)는 **명시 문구 미확인·실행 증거 없음**이므로 구현 전에 **별도 승인된 최소 격리 검증**이 먼저다 (§7). 이번에 실험하지 않았다.

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
- 프로젝트 데이터(`.loreweave/*`, 원고)는 **프로젝트 폴더에 있어 `userData`·설치 경로 어디와도 겹치지 않는다**. 겹칠 수 있는 곳은 `userData`(설정·키·프로필)와 설치 경로의 상위/하위 관계뿐이다.

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
4. **업그레이드·실행 중 파일·재설치**: 같은 식별로 덮어 설치할 때 실행 중인 `LoreWeave.exe`가 잠겨 있으면 설치기가 실패하거나 재시도한다(도구별 동작은 이번에 읽은 범위에서 **[미확인]**; NSIS 템플릿에는 `atomicRMDir`로 설치 폴더를 **임시로 옮겼다가 복구하는 로직**이 있다 [명시: `templates/nsis/uninstaller.nsh`]). 사용자 데이터가 설치 폴더 밖에 있어야 한다는 전제는 §2의 대조로 만족된다.
5. **실패 산출물**: 설치 실패 시 부분 설치물이 남을 수 있다. 검증에서 "실패해도 기존 파일(합성 기존 설치 폴더·합성 사용자 데이터)이 그대로"임을 확인해야 하며, 도구가 자동으로 정리하는 범위는 **[미확인]**.
6. **제거 정책(최소)**: 설치/제거는 **앱 소유 바이너리(설치 폴더·바로가기·제거 항목)만 대상**으로 한다. **원고·프로젝트·`.loreweave/*`·`settings.json`·`openai-key.bin`·AI DB·`userData`·공유 캐시를 삭제·이전·초기화하지 않는다.** 이 계획은 일반 "재귀 삭제 0" 정책을 해제하지 않는다.
7. **도구 기본 동작과의 충돌 (그대로 지적, 감독 결정 필요)**:
   - NSIS 제거기는 설치 폴더를 **`RMDir /r $INSTDIR`로 재귀 삭제**한다 [명시: `uninstaller.nsh`]. 설치 폴더가 앱 전용 고정 경로일 때만 앱 소유 범위 안이다. 사용자가 설치 경로를 바꿀 수 있거나 데이터와 같은 폴더면 사용자 데이터가 지워질 수 있으므로 **고정 경로·전용 폴더**가 전제이며, 이 재귀 삭제를 "앱 소유 설치 폴더 한정 예외"로 받아들일지는 **감독 결정**이다.
   - NSIS 제거기는 `--delete-app-data` 인자 또는 `deleteAppDataOnUninstall`(기본 `false`)이면 **`$APPDATA\<APP_FILENAME>`, `<productFilename>`, `<package.json name>`을 재귀 삭제**한다 [명시: `uninstaller.nsh`, `nsisOptions.ts`]. `<package.json name>` = `loreweave`는 우리 기본 `userData`(설정·키)다. **옵션은 끄고 제거 시 그 인자가 쓰이지 않게** 해야 하며, 사용자가 인자를 주는 경로를 막을 수 있는지는 **[미확인]**(필요하면 커스텀 NSIS 스크립트 — 감독 결정).
   - Squirrel(B)은 설치·제거 중 앱을 `--squirrel-*` 인자로 실행하므로 제품 코드 변경과 start 장벽 재설계가 필요하다.
   - A의 NSIS 도구는 **다운로드**(고정 sha256)와 **네이티브 `makensis` 실행**을 요구한다 — 새 의존성·다운로드·네이티브 실행 승인이 필요하다.

## 6. 권고 (하나)

**설치형 도입을 지금 확정하지 않는다. 가장 작은 다음 단계는 `electron-builder@26.18.0`(정확 버전)의 `--prepackaged` + NSIS(사용자별 one-click, `runAfterFinish`·`deleteAppDataOnUninstall` 끔, 설치 경로 고정)를 저장소 밖 독점 격리 루트에서 1회 검증하는 것**이다 — 단 아래 §7의 **별도 승인**이 있어야 한다. 이유: 기존 폴더 입력이 문서화되어 있고, 제품 코드 변경 증거가 없으며(B와의 차이), 의존이 Squirrel의 `install` 스크립트 같은 라이프사이클 스크립트를 갖지 않는다. 이유가 되지 않는 것: 지원 근거 충분성(미확인), 안전한 제거(조건부), 다운로드 불필요(아님). 근거가 부족하면 **구현이 아니라 이 격리 검증만** 진행하고, 검증이 막히면 현행 폴더 배포(A·B)를 유지한다.

## 7. 후속 작업 분할 (이번 실행 아님; 모두 별도 승인 필요)

**I0. 격리 검증 1회** (문서 결과 PR만; 저장소 `package.json`·lock·제품 코드 변경 0)
- 입력: 이미 검증한 `package:win:branded` 출력 1개(새로 빌드하거나 기존 임시 산출물), 저장소 밖 독점 임시 루트(`mkdtemp`)에 `electron-builder@26.18.0` 임시 install(`--ignore-scripts`, 루트 안 캐시·TEMP), 합성 설정 파일(저장소 밖)로 `--prepackaged`·NSIS·사용자별·one-click·`runAfterFinish: false`·`deleteAppDataOnUninstall: false`·고정 경로.
- 승인 필요: ① 전이 의존 설치(메타데이터상 `app-builder-lib` 직접 의존 41 등), ② NSIS 도구 **다운로드**(§4 A의 7z들; 실제 필요한 것과 호스트는 실행 전에 소스로 재확인) 및 **네이티브 `makensis` 실행**, ③ 재귀 삭제 호출의 범위(독점 루트 안으로 한정하는 방어를 둘지), ④ **설치/제거를 격리할 수 없는 시스템 변경**: NSIS 설치는 경로를 지정하더라도 사용자 레지스트리(제거 항목)와 시작 메뉴/바탕화면 바로가기를 **실제 사용자 환경에 만들 수 있다** — 이 PC에서 안전하게 격리하는 방법(별도 Windows 계정/VM/샌드박스 등)이 없으면 설치·제거 실행은 **확인하지 못함으로 남기고** 설치기 생성(`makensis` 출력물)까지만 검증한다 **[미확인: 실제로 격리 가능한지]**.
- 합성 검증 기준(증거 종류): (a) 설치기 파일의 PE 문자열·아이콘(resedit 읽기), (b) 설치기 안에 들어간 앱 파일 목록이 입력 브랜드 폴더와 동일(해시 매니페스트), (c) 격리 설치가 가능할 때만: 설치 후 첫 실행은 **새 `--user-data-dir`·새 합성 프로젝트로** 제품 main 이전 `--inspect-brk` 장벽 통과(실제 기본 프로필 실행 0), 오프라인 편집→저장→재열기→검색, 바로가기 대상·아이콘(WScript.Shell 읽기), 고지 파일 존재, (d) **제거 뒤** 합성 프로젝트·합성 `userData`(합성 `settings.json`/`openai-key.bin` 대역 파일, 실제 키 아님)·`.loreweave` 합성 파일의 **해시 불변**과 설치 폴더만 사라졌음, (e) 설치 중단/실패 주입 시 합성 기존 설치 폴더·합성 데이터 보존. 하나라도 확인하지 못하면 그 항목을 "확인 못함"으로 보고한다.

**I1. `package:win:installer` 스크립트 PR** (I0이 성공하고 감독이 도입을 승인한 뒤에만)
- 예상 변경: `package.json`/`pnpm-lock.yaml`(정확 버전 devDependency), `scripts/package-win-installer.ts`(브랜드 출력 → 독점 루트에서 설치기 생성 → 검증 → 새 최종 출력 복사; 브랜드 빌드와 같은 독점 루트·rm 방어·exclusive 출력 패턴 재사용), `tests/core/package-win-installer.test.ts`(합성 입력 거절 검사), `tests/e2e/…`(위 검증 기준 중 격리 가능한 것), README/계획 링크.
- 입출력: 입력 = 브랜드 폴더, 출력 = 새 폴더 안의 설치기 파일. 서명·업데이트 메타데이터(`latest.yml`)·공개 업로드 없음.

**I2. 설치형 smoke/문서 정합 PR** (필요하면; 격리 설치가 가능한 경우)

공통 금지: 실제 기본 프로필 실행, 실제 원고·키·AI DB 접근, 유료 API·Costs, 자동 업데이트·서명·공개 릴리스, 새 UI·기능.

## 8. 감독 결정이 필요한 것

(1) 설치형 도입을 계속할지(현행 폴더 배포 유지 포함) · (2) A안(electron-builder+NSIS)을 격리 검증 후보로 승인할지, Forge/B/D를 더 조사할지 · (3) 전이 의존 설치와 NSIS 도구 다운로드·네이티브 실행 승인 · (4) NSIS 제거기의 `RMDir /r $INSTDIR`를 "앱 전용 고정 설치 폴더 한정 예외"로 받을지, `--delete-app-data`/`deleteAppDataOnUninstall`을 구조적으로 막을 방법 · (5) 설치/제거를 실제 사용자 환경과 격리할 수 있는 실행 환경이 있는지 · (6) 설치본·개발본의 기본 `userData` 공유를 그대로 둘지.

## 9. 이 문서가 확인하지 않은 것

- Electron 44.9.3과 `electron-builder` 26.18.0/`electron-winstaller` 5.4.4/Forge 8.0.1의 **명시 지원 문구와 실행 호환**, NSIS가 우리 사용 경로에서 실제로 내려받는 도구와 호스트, 기본 설치 경로의 실제 값, 앱 식별 값(`appId`)의 영향 범위, 실행 중 파일·재설치·중단 때의 실제 동작, 설치기 생성·설치·제거 결과, 바로가기·제거 항목이 만들어지는 실제 위치, D(외부 설치기 도구)의 요구사항, `@electron/windows-installer` 외 다른 Squirrel 래퍼.
- 실제 기본 `userData`의 값과 내용(조회 0), 설치/제거가 사용자 데이터에 미치는 실제 영향(실행 0).
- 읽은 자료의 URL: `registry.npmjs.org/{electron-builder, electron-winstaller, @electron-forge/maker-squirrel, @electron-forge/maker-wix}`, `raw.githubusercontent.com/electron-userland/electron-builder/electron-builder%4026.18.0/{website/docs/nsis.md, packages/app-builder-lib/src/targets/nsis/nsisOptions.ts, packages/app-builder-lib/src/toolsets/windows.ts, packages/app-builder-lib/src/options/CommonWindowsInstallerConfiguration.ts, packages/app-builder-lib/templates/nsis/uninstaller.nsh, packages/electron-builder/src/builder.ts, packages/app-builder-lib/src/packager.ts}`, `raw.githubusercontent.com/electron/windows-installer/v5.4.4/README.md`, `raw.githubusercontent.com/Squirrel/Squirrel.Windows/master/docs/using/install-process.md`, `raw.githubusercontent.com/electron/electron/v44.9.3/docs/tutorial/application-distribution.md`, `www.electronforge.io/cli`. 모두 2026-11-16에 읽었고 구현 시점에 다시 확인해야 한다.
