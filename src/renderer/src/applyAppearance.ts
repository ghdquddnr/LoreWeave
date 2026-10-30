// renderer 전용: 외관 설정을 <html>에 반영한다.
// 위치 제안: src/renderer/src/applyAppearance.ts

import { type AppearanceSettings, resolveTheme, themeMeta } from '../../core/appearance.ts';

export function applyAppearance(a: AppearanceSettings, systemDark: boolean, root: HTMLElement = document.documentElement): void {
  const meta = themeMeta(resolveTheme(a, systemDark));

  // 전환 순간 transition이 한꺼번에 돌며 번쩍이는 것을 막는다 (themes.css 마지막 규칙)
  root.classList.add('lw-theme-switching');

  root.dataset['theme'] = meta.id;
  root.dataset['scheme'] = meta.scheme;
  if (a.manuscriptFont === 'theme') delete root.dataset['msFont'];
  else root.dataset['msFont'] = a.manuscriptFont;

  // null이면 테마 기본값(themes.css)을 쓰도록 인라인 값을 지운다
  if (a.manuscriptSize === null) root.style.removeProperty('--lw-ms-size');
  else root.style.setProperty('--lw-ms-size', `${a.manuscriptSize}px`);
  if (a.lineHeight === null) root.style.removeProperty('--lw-ms-line-height');
  else root.style.setProperty('--lw-ms-line-height', String(a.lineHeight));

  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('lw-theme-switching')));
}
