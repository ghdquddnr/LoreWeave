// 원고 폴더를 열고, 화를 고치고, 자동 저장되는지 실제 앱에서 확인한다 (M1-PLAN 5절).

import assert from 'node:assert/strict';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import type { Page } from 'playwright';
import { closeWindow, killApp, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
let project: string;
let userData: string;
let originals: Map<string, Buffer>;

before(async () => {
  project = await tempDir('project');
  userData = await tempDir('userdata');
  await mkdir(join(project, 'chapters'));
  for (const n of ['01', '02', '03']) await copyFile(join(M0A, `ch${n}.md`), join(project, 'chapters', `0${n}.md`));
  // BOM + CRLF + frontmatter 원고 (윈도우 편집기에서 쓴 파일)
  await writeFile(join(project, 'chapters', '004.md'), '\uFEFF---\r\nid: x\r\ntitle: 넷째\r\n---\r\n첫 줄.\r\n\r\n둘째 줄.\r\n');
  originals = new Map();
  for (const f of await readdir(join(project, 'chapters'))) originals.set(f, await readFile(join(project, 'chapters', f)));
});

const chapterFile = (f: string) => join(project, 'chapters', f);
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });

test('폴더를 열고 모든 화를 열어 본 뒤 닫아도 파일 바이트가 그대로다', async () => {
  const { app, page } = await launch(userData);
  await stubFolderDialog(app, project);
  await page.getByRole('button', { name: '원고 폴더 열기' }).click();
  const list = page.getByRole('navigation', { name: '화 목록' });
  await list.getByRole('button', { name: '1화. 입학' }).waitFor();
  assert.deepEqual(await list.getByRole('button').allTextContents(), ['1화. 입학', '2화. 설명회', '3화. MT', '넷째']);
  for (const name of ['2화. 설명회', '3화. MT', '넷째', '1화. 입학']) {
    await list.getByRole('button', { name }).click();
    await page.locator('.ProseMirror').waitFor();
  }
  await closeWindow(app);
  for (const [f, bytes] of originals) assert.deepEqual(await readFile(chapterFile(f)), bytes, f);
});

test('다시 실행하면 마지막 폴더가 열리고, 입력하면 3초 안에 그 줄만 바뀌어 저장된다', async () => {
  const { app, page } = await launch(userData);
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '넷째' }).click();
  const editor = page.locator('.ProseMirror');
  await editor.getByText('둘째 줄.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 추가');
  const started = Date.now();
  await saved(page);
  assert.ok(Date.now() - started < 3000, `저장까지 ${Date.now() - started}ms`);
  assert.equal(
    await readFile(chapterFile('004.md'), 'utf8'),
    '\uFEFF---\r\nid: x\r\ntitle: 넷째\r\n---\r\n첫 줄.\r\n\r\n둘째 줄. 추가\r\n',
  );
  await closeWindow(app);
});

test('새 화를 만들고 입력하면 저장된다. 붙여넣기는 글자만 줄마다 문단으로', async () => {
  const { app, page } = await launch(userData);
  await page.getByRole('button', { name: '+ 새 화' }).click();
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '5화' }).waitFor();
  const editor = page.locator('.ProseMirror');
  await editor.click();
  await page.keyboard.type('새 화 첫 줄');
  await page.keyboard.press('Shift+Enter');
  await page.keyboard.type('둘째 줄');
  await page.evaluate(() => {
    const data = new DataTransfer();
    data.setData('text/plain', '\r\n붙여넣은 <b>글</b>\r\n\r\n끝');
    data.setData('text/html', '<p>붙여넣은 <b>글</b></p>');
    document.querySelector('.ProseMirror')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  });
  await saved(page);
  const text = await readFile(chapterFile('005.md'), 'utf8');
  assert.match(text, /^---\nid: [0-9a-f-]{36}\ntitle: 5화\n---\n새 화 첫 줄\n둘째 줄\n붙여넣은 <b>글<\/b>\n\n끝\n$/);
  await closeWindow(app);
});

test('입력한 * 가 다시 열 때 기울임이 되면 저장하고 경고한다', async () => {
  const { app, page } = await launch(userData);
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '넷째' }).click();
  await page.locator('.ProseMirror').getByText('첫 줄.').click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 5*5=25, 2*3');
  await saved(page);
  await page.getByRole('status').getByText(/1번째 줄 근처는 다시 열면 다르게 보입니다/).waitFor();
  assert.match(await readFile(chapterFile('004.md'), 'utf8'), /첫 줄\. 5\*5=25, 2\*3\r\n/);
  await closeWindow(app);
});

test('저장 안 된 변경이 있을 때 다른 프로그램이 화를 바꾸면 덮어쓰지 않고 묻는다', async () => {
  const { app, page } = await launch(userData);
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '넷째' }).click();
  await page.locator('.ProseMirror').getByText(/둘째 줄/).click();
  await page.keyboard.press('End');
  await page.keyboard.type('!');
  // 자동 저장(1.5초) 전에 바깥에서 바꾼다
  await writeFile(chapterFile('004.md'), '다른 편집기에서 고침\n');
  await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 5000 });
  await page.waitForTimeout(2000);
  assert.equal(await readFile(chapterFile('004.md'), 'utf8'), '다른 편집기에서 고침\n');
  await page.getByRole('button', { name: '내 것으로 덮어쓰기' }).click();
  await saved(page);
  assert.match(await readFile(chapterFile('004.md'), 'utf8'), /둘째 줄\. 추가!\r\n$/);
  await closeWindow(app);
});

test('저장 안 된 변경이 없을 때 다른 프로그램이 화를 바꾸면 다시 불러온다', async () => {
  const outside = '---\nid: x\ntitle: 넷째\n---\n바깥에서 새로 쓴 줄\n';
  const { app, page } = await launch(userData);
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '넷째' }).click();
  await page.locator('.ProseMirror').getByText(/둘째 줄/).waitFor();
  await writeFile(chapterFile('004.md'), outside);
  await page.locator('.ProseMirror').getByText('바깥에서 새로 쓴 줄').waitFor({ timeout: 5000 });
  await page.getByRole('status').getByText('다른 프로그램에서 바뀌어 다시 불러왔습니다').waitFor();
  await closeWindow(app);
  assert.equal(await readFile(chapterFile('004.md'), 'utf8'), outside);
});

test('입력 중 앱이 강제로 꺼져도 잃는 것은 마지막 자동 저장 이후 분량뿐이다', async () => {
  const { app, page } = await launch(userData);
  await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '1화. 입학' }).click();
  await page.locator('.ProseMirror').getByText(/북적였다/).click();
  await page.keyboard.press('End');
  await page.keyboard.type(' 앞부분');
  await saved(page);
  await page.keyboard.type(' 뒷부분');
  await killApp(app);
  // 살아남은 프로세스가 자동 저장(1.5초)을 하지 않는지 확인할 만큼 기다린다
  await new Promise((r) => setTimeout(r, 2500));
  const text = await readFile(chapterFile('001.md'), 'utf8');
  // 원자적 쓰기라 파일이 반쯤 쓰인 채로 남지 않는다: 마지막 자동 저장 그대로다
  assert.equal(text, originals.get('001.md')!.toString('utf8').replace('북적였다.', '북적였다. 앞부분'));
  assert.deepEqual((await readdir(join(project, 'chapters'))).filter((f) => f.endsWith('.tmp')), []);
});
