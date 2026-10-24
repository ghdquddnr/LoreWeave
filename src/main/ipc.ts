// renderer 요청 처리. 열린 프로젝트 폴더는 main만 알고, 모든 파일 접근은 그 폴더의 `chapters/` 안으로 제한된다.

import { readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import { CHANNELS, type ProjectOpened } from '../preload/api.ts';
import { createChapter, listChapters, readChapter, writeChapter } from './project-files.ts';

let root: string | null = null;

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
  await writeFile(settingsPath(), JSON.stringify({ lastProject: path }, null, 2));
  return { name: basename(path), list };
}

function requireRoot(): string {
  if (!root) throw new Error('열린 프로젝트가 없습니다');
  return root;
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
  ipcMain.handle(CHANNELS.chapterWrite, (_e, file: string, text: string, expectedHash: string) =>
    writeChapter(requireRoot(), file, text, expectedHash),
  );
  ipcMain.handle(CHANNELS.chapterCreate, () => createChapter(requireRoot()));
}
