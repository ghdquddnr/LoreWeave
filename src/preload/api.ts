// renderer가 쓸 수 있는 main 기능 전부. preload가 이 모양 그대로 window.loreweave에 노출한다.
// renderer는 파일 경로를 다루지 않는다. 화는 `chapters/` 안의 파일 이름으로만 가리킨다.

import type { AppearanceSettings } from '../core/appearance.ts';
import type { StoredAnalysis, StoredCheck } from '../main/ai-db.ts';
import type { AnalysisState, AnalyzeProgress } from '../main/analyzer.ts';
import type { CheckOutcome, CheckPlan, CheckState } from '../main/checker.ts';
import type { SearchResult } from '../main/indexer.ts';

export type { StoredAnalysis, StoredCheck, StoredFinding } from '../main/ai-db.ts';
export type { AnalysisState, AnalyzeProgress } from '../main/analyzer.ts';
export type { CheckOutcome, CheckPlan, CheckState } from '../main/checker.ts';
import type { ChapterContent, ChapterList, WriteResult } from '../main/project-files.ts';

export type { SearchHit, SearchResult } from '../main/indexer.ts';

export type { ChapterContent, ChapterList, ChapterSummary, WriteResult } from '../main/project-files.ts';

export interface ProjectOpened {
  /** 프로젝트 폴더 이름 (표시용) */
  name: string;
  list: ChapterList;
  /**
   * 이 프로젝트를 연 차례 (main이 프로젝트를 열 때마다 바뀐다). 화 읽기·쓰기·새 화·id 재발급에 함께 보내면,
   * 그사이 다른 프로젝트가 열렸을 때 main이 거절한다 (이전 프로젝트 화면의 저장이 새 프로젝트 파일에 쓰이지 않게)
   */
  token: number;
  /** 열기는 성공했지만 다음 실행 때 다시 열 폴더로 기억하지 못했다 (설정 저장 실패의 오류 문구) */
  rememberError?: string;
}

/** 요청한 프로젝트가 지금 열린 프로젝트가 아닐 때 main이 돌려주는 오류 문구 */
export const STALE_PROJECT = '원고 폴더가 바뀌어 이 요청을 처리하지 않았습니다';

export interface AiStatus {
  /** 키가 저장돼 있는가 (키 자체는 renderer로 오지 않는다) */
  hasKey: boolean;
  /** 이 컴퓨터에서 키를 암호화해 저장할 수 있는가 */
  canEncrypt: boolean;
  model: string;
  models: { id: string; label: string }[];
}

export interface AppearanceBootstrap {
  /** 저장된 외관 설정 (검증된 값) */
  appearance: AppearanceSettings;
  /** 지금 운영체제가 어두운 모드인가 (nativeTheme) */
  systemDark: boolean;
  /** systemDark를 읽은 시점의 OS 변경 차례. 이보다 큰 차례의 변경 알림이 이 값보다 새롭다 (응답이 늦게 도착해도 순서를 가릴 수 있게) */
  systemDarkSeq: number;
}

/** OS 낮·밤 변경 알림. seq는 main이 변경할 때마다 1씩 늘린다 */
export interface SystemDarkChange {
  systemDark: boolean;
  seq: number;
}

