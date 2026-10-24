// API 키 저장 (M3-PLAN 1절, VISION §12). Electron safeStorage로 암호화해 사용자 데이터 폴더에 둔다.
// Windows에서는 DPAPI(현재 Windows 사용자 계정)로 암호화된다. 키를 평문으로 디스크에 쓰지 않는다.
// 키를 읽는 곳은 이 모듈과 AI 클라이언트를 만드는 main 코드뿐이다. renderer로는 보내지 않는다.

import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeStorage } from 'electron';

const keyPath = (userData: string) => join(userData, 'openai-key.bin');

export const canEncrypt = () => safeStorage.isEncryptionAvailable();

export async function saveApiKey(userData: string, key: string): Promise<void> {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('API 키가 비어 있습니다');
  if (!canEncrypt()) throw new Error('이 컴퓨터에서는 키를 암호화해 저장할 수 없습니다');
  await writeFile(keyPath(userData), safeStorage.encryptString(trimmed));
}

/** 저장된 키. 없거나 풀 수 없으면(다른 사용자 계정에서 만든 파일 등) null */
export async function loadApiKey(userData: string): Promise<string | null> {
  try {
    return safeStorage.decryptString(await readFile(keyPath(userData)));
  } catch {
    return null;
  }
}

export async function deleteApiKey(userData: string): Promise<void> {
  await rm(keyPath(userData), { force: true });
}
