// renderer 요청 처리. 열린 프로젝트 폴더는 main만 알고, 모든 파일 접근은 그 폴더의 `chapters/` 안으로 제한된다.

import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { MODELS } from '../core/ai/models.ts';
import { CHAPTERS_DIR } from '../core/project/chapters.ts';
import { CHANNELS, STALE_PROJECT, type AiStatus, type ProjectOpened } from '../preload/api.ts';
import { createOpenAiClient, toAiError } from './ai-client.ts';
import { AiStore } from './ai-db.ts';
import { analysisStates, analyzeChapters, estimate } from './analyzer.ts';
import { checkChapter, checkStates, planCheck } from './checker.ts';
import { INDEX_DIR, ManuscriptIndex } from './index-db.ts';
import { indexChapterText, reindexChapter, searchIndex, syncIndex } from './indexer.ts';
import {
  chapterFileNames,
  chapterHash,
  createChapter,
  listChapters,
  readChapter,
  reissueChapterId,
  writeChapter,
} from './project-files.ts';
import { canEncrypt, deleteApiKey, loadApiKey, saveApiKey } from './secrets.ts';
import { readSettings, updateSettings } from './settings.ts';
import { watchChapters } from './watch.ts';

let root: string | null = null;
/** 열린 프로젝트의 색인. 만들 수 없으면(읽기 전용 폴더 등) null이고 검색만 못 한다 */
let index: ManuscriptIndex | null = null;
/** 폴더를 열 때의 색인 동기화. 검색은 이것이 끝난 뒤에 한다 */
let indexReady: Promise<void> = Promise.resolve();
let indexError: string | null = null;
/** AI 분석 결과 저장소. 처음 분석할 때 만든다 (AI를 쓰지 않으면 ai.db가 생기지 않는다) */
let aiStore: AiStore | null = null;
/**
 * 진행 중인 분석·검사가 쓰는 저장소. 프로젝트를 바꿔도 이 저장소는 닫지 않고, 그 작업이 이미 보낸 요청을 정산하고 끝날 때 닫는다
 * (취소 신호로 새 요청은 보내지 않는다. 늦게 온 응답의 호출 기록·비용은 원래 프로젝트의 ai.db에 남는다)
 */
let jobStore: AiStore | null = null;
/** 진행 중인 분석·검사의 취소 장치. 한 번에 하나만 */
let analyzing: AbortController | null = null;

function openAiStore(path: string, create: boolean): AiStore | null {
  if (aiStore) return aiStore;
  if (!create && !existsSync(join(path, INDEX_DIR, 'ai.db'))) return null;
  aiStore = AiStore.open(path);
  return aiStore;
}

function openIndex(path: string): void {
  index?.close();
  index = null;
  indexError = null;
  try {
    const opened = ManuscriptIndex.open(path);
    index = opened;
    indexReady = syncIndex(opened, path).then(
      () => undefined,
      (e: Error) => {
        indexError = e.message;
      },
    );
  } catch (e) {
    indexError = e instanceof Error ? e.message : String(e);
    indexReady = Promise.resolve();
  }
}

/** 색인 갱신은 실패해도 원고 작업을 막지 않는다. 다음에 폴더를 열 때 다시 맞춰진다 */
function updateIndex(work: (index: ManuscriptIndex) => void | Promise<void>): Promise<void> {
  const current = index;
  if (!current) return Promise.resolve();
  return Promise.resolve(work(current)).catch((e: Error) => {
    indexError = e.message;
  });
}
let stopWatching: () => void = () => {};
/** 이 앱이 마지막으로 쓴 내용의 해시. 감시 이벤트가 자기 쓰기 때문이면 알리지 않는다 */
const ownWrites = new Map<string, string>();

function startWatching(path: string): void {
  stopWatching();
  stopWatching = watchChapters(path, (file) => {
    void chapterHash(path, file).then((hash) => {
      if (root !== path || (hash !== null && ownWrites.get(file) === hash)) return;
      void updateIndex((i) => reindexChapter(i, path, file));
      for (const win of BrowserWindow.getAllWindows()) win.webContents.send(CHANNELS.chapterChangedOutside, { file, hash });
    });
  });
}

const userData = () => app.getPath('userData');

