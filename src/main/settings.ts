// 앱 설정 (사용자 데이터 폴더의 settings.json). 비밀이 아닌 값만 둔다. API 키는 secrets.ts가 따로 다룬다.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_MODEL, MODELS } from '../core/ai/models.ts';
import { type AppearanceSettings, DEFAULT_APPEARANCE, sanitizeAppearance } from '../core/appearance.ts';

export interface Settings {
  lastProject: string | null;
  aiModel: string;
  /** 원고가 OpenAI로 전송된다는 안내를 확인했는가 (M3-PLAN 1절) */
  aiSendConsent: boolean;
  /** 테마와 원고 글꼴 (core/appearance.ts). 사용자 데이터에만 저장하고 원고·frontmatter·AI DB에는 두지 않는다 */
  appearance: AppearanceSettings;
}

const DEFAULTS: Settings = { lastProject: null, aiModel: DEFAULT_MODEL, aiSendConsent: false, appearance: DEFAULT_APPEARANCE };

export const settingsPath = (userData: string) => join(userData, 'settings.json');

async function readRaw(userData: string): Promise<Settings> {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(await readFile(settingsPath(userData), 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
  } catch {
    // 처음 실행이거나 깨진 파일이다
  }
  return {
    lastProject: typeof raw['lastProject'] === 'string' ? raw['lastProject'] : DEFAULTS.lastProject,
    aiModel: MODELS.some((m) => m.id === raw['aiModel']) ? (raw['aiModel'] as string) : DEFAULTS.aiModel,
    aiSendConsent: raw['aiSendConsent'] === true,
    appearance: sanitizeAppearance(raw['appearance']),
  };
}

/**
 * 읽기와 쓰기는 폴더별로 한 번에 하나씩 차례대로 한다.
 * - 쓰기: "읽고 → 합치고 → 쓰기"가 겹치면 나중 쓰기가 먼저 쓴 다른 항목(슬라이더 값, 모델, 마지막 프로젝트)을 되돌린다.
 * - 읽기도 같은 대기열: Windows에서는 다른 곳이 읽는 중인 settings.json을 바꿔치기(rename)하면 EPERM으로 실패한다.
 * 앞 작업이 실패해도 대기열은 계속 진행된다 (실패한 작업의 오류는 그 호출자에게만 돌아간다).
 */
const queues = new Map<string, Promise<unknown>>();

function enqueue<T>(userData: string, task: () => Promise<T>): Promise<T> {
  const result = (queues.get(userData) ?? Promise.resolve()).then(task);
  queues.set(userData, result.catch(() => undefined));
  return result;
}

/** 읽을 수 없거나 값이 이상하면 기본값을 쓴다 */
export function readSettings(userData: string): Promise<Settings> {
  return enqueue(userData, () => readRaw(userData));
}

const RETRYABLE = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** 바꿔치기: 백신·색인기 등 바깥 프로세스가 잠깐 잡고 있으면 짧게 몇 번 다시 시도한다 */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (e) {
      if (attempt >= 4 || !RETRYABLE.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

/** change를 현재 저장된 설정에 합쳐 쓴다. 함수를 주면 대기열 안에서 최신 설정을 받아 부분 변경을 계산한다 */
export function updateSettings(userData: string, change: Partial<Settings> | ((current: Settings) => Partial<Settings>)): Promise<Settings> {
  return enqueue(userData, async () => {
    const current = await readRaw(userData);
    const next: Settings = { ...current, ...(typeof change === 'function' ? change(current) : change) };
    // 임시 파일에 쓴 뒤 바꿔치기: 쓰는 도중 종료돼도 settings.json이 반쪽 내용이 되지 않는다
    const tmp = `${settingsPath(userData)}.tmp`;
    await writeFile(tmp, JSON.stringify(next, null, 2));
    await replaceFile(tmp, settingsPath(userData));
    return next;
  });
}
