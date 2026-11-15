// package:win:branded가 띄우는 packager 자식 프로세스 (직접 실행하는 명령이 아니다).
// 부모가 쓴 설정 파일(<독점 루트>/logs/packager-config.json)을 읽어, packager를 import하기 *전에* 삭제 방어를 설치하고 packager를 한 번만 호출한다.
// 모든 삭제 호출은 <독점 루트>/logs/rm-calls.jsonl에 기록된다. 이 프로세스의 TEMP/TMP는 부모가 독점 루트 안으로 지정한다.

import { appendFileSync, readFileSync } from 'node:fs';
import type { Options } from '@electron/packager';
import { installRmGuard } from './rm-guard.ts';

interface Config {
  options: Options;
  allowedRm: string[];
  rmLog: string;
}

const configPath = process.argv[2];
if (!configPath) throw new Error('설정 파일 경로가 필요하다');
const config = JSON.parse(readFileSync(configPath, 'utf8')) as Config;

installRmGuard(config.allowedRm, (call) => appendFileSync(config.rmLog, `${JSON.stringify(call)}\n`));

// tsx는 이 파일을 CommonJS로 변환하므로 최상위 await 대신 async 함수를 쓴다
async function run(): Promise<void> {
  try {
    const { packager } = await import('@electron/packager');
    const appPaths = await packager(config.options);
    console.log(JSON.stringify({ ok: true, appPaths }));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) }));
    process.exitCode = 1;
  }
}
void run();
