// renderer가 쓸 수 있는 main 기능 전부. preload가 이 모양 그대로 window.loreweave에 노출한다.
// renderer는 파일 경로를 다루지 않는다. 화는 `chapters/` 안의 파일 이름으로만 가리킨다.

import type { StoredAnalysis } from '../main/ai-db.ts';
import type { AnalysisState, AnalyzeProgress } from '../main/analyzer.ts';
import type { SearchResult } from '../main/indexer.ts';

export type { StoredAnalysis } from '../main/ai-db.ts';
export type { AnalysisState, AnalyzeProgress } from '../main/analyzer.ts';
import type { ChapterContent, ChapterList, WriteResult } from '../main/project-files.ts';

export type { SearchHit, SearchResult } from '../main/indexer.ts';

export type { ChapterContent, ChapterList, ChapterSummary, WriteResult } from '../main/project-files.ts';

export interface ProjectOpened {
  /** 프로젝트 폴더 이름 (표시용) */
  name: string;
  list: ChapterList;
}

export interface AiStatus {
  /** 키가 저장돼 있는가 (키 자체는 renderer로 오지 않는다) */
  hasKey: boolean;
  /** 이 컴퓨터에서 키를 암호화해 저장할 수 있는가 */
  canEncrypt: boolean;
  model: string;
  models: { id: string; label: string }[];
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
    /** 원고 전체 검색. 색인이 준비될 때까지 기다린다 */
    search(query: string): Promise<SearchResult>;
    /** frontmatter id를 새로 발급한다 (중복 id 해결). 새 화 목록을 돌려준다 */
    reissueId(file: string): Promise<ChapterList>;
    /** 다른 프로그램이 화 파일을 바꾸거나 지웠을 때 (지웠으면 hash는 null). 이 앱이 쓴 변경은 알리지 않는다 */
    onChangedOutside(listener: (change: { file: string; hash: string | null }) => void): () => void;
  };
  ai: {
    status(): Promise<AiStatus>;
    /** 키를 암호화해 저장한다. 키는 돌려받을 수 없다 */
    setKey(key: string): Promise<AiStatus>;
    deleteKey(): Promise<AiStatus>;
    setModel(model: string): Promise<AiStatus>;
    /** 키와 모델로 OpenAI에 연결해 본다 (비용 없음) */
    check(): Promise<{ ok: true } | { ok: false; message: string }>;
    /** 원고가 OpenAI로 전송된다는 안내에 동의했는지 저장한다 */
    setConsent(consent: boolean): Promise<void>;
    /** 화마다 분석 상태, 지금까지 쓴 비용, 깨진 분석 파일을 옮겼는지, 전송 동의 여부 */
    analysisStatus(): Promise<{
      states: Record<string, AnalysisState>;
      totalCostUsd: number;
      recoveredFrom: string | null;
      consent: boolean;
    }>;
    /** 분석 전에 보여 줄 예상 비용 (상한) */
    estimate(files: string[]): Promise<{ chars: number; costUsd: number }>;
    /** 화들을 차례로 분석한다. 진행 상황은 onProgress로 온다 */
    analyze(files: string[]): Promise<AnalyzeProgress>;
    cancel(): Promise<void>;
    onProgress(listener: (progress: AnalyzeProgress) => void): () => void;
    /** 저장된 분석 결과 */
    analysis(file: string): Promise<StoredAnalysis | null>;
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
  chaptersSearch: 'chapters:search',
  chapterReissueId: 'chapter:reissue-id',
  aiStatus: 'ai:status',
  aiSetKey: 'ai:set-key',
  aiDeleteKey: 'ai:delete-key',
  aiSetModel: 'ai:set-model',
  aiCheck: 'ai:check',
  aiSetConsent: 'ai:set-consent',
  aiAnalysisStatus: 'ai:analysis-status',
  aiEstimate: 'ai:estimate',
  aiAnalyze: 'ai:analyze',
  aiCancel: 'ai:cancel',
  aiProgress: 'ai:progress',
  aiAnalysis: 'ai:analysis',
  beforeClose: 'app:before-close',
  replyClose: 'app:reply-close',
} as const;

declare global {
  interface Window {
    loreweave: LoreweaveApi;
  }
}
