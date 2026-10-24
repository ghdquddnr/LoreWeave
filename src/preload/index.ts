import { contextBridge, ipcRenderer } from 'electron';
import { CHANNELS, type LoreweaveApi } from './api.ts';

const api: LoreweaveApi = {
  project: {
    choose: () => ipcRenderer.invoke(CHANNELS.projectChoose),
    reopenLast: () => ipcRenderer.invoke(CHANNELS.projectReopenLast),
  },
  chapters: {
    list: () => ipcRenderer.invoke(CHANNELS.chaptersList),
    read: (file) => ipcRenderer.invoke(CHANNELS.chapterRead, file),
    write: (file, text, expectedHash) => ipcRenderer.invoke(CHANNELS.chapterWrite, file, text, expectedHash),
    create: () => ipcRenderer.invoke(CHANNELS.chapterCreate),
    search: (query) => ipcRenderer.invoke(CHANNELS.chaptersSearch, query),
    reissueId: (file) => ipcRenderer.invoke(CHANNELS.chapterReissueId, file),
    onChangedOutside(listener) {
      const handler = (_e: Electron.IpcRendererEvent, change: { file: string; hash: string | null }) => listener(change);
      ipcRenderer.on(CHANNELS.chapterChangedOutside, handler);
      return () => ipcRenderer.off(CHANNELS.chapterChangedOutside, handler);
    },
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
