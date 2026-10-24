// renderer 요청 처리. 열린 프로젝트 폴더는 main만 알고, 모든 파일 접근은 그 폴더의 `chapters/` 안으로 제한된다.

import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { CHANNELS, type ProjectOpened } from '../preload/api.ts';
import { chapterHash, createChapter, listChapters, readChapter, writeChapter } from './project-files.ts';
import { watchChapters } from './watch.ts';

let root: string | null = null;
let stopWatching: () => void = () => {};
/** 이 앱이 마지막으로 쓴 내용의 해시. 감시 이벤트가 자기 쓰기 때문이면 알리지 않는다 */
const ownWrites = new Map<string, string>();

function startWatching(path: string): void {
  stopWatching();
  stopWatching = watchChapters(path, (file) => {
    void chapterHash(path, file).then((hash) => {
      if (root !== path || (hash !== null && ownWrites.get(file) === hash)) return;
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
    const result = await writeChapter(requireRoot(), file, text, expectedHash);
    if (result.status === 'saved') ownWrites.set(file, result.hash);
    return result;
  });
  ipcMain.handle(CHANNELS.chapterCreate, async () => {
    const path = requireRoot();
    const created = await createChapter(path);
    ownWrites.set(created.file, created.hash);
    // chapters 폴더를 방금 만들었을 수 있다
    startWatching(path);
    return created;
  });
}
