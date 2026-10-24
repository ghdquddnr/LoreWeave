// 원고 폴더의 파일 입출력 (M1-PLAN 4절). Electron에 의존하지 않아 Node에서 바로 테스트한다.
//   - 쓰기는 같은 폴더의 임시 파일 → fsync → 이름 바꾸기 (원자적 쓰기)
//   - 쓰기 직전에 디스크 내용의 해시를 읽을 때의 해시와 비교해, 다른 프로그램이 바꾼 내용을 덮어쓰지 않는다
//   - UTF-8이 아닌 파일은 열지 않는다 (잘못 읽은 채로 저장하면 원고가 깨진다)

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  CHAPTERS_DIR,
  chapterInfo,
  findDuplicateIds,
  isChapterFileName,
  newChapterText,
  nextChapterFile,
  sortChapterFiles,
} from '../core/project/chapters.ts';

export interface ChapterSummary {
  file: string;
  title: string;
  id: string | null;
  /** UTF-8이 아니라 열 수 없는 파일 */
  unreadable: boolean;
}

export interface ChapterList {
  chapters: ChapterSummary[];
  /** 같은 id를 쓰는 파일 묶음 */
  duplicateIds: string[][];
}

export interface ChapterContent {
  text: string;
  hash: string;
}

export type WriteResult =
  | { status: 'saved'; hash: string }
  /** 디스크 내용이 마지막으로 읽은 것과 다르다. 파일이 없어졌으면 diskHash는 null */
  | { status: 'conflict'; diskHash: string | null };

export class NotUtf8Error extends Error {
  constructor(readonly file: string) {
    super(`UTF-8이 아닌 파일은 열 수 없습니다: ${file}`);
  }
}

const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hashOf = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

function chapterPath(root: string, file: string): string {
  if (!isChapterFileName(file)) throw new Error(`잘못된 화 파일 이름: ${file}`);
  return join(root, CHAPTERS_DIR, file);
}

async function readBytes(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

function decode(bytes: Uint8Array): string | null {
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

async function chapterFiles(root: string): Promise<string[]> {
  try {
    const entries = await readdir(join(root, CHAPTERS_DIR), { withFileTypes: true });
    return entries.filter((e) => e.isFile() && isChapterFileName(e.name)).map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
}

export async function listChapters(root: string): Promise<ChapterList> {
  const files = sortChapterFiles(await chapterFiles(root));
  const chapters = await Promise.all(
    files.map(async (file): Promise<ChapterSummary> => {
      const text = decode(await readFile(chapterPath(root, file)));
      if (text === null) return { file, title: file.replace(/\.md$/, ''), id: null, unreadable: true };
      return { file, ...chapterInfo(text, file), unreadable: false };
    }),
  );
  return { chapters, duplicateIds: findDuplicateIds(chapters) };
}

export async function readChapter(root: string, file: string): Promise<ChapterContent> {
  const bytes = await readFile(chapterPath(root, file));
  const text = decode(bytes);
  if (text === null) throw new NotUtf8Error(file);
  return { text, hash: hashOf(bytes) };
}

const RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 백신·OneDrive 등이 파일을 잠시 잡고 있으면 이름 바꾸기가 실패하므로 짧게 재시도한다 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await rename(from, to);
    } catch (e) {
      if (attempt >= 5 || !RETRY_CODES.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      await sleep(50 * 2 ** attempt);
    }
  }
}

async function atomicWrite(path: string, bytes: Uint8Array): Promise<void> {
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await open(temp, 'wx');
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await renameWithRetry(temp, path);
  } catch (e) {
    await rm(temp, { force: true });
    throw e;
  }
}

/**
 * expectedHash: 마지막으로 읽은(또는 저장한) 내용의 해시. 디스크가 그와 다르면 쓰지 않고 conflict를 돌려준다.
 * 같은 파일에 대한 쓰기는 호출하는 쪽이 한 번에 하나씩 보낸다.
 */
export async function writeChapter(root: string, file: string, text: string, expectedHash: string): Promise<WriteResult> {
  const path = chapterPath(root, file);
  const disk = await readBytes(path);
  const diskHash = disk ? hashOf(disk) : null;
  if (diskHash !== expectedHash) return { status: 'conflict', diskHash };
  const bytes = Buffer.from(text, 'utf8');
  await atomicWrite(path, bytes);
  return { status: 'saved', hash: hashOf(bytes) };
}

export async function createChapter(root: string): Promise<{ file: string } & ChapterContent> {
  await mkdir(join(root, CHAPTERS_DIR), { recursive: true });
  const file = nextChapterFile(await chapterFiles(root));
  const number = Number(file.replace(/\.md$/, ''));
  const bytes = Buffer.from(newChapterText(randomUUID(), `${number}화`), 'utf8');
  // 'wx': 같은 이름이 이미 있으면 덮어쓰지 않고 실패한다
  const handle = await open(chapterPath(root, file), 'wx');
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  return { file, text: bytes.toString('utf8'), hash: hashOf(bytes) };
}
