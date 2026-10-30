// StrictMode를 쓰지 않는다: 개발 모드에서 effect를 두 번 실행해 에디터·자동 저장 타이머가 겹치고,
// M0-B 성능 측정 조건(StrictMode 없음)과도 맞춘다.
//
// 첫 화면: 저장된 외관 설정과 OS 낮·밤을 받아 <html>에 적용한 뒤에 React를 그린다. 창은 숨겨져 있고,
// 첫 화면(글꼴 포함)을 그린 다음에야 main에 알려 보이게 한다 (themes.css의 --lw-bg와 창 배경색이 같아 깜빡임이 없다).

import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { applyAppearance } from './applyAppearance.ts';
import './fonts.css';
import './themes.css';
import './app.css';

/** 글꼴을 기다리는 최대 시간: 로컬 파일이라 보통 즉시지만 멈춰도 창은 보인다 */
const FONT_WAIT_MS = 2000;

async function start(): Promise<void> {
  const api = window.loreweave.appearance;
  const boot = await api.bootstrap();
  applyAppearance(boot.appearance, boot.systemDark);
  createRoot(document.getElementById('root')!).render(<App boot={boot} />);
  await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  await Promise.race([document.fonts.ready, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))]);
  api.rendererReady();
}

void start();
