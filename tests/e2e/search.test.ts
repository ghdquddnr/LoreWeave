// 원고 검색과 결과로 이동, 중복 id 해결 (M2-PLAN 5절)

import assert from 'node:assert/strict';
import { access, copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { before, test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const M0A = join(__dirname, '../../spikes/m0a-ai-feasibility/benchmark/chapters');
let project: string;
let userData: string;
const chapterFile = (f: string) => join(project, 'chapters', f);

before(async () => {
  project = await tempDir('search');
  userData = await tempDir('userdata');
  await mkdir(join(project, 'chapters'));
  for (const f of await readdir(M0A)) await copyFile(join(M0A, f), chapterFile(f.replace(/^ch/, '0')));
});

/** 테스트가 실패해도 앱을 닫는다 (안 닫으면 색인 파일이 잠겨 다음 테스트가 실패한다) */
async function withApp(work: (app: ElectronApplication, page: Page) => Promise<void>): Promise<void> {
  const { app, page } = await launch(userData);
  try {
    await work(app, page);
  } finally {
    await closeWindow(app).catch(() => app.close());
  }
}

async function search(page: Page, query: string): Promise<void> {
  const box = page.getByRole('searchbox', { name: '원고 검색' });
  await box.fill(query);
  await box.press('Enter');
  await page.locator('.search-summary').filter({ hasText: /찾음|없음|색인/ }).waitFor();
}

const results = (page: Page) => page.getByRole('list', { name: '검색 결과' }).getByRole('button');
const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');

test('검색 결과를 누르면 그 화가 열리고 찾은 글자가 선택된다 (결과 30개 모두)', async () => {
  await withApp(async (app, page) => {
    await stubFolderDialog(app, project);
    await page.getByRole('button', { name: '원고 폴더 열기' }).click();
    await page.locator('.ProseMirror').waitFor();
    await search(page, '지현');
    const count = Math.min(30, await results(page).count());
    assert.ok(count >= 30, `결과 ${count}개`);
    for (let i = 0; i < count; i++) {
      const item = results(page).nth(i);
      const where = await item.locator('.search-where').textContent();
      await item.click();
      await page.waitForFunction(() => window.getSelection()?.toString() === '지현', null, { timeout: 3000 }).catch(() => {});
      assert.equal(await selection(page), '지현', `${i}: ${where}`);
    }
  });
});

test('2글자 검색어, 없는 검색어, Esc로 목록 복귀', async () => {
  await withApp(async (_app, page) => {
    await search(page, '민수');
    assert.match((await page.locator('.search-summary').first().textContent()) ?? '', /\d+줄에서 찾음/);
    await search(page, '원고에 없는 말');
    await page.getByText('"원고에 없는 말" 없음').waitFor();
    await page.getByRole('searchbox', { name: '원고 검색' }).press('Escape');
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '1화. 입학' }).waitFor();
  });
});

test('방금 입력한 글자(저장 전)와 바깥에서 고친 글자도 찾는다', async () => {
  await withApp(async (_app, page) => {
    await page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: '2화. 설명회' }).click();
    await page.locator('.ProseMirror').getByText(/세미나실/).first().click();
    await page.keyboard.press('End');
    await page.keyboard.type(' 새로친낱말');
    // 자동 저장(1.5초)을 기다리지 않고 바로 검색한다
    await search(page, '새로친낱말');
    assert.equal(await results(page).count(), 1);
    await writeFile(chapterFile('005.md'), '# 5화\n\n바깥에서고친낱말\n');
    await page.waitForTimeout(1000);
    await search(page, '바깥에서고친낱말');
    assert.equal(await results(page).count(), 1);
  });
});

test('색인은 .loreweave/에만 생기고, 지워도 다시 만들어진다', async () => {
  await access(join(project, '.loreweave', 'index.db'));
  assert.equal(await readFile(join(project, '.loreweave', '.gitignore'), 'utf8'), 'index.db*\n');
  for (const suffix of ['', '-wal', '-shm']) await writeFile(join(project, '.loreweave', `index.db${suffix}`), '');
  await withApp(async (_app, page) => {
    await page.locator('.ProseMirror').waitFor();
    await search(page, '김정호').catch(async (e) => {
      throw new Error(`${(e as Error).message}
사이드바: ${(await page.locator('.sidebar').innerText()).slice(0, 300)}`);
    });
    assert.ok((await results(page).count()) > 0);
  });
});

test('같은 id를 쓰는 화: 새 id 발급 버튼을 누르면 경고가 사라지고 본문은 그대로다', async () => {
  const body = '본문은 바뀌면 안 된다\n';
  await writeFile(chapterFile('020.md'), `---\nid: same\ntitle: 스물\n---\n${body}`);
  await writeFile(chapterFile('021.md'), `---\nid: same\ntitle: 스물하나\n---\n${body}`);
  await withApp(async (_app, page) => {
    const alert = page.getByRole('alert').filter({ hasText: '같은 id를 쓰는 화' });
    await alert.waitFor();
    await alert.getByRole('button', { name: '새 id 발급' }).click();
    await alert.waitFor({ state: 'detached' });
  });
  const text = await readFile(chapterFile('021.md'), 'utf8');
  assert.match(text, /^---\nid: [0-9a-f-]{36}\ntitle: 스물하나\n---\n본문은 바뀌면 안 된다\n$/);
  assert.equal(await readFile(chapterFile('020.md'), 'utf8'), `---\nid: same\ntitle: 스물\n---\n${body}`);
});
