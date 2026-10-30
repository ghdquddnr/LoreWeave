// 외관(테마·원고 글꼴) IPC와 첫 화면 맞춤. 저장은 settings.json의 appearance 하나이며 원고·AI DB와 무관하다.

import { BrowserWindow, ipcMain, nativeTheme } from 'electron';
import { parseAppearancePatch, resolveTheme, themeMeta } from '../core/appearance.ts';
import { CHANNELS, type AppearanceBootstrap } from '../preload/api.ts';
import { readSettings, updateSettings } from './settings.ts';

/** renderer가 답하지 않아도 창이 영영 숨겨지지 않게 하는 최대 대기 */
const SHOW_FALLBACK_MS = 5000;

/** 지금 설정과 OS 낮·밤으로 정해지는 창 배경색 (첫 페인트 전, 크기 조절 중에도 테마와 같은 색) */
export async function windowBackground(userData: string): Promise<string> {
  const { appearance } = await readSettings(userData);
  return themeMeta(resolveTheme(appearance, nativeTheme.shouldUseDarkColors)).background;
}

/**
 * 창은 숨긴 채로 만들고, renderer가 설정을 적용한 첫 화면을 그렸다고 알리면 보인다 (배경색만 맞추고 React effect를 기다리지 않는다).
 * 알리지 않으면 SHOW_FALLBACK_MS 뒤에 보인다.
 */
export function showWhenRendererReady(win: BrowserWindow): void {
  const timer = setTimeout(() => {
    if (!win.isDestroyed() && !win.isVisible()) win.show();
  }, SHOW_FALLBACK_MS);
  win.once('closed', () => clearTimeout(timer));
}

export function registerAppearanceIpc(userData: () => string): void {
  const refreshBackgrounds = async () => {
    const color = await windowBackground(userData());
    for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.setBackgroundColor(color);
  };

  ipcMain.handle(CHANNELS.appearanceBootstrap, async (): Promise<AppearanceBootstrap> => ({
    appearance: (await readSettings(userData())).appearance,
    systemDark: nativeTheme.shouldUseDarkColors,
  }));

  ipcMain.handle(CHANNELS.appearanceUpdate, async (_e, rawPatch: unknown) => {
    const patch = parseAppearancePatch(rawPatch);
    // 최신 저장값에 합치는 일까지 설정 쓰기 대기열 안에서 한다 (빠른 연속 변경·모델·프로젝트 저장과 겹쳐도 서로를 되돌리지 않는다)
    const saved = await updateSettings(userData(), (current) => ({ appearance: { ...current.appearance, ...patch } }));
    void refreshBackgrounds().catch(() => {});
    return saved.appearance;
  });

  ipcMain.on(CHANNELS.appearanceRendererReady, (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win && !win.isDestroyed() && !win.isVisible()) win.show();
  });

  // OS 낮·밤이 바뀌면 열린 창에 알린다 (앱 전체에서 한 번만 구독하고, 이미 닫힌 창에는 보내지 않는다)
  nativeTheme.on('updated', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send(CHANNELS.appearanceSystemDark, nativeTheme.shouldUseDarkColors);
    }
    void refreshBackgrounds().catch(() => {});
  });
}
