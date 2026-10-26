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
    // 그사이 다른 프로젝트를 열어 이 색인이 닫혔으면 새 프로젝트의 오류로 남기지 않는다
    if (index === current) indexError = e.message;
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
  // 열기는 여기서 끝났다 (root·token이 바뀌었다). 다음 실행 때 다시 열 폴더를 기억하지 못해도 열기를 실패로 돌리지 않는다:
  // 실패로 돌리면 main은 새 프로젝트인데 화면은 이전 프로젝트에 남아, 그 화면의 입력은 저장이 거절된다. 대신 화면에 알린다
  try {
    await updateSettings(userData(), { lastProject: path });
  } catch (e) {
    return { name: basename(path), list, token, rememberError: e instanceof Error ? e.message : String(e) };
  }
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

/**
 * 요청을 받을 때 열려 있던 프로젝트(token)가 아직 열려 있는가. 디스크 작업이 끝나기 전에 다른 프로젝트(같은 폴더를 다시 연 것 포함)를
 * 열었으면, 끝난 작업은 원래 폴더에 남기고 새 프로젝트의 색인·자기 쓰기 기록·감시는 건드리지 않는다
 * (원래 프로젝트의 색인은 다음에 열 때 맞춰지고, 같은 폴더를 다시 열었으면 새 감시가 이 변경을 알아챈다)
 */
const stillOpen = (token: number) => token === projectToken;

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
    if (result.status === 'saved' && stillOpen(token)) {
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
    if (stillOpen(token)) {
      ownWrites.set(created.file, created.hash);
      await updateIndex((i) => reindexChapter(i, path, created.file));
    }
    // chapters 폴더를 방금 만들었을 수 있다. 그사이 다른 폴더를 열었으면 그 폴더의 감시는 그대로 둔다 (같은 폴더를 다시 열었으면 다시 시작한다)
    if (root === path) startWatching(path);
    return created;
  });
  ipcMain.handle(CHANNELS.chapterReissueId, async (_e, file: string, token: number) => {
    const path = requireProject(token);
    const { hash } = await reissueChapterId(path, file);
    if (stillOpen(token)) {
      ownWrites.set(file, hash);
      await updateIndex((i) => reindexChapter(i, path, file));
    }
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
  /**
   * token: 요청한 화면의 프로젝트. 기다리는 사이 다른 프로젝트(같은 폴더 다시 열기 포함)를 열면 이 저장소는 닫혔을 수 있다.
   * 그러면 결과든 닫힌 저장소의 오류든 돌려주지 않고 STALE_PROJECT로 끝낸다 (이전 화면의 응답이 새 화면을 덮거나 새 프로젝트의 오류가 되지 않게)
   */
  ipcMain.handle(CHANNELS.aiAnalysisStatus, async (_e, token: number) => {
    const path = requireProject(token);
    const store = openAiStore(path, false);
    const read = async () => {
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
    };
    try {
      const status = await read();
      if (stillOpen(token)) return status;
    } catch (e) {
      if (stillOpen(token)) throw e;
    }
    throw new Error(STALE_PROJECT);
  });
  ipcMain.handle(CHANNELS.aiEstimate, async (_e, files: string[], token: number) => {
    const path = requireProject(token);
    return estimate(path, files, (await readSettings(userData())).aiModel);
  });
  ipcMain.handle(CHANNELS.aiAnalysis, (_e, file: string, token: number) => openAiStore(requireProject(token), false)?.analysis(file) ?? null);
  ipcMain.handle(CHANNELS.aiCancel, () => analyzing?.abort());
  /**
   * 분석·검사를 한 번에 하나만, 키와 전송 동의가 있을 때만 실행한다.
   * token: 요청을 시작한 화면의 프로젝트. 화면이 키·동의 확인을 기다리는 사이 다른 프로젝트(같은 폴더 다시 열기 포함)가 열렸으면
   * await 전에 거절한다 (이전 화면의 요청이 새 프로젝트 원고를 보내거나 새 ai.db에 쓰지 않게)
   */
  const runAi = async <T>(
    sender: Electron.WebContents,
    token: number,
    work: (o: Parameters<typeof analyzeChapters>[1]) => Promise<T>,
  ): Promise<T> => {
    const path = requireProject(token);
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
  ipcMain.handle(CHANNELS.aiAnalyze, (event, files: string[], token: number) => runAi(event.sender, token, (o) => analyzeChapters(files, o)));
  ipcMain.handle(CHANNELS.aiPlanCheck, async (_e, file: string, token: number) => {
    const path = requireProject(token);
    return planCheck(path, openAiStore(path, false), file, (await readSettings(userData())).aiModel);
  });
  ipcMain.handle(CHANNELS.aiRunCheck, (event, file: string, token: number) => runAi(event.sender, token, (o) => checkChapter(file, o)));
  ipcMain.handle(CHANNELS.aiCheckResult, (_e, file: string, token: number) => openAiStore(requireProject(token), false)?.check(file) ?? null);
  /** token: 무시를 누른 화면의 프로젝트. 다른 프로젝트가 열린 뒤의 요청은 거절한다 (ord는 그 화면의 검사 결과 번호라 새 프로젝트의 결과를 무시하게 된다) */
  ipcMain.handle(CHANNELS.aiDismiss, (_e, file: string, ord: number, token: number) => {
    const store = openAiStore(requireProject(token), false);
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
