// StrictMode를 쓰지 않는다: 개발 모드에서 effect를 두 번 실행해 에디터·자동 저장 타이머가 겹치고,
// M0-B 성능 측정 조건(StrictMode 없음)과도 맞춘다.

import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import './app.css';

createRoot(document.getElementById('root')!).render(<App />);
