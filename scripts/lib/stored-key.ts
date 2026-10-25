// 측정 스크립트에서 앱에 저장된 API 키 쓰기 (M5-PLAN 2절). Electron main 프로세스에서만 동작한다.
// 키를 환경 변수·파일·명령줄에 두지 않으려고, 앱이 safeStorage로 암호화해 둔 키를 같은 방식으로 푼다.
//   - safeStorage의 암호화 키는 사용자 데이터 폴더의 "Local State"에 (Windows에서는 DPAPI로) 들어 있다
//   - 앱 폴더를 직접 쓰면 이 스크립트의 Electron이 앱의 캐시 파일을 건드리므로, "Local State"만 별도 폴더에 복사해 쓴다
//     (Electron이 실행 중에는 그 폴더의 파일을 잡고 있어 지울 수 없으므로, 같은 폴더를 매번 다시 쓴다)
//   - 키는 메모리에만 두고 출력하지 않는다
// 실행: pnpm ai-script <스크립트.ts> [인자]   (scripts/electron-run.mjs가 tsx 로더를 붙여 Electron으로 실행)

import { copyFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { app } from 'electron';
import { createOpenAiClient, type AiClient } from '../../src/main/ai-client.ts';
import { loadApiKey } from '../../src/main/secrets.ts';
import { readSettings } from '../../src/main/settings.ts';

/** 개발 실행(pnpm dev)과 같은 앱의 사용자 데이터 폴더 (package.json의 name) */
const APP_DATA_NAME = 'loreweave';

export interface ScriptContext {
  client: AiClient;
  /** 앱 [설정]에서 고른 모델 */
  model: string;
  args: string[];
}

export interface LazyScriptContext {
  /** 저장된 키를 그때 풀어 클라이언트를 만든다. 부르기 전에는 키를 읽지 않는다 */
  connect(options?: { maxRetries?: number }): Promise<AiClient>;
  args: string[];
}

/** 저장된 키로 클라이언트를 만들어 work를 실행하고, 끝나면 Electron을 끝낸다 */
export function runWithStoredKey(work: (ctx: ScriptContext) => Promise<void>): void {
  runWithLazyKey(async ({ connect, args }) => {
    const client = await connect();
    const { aiModel } = await readSettings(join(app.getPath('appData'), APP_DATA_NAME));
    await work({ client, model: aiModel, args });
  });
}

/** 키를 work가 connect()를 부를 때에만 푼다 (M9: 유료 호출 전 대조를 통과한 뒤에만 클라이언트를 만든다) */
export function runWithLazyKey(work: (ctx: LazyScriptContext) => Promise<void>): void {
  const appFolder = join(app.getPath('appData'), APP_DATA_NAME);
  const scriptFolder = join(tmpdir(), 'loreweave-script-userdata');
  try {
    mkdirSync(scriptFolder, { recursive: true });
    copyFileSync(join(appFolder, 'Local State'), join(scriptFolder, 'Local State'));
  } catch {
    console.error(`앱 데이터 폴더를 찾을 수 없습니다: ${appFolder}. 앱을 한 번 실행하고 [설정]에 키를 저장하세요.`);
    process.exit(1);
  }
  app.setPath('userData', scriptFolder);

  const finish = (code: number) => app.exit(code);

  void app.whenReady().then(async () => {
    try {
      const connect = async (options: { maxRetries?: number } = {}) => {
        const key = await loadApiKey(appFolder);
        if (!key) throw new Error('저장된 API 키를 풀 수 없습니다. 앱 [설정]에 키를 저장했는지 확인하세요.');
        return createOpenAiClient(key, options);
      };
      // Electron은 자기 인자를 앞에 둔다: [electron, 번들 파일, ...스크립트 인자]
      await work({ connect, args: process.argv.slice(2) });
      finish(Number(process.exitCode ?? 0));
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      finish(1);
    }
  });
}
