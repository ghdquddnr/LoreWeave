// renderer 요청 처리. 열린 프로젝트 폴더는 main만 알고, 모든 파일 접근은 그 폴더의 `chapters/` 안으로 제한된다.

import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { CHAPTERS_DIR } from '../core/project/chapters.ts';
import { CHANNELS, type ProjectOpened } from '../preload/api.ts';
import { ManuscriptIndex } from './index-db.ts';
import { indexChapterText, reindexChapter, searchIndex, syncIndex } from './indexer.ts';
import { chapterHash, createChapter, listChapters, readChapter, reissueChapterId, writeChapter } from './project-files.ts';
import { watchChapters } from './watch.ts';

let root: string | null = null;
/** 열린 프로젝트의 색인. 만들 수 없으면(읽기 전용 폴더 등) null이고 검색만 못 한다 */
let index: ManuscriptIndex | null = null;
/** 폴더를 열 때의 색인 동기화. 검색은 이것이 끝난 뒤에 한다 */
let indexReady: Promise<void> = Promise.resolve();
let indexError: string | null = null;

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

const settingsPath = () => join(app.getPath('userData'), 'settings.json');

async function loadLastProject(): Promise<string | null> {
  try {
    const settings = JSON.parse(await readFile(settingsPath(), 'utf8')) as { lastProject?: unknown };
    return typeof settings.lastProject === 'string' ? settings.lastProject : null;
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function openProject(path: string): Promise<ProjectOpened> {
  const list = await listChapters(path);
  root = path;
  ownWrites.clear();
  startWatching(path);
  openIndex(path);
  await writeFile(settingsPath(), JSON.stringify({ lastProject: path }, null, 2));
  return { name: basename(path), list };
}

function requireRoot(): string {
  if (!root) throw new Error('열린 프로젝트가 없습니다');
  return root;
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
    const path = await loadLastProject();
    return path && (await isDirectory(path)) ? openProject(path) : null;
  });

  ipcMain.handle(CHANNELS.chaptersList, () => listChapters(requireRoot()));
  ipcMain.handle(CHANNELS.chapterRead, (_e, file: string) => readChapter(requireRoot(), file));
  ipcMain.handle(CHANNELS.chapterWrite, async (_e, file: string, text: string, expectedHash: string | null) => {
    const path = requireRoot();
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
  ipcMain.handle(CHANNELS.chapterCreate, async () => {
    const path = requireRoot();
    const created = await createChapter(path);
    ownWrites.set(created.file, created.hash);
    await updateIndex((i) => reindexChapter(i, path, created.file));
    // chapters 폴더를 방금 만들었을 수 있다
    startWatching(path);
    return created;
  });
  ipcMain.handle(CHANNELS.chapterReissueId, async (_e, file: string) => {
    const path = requireRoot();
    const { hash } = await reissueChapterId(path, file);
    ownWrites.set(file, hash);
    await updateIndex((i) => reindexChapter(i, path, file));
    return listChapters(path);
  });
  ipcMain.handle(CHANNELS.chaptersSearch, async (_e, query: string) => {
    requireRoot();
    await indexReady;
    if (!index) throw new Error(`검색 색인을 만들 수 없습니다: ${indexError ?? '알 수 없는 이유'}`);
    return searchIndex(index, query);
  });
}
