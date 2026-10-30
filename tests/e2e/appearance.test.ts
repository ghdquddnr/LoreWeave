// 외관(테마·원고 글꼴) 설정 (P1): 환경설정 화면의 네 테마·OS 자동 전환·수동 유지·원고 글꼴/크기/줄 간격, 손상·예전 설정, 재실행 영속,
// 빠른 연속 저장과 저장 실패 뒤 복구, 첫 프레임 일치, 인터넷 차단 상태의 로컬 글꼴, 그리고 편집기(문서·선택·undo·미저장 입력·원고 바이트)가 바뀌지 않는 것.
// 실제 앱(Electron + Playwright). 합성 원고와 별도 userData만 쓰고, 실제 API는 쓰지 않는다.
// OS 낮·밤은 main의 nativeTheme.themeSource로 흉내 낸다 (OS 자체를 바꾸지 않는다). 첫 프레임 관측은 hooks/main-show-probe.cjs (읽기 전용).

import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ElectronApplication, Page } from 'playwright';
import { THEMES, type AppearanceSettings, type ThemeId } from '../../src/core/appearance.ts';
import { closeWindow, launch, stubFolderDialog, tempDir } from './launch.ts';

const envelope = (id: string, title: string) => `\uFEFF---\r\nid: ${id}\r\ntitle: ${title}\r\n---\r\n`;
const ONE = `${envelope('one', 'ONE')}EVIDENCE_QUOTE\r\n`;
const TWO = `${envelope('two', 'TWO')}TARGET_BODY\r\n`;
const TWO_TYPED = `${envelope('two', 'TWO')}TARGET_BODY UNSAVED_INPUT\r\n`;
const PROBE_ENTRY = join(__dirname, 'hooks', 'main-show-probe-entry.cjs');
const BOOT_ENTRY = join(__dirname, 'hooks', 'main-boot-hold-entry.cjs');

