import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { renderApp } from '../ui/app.mjs';
import { MOON_ICON, SUN_ICON, THEME_KEY, THEMES, otherTheme, readTheme, saveTheme, startTheme, themeControlHtml, themeLabel } from '../ui/theme.mjs';
import { NOW, exampleSnapshot, fixture } from './helpers/ui.mjs';

const read = name => readFileSync(new URL(`../ui/${name}`, import.meta.url), 'utf8');
const css = read('styles.css');
const block = selector => {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, selector);
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
};
const tokens = body => new Map([...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map(([, name, value]) => [name, value.trim()]));

const memory = (entries = {}) => {
  const data = new Map(Object.entries(entries));
  return { getItem: key => (data.has(key) ? data.get(key) : null), setItem: (key, value) => data.set(key, String(value)), data };
};
const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };

test('the theme is the saved choice, else the system setting', () => {
  assert.deepEqual(THEMES, ['light', 'dark']);
  assert.equal(startTheme('dark', false), 'dark');
  assert.equal(startTheme('light', true), 'light');
  assert.equal(startTheme(null, true), 'dark');
  assert.equal(startTheme(null, false), 'light');
  assert.equal(startTheme('sepia', true), 'dark');
  assert.equal(otherTheme('light'), 'dark');
  assert.equal(otherTheme('dark'), 'light');
});

test('the choice is saved under its own key, and missing storage is no choice', () => {
  const storage = memory();
  assert.equal(readTheme(storage), null);
  saveTheme(storage, 'dark');
  assert.equal(storage.data.get(THEME_KEY), 'dark');
  assert.equal(readTheme(storage), 'dark');
  assert.equal(readTheme(memory({ [THEME_KEY]: 'sepia' })), null);
  assert.equal(readTheme(broken), null);
  assert.doesNotThrow(() => saveTheme(broken, 'dark'));
});

