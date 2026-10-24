// 실제 앱 성능 측정 (M1-PLAN 5절): 300화 목록, 2만 자 화 열기, 입력 지연.
// 사용: pnpm perf   (빌드 후 앱을 띄운다. 측정 중 다른 무거운 작업은 멈출 것)
// 측정 방법은 M0-B와 같다: keydown 시각 → 다음 프레임이 그려진 직후. 5회 반복 중앙값.

import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { closeWindow, launch, stubFolderDialog, tempDir } from '../tests/e2e/launch.ts';

const RUNS = 5;
const KEYS = 40;
const M0A = join(__dirname, '../spikes/m0a-ai-feasibility/benchmark/chapters');

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!;
const fmt = (x: number) => `${x.toFixed(x < 10 ? 1 : 0)}ms`;

async function makeProject(): Promise<string> {
  const root = await tempDir('perf');
  await mkdir(join(root, 'chapters'));
  const sources = (await readdir(M0A)).filter((f) => f.endsWith('.md')).sort();
  for (let i = 1; i <= 300; i++) {
    await copyFile(join(M0A, sources[(i - 1) % sources.length]!), join(root, 'chapters', `${String(i).padStart(3, '0')}.md`));
  }
  // 1번 화는 2만 자 (M0-A 본문을 이어 붙임)
  const paragraphs = (await Promise.all(sources.map((f) => readFile(join(M0A, f), 'utf8'))))
    .flatMap((t) => t.split('\n\n'))
    .map((p) => p.trim())
    .filter((p) => p && !p.startsWith('#'));
  let body = '# 1화. 긴 화\n';
  for (let i = 0; body.length < 20_000; i++) body += `\n${paragraphs[i % paragraphs.length]}\n`;
  await writeFile(join(root, 'chapters', '001.md'), body);
  return root;
}

async function main() {
  const project = await makeProject();
  const list: number[] = [];
  const open: number[] = [];
  const typing: number[] = [];

  for (let run = 0; run < RUNS; run++) {
    const { app, page } = await launch(await tempDir('perf-ud'));
    await stubFolderDialog(app, project);
    const buttons = page.getByRole('navigation', { name: '화 목록' }).getByRole('button');

    // 300화 목록: 폴더 열기 클릭 → 목록 300개 표시
    let t = Date.now();
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await buttons.nth(299).waitFor();
    list.push(Date.now() - t);

    // 2만 자 화 열기: 다른 화에서 1화로 옮겨 마지막 문단이 그려질 때까지
    await buttons.nth(1).click();
    await page.locator('.ProseMirror').waitFor();
    t = Date.now();
    await buttons.nth(0).click();
    await page.locator('.ProseMirror p').last().filter({ hasText: /\S/ }).waitFor();
    await page.locator('.ProseMirror').getByText('1화. 긴 화').waitFor();
    open.push(Date.now() - t);

    // 입력 지연: 문서 중간에서 40키
    await page.evaluate(() => {
      const w = window as unknown as { __lat: number[] };
      w.__lat = [];
      document.addEventListener(
        'keydown',
        (e) => {
          const start = e.timeStamp;
          requestAnimationFrame(() => {
            const ch = new MessageChannel();
            ch.port1.onmessage = () => w.__lat.push(performance.now() - start);
            ch.port2.postMessage(0);
          });
        },
        true,
      );
    });
    const paragraphsInDoc = page.locator('.ProseMirror p');
    await paragraphsInDoc.nth(Math.floor((await paragraphsInDoc.count()) / 2)).click();
    for (let i = 0; i < KEYS; i++) {
      await page.keyboard.press(i % 10 === 9 ? 'Backspace' : String.fromCharCode(97 + (i % 26)));
      await page.waitForTimeout(60);
    }
    await page.waitForTimeout(300);
    typing.push(p95(await page.evaluate(() => (window as unknown as { __lat: number[] }).__lat)));
    await closeWindow(app);
  }

  const range = (xs: number[]) => `${fmt(Math.min(...xs))}–${fmt(Math.max(...xs))}`;
  console.log(`| 항목 | 중앙값 (${RUNS}회) | 범위 | 기준 |`);
  console.log('|---|---|---|---|');
  console.log(`| 300화 목록 표시 | ${fmt(median(list))} | ${range(list)} | < 1초 |`);
  console.log(`| 2만 자 화 열기 | ${fmt(median(open))} | ${range(open)} | < 1초 |`);
  console.log(`| 입력 지연 p95 (2만 자, 문서 중간) | ${fmt(median(typing))} | ${range(typing)} | < 50ms |`);
  console.log('\n목록·열기는 테스트 프로세스에서 잰 시간이라 Playwright 왕복 시간이 포함된 상한이다.');
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