export interface LoreweaveApi {
  appearance: {
    /** 첫 화면을 그리기 전에 적용할 설정과 OS 낮·밤 상태 */
    bootstrap(): Promise<AppearanceBootstrap>;
    /** 부분 변경을 검증해 저장하고, 저장된 전체 외관 설정을 돌려준다. 이상한 값이면 거절한다 */
    update(patch: Partial<AppearanceSettings>): Promise<AppearanceSettings>;
    /** 첫 화면(테마와 글꼴 적용 뒤)을 그렸다고 알린다. main이 그제야 창을 보인다 */
    rendererReady(): void;
    /** 운영체제 낮·밤이 바뀔 때. 반환값은 구독 해제 */
    onSystemDarkChange(listener: (change: SystemDarkChange) => void): () => void;
  };
  project: {
    /** 폴더 선택 창을 띄운다. 취소하면 null */
    choose(): Promise<ProjectOpened | null>;
    /** 마지막으로 연 폴더를 다시 연다. 없거나 사라졌으면 null */
    reopenLast(): Promise<ProjectOpened | null>;
  };
  chapters: {
    /** token: 요청한 화면의 프로젝트 token. 지금 열린 프로젝트가 아니면 거절한다 (다른 프로젝트의 목록을 받지 않게) */
    list(token: number): Promise<ChapterList>;
    /** token: 이 화를 연 프로젝트의 token (ProjectOpened.token). 지금 열린 프로젝트가 아니면 거절한다 */
    read(file: string, token: number): Promise<ChapterContent>;
    /** expectedHash: 마지막으로 읽거나 저장한 내용의 해시. null이면 파일이 없어야 한다 (지워진 화를 다시 만들 때) */
    write(file: string, text: string, expectedHash: string | null, token: number): Promise<WriteResult>;
    create(token: number): Promise<{ file: string } & ChapterContent>;
    /** 원고 전체 검색. 색인이 준비될 때까지 기다린다 */
    search(query: string): Promise<SearchResult>;
    /** frontmatter id를 새로 발급한다 (중복 id 해결). 새 화 목록을 돌려준다 */
    reissueId(file: string, token: number): Promise<ChapterList>;
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
    /**
     * 화마다 분석·검사 상태, 지금까지 쓴 비용, 깨진 분석 파일을 옮겼는지, 전송 동의 여부.
     * token: 요청한 화면의 프로젝트 token. 다른 프로젝트가 열렸으면(답을 기다리는 사이 포함) STALE_PROJECT로 거절한다 (analysis·checkResult·dismiss도 같다)
     */
    analysisStatus(token: number): Promise<{
      states: Record<string, AnalysisState>;
      checkStates: Record<string, CheckState>;
      totalCostUsd: number;
      recoveredFrom: string | null;
      consent: boolean;
    }>;
    /**
     * 분석 전에 보여 줄 예상 비용 (상한). token: 이 요청을 시작한 화면의 프로젝트 token (ProjectOpened.token).
     * 그사이 다른 프로젝트(같은 폴더를 다시 연 것 포함)가 열렸으면 main이 STALE_PROJECT로 거절한다 (아래 analyze·planCheck·runCheck도 같다)
     */
    estimate(files: string[], token: number): Promise<{ chars: number; costUsd: number }>;
    /** 화들을 차례로 분석한다. 진행 상황은 onProgress로 온다 */
    analyze(files: string[], token: number): Promise<AnalyzeProgress>;
    cancel(): Promise<void>;
    onProgress(listener: (progress: AnalyzeProgress) => void): () => void;
    /** 저장된 분석 결과 */
    analysis(file: string, token: number): Promise<StoredAnalysis | null>;
    /** [이 화 검사] 전에 보여 줄 것: 먼저 분석할 화, 비교할 앞 화 수, 예상 비용 (상한) */
    planCheck(file: string, token: number): Promise<CheckPlan>;
    /** 필요한 화를 분석하고 이 화를 앞 화들과 비교한다. 분석 진행 상황은 onProgress로 온다. 취소는 cancel */
    runCheck(file: string, token: number): Promise<CheckOutcome>;
    /** 저장된 검사 결과 (무시한 결과도 dismissed 표시와 함께 온다) */
    checkResult(file: string, token: number): Promise<StoredCheck | null>;
    /** 검사 결과 하나를 무시한다. 다시 검사해도 같은 화·종류·문장의 결과는 숨는다 */
    dismiss(file: string, ord: number, token: number): Promise<void>;
  };
  app: {
    /** 창을 닫기 직전에 불린다. 저장을 마친 뒤 replyClose로 답해야 창이 닫힌다 */
    onBeforeClose(listener: () => void): () => void;
    replyClose(proceed: boolean): void;
  };
}

export const CHANNELS = {
  appearanceBootstrap: 'appearance:bootstrap',
  appearanceUpdate: 'appearance:update',
  appearanceRendererReady: 'appearance:renderer-ready',
  appearanceSystemDark: 'appearance:system-dark',
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
  aiPlanCheck: 'ai:plan-check',
  aiRunCheck: 'ai:run-check',
  aiCheckResult: 'ai:check-result',
  aiDismiss: 'ai:dismiss',
  beforeClose: 'app:before-close',
  replyClose: 'app:reply-close',
} as const;

declare global {
  interface Window {
    loreweave: LoreweaveApi;
  }
}