test('the switch is named for what a click does and carries both icons', () => {
  assert.equal(themeLabel('light'), 'Switch to dark theme');
  assert.equal(themeLabel('dark'), 'Switch to light theme');
  const icons = `<span class="th-icon">${MOON_ICON}${SUN_ICON}</span>`;
  assert.equal(themeControlHtml('light'), `<div class="seg th-open"><button type="button" data-theme-toggle aria-label="Switch to dark theme" title="Switch to dark theme">${icons}</button></div>`);
  assert.equal(themeControlHtml('dark'), `<div class="seg th-open"><button type="button" data-theme-toggle aria-label="Switch to light theme" title="Switch to light theme">${icons}</button></div>`);
  assert.equal(themeControlHtml(undefined), themeControlHtml('light'));
  for (const icon of [MOON_ICON, SUN_ICON]) {
    assert.match(icon, /^<svg class="th-(moon|sun)" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">/);
    assert.doesNotMatch(icon, /xmlns|https?:/);
  }
});

const view = (overrides = {}) => ({
  page: 'live', tab: 'cards', detail: null, span: '12h', narrow: false, loaded: true, snapshot: exampleSnapshot(),
  swarms: fixture('example-swarms.json'), swarm: null, runs: null, run: null, connection: 'open', demo: false,
  now: NOW, phaseMs: 0, fresh: { feed: new Set(), reports: new Set(), chips: new Set() }, host: 'browser', cockpitNote: null, theme: 'light', ...overrides,
});

test('the switch sits right after the Cockpit control, and on every page', () => {
  const tools = html => html.match(/<div class="d-tools">([\s\S]*?)<\/div><\/div><\/div>/)?.[1] ?? '';
  assert.match(tools(renderApp(view())), /^<div class="seg ck-open">[\s\S]*?<\/div><div class="seg th-open"><button type="button" data-theme-toggle aria-label="Switch to dark theme"/);
  assert.match(renderApp(view({ theme: 'dark' })), /data-theme-toggle aria-label="Switch to light theme"/);
  assert.match(tools(renderApp(view({ snapshot: null }))), /^<div class="seg th-open">/);
  assert.match(renderApp(view({ page: 'history', runs: [] })), /<div class="d-tools"><div class="seg th-open">/);
  assert.match(renderApp(view({ page: 'run', run: null })), /<div class="d-tools"><div class="seg th-open">/);
});

/** Run ui/theme-boot.mjs as the browser does, as a classic script, against fake storage and a fake system setting. */
function boot({ storage, prefersDark }) {
  const document = { documentElement: { dataset: {} } };
  const window = { matchMedia: query => ({ matches: query === '(prefers-color-scheme: dark)' && prefersDark }) };
  vm.runInNewContext(read('theme-boot.mjs'), { document, window, localStorage: storage });
  return document.documentElement.dataset.theme;
}

test('before the first paint, the page takes the saved choice, else the system setting', () => {
  assert.equal(boot({ storage: memory({ [THEME_KEY]: 'dark' }), prefersDark: false }), 'dark');
  assert.equal(boot({ storage: memory({ [THEME_KEY]: 'light' }), prefersDark: true }), 'light');
  assert.equal(boot({ storage: memory(), prefersDark: true }), 'dark');
  assert.equal(boot({ storage: memory(), prefersDark: false }), 'light');
  assert.equal(boot({ storage: memory({ [THEME_KEY]: 'sepia' }), prefersDark: true }), 'dark');
  assert.equal(boot({ storage: broken, prefersDark: true }), 'dark');
  assert.ok(read('theme-boot.mjs').includes(`'${THEME_KEY}'`), 'the boot script reads the same key');
  assert.doesNotMatch(read('theme-boot.mjs'), /\b(import|export)\b/, 'a classic script');
});

test('the page loads the boot script as a classic script ahead of the stylesheet and the app', () => {
  const html = read('index.html');
  const bootAt = html.indexOf('<script src="/ui/theme-boot.mjs"></script>');
  assert.notEqual(bootAt, -1);
  assert.ok(bootAt < html.indexOf('<link rel="stylesheet" href="/ui/styles.css">'));
  assert.ok(bootAt < html.indexOf('<script type="module" src="/ui/main.mjs"></script>'));
});

test('the dark theme sets every colour the light theme sets', () => {
  const light = tokens(block(':root'));
  const dark = tokens(block(':root[data-theme="dark"]'));
  assert.match(block(':root[data-theme="dark"]'), /color-scheme: dark;/);
  const derived = new Set(['--card-pad', '--card-border', '--stg-planned', '--stg-subagent']);
  for (const [name, value] of light) {
    if (derived.has(name)) {
      assert.ok(!dark.has(name), `${name} follows the tokens it refers to`);
      continue;
    }
    assert.ok(dark.has(name), `${name} has a dark value`);
    assert.notEqual(dark.get(name), value, `${name} differs in the dark theme`);
  }
  for (const name of dark.keys()) assert.ok(light.has(name), `${name} is also a light token`);
  assert.match(css, /\.st-pr \{ --c: var\(--stg-pr\); --c-ink: var\(--pr-ink\); --c-soft: var\(--stg-coding\); \}/);
});

test('the switch shows the moon in the light theme and the sun in the dark one, and stops moving on request', () => {
  assert.equal(block(':root[data-theme="dark"] .th-moon, :root:not([data-theme="dark"]) .th-sun').trim(), 'opacity: 0; transform: rotate(90deg) scale(.5);');
  assert.match(block('.th-icon svg'), /grid-area: 1 \/ 1; transition: opacity \.2s ease, transform \.3s /);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\* \{ animation: none !important; \}\s*\.th-icon svg \{ transition: none; \}/);
  assert.equal(block('.th-icon').trim(), 'display: grid; color: var(--icon);');
  assert.equal(block('.ck-open path').trim(), 'fill: var(--icon);');
});

test('the page wires the switch, the system setting and other tabs', () => {
  const main = read('main.mjs');
  assert.match(main, /\[data-cockpit\],\[data-cockpit-copy\],\[data-theme-toggle\]/);
  assert.match(main, /el\.dataset\.themeToggle !== undefined\) \{\n\s+const theme = otherTheme\(view\.theme\);\n\s+saveTheme\(localStorage, theme\);\n\s+showTheme\(theme\);/);
  assert.match(main, /darkScheme\.addEventListener\('change', /);
  assert.match(main, /window\.addEventListener\('storage', /);
  assert.match(main, /document\.documentElement\.dataset\.theme = theme;/);
});

test('the run summary\'s busy line stays darker than its start-to-finish bar in both themes, as its legend says', () => {
  const light = tokens(block(':root'));
  const dark = tokens(block(':root[data-theme="dark"]'));
  const lightness = (map, name) => {
    const value = map.get(name);
    const ref = value.match(/^var\((--[\w-]+)\)$/);
    return ref ? lightness(map, ref[1]) : Number(value.match(/^oklch\(([\d.]+) /)[1]);
  };
  assert.equal(block('.g-busy').match(/background: ([^;]+);/)[1], 'var(--g-busy)');
  assert.equal(block('.g-span.no + .g-busy').trim(), 'background: var(--g-busy-no);');
  for (const map of [light, dark]) {
    assert.ok(lightness(map, '--g-busy') < lightness(map, '--merged'));
    assert.ok(lightness(map, '--g-busy-no') < lightness(map, '--blocked'));
  }
  assert.match(readFileSync(new URL('../ui/history.mjs', import.meta.url), 'utf8'), /Light bar: start to finish\. Dark line: total busy time/);
});