const theme = (id: ThemeId) => THEMES.find((t) => t.id === id)!;
const rgb = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${n >> 16}, ${(n >> 8) & 255}, ${n & 255})`;
};
const editor = (page: Page) => page.locator('.ProseMirror');
const chapter = (page: Page, title: string) => page.getByRole('navigation', { name: '화 목록' }).getByRole('button', { name: title });
const settingsDialog = (page: Page) => page.getByRole('dialog', { name: '환경설정' });

async function project(): Promise<string> {
  const dir = await tempDir('appearance');
  await mkdir(join(dir, 'chapters'));
  await writeFile(join(dir, 'chapters', '001.md'), ONE);
  await writeFile(join(dir, 'chapters', '002.md'), TWO);
  return dir;
}

async function openProject(app: ElectronApplication, page: Page, dir: string): Promise<void> {
  await stubFolderDialog(app, dir);
  await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).click();
  await editor(page).waitFor();
  await chapter(page, 'TWO').click();
  await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
  await page.waitForFunction(() => document.activeElement?.classList.contains('ProseMirror') === true, null, { timeout: 10_000 });
}

const readFileSettings = async (userData: string) => JSON.parse(await readFile(join(userData, 'settings.json'), 'utf8')) as { lastProject?: string; aiModel?: string; aiSendConsent?: boolean; appearance?: AppearanceSettings };
const pollSettings = async (userData: string, ok: (s: Awaited<ReturnType<typeof readFileSettings>>) => boolean, what: string) => {
  const deadline = Date.now() + 5000;
  let last: unknown;
  while (Date.now() < deadline) {
    last = await readFileSettings(userData).catch((e: unknown) => String(e));
    if (typeof last === 'object' && ok(last as never)) return last as Awaited<ReturnType<typeof readFileSettings>>;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`${what}: ${JSON.stringify(last)}`);
};

interface Look {
  theme: string | undefined;
  scheme: string | undefined;
  msFont: string | undefined;
  inlineSize: string;
  inlineLineHeight: string;
  bodyBg: string;
  uiFont: string;
  msFamily: string;
  msSize: string;
  msLineHeight: string;
}
const look = (page: Page) =>
  page.evaluate((): Look => {
    const root = document.documentElement;
    const pm = document.querySelector('.ProseMirror');
    const css = pm ? getComputedStyle(pm) : null;
    return {
      theme: root.dataset['theme'],
      scheme: root.dataset['scheme'],
      msFont: root.dataset['msFont'],
      inlineSize: root.style.getPropertyValue('--lw-ms-size'),
      inlineLineHeight: root.style.getPropertyValue('--lw-ms-line-height'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
      uiFont: getComputedStyle(document.body).fontFamily,
      msFamily: css?.fontFamily ?? '',
      msSize: css?.fontSize ?? '',
      msLineHeight: css?.lineHeight ?? '',
    };
  });

const setOsDark = (app: ElectronApplication, source: 'dark' | 'light' | 'system') =>
  app.evaluate(({ nativeTheme }, s) => void (nativeTheme.themeSource = s), source);
const winBackground = (app: ElectronApplication) => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toUpperCase());
const waitTheme = (page: Page, id: ThemeId) => page.waitForFunction((t) => document.documentElement.dataset['theme'] === t, id, { timeout: 5000 });
const waitWindowBg = async (app: ElectronApplication, hex: string) => {
  const deadline = Date.now() + 5000;
  let last = '';
  while (Date.now() < deadline) {
    last = await winBackground(app);
    if (last === hex.toUpperCase()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.equal(last, hex.toUpperCase(), '창 배경색');
};

const editorSnapshot = (page: Page) =>
  page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror') as unknown as { editor: { state: { doc: { toJSON(): unknown }; selection: { from: number; to: number } }; can(): { undo(): boolean } }; __marker?: number };
    return { marker: pm.__marker ?? null, doc: JSON.stringify(pm.editor.state.doc.toJSON()), from: pm.editor.state.selection.from, to: pm.editor.state.selection.to, canUndo: pm.editor.can().undo() };
  });

test('네 테마를 환경설정에서 바꿔도 화면 색·원고 글꼴·창 배경이 테마대로 바뀌고, 편집기 문서·선택·undo·미저장 입력과 원고 바이트는 그대로다', { timeout: 120_000 }, async () => {
  const dir = await project();
  const userData = await tempDir('appearance-ud');
  const { app, page } = await launch(userData);
  try {
    await openProject(app, page, dir);
    const two = join(dir, 'chapters', '002.md');
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type(' UNSAVED_INPUT');
    await page.evaluate(() => void ((document.querySelector('.ProseMirror') as unknown as { __marker: number }).__marker = 7));
    const before = await editorSnapshot(page);
    assert.equal(before.canUndo, true);

    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = settingsDialog(page);
    const observed: Record<string, Look> = {};
    for (const t of THEMES) {
      await dialog.getByRole('radio', { name: new RegExp(`^${t.label}`) }).check();
      await waitTheme(page, t.id);
      const l = await look(page);
      observed[t.id] = l;
      assert.equal(l.scheme, t.scheme, `${t.id} 계열`);
      assert.equal(l.bodyBg, rgb(t.background), `${t.id} 본문 배경 = --lw-bg = 창 배경색`);
      await waitWindowBg(app, t.background);
      // 원고 글꼴·크기: 테마 기본 (고딕 17px · 명조 18px)
      const family = t.manuscriptFont === 'serif' ? 'Noto Serif KR' : 'IBM Plex Sans KR';
      assert.match(l.msFamily, new RegExp(`^"?${family}`), `${t.id} 원고 글꼴 ${l.msFamily}`);
      assert.equal(l.msSize, t.manuscriptFont === 'serif' ? '18px' : '17px', `${t.id} 원고 글자 크기`);
      assert.match(l.uiFont, /^"?IBM Plex Sans KR/);
      assert.ok(Math.abs(Number.parseFloat(l.msLineHeight) - 1.9 * (t.manuscriptFont === 'serif' ? 18 : 17)) < 0.01, `${t.id} 줄 간격 1.9: ${l.msLineHeight}`);
      const saved = await pollSettings(userData, (s) => s.appearance?.theme === t.id && s.appearance.followSystem === false, `${t.id} 저장`);
      assert.equal(saved.appearance?.theme, t.id);
    }
    // 서로 다른 네 화면이다 (배경색 네 가지)
    assert.equal(new Set(Object.values(observed).map((l) => l.bodyBg)).size, 4);

    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    // 에디터: 같은 DOM 노드, 같은 문서와 선택, undo 기록 유지
    const after = await editorSnapshot(page);
    assert.deepEqual(after, before, '테마 변경 전후 편집기 노드 표식·문서·선택·undo 가능 여부');
    // 실제 undo/redo가 입력 한 단계만 되돌린다 (history가 그대로다)
    await editor(page).getByText('TARGET_BODY UNSAVED_INPUT').click();
    await page.keyboard.press('End');
    await page.keyboard.press('Control+z');
    await editor(page).getByText('TARGET_BODY', { exact: true }).waitFor();
    await page.keyboard.press('Control+Shift+z');
    await editor(page).getByText('TARGET_BODY UNSAVED_INPUT', { exact: true }).waitFor();
    // 저장된 원고 바이트: BOM·CRLF·frontmatter를 지키고 입력만 더해졌다
    await page.keyboard.press('Control+s');
    await page.getByRole('status').getByText('저장됨', { exact: true }).waitFor({ timeout: 10_000 });
    assert.equal(await readFile(two, 'utf8'), TWO_TYPED);
    assert.equal(await readFile(join(dir, 'chapters', '001.md'), 'utf8'), ONE, '다른 화는 바뀌지 않는다');
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('OS 낮·밤: 자동 전환은 양방향으로 낮·밤 테마를 따르고(창 배경색 포함), 카드를 고르면 수동으로 고정돼 OS가 바뀌어도 유지되며, 닫힌 창은 이벤트로 오류를 내지 않는다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const userData = await tempDir('appearance-os');
  const { app, page } = await launch(userData);
  try {
    await setOsDark(app, 'light');
    await openProject(app, page, dir);
    // 기본 설정: 자동 전환 켜짐, 낮 미색 종이 / 밤 심야
    await waitTheme(page, 'paper');
    await waitWindowBg(app, theme('paper').background);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = settingsDialog(page);
    const follow = dialog.getByRole('checkbox', { name: /자동 전환/ });
    assert.equal(await follow.isChecked(), true);
    await setOsDark(app, 'dark');
    await waitTheme(page, 'midnight');
    await waitWindowBg(app, theme('midnight').background);
    assert.equal((await look(page)).bodyBg, rgb(theme('midnight').background));
    assert.equal(await dialog.getByRole('radio', { name: /^심야/ }).isChecked(), true, '카드는 지금 쓰이는 테마를 보여 준다');
    await setOsDark(app, 'light');
    await waitTheme(page, 'paper');

    // 낮·밤 테마를 바꾸면 현재 OS 상태에 바로 반영된다
    await dialog.getByLabel('낮에 쓸 테마').selectOption({ label: '한낮' });
    await waitTheme(page, 'daylight');
    await dialog.getByLabel('밤에 쓸 테마').selectOption({ label: '등잔불' });
    await setOsDark(app, 'dark');
    await waitTheme(page, 'lamplight');
    await waitWindowBg(app, theme('lamplight').background);
    await pollSettings(userData, (s) => s.appearance?.dayTheme === 'daylight' && s.appearance.nightTheme === 'lamplight' && s.appearance.followSystem === true, '낮밤 저장');

    // 카드를 고르면 수동 고정: 자동 전환이 꺼지고 OS가 바뀌어도 그대로 (양방향)
    await dialog.getByRole('radio', { name: /^미색 종이/ }).check();
    await waitTheme(page, 'paper');
    assert.equal(await follow.isChecked(), false);
    await setOsDark(app, 'light');
    await setOsDark(app, 'dark');
    await setOsDark(app, 'light');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await look(page)).theme, 'paper');
    await setOsDark(app, 'dark');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal((await look(page)).theme, 'paper');
    await waitWindowBg(app, theme('paper').background);
    const manual = await pollSettings(userData, (s) => s.appearance?.followSystem === false && s.appearance.theme === 'paper', '수동 저장');
    assert.equal(manual.appearance?.dayTheme, 'daylight');

    // 다시 자동 전환: 지금 OS(어두움)의 밤 테마
    await follow.check();
    await waitTheme(page, 'lamplight');

    // 닫힌 창: 두 번째 창을 열고 닫은 뒤 OS 낮·밤이 바뀌어도 main이 예외 없이 계속 동작한다
    const problem = await app.evaluate(async ({ BrowserWindow, nativeTheme }) => {
      const errors: string[] = [];
      const handler: { fn?: (e: Error) => void } = {};
      handler.fn = (e) => void errors.push(e.message);
      process.on('uncaughtException', handler.fn);
      const extra = new BrowserWindow({ show: false });
      await extra.loadURL('about:blank');
      extra.destroy();
      nativeTheme.themeSource = 'light';
      await new Promise((r) => setTimeout(r, 200));
      nativeTheme.themeSource = 'dark';
      await new Promise((r) => setTimeout(r, 200));
      process.off('uncaughtException', handler.fn);
      return errors;
    });
    assert.deepEqual(problem, []);
    await waitTheme(page, 'lamplight');
  } finally {
    await setOsDark(app, 'system').catch(() => {});
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('예전·손상 설정: 외관이 없거나 이상해도 앱이 뜨고 기본 외관을 쓰며, 기존 모델·동의·마지막 폴더는 보존되고 저장하면 올바른 파일로 돌아온다', { timeout: 120_000 }, async () => {
  const cases: [string, string][] = [
    ['외관 없는 예전 설정', JSON.stringify({ lastProject: 'D:/없는폴더', aiModel: 'gpt-6.1-sol', aiSendConsent: true })],
    ['손상된 외관 값', JSON.stringify({ lastProject: 'D:/없는폴더', aiModel: 'gpt-6.1-sol', aiSendConsent: true, appearance: { theme: 'neon', followSystem: 'yes', manuscriptSize: 99, lineHeight: 'x', manuscriptFont: 3 } })],
    ['깨진 JSON', '{ 깨짐'],
  ];
  for (const [name, text] of cases) {
    const userData = await tempDir('appearance-old');
    await writeFile(join(userData, 'settings.json'), text);
    const { app, page } = await launch(userData);
    try {
      await page.evaluate(() => document.fonts.ready);
      const osDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
      const expected: ThemeId = osDark ? 'midnight' : 'paper';
      await waitTheme(page, expected);
      const l = await look(page);
      assert.equal(l.msFont, undefined, name);
      assert.equal(l.inlineSize, '', name);
      assert.equal(l.bodyBg, rgb(theme(expected).background), name);
      const status = await page.evaluate(() => window.loreweave.ai.status());
      if (name !== '깨진 JSON') assert.equal(status.model, 'gpt-6.1-sol', `${name}: 모델 보존`);
      // 외관을 저장하면 다른 항목이 그대로 남은 올바른 파일이 된다
      const saved = await page.evaluate(() => window.loreweave.appearance.update({ followSystem: false, theme: 'lamplight', manuscriptSize: 21 }));
      assert.equal(saved.theme, 'lamplight');
      const file = await readFileSettings(userData);
      assert.deepEqual(file.appearance, { theme: 'lamplight', followSystem: false, dayTheme: 'paper', nightTheme: 'midnight', manuscriptFont: 'theme', manuscriptSize: 21, lineHeight: null }, name);
      if (name !== '깨진 JSON') {
        assert.equal(file.aiModel, 'gpt-6.1-sol', name);
        assert.equal(file.aiSendConsent, true, name);
        assert.equal(file.lastProject, 'D:/없는폴더', name);
      }
    } finally {
      await closeWindow(app);
    }
  }
});

test('재실행 영속과 첫 프레임: 저장한 테마·글꼴·크기·줄 간격이 다시 켠 앱의 첫 화면에 이미 적용돼 있다 (창이 보이는 순간의 DOM·배경색)', { timeout: 180_000 }, async () => {
  for (const t of THEMES) {
    const userData = await tempDir(`appearance-first-${t.id}`);
    const stored: AppearanceSettings = { theme: t.id, followSystem: false, dayTheme: 'paper', nightTheme: 'midnight', manuscriptFont: t.manuscriptFont === 'serif' ? 'sans' : 'serif', manuscriptSize: 21, lineHeight: 2.2 };
    await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: stored }));
    const { app, page } = await launch(userData, {}, PROBE_ENTRY);
    try {
      await page.waitForFunction(() => document.fonts.status === 'loaded');
      // 창이 보이는 순간의 관측이 모였다
      const deadline = Date.now() + 5000;
      let shows: { backgroundColor: string; dom: null | { theme: string; scheme: string; msFont: string | null; bodyBg: string; rendered: boolean; fonts: string } }[] = [];
      while (Date.now() < deadline) {
        shows = await app.evaluate(() => (globalThis as unknown as { __shows: typeof shows }).__shows);
        if (shows.length > 0 && shows[0]!.dom) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(shows.length >= 1 && shows[0]!.dom, `${t.id}: 창이 보였다`);
      const first = shows[0]!;
      assert.equal(first.backgroundColor.toUpperCase(), t.background.toUpperCase(), `${t.id}: 창 배경색`);
      assert.equal(first.dom!.theme, t.id, `${t.id}: 보이는 순간 테마가 이미 적용됨`);
      assert.equal(first.dom!.scheme, t.scheme);
      assert.equal(first.dom!.bodyBg, rgb(t.background), `${t.id}: 보이는 순간 본문 배경이 테마 배경`);
      assert.equal(first.dom!.msFont, stored.manuscriptFont);
      assert.equal(first.dom!.rendered, true, `${t.id}: 보이는 순간 React 화면이 이미 그려짐`);
      const l = await look(page);
      assert.equal(l.theme, t.id);
      assert.equal(l.msFont, stored.manuscriptFont);
      assert.equal(l.inlineSize, '21px');
      assert.equal(l.inlineLineHeight, '2.2');
    } finally {
      await closeWindow(app);
    }
  }
});

