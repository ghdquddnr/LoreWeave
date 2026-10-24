// 앱 설정 (사용자 데이터 폴더의 settings.json). 비밀이 아닌 값만 둔다. API 키는 secrets.ts가 따로 다룬다.

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MODEL, MODELS } from '../core/ai/models.ts';

export interface Settings {
  lastProject: string | null;
  aiModel: string;
  /** 원고가 OpenAI로 전송된다는 안내를 확인했는가 (M3-PLAN 1절) */
  aiSendConsent: boolean;
}

const DEFAULTS: Settings = { lastProject: null, aiModel: DEFAULT_MODEL, aiSendConsent: false };

export const settingsPath = (userData: string) => join(userData, 'settings.json');

/** 읽을 수 없거나 값이 이상하면 기본값을 쓴다 */
export async function readSettings(userData: string): Promise<Settings> {
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(await readFile(settingsPath(userData), 'utf8')) as Record<string, unknown>;
  } catch {
    // 처음 실행이거나 깨진 파일이다
  }
  return {
    lastProject: typeof raw['lastProject'] === 'string' ? raw['lastProject'] : DEFAULTS.lastProject,
    aiModel: MODELS.some((m) => m.id === raw['aiModel']) ? (raw['aiModel'] as string) : DEFAULTS.aiModel,
    aiSendConsent: raw['aiSendConsent'] === true,
  };
}

export async function updateSettings(userData: string, change: Partial<Settings>): Promise<Settings> {
  const next = { ...(await readSettings(userData)), ...change };
  await writeFile(settingsPath(userData), JSON.stringify(next, null, 2));
  return next;
}
