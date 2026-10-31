// 사실 패널의 "본문에서 이 인용을 찾을 수 없습니다" 안내는 그 화·그 분석에 묶인다: A에서 없는 인용을 눌러 안내를 본 뒤 B(분석 있음/없음)로 옮기면 안내가 B에 남지 않는다.
// 같은 화의 정상/없는 인용 클릭(이동·선택 접기·안내)은 그대로다. 합성 원고와 합성 저장 분석(AiStore)·격리 userData. OpenAI·실제 AI DB 접근 0.

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { Page } from 'playwright';
import { AiStore } from '../../src/main/ai-db.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

async function project(): Promise<string> {
  const dir = await tempDir('facts-missing');
  await mkdir(join(dir, 'chapters'));
  const db = AiStore.open(dir);
  const createdAt = new Date().toISOString();
  const meta = { contentHash: 'synthetic', model: 'fake', modelVersion: 'fake', promptVersion: 'fake', costUsd: 0, createdAt };
  for (const [file, name] of [
    ['001.md', 'ONE'],
    ['002.md', 'TWO'],
    ['003.md', 'THREE'],
  ] as const) await writeFile(join(dir, 'chapters', file), `# ${name}\n\n${name}_BODY\n`);
  const fact = (quote: string, value: string) => ({ entity: '인물', predicate: '나이', value, quote, line: 3, start: 0, end: quote.length });
  // 001: 본문에 있는 인용과 없는 인용 / 002: 정상 분석 / 003: 분석 없음
  db.saveAnalysis({ file: '001.md', ...meta, summary: '요약', droppedQuotes: 0, entities: [], facts: [fact('ONE_BODY', 'ONE_FACT_OK'), fact('NOT_IN_THE_BODY', 'ONE_FACT_ABSENT')] });
  db.saveAnalysis({ file: '002.md', ...meta, summary: '요약', droppedQuotes: 0, entities: [], facts: [fact('TWO_BODY', 'TWO_FACT')] });
  db.close();
  return dir;
}

const editor = (page: Page) => page.locator('.ProseMirror');
const facts = (page: Page) => page.getByRole('complementary', { name: 'AI가 찾은 사실' });
const missingNote = (page: Page) => facts(page).getByText(/지금 본문에서 이 인용을 찾을 수 없습니다/);
const list = (page: Page) => page.getByRole('navigation', { name: '화 목록' });
const selection = (page: Page) => page.evaluate(() => window.getSelection()?.toString() ?? '');
const settled = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

test('없는 인용 안내는 그 화에 묶여 다른 화(분석 있음·없음)로 옮기면 사라지고, 같은 화의 정상/없는 인용 클릭은 그대로 동작한다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const { app, page } = await launch(await tempDir('facts-missing-ud'));
  try {
    await stubFolderDialog(app, dir);
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
    await editor(page).getByText('ONE_BODY', { exact: true }).waitFor();
    await facts(page).getByText('ONE_FACT_ABSENT').waitFor();
    // 같은 화: 정상 인용은 이동·선택하고 안내가 없다, 없는 인용은 안내와 선택 접기
    await facts(page).getByRole('button', { name: /“ONE_BODY”/ }).click();
    await page.waitForFunction(() => window.getSelection()?.toString() === 'ONE_BODY', undefined, { timeout: 10_000 });
    assert.equal(await missingNote(page).count(), 0);
    await facts(page).getByRole('button', { name: /“NOT_IN_THE_BODY”/ }).click();
    await missingNote(page).waitFor();
    assert.equal(await selection(page), '', '없는 인용은 선택을 접는다');
    await facts(page).getByRole('button', { name: /“ONE_BODY”/ }).click();
    await missingNote(page).waitFor({ state: 'detached' });
    await facts(page).getByRole('button', { name: /“NOT_IN_THE_BODY”/ }).click();
    await missingNote(page).waitFor();

    // 분석이 있는 다른 화(002)로: 안내가 남지 않는다 (002의 사실이 표시된 뒤에 확인)
    await list(page).getByRole('button', { name: 'TWO' }).click();
    await editor(page).getByText('TWO_BODY', { exact: true }).waitFor();
    await facts(page).getByText('TWO_FACT').waitFor();
    await settled(page);
    assert.equal(await missingNote(page).count(), 0, '이전 화의 인용 없음 안내가 002의 사실 위에 남지 않는다');

    // 분석이 없는 화(003)로 갔다가 돌아와도(001) 이전 안내가 되살아나지 않는다
    await list(page).getByRole('button', { name: 'THREE' }).click();
    await editor(page).getByText('THREE_BODY', { exact: true }).waitFor();
    await facts(page).getByText(/아직 분석하지 않은 화입니다/).waitFor();
    assert.equal(await missingNote(page).count(), 0);
    await list(page).getByRole('button', { name: 'ONE' }).click();
    await editor(page).getByText('ONE_BODY', { exact: true }).waitFor();
    await facts(page).getByText('ONE_FACT_ABSENT').waitFor();
    await settled(page);
    assert.equal(await missingNote(page).count(), 0, '다시 돌아와도 이전 안내가 되살아나지 않는다');
  } finally {
    await closeWindow(app);
  }
});