test('원고 글꼴·크기·줄 간격: 글꼴 고정은 family만 바꾸고 명시한 크기는 지키며, 범위 안의 슬라이더 값이 화면과 저장에 같이 반영되고 기본값 복원이 둘 다 되돌린다', { timeout: 120_000 }, async () => {
  const dir = await project();
  const userData = await tempDir('appearance-ms');
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'midnight', followSystem: false } }));
  const { app, page } = await launch(userData);
  try {
    await openProject(app, page, dir);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = settingsDialog(page);
    // midnight = 고딕 17px. 명조로 고정해도 크기는 테마 기본(17px)을 그대로 쓴다
    await dialog.getByRole('radio', { name: /^명조로 고정/ }).check();
    await pollSettings(userData, (s) => s.appearance?.manuscriptFont === 'serif', '명조 고정 저장');
    let l = await look(page);
    assert.match(l.msFamily, /^"?Noto Serif KR/);
    assert.equal(l.msSize, '17px');
    assert.equal(l.inlineSize, '');
    // 크기를 명시하면 글꼴을 바꿔도 지킨다
    const size = dialog.getByRole('slider', { name: '원고 글자 크기' });
    await size.focus();
    for (let i = 0; i < 5; i += 1) await page.keyboard.press('ArrowRight'); // 17 → 22
    await pollSettings(userData, (s) => s.appearance?.manuscriptSize === 22, '크기 22 저장');
    await dialog.getByRole('radio', { name: /^고딕으로 고정/ }).check();
    await pollSettings(userData, (s) => s.appearance?.manuscriptFont === 'sans', '고딕 고정 저장');
    l = await look(page);
    assert.match(l.msFamily, /^"?IBM Plex Sans KR/);
    assert.equal(l.msSize, '22px');
    // 범위 끝: 14~24, 1.4~2.4
    await size.focus(); // 라디오에서 방향키는 선택을 옮기므로 슬라이더로 되돌아온다
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('ArrowRight'); // 24에서 멈춘다
    await pollSettings(userData, (s) => s.appearance?.manuscriptSize === 24, '크기 24 저장');
    assert.equal((await look(page)).msSize, '24px');
    for (let i = 0; i < 20; i += 1) await page.keyboard.press('ArrowLeft'); // 14에서 멈춘다
    await pollSettings(userData, (s) => s.appearance?.manuscriptSize === 14, '크기 14 저장');
    assert.equal((await look(page)).msSize, '14px');
    const line = dialog.getByRole('slider', { name: '줄 간격' });
    await line.focus();
    for (let i = 0; i < 3; i += 1) await page.keyboard.press('ArrowRight'); // 1.9 → 2.2
    await pollSettings(userData, (s) => s.appearance?.lineHeight === 2.2, '줄 간격 2.2 저장');
    assert.equal((await look(page)).inlineLineHeight, '2.2');
    for (let i = 0; i < 30; i += 1) await page.keyboard.press('ArrowLeft'); // 1.4에서 멈춘다
    await pollSettings(userData, (s) => s.appearance?.lineHeight === 1.4, '줄 간격 1.4 저장');
    // 기본값 복원: 테마·자동 전환·글꼴·크기·줄 간격이 모두 기본으로
    await dialog.getByRole('button', { name: '기본값으로', exact: true }).click();
    const reset = await pollSettings(userData, (s) => s.appearance?.manuscriptSize === null && s.appearance.lineHeight === null && s.appearance.followSystem === true, '기본값 저장');
    assert.deepEqual(reset.appearance, { theme: 'midnight', followSystem: true, dayTheme: 'paper', nightTheme: 'midnight', manuscriptFont: 'theme', manuscriptSize: null, lineHeight: null });
    l = await look(page);
    assert.equal(l.msFont, undefined);
    assert.equal(l.inlineSize, '');
    assert.equal(l.inlineLineHeight, '');
    // 입력 도중 값이 바뀌어도 원고는 건드리지 않았다
    assert.equal(await readFile(join(dir, 'chapters', '002.md'), 'utf8'), TWO);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('빠른 연속 저장: 슬라이더·낮밤 테마·모델·동의 저장이 동시에 겹쳐도 서로를 되돌리지 않고, 잘못된 값은 거절되며 저장값을 바꾸지 않는다', { timeout: 90_000 }, async () => {
  const userData = await tempDir('appearance-concurrent');
  const { app, page } = await launch(userData);
  try {
    const result = await page.evaluate(async () => {
      const api = window.loreweave;
      const jobs: Promise<unknown>[] = [];
      for (let i = 14; i <= 24; i += 1) {
        jobs.push(api.appearance.update({ manuscriptSize: i }));
        jobs.push(api.appearance.update({ lineHeight: Math.round((1.4 + (i - 14) / 10) * 10) / 10 }));
        if (i === 15) jobs.push(api.ai.setModel('gpt-6.1-sol'));
        if (i === 17) jobs.push(api.appearance.update({ dayTheme: 'daylight', nightTheme: 'lamplight', followSystem: false, theme: 'paper' }));
        if (i === 19) jobs.push(api.ai.setConsent(true));
        if (i === 21) jobs.push(api.appearance.update({ manuscriptFont: 'serif' }));
      }
      const bad: string[] = [];
      for (const patch of [{ theme: 'neon' }, { manuscriptSize: 99 }, { lineHeight: 5 }, { color: 'red' }, { followSystem: 'no' }] as unknown[]) {
        jobs.push(api.appearance.update(patch as never).then(() => bad.push(`accepted ${JSON.stringify(patch)}`), () => undefined));
      }
      await Promise.all(jobs);
      return bad;
    });
    assert.deepEqual(result, [], '잘못된 값은 모두 거절됐다');
    const file = await readFileSettings(userData);
    assert.deepEqual(file.appearance, { theme: 'paper', followSystem: false, dayTheme: 'daylight', nightTheme: 'lamplight', manuscriptFont: 'serif', manuscriptSize: 24, lineHeight: 2.4 });
    assert.equal(file.aiModel, 'gpt-6.1-sol');
    assert.equal(file.aiSendConsent, true);
    // 화면도 마지막 저장값과 같다 (같은 창에서 다시 읽는다)
    assert.deepEqual((await page.evaluate(() => window.loreweave.appearance.bootstrap())).appearance, file.appearance);
  } finally {
    await closeWindow(app);
  }
});

test('저장 실패: 화면에는 바로 적용되고 알림이 보이며, 실패한 변경들은 다시 저장할 때 함께 저장되고, 복구 뒤 후속 변경도 정상 저장된다', { timeout: 90_000 }, async () => {
  const dir = await project();
  const userData = await tempDir('appearance-failure');
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'daylight', followSystem: false } }));
  const { app, page } = await launch(userData);
  try {
    await openProject(app, page, dir);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = settingsDialog(page);
    const size = dialog.getByRole('slider', { name: '원고 글자 크기' });
    const line = dialog.getByRole('slider', { name: '줄 간격' });
    await size.focus();
    await page.keyboard.press('ArrowRight'); // 18 (정상 저장)
    await pollSettings(userData, (s) => s.appearance?.manuscriptSize === 18, '정상 저장');

    // 설정 쓰기를 실제로 실패시킨다: 임시 파일 자리에 폴더
    await mkdir(join(userData, 'settings.json.tmp'));
    await page.keyboard.press('ArrowRight'); // 19
    await dialog.getByRole('radio', { name: /^명조로 고정/ }).check();
    await line.focus();
    await page.keyboard.press('ArrowRight'); // 2.0
    const alert = dialog.getByRole('alert');
    await alert.getByText('외관 설정을 저장하지 못했습니다').waitFor();
    // 기본 안내에는 IPC 문구·파일 시스템 코드·임시 경로가 없고, 기술 상세를 펼치면 원문이 보인다
    const shown = await alert.innerText();
    assert.doesNotMatch(shown, /Error invoking|EISDIR|settings\.json|AppData|[A-Z]:\\/, `기본 안내: ${shown}`);
    assert.match(shown, /이 컴퓨터의 설정 파일에는 아직 저장되지 않았습니다/);
    await alert.getByRole('button', { name: '기술 상세' }).click();
    await alert.locator('.tech-detail').getByText('EISDIR', { exact: false }).waitFor();
    await alert.getByRole('button', { name: '상세 닫기' }).click();
    const l = await look(page);
    assert.equal(l.inlineSize, '19px', '저장은 실패했지만 화면에는 적용돼 있다');
    assert.equal(l.msFont, 'serif');
    assert.equal(l.inlineLineHeight, '2');
    assert.equal((await readFileSettings(userData)).appearance?.manuscriptSize, 18, '디스크에는 마지막 성공값');
    // 입력은 막히지 않는다
    await dialog.getByRole('button', { name: '닫기', exact: true }).click();
    await editor(page).getByText('TARGET_BODY', { exact: true }).click();
    await page.keyboard.press('End');
    await page.keyboard.type('X');
    await editor(page).getByText('TARGET_BODYX', { exact: true }).waitFor();
    await page.getByRole('button', { name: '설정', exact: true }).click();

    // 복구: 폴더를 치우고 "다시 저장" — 실패한 변경 세 가지가 모두 저장된다
    await rm(join(userData, 'settings.json.tmp'), { recursive: true });
    await dialog.getByRole('button', { name: '다시 저장', exact: true }).click();
    await alert.waitFor({ state: 'detached' });
    const recovered = await pollSettings(userData, (s) => s.appearance?.manuscriptSize === 19 && s.appearance.manuscriptFont === 'serif' && s.appearance.lineHeight === 2, '복구 뒤 저장');
    assert.equal(recovered.appearance?.theme, 'daylight');
    // 후속 변경도 정상
    await size.focus();
    await page.keyboard.press('ArrowLeft'); // 18
    await pollSettings(userData, (s) => s.appearance?.manuscriptSize === 18, '후속 저장');
    assert.equal(await page.getByRole('alert').count(), 0);
  } finally {
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});

