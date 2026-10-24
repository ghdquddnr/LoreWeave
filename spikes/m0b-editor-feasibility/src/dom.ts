// Node에서 (b) 커뮤니티 변환기가 쓰는 DOM. 브라우저에서는 아무것도 하지 않는다.

import { Window } from 'happy-dom';

if (typeof document === 'undefined') {
  const window = new Window();
  Object.assign(globalThis, {
    window,
    document: window.document,
    Node: window.Node,
    Element: window.Element,
    HTMLElement: window.HTMLElement,
    DOMParser: window.DOMParser,
    getComputedStyle: window.getComputedStyle.bind(window),
  });
}
