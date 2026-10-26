// 프로젝트를 바꿔도 같은 이름의 화(001.md)가 이전 프로젝트 본문으로 남지 않는다. 실제 앱(Electron + Playwright)에서 확인한다.
// 실제 API는 쓰지 않는다. 원고는 모두 임시 폴더의 합성 원고다.

import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(dir: string, title: string, body: string): Promise<string> {
  await mkdir(join(dir, 'chapters'), { recursive: true });
  await writeFile(join(dir, 'chapters', '001.md'), `# ${title}\n\n${body}\n`);
  return dir;
}

const editor = (page: Page) => page.locator('.ProseMirror');
const saved = (page: Page) => page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 5000 });
const read = (dir: string) => readFile(join(dir, 'chapters', '001.md'), 'utf8');

async function openFirst(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
}
async function switchTo(app: ElectronApplication, page: Page, dir: string) {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '열기', exact: true }).click();
}

test('A → B (둘 다 001.md): B 본문이 바로 보이고, B에서 고쳐 저장하면 B만 바뀌며, A로 돌아가면 A 본문이 보인다', { timeout: 60_000 }, async () => {
  const A = await project(await tempDir('switch-A'), 'Project A', 'Alpha manuscript');
  const B = await project(await tempDir('switch-B'), 'Project B', 'Beta manuscript');
  const aBefore = await read(A);
  const { app, page } = await launch(await tempDir('switch-userdata'));
  try {
    await openFirst(app, page, A);
    await editor(page).getByText('Alpha manuscript').waitFor();
    await switchTo(app, page, B);
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'Project B' }).waitFor();
    await editor(page).getByText('Beta manuscript').waitFor({ timeout: 5000 });
    assert.ok(!(await editor(page).innerText()).includes('Alpha'), 'B를 열었는데 A 본문이 남아 있다');
    // B에서 입력하고 저장한다
    await editor(page).getByText('Beta manuscript').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' edited in B');
    await page.keyboard.press('Control+S');
    await saved(page);
    assert.equal(await read(B), '# Project B\n\nBeta manuscript edited in B\n');
    assert.equal(await read(A), aBefore);
    // A로 돌아간다
    await switchTo(app, page, A);
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'Project A' }).waitFor();
    await editor(page).getByText('Alpha manuscript').waitFor({ timeout: 5000 });
    assert.ok(!(await editor(page).innerText()).includes('Beta'));
  } finally {
    await closeWindow(app);
  }
  assert.equal(await read(A), aBefore);
  assert.equal(await read(B), '# Project B\n\nBeta manuscript edited in B\n');
});

test('표시 이름이 같은 서로 다른 폴더, 같은 폴더 다시 열기: 언제나 지금 연 폴더의 본문을 읽는다', { timeout: 60_000 }, async () => {
  const one = await project(join(await tempDir('same-1'), 'Same'), 'Same One', 'first folder text');
  const two = await project(join(await tempDir('same-2'), 'Same'), 'Same Two', 'second folder text');
  const { app, page } = await launch(await tempDir('same-userdata'));
  try {
    await openFirst(app, page, one);
    await editor(page).getByText('first folder text').waitFor();
    await switchTo(app, page, two);
    await editor(page).getByText('second folder text').waitFor({ timeout: 5000 });
    // 같은 폴더를 다시 연다: 바깥에서 바꾼 내용도 새로 읽는다 (에디터는 변경이 없으므로 그대로 다시 연다)
    await writeFile(join(two, 'chapters', '001.md'), '# Same Two\n\nsecond folder text v2\n');
    await editor(page).getByText('second folder text v2').waitFor({ timeout: 5000 });
    await switchTo(app, page, two);
    await editor(page).getByText('second folder text v2').waitFor({ timeout: 5000 });
  } finally {
    await closeWindow(app);
  }
  assert.equal(await read(one), '# Same One\n\nfirst folder text\n');
  assert.equal(await read(two), '# Same Two\n\nsecond folder text v2\n');
});

test('미저장 변경: 전환할 때 저장되고(A에), 저장할 수 없으면 묻고, 취소하면 A에 머물며, 계속하면 A 파일은 바꾸지 않는다', { timeout: 60_000 }, async () => {
  const A = await project(await tempDir('pending-A'), 'Project A', 'Alpha manuscript');
  const B = await project(await tempDir('pending-B'), 'Project B', 'Beta manuscript');
  const { app, page } = await launch(await tempDir('pending-userdata'));
  try {
    await openFirst(app, page, A);
    await editor(page).getByText('Alpha manuscript').click();
    // 1) 저장되지 않은 입력이 있어도 전환하면 먼저 A에 저장한다
    await page.keyboard.press('End');
    await page.keyboard.type(' kept');
    await switchTo(app, page, B);
    await editor(page).getByText('Beta manuscript').waitFor({ timeout: 5000 });
    assert.equal(await read(A), '# Project A\n\nAlpha manuscript kept\n');
    assert.equal(await read(B), '# Project B\n\nBeta manuscript\n');

    // 2) 저장할 수 없는 변경(바깥에서 바뀌어 충돌)이 있으면 묻는다
    await switchTo(app, page, A);
    await editor(page).getByText('Alpha manuscript kept').click();
    await page.keyboard.press('End');
    await page.keyboard.type(' unsaved');
    await writeFile(join(A, 'chapters', '001.md'), '# Project A\n\noutside edit\n');
    await page.getByRole('alert').getByText(/다른 프로그램에서 바뀌었습니다/).waitFor({ timeout: 5000 });
    //    취소: A에 머문다
    page.once('dialog', (d) => void d.dismiss());
    await switchTo(app, page, B);
    await page.waitForTimeout(500);
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: 'Project A' }).waitFor();
    assert.ok((await editor(page).innerText()).includes('unsaved'));
    //    계속: B로 가고, A 파일은 바깥 편집 그대로다 (A 에디터 내용을 어디에도 쓰지 않는다)
    page.once('dialog', (d) => void d.accept());
    await switchTo(app, page, B);
    await editor(page).getByText('Beta manuscript').waitFor({ timeout: 5000 });
    assert.equal(await read(A), '# Project A\n\noutside edit\n');
    assert.equal(await read(B), '# Project B\n\nBeta manuscript\n');
  } finally {
    await closeWindow(app);
  }
  assert.equal(await read(A), '# Project A\n\noutside edit\n');
  assert.equal(await read(B), '# Project B\n\nBeta manuscript\n');
});