test('로컬 글꼴: 인터넷을 막은 상태에서 세 글꼴이 파일에서 읽히고 한글 글리프가 로컬 파일로 덮이며, 외부 요청은 한 번도 시도되지 않는다', { timeout: 90_000 }, async () => {
  const userData = await tempDir('appearance-fonts');
  const { app, page } = await launch(userData);
  try {
    // 모든 http(s) 요청을 막고 시도 횟수를 센다
    await app.evaluate(({ session }) => {
      const g = globalThis as unknown as { __blocked: string[] };
      g.__blocked = [];
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*'] }, (details, callback) => {
        g.__blocked.push(details.url);
        callback({ cancel: true });
      });
    });
    await page.reload();
    await page.waitForFunction(() => document.fonts.status === 'loaded');
    await page.evaluate(() => window.loreweave.appearance.update({ followSystem: false, theme: 'paper' })); // 명조 원고
    await waitTheme(page, 'paper');
    const sample = '가각힣뷁똠웱 달빛이 유리숲 위로 내려앉았다 ABC abc 0123';
    const report = await page.evaluate(async (text) => {
      await Promise.all([
        document.fonts.load('400 13px "IBM Plex Sans KR"', text),
        document.fonts.load('500 13px "IBM Plex Sans KR"', text),
        document.fonts.load('600 13px "IBM Plex Sans KR"', text),
        document.fonts.load('400 18px "Noto Serif KR"', text),
        document.fonts.load('700 28px "Noto Serif KR"', text),
        document.fonts.load('400 12px "JetBrains Mono"', 'abc 0123'),
        document.fonts.load('500 12px "JetBrains Mono"', 'abc 0123'),
      ]);
      const loaded = [...document.fonts].filter((f) => f.status === 'loaded');
      const families = [...new Set(loaded.map((f) => f.family.replace(/"/g, '')))].sort();
      // 샘플의 모든 글자가 해당 글꼴의 불러온 파일(unicode-range) 중 하나에 덮이는지: 덮이지 않으면 시스템 글꼴로 대체된다
      const uncovered: Record<string, string[]> = { sans: [], serif: [], mono: [] };
      const checks: [string, string, string][] = [['IBM Plex Sans KR', text, 'sans'], ['Noto Serif KR', text, 'serif'], ['JetBrains Mono', 'abc0123', 'mono']];
      for (const [family, chars, key] of checks) {
        for (const ch of chars) {
          if (ch === ' ') continue;
          const cp = ch.codePointAt(0)!;
          let covered = false;
          for (const face of loaded) {
            if (face.family.replace(/"/g, '') !== family) continue;
            for (const part of face.unicodeRange.split(',')) {
              const m = /U\+([0-9a-f]+)(?:-([0-9a-f]+))?/i.exec(part.trim());
              if (!m) continue;
              const lo = Number.parseInt(m[1]!, 16);
              const hi = m[2] ? Number.parseInt(m[2], 16) : lo;
              if (cp >= lo && cp <= hi) covered = true;
            }
          }
          if (!covered) uncovered[key]!.push(ch);
        }
      }
      // 적용된 @font-face 규칙의 원본: 번들 파일(상대 경로)뿐이고 원격 주소가 없다
      let faceRules = 0;
      const remoteFaces: string[] = [];
      for (const sheet of document.styleSheets) {
        for (const rule of sheet.cssRules) {
          if (rule.constructor.name !== 'CSSFontFaceRule') continue;
          faceRules += 1;
          if (/https?:/.test(rule.cssText)) remoteFaces.push(rule.cssText.slice(0, 80));
        }
      }
      return {
        families,
        uncoveredSans: uncovered['sans'],
        uncoveredSerif: uncovered['serif'],
        uncoveredMono: uncovered['mono'],
        faceRules,
        remoteFaces,
        weightsSans: [...new Set(loaded.filter((f) => f.family.includes('IBM Plex Sans KR')).map((f) => f.weight))].sort(),
        weightsSerif: [...new Set(loaded.filter((f) => f.family.includes('Noto Serif KR')).map((f) => f.weight))].sort(),
        weightsMono: [...new Set(loaded.filter((f) => f.family.includes('JetBrains Mono')).map((f) => f.weight))].sort(),
        bodyFamily: getComputedStyle(document.body).fontFamily,
      };
    }, sample);
    assert.deepEqual(report.families, ['IBM Plex Sans KR', 'JetBrains Mono', 'Noto Serif KR']);
    assert.deepEqual(report.uncoveredSans, [], 'Plex Sans KR가 한글·라틴 샘플을 모두 덮는다');
    assert.deepEqual(report.uncoveredSerif, [], 'Noto Serif KR가 한글·라틴 샘플을 모두 덮는다');
    assert.deepEqual(report.uncoveredMono, []);
    assert.deepEqual(report.weightsSans, ['400', '500', '600']);
    assert.deepEqual(report.weightsSerif, ['400', '700']);
    assert.deepEqual(report.weightsMono, ['400', '500']);
    assert.ok(report.faceRules > 400, `번들 @font-face 규칙이 적용돼 있다: ${report.faceRules}`);
    assert.deepEqual(report.remoteFaces, [], '원격 글꼴 주소가 없다');
    assert.deepEqual(await app.evaluate(() => (globalThis as unknown as { __blocked: string[] }).__blocked), [], '외부 요청 시도 0');
    assert.match(report.bodyFamily, /^"?IBM Plex Sans KR/);
  } finally {
    await closeWindow(app);
  }
});

test('시작 중 OS 낮·밤 변경(합성 지연 응답 경계): bootstrap 응답 전달이 늦는 동안 OS가 바뀌어도 양방향 모두 최신 OS 값이 첫 표시 DOM과 창 배경에 반영된다', { timeout: 90_000 }, async () => {
  const userData = await tempDir('appearance-boot-race');
  const { app, page } = await launch(userData, {}, BOOT_ENTRY);
  try {
    for (const round of [1, 2]) {
      await app.evaluate(async () => {
        const g = globalThis as unknown as { __boot: { held: boolean } };
        while (!g.__boot.held) await new Promise((r) => setTimeout(r, 25));
      });
      const snapshotDark = await app.evaluate(() => (globalThis as unknown as { __boot: { snapshotDark: boolean } }).__boot.snapshotDark);
      // 스냅샷을 만든 뒤 전달 전에 OS를 반대로 바꾼다 (알림은 응답보다 먼저 renderer에 닿는다)
      await setOsDark(app, snapshotDark ? 'light' : 'dark');
      await new Promise((r) => setTimeout(r, 200));
      const actualDark = await app.evaluate(({ nativeTheme }) => nativeTheme.shouldUseDarkColors);
      assert.equal(actualDark, !snapshotDark, `${round}회차: OS가 실제로 바뀌었다`);
      await app.evaluate(() => (globalThis as unknown as { __boot: { release(): void } }).__boot.release());
      await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
      const expected: ThemeId = actualDark ? 'midnight' : 'paper';
      await page.waitForTimeout(300);
      assert.equal((await look(page)).theme, expected, `${round}회차: 스냅샷(${snapshotDark ? '어두움' : '밝음'}) 이후 바뀐 OS(${actualDark ? '어두움' : '밝음'})가 DOM에 반영`);
      assert.equal((await look(page)).bodyBg, rgb(theme(expected).background));
      await waitWindowBg(app, theme(expected).background);
      // 다음 회차: 새 bootstrap을 다시 붙잡고 다시 불러온다
      await app.evaluate(() => void ((globalThis as unknown as { __boot: { hold: boolean } }).__boot.hold = true));
      if (round === 1) void page.reload();
    }
  } finally {
    await setOsDark(app, 'system').catch(() => {});
    await closeWindow(app);
  }
});

test('시작 중 OS 변경(합성 지연 응답 경계): 수동 테마는 그대로 유지된다', { timeout: 60_000 }, async () => {
  const userData = await tempDir('appearance-boot-manual');
  await writeFile(join(userData, 'settings.json'), JSON.stringify({ appearance: { theme: 'lamplight', followSystem: false } }));
  const { app, page } = await launch(userData, {}, BOOT_ENTRY);
  try {
    await app.evaluate(async () => {
      const g = globalThis as unknown as { __boot: { held: boolean } };
      while (!g.__boot.held) await new Promise((r) => setTimeout(r, 25));
    });
    const snapshotDark = await app.evaluate(() => (globalThis as unknown as { __boot: { snapshotDark: boolean } }).__boot.snapshotDark);
    await setOsDark(app, snapshotDark ? 'light' : 'dark');
    await new Promise((r) => setTimeout(r, 200));
    await app.evaluate(() => (globalThis as unknown as { __boot: { release(): void } }).__boot.release());
    await page.getByRole('button', { name: '원고 폴더 열기', exact: true }).waitFor();
    await page.waitForTimeout(300);
    assert.equal((await look(page)).theme, 'lamplight');
    await setOsDark(app, snapshotDark ? 'dark' : 'light');
    await page.waitForTimeout(300);
    assert.equal((await look(page)).theme, 'lamplight');
    await waitWindowBg(app, theme('lamplight').background);
    // 구독 정리: 앱이 끝날 때(will-quit) nativeTheme 구독이 하나 줄고 bootstrap 처리기도 거둬진다
    const counts = await app.evaluate(({ app: electronApp, nativeTheme, ipcMain }) => {
      const before = nativeTheme.listenerCount('updated');
      electronApp.emit('will-quit', {} as never);
      let handlerRemoved = false;
      try {
        (ipcMain as unknown as { _invokeHandlers: Map<string, unknown> })._invokeHandlers.has('appearance:bootstrap') || (handlerRemoved = true);
      } catch {
        handlerRemoved = false;
      }
      return { before, after: nativeTheme.listenerCount('updated'), handlerRemoved };
    });
    assert.equal(counts.after, counts.before - 1, 'nativeTheme updated 구독이 해제됐다');
    assert.equal(counts.handlerRemoved, true, 'bootstrap 처리기가 거둬졌다');
  } finally {
    await setOsDark(app, 'system').catch(() => {});
    await closeWindow(app);
  }
});

test('이미 선택된(지금 쓰이는) 카드를 눌러도 수동 고정이 된다: 라디오 클릭, 라벨·미리보기 클릭, 키보드(Space)', { timeout: 90_000 }, async () => {
  const dir = await project();
  const userData = await tempDir('appearance-card');
  const { app, page } = await launch(userData);
  try {
    await setOsDark(app, 'light');
    await openProject(app, page, dir);
    await waitTheme(page, 'paper');
    await page.getByRole('button', { name: '설정', exact: true }).click();
    const dialog = settingsDialog(page);
    const follow = dialog.getByRole('checkbox', { name: /자동 전환/ });
    const current = () => dialog.locator('input[name="theme"]:checked');
    const fixedAsPaper = async (how: string) => {
      assert.equal(await follow.isChecked(), false, `${how}: 자동 전환이 꺼졌다`);
      const saved = await pollSettings(userData, (s) => s.appearance?.followSystem === false && s.appearance.theme === 'paper', `${how}: 저장`);
      assert.equal(saved.appearance?.theme, 'paper');
      // OS가 어두워져도 그대로
      await setOsDark(app, 'dark');
      await new Promise((r) => setTimeout(r, 250));
      assert.equal((await look(page)).theme, 'paper', `${how}: 수동 유지`);
      await setOsDark(app, 'light');
      await follow.check(); // 다음 방식을 위해 자동 전환으로 되돌린다
      await waitTheme(page, 'paper');
    };
    assert.equal(await follow.isChecked(), true);
    assert.equal(await current().inputValue(), 'paper');
    await current().click();
    await fixedAsPaper('라디오 클릭');
    await dialog.locator('label.theme-card.on .theme-preview').click();
    await fixedAsPaper('미리보기 클릭');
    await dialog.locator('label.theme-card.on strong').click();
    await fixedAsPaper('이름(라벨) 클릭');
    await current().focus();
    await page.keyboard.press('Space');
    await fixedAsPaper('키보드 Space');
    // 다른 카드 선택은 그대로 동작
    await dialog.getByRole('radio', { name: /^등잔불/ }).check();
    await waitTheme(page, 'lamplight');
    assert.equal(await follow.isChecked(), false);
  } finally {
    await setOsDark(app, 'system').catch(() => {});
    page.on('dialog', (d) => void d.accept());
    await closeWindow(app);
  }
});