async function aiStatus(): Promise<AiStatus> {
  const settings = await readSettings(userData());
  return {
    hasKey: (await loadApiKey(userData())) !== null,
    canEncrypt: canEncrypt(),
    model: settings.aiModel,
    models: MODELS.map(({ id, label }) => ({ id, label })),
  };
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** 프로젝트를 연 차례. 열 때마다 1씩 는다 (ProjectOpened.token) */
let projectToken = 0;

async function openProject(path: string): Promise<ProjectOpened> {
  const list = await listChapters(path);
  analyzing?.abort();
  // 진행 중인 작업이 쓰는 저장소는 그 작업이 끝날 때 닫는다 (runAi). 새 프로젝트는 새 저장소를 연다
  if (aiStore !== jobStore) aiStore?.close();
  aiStore = null;
  // root와 token은 await 없이 함께 바꾼다. 이 뒤로 이전 token의 화 읽기·쓰기는 거절된다
  root = path;
  projectToken += 1;
  const token = projectToken;
  ownWrites.clear();
  startWatching(path);
  openIndex(path);
  await updateSettings(userData(), { lastProject: path });
  return { name: basename(path), list, token };
}

function requireRoot(): string {
  if (!root) throw new Error('열린 프로젝트가 없습니다');
  return root;
}

/** 요청을 보낸 화면의 프로젝트(token)가 지금 열린 프로젝트일 때만 그 root를 돌려준다 */
function requireProject(token: unknown): string {
  const path = requireRoot();
  if (token !== projectToken) throw new Error(STALE_PROJECT);
  return path;
}

const CLOSE_TIMEOUT_MS = 10_000;

/**
 * 창을 닫기 전에 renderer에 저장할 기회를 준다. renderer가 답하지 않으면(멈춤 등) 10초 뒤 닫는다.
 * renderer가 false로 답하면(사용자가 닫기를 취소) 창을 그대로 둔다.
 */
export function guardWindowClose(win: BrowserWindow): void {
  let allowed = false;
  let timer: NodeJS.Timeout | null = null;
  const close = () => {
    allowed = true;
    if (!win.isDestroyed()) win.close();
  };
  win.on('close', (event) => {
    if (allowed) return;
    event.preventDefault();
    if (timer) return;
    win.webContents.send(CHANNELS.beforeClose);
    timer = setTimeout(close, CLOSE_TIMEOUT_MS);
  });
  ipcMain.on(CHANNELS.replyClose, (event, proceed: boolean) => {
    if (event.sender !== win.webContents || !timer) return;
    clearTimeout(timer);
    timer = null;
    if (proceed) close();
  });
}

export function registerIpc(): void {
  ipcMain.handle(CHANNELS.projectChoose, async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { title: '원고 폴더 열기', properties: ['openDirectory', 'createDirectory'] });
    const path = result.filePaths[0];
    return !result.canceled && path ? openProject(path) : null;
  });

  ipcMain.handle(CHANNELS.projectReopenLast, async () => {
    const path = (await readSettings(userData())).lastProject;
    return path && (await isDirectory(path)) ? openProject(path) : null;
  });

  ipcMain.handle(CHANNELS.chaptersList, (_e, token: number) => listChapters(requireProject(token)));
  ipcMain.handle(CHANNELS.chapterRead, (_e, file: string, token: number) => readChapter(requireProject(token), file));
  ipcMain.handle(CHANNELS.chapterWrite, async (_e, file: string, text: string, expectedHash: string | null, token: number) => {
    // root는 await 전에 정한다: 이미 시작한 저장은 프로젝트를 바꿔도 원래 폴더에서 끝난다
    const path = requireProject(token);
    const result = await writeChapter(path, file, text, expectedHash);
    if (result.status === 'saved') {
      ownWrites.set(file, result.hash);
      await updateIndex(async (i) => {
        const info = await stat(join(path, CHAPTERS_DIR, file));
        indexChapterText(i, file, text, info.mtimeMs, info.size);
      });
    }
    return result;
  });
  ipcMain.handle(CHANNELS.chapterCreate, async (_e, token: number) => {
    const path = requireProject(token);
    const created = await createChapter(path);
    ownWrites.set(created.file, created.hash);
    await updateIndex((i) => reindexChapter(i, path, created.file));
    // chapters 폴더를 방금 만들었을 수 있다
    startWatching(path);
    return created;
  });
  ipcMain.handle(CHANNELS.chapterReissueId, async (_e, file: string, token: number) => {
    const path = requireProject(token);
    const { hash } = await reissueChapterId(path, file);
    ownWrites.set(file, hash);
    await updateIndex((i) => reindexChapter(i, path, file));
    return listChapters(path);
  });
  ipcMain.handle(CHANNELS.aiStatus, () => aiStatus());
  ipcMain.handle(CHANNELS.aiSetKey, async (_e, key: string) => {
    await saveApiKey(userData(), key);
    return aiStatus();
  });
  ipcMain.handle(CHANNELS.aiDeleteKey, async () => {
    await deleteApiKey(userData());
    return aiStatus();
  });
  ipcMain.handle(CHANNELS.aiSetModel, async (_e, model: string) => {
    if (!MODELS.some((m) => m.id === model)) throw new Error(`알 수 없는 모델: ${model}`);
    await updateSettings(userData(), { aiModel: model });
    return aiStatus();
  });
  ipcMain.handle(CHANNELS.aiCheck, async () => {
    const key = await loadApiKey(userData());
    if (!key) return { ok: false, message: 'API 키가 없습니다' };
    try {
      await createOpenAiClient(key).check((await readSettings(userData())).aiModel);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: toAiError(e).message };
    }
  });
  ipcMain.handle(CHANNELS.aiSetConsent, async (_e, consent: boolean) => {
    await updateSettings(userData(), { aiSendConsent: consent === true });
  });
  ipcMain.handle(CHANNELS.aiAnalysisStatus, async () => {
    const path = requireRoot();
    const store = openAiStore(path, false);
    const settings = await readSettings(userData());
    if (!store) {
      const files = await chapterFileNames(path);
      const none = Object.fromEntries(files.map((f) => [f, 'none' as const]));
      return { states: none, checkStates: none, totalCostUsd: 0, recoveredFrom: null, consent: settings.aiSendConsent };
    }
    return {
      states: await analysisStates(path, store),
      checkStates: await checkStates(path, store),
      totalCostUsd: store.totalCost(),
      recoveredFrom: store.recoveredFrom,
      consent: settings.aiSendConsent,
    };
  });
  ipcMain.handle(CHANNELS.aiEstimate, async (_e, files: string[]) => {
    const path = requireRoot();
    return estimate(path, files, (await readSettings(userData())).aiModel);
  });
  ipcMain.handle(CHANNELS.aiAnalysis, (_e, file: string) => openAiStore(requireRoot(), false)?.analysis(file) ?? null);
  ipcMain.handle(CHANNELS.aiCancel, () => analyzing?.abort());
  /** 분석·검사를 한 번에 하나만, 키와 전송 동의가 있을 때만 실행한다 */
  const runAi = async <T>(
    sender: Electron.WebContents,
    work: (o: Parameters<typeof analyzeChapters>[1]) => Promise<T>,
  ): Promise<T> => {
    const path = requireRoot();
    if (analyzing) throw new Error('이미 분석 중입니다');
    // 첫 await 전에 한 작업의 자리를 잡는다. 설정·키를 읽는 동안 들어온 다른 분석·검사 요청은 위에서 거절된다
    const controller = new AbortController();
    analyzing = controller;
    try {
      const settings = await readSettings(userData());
      if (!settings.aiSendConsent) throw new Error('원고 전송에 동의해야 분석할 수 있습니다');
      const key = await loadApiKey(userData());
      if (!key) throw new Error('API 키가 없습니다. 설정에서 키를 넣으세요.');
      // 설정·키를 읽는 동안 취소했으면(또는 프로젝트를 바꿨으면) 작업을 시작하지 않는다
      if (controller.signal.aborted) throw new Error('취소했습니다');
      // 이 작업이 끝날 때까지 쓸 저장소. 도중에 프로젝트를 바꾸면 aiStore는 새 저장소로 바뀌지만 이 저장소는 열린 채 남는다
      const store = openAiStore(path, true)!;
      jobStore = store;
      try {
        return await work({
          root: path,
          store,
          client: createOpenAiClient(key),
          model: settings.aiModel,
          signal: controller.signal,
          onProgress: (p) => sender.send(CHANNELS.aiProgress, p),
        });
      } finally {
        jobStore = null;
        // 프로젝트를 바꿔 지금 열린 저장소가 아니게 됐으면, 정산이 끝난 지금 닫는다
        if (store !== aiStore) store.close();
      }
    } finally {
      // 자기 자리만 비운다
      if (analyzing === controller) analyzing = null;
    }
  };
  ipcMain.handle(CHANNELS.aiAnalyze, (event, files: string[]) => runAi(event.sender, (o) => analyzeChapters(files, o)));
  ipcMain.handle(CHANNELS.aiPlanCheck, async (_e, file: string) => {
    const path = requireRoot();
    return planCheck(path, openAiStore(path, false), file, (await readSettings(userData())).aiModel);
  });
  ipcMain.handle(CHANNELS.aiRunCheck, (event, file: string) => runAi(event.sender, (o) => checkChapter(file, o)));
  ipcMain.handle(CHANNELS.aiCheckResult, (_e, file: string) => openAiStore(requireRoot(), false)?.check(file) ?? null);
  ipcMain.handle(CHANNELS.aiDismiss, (_e, file: string, ord: number) => {
    const store = openAiStore(requireRoot(), false);
    const finding = store?.check(file)?.findings.find((f) => f.ord === ord);
    if (!store || !finding) throw new Error('무시할 검사 결과가 없습니다');
    store.dismiss(file, finding.category, finding.key, new Date().toISOString());
  });
  ipcMain.handle(CHANNELS.chaptersSearch, async (_e, query: string) => {
    requireRoot();
    await indexReady;
    if (!index) throw new Error(`검색 색인을 만들 수 없습니다: ${indexError ?? '알 수 없는 이유'}`);
    return searchIndex(index, query);
  });
}
