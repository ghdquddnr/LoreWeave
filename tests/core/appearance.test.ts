// 외관(테마·원고 글꼴) 설정: 검증·해석, settings.json 저장(기존 값 보존·손상 복구·동시 쓰기 직렬화·실패 뒤 복구), 테마 CSS와 창 배경색의 일치, 외부 자원 없음.

import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  DEFAULT_APPEARANCE,
  parseAppearancePatch,
  resolveTheme,
  sanitizeAppearance,
  THEMES,
  themeMeta,
} from '../../src/core/appearance.ts';
import { readSettings, settingsPath, updateSettings } from '../../src/main/settings.ts';

const dir = () => mkdtemp(join(tmpdir(), 'loreweave-appearance-'));
const src = (...p: string[]) => join(__dirname, '../../src', ...p);

test('기본값: 자동 전환 켜짐, 낮 미색 종이 / 밤 심야, 수동 기본 심야, 글자 크기·줄 간격은 테마 기본(null)', () => {
  assert.deepEqual(DEFAULT_APPEARANCE, {
    theme: 'midnight',
    followSystem: true,
    dayTheme: 'paper',
    nightTheme: 'midnight',
    manuscriptFont: 'theme',
    manuscriptSize: null,
    lineHeight: null,
  });
  // 밝은 OS의 첫 실행은 미색 종이, 어두운 OS는 심야 (감독 확정 해석)
  assert.equal(resolveTheme(DEFAULT_APPEARANCE, false), 'paper');
  assert.equal(resolveTheme(DEFAULT_APPEARANCE, true), 'midnight');
});

test('resolveTheme: 자동 전환이 꺼져 있으면 OS 낮·밤과 무관하게 수동 테마를 쓴다', () => {
  const manual = { ...DEFAULT_APPEARANCE, followSystem: false, theme: 'lamplight' as const };
  assert.equal(resolveTheme(manual, true), 'lamplight');
  assert.equal(resolveTheme(manual, false), 'lamplight');
  const follow = { ...DEFAULT_APPEARANCE, dayTheme: 'daylight' as const, nightTheme: 'lamplight' as const };
  assert.equal(resolveTheme(follow, false), 'daylight');
  assert.equal(resolveTheme(follow, true), 'lamplight');
});

test('sanitizeAppearance: 이상한 값은 항목별로 기본값이 되고 나머지는 남는다', () => {
  assert.deepEqual(sanitizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(sanitizeAppearance('x'), DEFAULT_APPEARANCE);
  assert.deepEqual(sanitizeAppearance([1]), DEFAULT_APPEARANCE);
  const mixed = sanitizeAppearance({ theme: 'neon', followSystem: 'yes', dayTheme: 'daylight', nightTheme: 3, manuscriptFont: 'comic', manuscriptSize: 99, lineHeight: 'x' });
  assert.deepEqual(mixed, { ...DEFAULT_APPEARANCE, dayTheme: 'daylight' });
  const good = sanitizeAppearance({ theme: 'paper', followSystem: false, dayTheme: 'paper', nightTheme: 'lamplight', manuscriptFont: 'serif', manuscriptSize: 14, lineHeight: 2.4 });
  assert.deepEqual(good, { theme: 'paper', followSystem: false, dayTheme: 'paper', nightTheme: 'lamplight', manuscriptFont: 'serif', manuscriptSize: 14, lineHeight: 2.4 });
  // 범위 밖·NaN·무한대는 null (테마 기본)
  for (const bad of [13.9, 24.1, Number.NaN, Infinity, '17']) assert.equal(sanitizeAppearance({ manuscriptSize: bad }).manuscriptSize, null);
  for (const bad of [1.3, 2.5, Number.NaN]) assert.equal(sanitizeAppearance({ lineHeight: bad }).lineHeight, null);
});

test('parseAppearancePatch: 올바른 부분 변경은 통과하고, 이상한 값·모르는 키·형식 오류는 거절한다', () => {
  assert.deepEqual(parseAppearancePatch({}), {});
  assert.deepEqual(parseAppearancePatch({ theme: 'daylight', manuscriptSize: null, lineHeight: 1.4, manuscriptFont: 'sans', followSystem: false }), {
    theme: 'daylight',
    manuscriptSize: null,
    lineHeight: 1.4,
    manuscriptFont: 'sans',
    followSystem: false,
  });
  for (const bad of [null, undefined, 'x', 3, [1], { theme: 'neon' }, { followSystem: 'true' }, { manuscriptFont: 'comic' }, { manuscriptSize: 13 }, { manuscriptSize: 25 }, { manuscriptSize: '17' }, { manuscriptSize: Number.NaN }, { lineHeight: 1.3 }, { lineHeight: 2.5 }, { dayTheme: 1 }, { nightTheme: null }, { color: 'red' }, { __proto__: null, lastProject: 'x' }]) {
    assert.throws(() => parseAppearancePatch(bad), Error, JSON.stringify(bad));
  }
});

test('설정 읽기: 외관이 없는 예전 settings.json은 기존 값을 그대로 두고 외관만 기본값이다', async () => {
  const d = await dir();
  await writeFile(settingsPath(d), JSON.stringify({ lastProject: 'D:/원고', aiModel: 'gpt-6.1-sol', aiSendConsent: true }));
  assert.deepEqual(await readSettings(d), { lastProject: 'D:/원고', aiModel: 'gpt-6.1-sol', aiSendConsent: true, appearance: DEFAULT_APPEARANCE });
});

test('설정 읽기: 손상된 외관·깨진 JSON·배열은 앱이 뜨는 데 지장이 없고, 다음 저장이 올바른 파일로 되돌린다', async () => {
  const d = await dir();
  await writeFile(settingsPath(d), JSON.stringify({ lastProject: 'D:/원고', appearance: { theme: 'neon', manuscriptSize: 99 } }));
  const damaged = await readSettings(d);
  assert.equal(damaged.lastProject, 'D:/원고');
  assert.deepEqual(damaged.appearance, DEFAULT_APPEARANCE);
  for (const text of ['{ 깨짐', '[1,2]', 'null', '']) {
    await writeFile(settingsPath(d), text);
    assert.deepEqual((await readSettings(d)).appearance, DEFAULT_APPEARANCE, text);
  }
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'paper' } }));
  assert.equal(JSON.parse(await readFile(settingsPath(d), 'utf8')).appearance.theme, 'paper');
});

