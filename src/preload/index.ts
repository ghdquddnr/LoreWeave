import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type LoreweaveApi } from './api.ts';

const api: LoreweaveApi = {
  project: {
    choose: () => ipcRenderer.invoke(CHANNELS.projectChoose),
    reopenLast: () => ipcRenderer.invoke(CHANNELS.projectReopenLast),
  },
  chapters: {
    list: (token) => ipcRenderer.invoke(CHANNELS.chaptersList, token),
    read: (file, token) => ipcRenderer.invoke(CHANNELS.chapterRead, file, token),
    write: (file, text, expectedHash, token) => ipcRenderer.invoke(CHANNELS.chapterWrite, file, text, expectedHash, token),
    create: (token) => ipcRenderer.invoke(CHANNELS.chapterCreate, token),
    search: (query) => ipcRenderer.invoke(CHANNELS.chaptersSearch, query),
    reissueId: (file, token) => ipcRenderer.invoke(CHANNELS.chapterReissueId, file, token),
    onChangedOutside(listener) {
      const handler = (_e: Electron.IpcRendererEvent, change: { file: string; hash: string | null }) => listener(change);
      ipcRenderer.on(CHANNELS.chapterChangedOutside, handler);
      return () => ipcRenderer.off(CHANNELS.chapterChangedOutside, handler);
    },
  },
  ai: {
    status: () => ipcRenderer.invoke(CHANNELS.aiStatus),
    setKey: (key) => ipcRenderer.invoke(CHANNELS.aiSetKey, key),
    deleteKey: () => ipcRenderer.invoke(CHANNELS.aiDeleteKey),
    setModel: (model) => ipcRenderer.invoke(CHANNELS.aiSetModel, model),
    check: () => ipcRenderer.invoke(CHANNELS.aiCheck),
    setConsent: (consent) => ipcRenderer.invoke(CHANNELS.aiSetConsent, consent),
    analysisStatus: (token) => ipcRenderer.invoke(CHANNELS.aiAnalysisStatus, token),
    estimate: (files, token) => ipcRenderer.invoke(CHANNELS.aiEstimate, files, token),
    analyze: (files, token) => ipcRenderer.invoke(CHANNELS.aiAnalyze, files, token),
    cancel: () => ipcRenderer.invoke(CHANNELS.aiCancel),
    onProgress(listener) {
      const handler = (_e: Electron.IpcRendererEvent, progress: Parameters<typeof listener>[0]) => listener(progress);
      ipcRenderer.on(CHANNELS.aiProgress, handler);
      return () => ipcRenderer.off(CHANNELS.aiProgress, handler);
    },
    analysis: (file, token) => ipcRenderer.invoke(CHANNELS.aiAnalysis, file, token),
    planCheck: (file, token) => ipcRenderer.invoke(CHANNELS.aiPlanCheck, file, token),
    runCheck: (file, token) => ipcRenderer.invoke(CHANNELS.aiRunCheck, file, token),
    checkResult: (file, token) => ipcRenderer.invoke(CHANNELS.aiCheckResult, file, token),
    dismiss: (file, ord, token) => ipcRenderer.invoke(CHANNELS.aiDismiss, file, ord, token),
  },
  app: {
    onBeforeClose(listener) {
      const handler = () => listener();
      ipcRenderer.on(CHANNELS.beforeClose, handler);
      return () => ipcRenderer.off(CHANNELS.beforeClose, handler);
    },
    replyClose: (proceed) => ipcRenderer.send(CHANNELS.replyClose, proceed),
  },
};

contextBridge.exposeInMainWorld('loreweave', api);
