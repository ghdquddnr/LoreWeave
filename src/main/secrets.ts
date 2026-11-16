// API 키 저장 (M3-PLAN 1절, VISION §12). Electron safeStorage로 암호화해 사용자 데이터 폴더에 둔다.
// Windows에서는 DPAPI(현재 Windows 사용자 계정)로 암호화된다. 키를 평문으로 디스크에 쓰지 않는다.
// 키를 읽는 곳은 이 모듈과 AI 클라이언트를 만드는 main 코드뿐이다. renderer로는 보내지 않는다.

import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

const keyPath = (userData: string) => join(userData, 'openai-key.bin');

export const canEncrypt = () => safeStorage.isEncryptionAvailable();

export async function saveApiKey(userData: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API 키가 비어 있습니다');
  if (!canEncrypt()) throw new Error('이 컴퓨터에서는 키를 암호화해 저장할 수 없습니다');
  // 같은 폴더의 독점 임시 파일에 암호문을 끝까지 쓴 뒤 바꿔치기한다: 쓰기·바꿔치기가 도중에 실패해도 기존 키 파일은 그대로 남는다
  const target = keyPath(userData);
  const tmp = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, safeStorage.encryptString(trimmed));
    await rename(tmp, target);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** 저장된 키. 없거나 풀 수 없으면(다른 사용자 계정에서 만든 파일 등) null */
export async function loadApiKey(userData: string): Promise<string | null> {
  try {
    return safeStorage.decryptString(await readFile(keyPath(userData)));
  } catch {
    return null;
  }
}

/**
 * 저장된 키가 있는가 (환경설정의 상태 조회용). 파일이 없으면(ENOENT) 진짜 '없음'이다. 파일은 있는데 읽다가 I/O 오류(EIO·EACCES·EPERM 등)가 나면 '없음'으로 오인하지 않도록 오류를 던진다.
 * 읽었지만 복호화할 수 없는 손상·다른 계정의 키는 loadApiKey와 같이 없는 것으로 본다 (기존 정책)
 */
export async function hasStoredApiKey(userData: string): Promise<boolean> {
  let bytes: Buffer;
  try {
    bytes = await readFile(keyPath(userData));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw e;
  }
  try {
    safeStorage.decryptString(bytes);
    return true;
  } catch {
    return false;
  }
}

export async function deleteApiKey(userData: string): Promise<void> {
  await rm(keyPath(userData), { force: true });
}