test('저장: 외관 변경은 마지막 프로젝트·모델·동의를 지우지 않고, 그 반대도 마찬가지다', async () => {
  const d = await dir();
  await updateSettings(d, { lastProject: 'D:/원고', aiModel: 'gpt-6.1-sol', aiSendConsent: true });
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'lamplight', followSystem: false, manuscriptSize: 20 } }));
  await updateSettings(d, { lastProject: 'D:/다른원고' });
  const s = await readSettings(d);
  assert.equal(s.lastProject, 'D:/다른원고');
  assert.equal(s.aiModel, 'gpt-6.1-sol');
  assert.equal(s.aiSendConsent, true);
  assert.deepEqual(s.appearance, { ...DEFAULT_APPEARANCE, theme: 'lamplight', followSystem: false, manuscriptSize: 20 });
  assert.deepEqual((await readdir(d)).filter((f) => f.endsWith('.tmp')), [], '임시 파일이 남지 않는다');
});

test('동시 저장: 슬라이더·모델·프로젝트·동의 저장이 겹쳐도 서로를 되돌리지 않고 호출 순서대로 마지막 값이 남는다', async () => {
  const d = await dir();
  const jobs: Promise<unknown>[] = [];
  for (let i = 14; i <= 24; i += 1) {
    jobs.push(updateSettings(d, (c) => ({ appearance: { ...c.appearance, manuscriptSize: i } })));
    jobs.push(updateSettings(d, (c) => ({ appearance: { ...c.appearance, lineHeight: 1.4 + (i - 14) / 10 } })));
    if (i === 16) jobs.push(updateSettings(d, { aiModel: 'gpt-6.1-sol' }));
    if (i === 18) jobs.push(updateSettings(d, { lastProject: 'D:/원고' }));
    if (i === 20) jobs.push(updateSettings(d, { aiSendConsent: true }));
  }
  await Promise.all(jobs);
  const s = await readSettings(d);
  assert.equal(s.appearance.manuscriptSize, 24);
  assert.equal(Math.round((s.appearance.lineHeight ?? 0) * 10), 24);
  assert.equal(s.aiModel, 'gpt-6.1-sol');
  assert.equal(s.lastProject, 'D:/원고');
  assert.equal(s.aiSendConsent, true);
  JSON.parse(await readFile(settingsPath(d), 'utf8')); // 유효한 JSON
});

