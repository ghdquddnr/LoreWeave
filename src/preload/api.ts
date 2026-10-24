// renderer가 쓸 수 있는 main 기능 전부. preload가 이 모양 그대로 window.loreweave에 노출한다.
// renderer는 파일 경로를 다루지 않는다. 화는 `chapters/` 안의 파일 이름으로만 가리킨다.

import type { ChapterContent, ChapterList, WriteResult } from '../main/project-files.ts';

export type { ChapterContent, ChapterList, ChapterSummary, WriteResult } from '../main/project-files.ts';

export interface ProjectOpened {
  /** 프로젝트 폴더 이름 (표시용) */
  name: string;
  list: ChapterList;
}

export interface LoreweaveApi {
  project: {
    /** 폴더 선택 창을 띄운다. 취소하면 null */
    choose(): Promise<ProjectOpened | null>;
    /** 마지막으로 연 폴더를 다시 연다. 없거나 사라졌으면 null */
    reopenLast(): Promise<ProjectOpened | null>;
  };
  chapters: {
    list(): Promise<ChapterList>;
    read(file: string): Promise<ChapterContent>;
    /** expectedHash: 마지막으로 읽거나 저장한 내용의 해시. null이면 파일이 없어야 한다 (지워진 화를 다시 만들 때) */
    write(file: string, text: string, expectedHash: string | null): Promise<WriteResult>;
    create(): Promise<{ file: string } & ChapterContent>;
    /** 다른 프로그램이 화 파일을 바꾸거나 지웠을 때 (지웠으면 hash는 null). 이 앱이 쓴 변경은 알리지 않는다 */
    onChangedOutside(listener: (change: { file: string; hash: string | null }) => void): () => void;
  };
  app: {
    /** 창을 닫기 직전에 불린다. 저장을 마친 뒤 replyClose로 답해야 창이 닫힌다 */
    onBeforeClose(listener: () => void): () => void;
    replyClose(proceed: boolean): void;
  };
}

export const CHANNELS = {
  projectChoose: 'project:choose',
  projectReopenLast: 'project:reopen-last',
  chaptersList: 'chapters:list',
  chapterRead: 'chapter:read',
  chapterWrite: 'chapter:write',
  chapterCreate: 'chapter:create',
  chapterChangedOutside: 'chapter:changed-outside',
  beforeClose: 'app:before-close',
  replyClose: 'app:reply-close',
} as const;

declare global {
  interface Window {
    loreweave: LoreweaveApi;
  }
}
