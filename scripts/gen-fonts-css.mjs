// 번들 폰트 CSS 생성: @fontsource 패키지의 @font-face에서 쓰는 굵기의 woff2만 골라 src/renderer/src/fonts.css로 쓴다.
// (패키지 CSS를 그대로 import하면 woff까지 이중으로 번들되고, 쓰지 않는 굵기·문자 집합도 따라온다.)
// 사용: node scripts/gen-fonts-css.mjs   — 폰트 패키지 버전을 올렸을 때만 다시 실행한다.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const packageDir = (name) => dirname(require.resolve(`${name}/package.json`));

/** [패키지, 굵기, 문자 집합 이름 규칙(true면 해당 파일 이름이 허용 목록에 있어야 함)] */
const WANTED = [
  { pkg: '@fontsource/ibm-plex-sans-kr', weights: [400, 500, 600], keep: () => true },
  { pkg: '@fontsource/noto-serif-kr', weights: [400, 700], keep: () => true },
  // 코드·파일명용 고정폭: 라틴만 (한글은 UI 글꼴로 이어진다)
  { pkg: '@fontsource/jetbrains-mono', weights: [400, 500], keep: (file) => /-latin-\d+-normal\.woff2$/.test(file) },
];

let out = '/* 자동 생성: node scripts/gen-fonts-css.mjs. 직접 고치지 않는다. 글꼴 출처·라이선스는 THIRD_PARTY_NOTICES.md */\n';
const counts = [];
for (const { pkg, weights, keep } of WANTED) {
  const dir = packageDir(pkg);
  let n = 0;
  for (const weight of weights) {
    const css = readFileSync(join(dir, `${weight}.css`), 'utf8');
    for (const block of css.match(/@font-face\s*\{[^}]*\}/g) ?? []) {
      if (!/font-style:\s*normal/.test(block)) continue;
      const woff2 = /url\(\.\/files\/([^)]+\.woff2)\)\s*format\('woff2'\)/.exec(block)?.[1];
      if (!woff2 || !keep(woff2)) continue;
      const family = /font-family:\s*('[^']+')/.exec(block)?.[1];
      const range = /unicode-range:\s*([^;]+);/.exec(block)?.[1];
      out += `@font-face {\n  font-family: ${family};\n  font-style: normal;\n  font-display: block;\n  font-weight: ${weight};\n  src: url(${pkg}/files/${woff2}) format('woff2');\n${range ? `  unicode-range: ${range};\n` : ''}}\n`;
      n += 1;
    }
  }
  counts.push(`${pkg}: ${n}`);
}
writeFileSync(join(import.meta.dirname, '../src/renderer/src/fonts.css'), out);
console.log(counts.join('\n'));