test('저장 실패: 실패한 쓰기는 그 호출에만 오류로 돌아가고, 대기열은 막히지 않아 뒤의 쓰기가 성공한다 (그 사이 쓴 값도 남는다)', async () => {
  const d = await dir();
  await updateSettings(d, { lastProject: 'D:/원고' });
  const blocker = `${settingsPath(d)}.tmp`;
  await mkdir(blocker); // 임시 파일 자리에 폴더: 쓰기가 실패한다
  const failing = [
    updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'paper' } })),
    updateSettings(d, (c) => ({ appearance: { ...c.appearance, manuscriptSize: 20 } })),
  ];
  const results = await Promise.allSettled(failing);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
  assert.deepEqual((await readSettings(d)).appearance, DEFAULT_APPEARANCE, '실패한 변경은 디스크에 반영되지 않았다');
  // 실패 중에 이미 대기열에 들어간 쓰기와, 복구 뒤의 쓰기
  const during = updateSettings(d, (c) => ({ appearance: { ...c.appearance, lineHeight: 2 } }));
  await assert.rejects(during);
  await rm(blocker, { recursive: true });
  await updateSettings(d, (c) => ({ appearance: { ...c.appearance, theme: 'daylight', manuscriptSize: 20 } }));
  const s = await readSettings(d);
  assert.equal(s.lastProject, 'D:/원고');
  assert.deepEqual(s.appearance, { ...DEFAULT_APPEARANCE, theme: 'daylight', manuscriptSize: 20 });
});

test('테마 CSS: 네 테마의 --lw-bg가 창 배경색(THEMES.background)과 같고, 모든 테마가 같은 토큰 집합을 정의한다', async () => {
  const css = await readFile(src('renderer/src/themes.css'), 'utf8');
  const block = (id: string) => {
    const start = css.search(id === 'midnight' ? /:root,\s*\[data-theme='midnight'\]\s*\{/ : new RegExp(`\\[data-theme='${id}'\\]\\s*\\{`));
    assert.ok(start >= 0, id);
    return css.slice(start, css.indexOf('\n}', start));
  };
  const tokens = (b: string) => [...b.matchAll(/--lw-([a-z0-9-]+):/g)].map((m) => m[1]!).sort();
  const reference = tokens(block('midnight'));
  for (const t of THEMES) {
    const b = block(t.id);
    assert.equal(/--lw-bg:\s*(#[0-9A-Fa-f]{6})/.exec(b)?.[1]?.toUpperCase(), t.background.toUpperCase(), `${t.id} 배경색`);
    assert.equal(new RegExp(`color-scheme:\\s*${t.scheme}`).test(b), true, `${t.id} color-scheme`);
    assert.deepEqual(tokens(b), reference, `${t.id} 토큰 집합`);
    assert.equal(themeMeta(t.id).id, t.id);
  }
});

test('외부 자원 없음: CSS·HTML에 원격 URL이 없고, CSP는 글꼴을 위해 풀리지 않았으며, 쓰는 글꼴 파일이 모두 패키지에 있다', async () => {
  const html = await readFile(src('renderer/index.html'), 'utf8');
  assert.match(html, /default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'/);
  assert.doesNotMatch(html, /font-src/);
  assert.doesNotMatch(html.replace(/<title>.*<\/title>/, ''), /https?:\/\//);
  for (const file of ['fonts.css', 'themes.css', 'app.css']) {
    const css = await readFile(src('renderer/src', file), 'utf8');
    assert.doesNotMatch(css, /https?:\/\//, file);
    assert.doesNotMatch(css, /@import/, file);
  }
  const fonts = await readFile(src('renderer/src/fonts.css'), 'utf8');
  const urls = [...fonts.matchAll(/url\((@fontsource\/[^)]+\.woff2)\)/g)].map((m) => m[1]!);
  assert.ok(urls.length > 400);
  for (const u of urls) assert.ok(existsSync(join(__dirname, '../../node_modules', u)), u);
  assert.equal(/url\((?!@fontsource\/)/.test(fonts), false, '번들 패키지 밖을 가리키는 url()이 없다');
  const families = new Set([...fonts.matchAll(/font-family:\s*'([^']+)'/g)].map((m) => m[1]));
  assert.deepEqual([...families].sort(), ['IBM Plex Sans KR', 'JetBrains Mono', 'Noto Serif KR']);
  const weights = (family: string) => [...new Set([...fonts.matchAll(new RegExp(`font-family: '${family}';[^}]*?font-weight: (\\d+)`, 'g'))].map((m) => Number(m[1])))].sort();
  assert.deepEqual(weights('IBM Plex Sans KR'), [400, 500, 600]);
  assert.deepEqual(weights('Noto Serif KR'), [400, 700]);
  assert.deepEqual(weights('JetBrains Mono'), [400, 500]);
});
