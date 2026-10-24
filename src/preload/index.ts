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
  },
};

contextBridge.exposeInMainWorld('loreweave', api);
