import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { CARD_FADE_MS } from '../ui/model.mjs';

const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
const declarations = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map(([, prop, value]) => [prop, value.trim()]);
const block = selector => {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, selector);
  return css.slice(css.indexOf('{', start) + 1, css.indexOf('}', start));
};

const TOKENS = {
  '--page': '0.975 0.004 250', '--surface': '0.993 0.002 250', '--sunk': '0.95 0.005 250', '--line': '0.905 0.008 250',
  '--line-2': '0.94 0.006 250', '--ink': '0.30 0.02 255', '--ink-2': '0.48 0.018 255', '--ink-3': '0.55 0.015 255',
  '--meter': '0.80 0.03 250', '--focus': '0.55 0.10 245',
  '--busy': '0.84 0.07 238', '--busy-ink': '0.46 0.09 245', '--busy-soft': '0.955 0.02 238',
  '--idle': '0.87 0.012 250', '--idle-ink': '0.48 0.015 250', '--idle-soft': '0.96 0.004 250',
  '--plan': '0.89 0.08 92', '--plan-ink': '0.47 0.08 75', '--plan-soft': '0.97 0.03 95',
  '--question': '0.85 0.07 300', '--question-ink': '0.47 0.11 300', '--question-soft': '0.965 0.02 300',
  '--stuck': '0.78 0.11 25', '--stuck-ink': '0.49 0.14 27', '--stuck-soft': '0.96 0.025 25',
  '--blocked': '0.85 0.085 62', '--blocked-ink': '0.48 0.10 55', '--blocked-soft': '0.965 0.03 65',
  '--merged': '0.86 0.07 160', '--merged-ink': '0.45 0.08 160', '--merged-soft': '0.965 0.02 160',
  '--archived': '0.91 0.006 250', '--archived-ink': '0.55 0.012 250', '--archived-soft': '0.97 0.003 250',
  '--stg-coding': '0.955 0.025 195', '--stg-pr': '0.925 0.045 188', '--stg-review': '0.895 0.06 178', '--stg-ink': '0.62 0.07 185',
};

test('the palette is the approved OKLCH tokens', () => {
  for (const [name, value] of Object.entries(TOKENS)) assert.ok(css.includes(`${name}: oklch(${value});`), name);
});

test('type uses only the approved sizes, line heights and weights, with no italic, uppercase or letter-spacing', () => {
  for (const [prop, value] of declarations) {
    if (prop === 'font-size') assert.match(value, /^(12|14|18)px$/, `font-size: ${value}`);
    if (prop === 'line-height') assert.match(value, /^(16|20|24)px$/, `line-height: ${value}`);
    if (prop === 'font-weight') assert.match(value, /^(400|500)$/, `font-weight: ${value}`);
    if (prop === 'font' && value !== 'inherit') assert.match(value, /^(400|500) (12|14|18)px\/(16|20|24)px /, `font: ${value}`);
    if (prop === 'font-style') assert.equal(value, 'normal');
    assert.notEqual(prop, 'letter-spacing');
    assert.notEqual(prop, 'text-transform');
  }
  assert.doesNotMatch(css, /italic|uppercase/);
});

test('spacing stays on the 4 px grid', () => {
  const allowed = new Set(['margin-top: 6px']);
  for (const [prop, value] of declarations) {
    if (!/^(gap|row-gap|column-gap|padding(-top|-right|-bottom|-left)?|margin(-top|-right|-bottom|-left)?|--card-pad)$/.test(prop)) continue;
    if (allowed.has(`${prop}: ${value}`)) continue;
    for (const [, number] of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) assert.equal(Number(number) % 4, 0, `${prop}: ${value}`);
  }
});

test('buttons take their colour, type and margin from the page, as the approved mockup renders them', () => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
  const buttons = rules.filter(([selector]) => selector !== 'button, select' && (/\bbutton\b/.test(selector) || /(^|[\s,])\.(link|x)(?![\w-])/.test(selector)));
  assert.ok(buttons.length >= 6, `${buttons.length} button rules`);
  for (const [selector, body] of buttons) assert.doesNotMatch(body, /(^|;)\s*(color|font(-[a-z]+)?|line-height|margin(-[a-z]+)?)\s*:/, selector);
});

test('the font comes from the host with the approved fallback, motion stops on request, and nothing loads from outside', () => {
  assert.ok(css.includes('var(--font-sans, system-ui, -apple-system, "Segoe UI", sans-serif)'));
  assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\* \{ animation: none !important; \}/);
  assert.doesNotMatch(css, /@import|url\((?!#cHatch2\))/);
  assert.match(css, /html\[data-host="canvas"\] \.dash \{/);
});

test('the Cards note takes its inset from the same tokens as a card and adds no margin', () => {
  assert.match(css, /--card-pad: 16px;/);
  assert.match(css, /--card-border: 1px;/);
  const card = block('.b-card');
  assert.match(card, /padding: var\(--card-pad\);/);
  assert.match(card, /border: var\(--card-border\) solid var\(--line\);/);
  const note = block('.b-grid > .cards-note');
  assert.match(note, /grid-column: 1 \/ -1;/);
  assert.match(note, /padding: 0 var\(--card-pad\);/);
  assert.match(note, /border-left: var\(--card-border\) solid transparent;/);
  assert.match(note, /border-right: var\(--card-border\) solid transparent;/);
  assert.doesNotMatch(note, /margin/);
});

test('finished sub-agents use the merged mint, and the Sub-agents column a neutral swatch', () => {
  assert.match(css, /--stg-subagent: var\(--sunk\);/);
  assert.equal(block('.st-done').trim(), '--c: var(--merged); --c-ink: var(--merged-ink); --c-soft: var(--merged-soft);');
  assert.equal(block('.stg-subagent').trim(), 'background: var(--stg-subagent);');
  assert.equal(block('.c-row.is-sub .c-who').trim(), 'padding-left: 16px;');
  assert.equal(block('.bcol-more').trim(), 'font-size: 12px; line-height: 16px; color: var(--ink-2);');
});

test('the row of sub-agents outside the window spans the whole row in both Timeline layouts', () => {
  assert.equal(block('.c-row.c-more').trim(), 'grid-template-areas: "who who";');
  const wide = css.slice(css.indexOf('@container main (min-width: 760px) {\n  .c-row {'));
  assert.match(wide.slice(0, wide.indexOf('\n}')), /\n  \.c-row\.c-more \{ grid-template-areas: "who who who"; \}/);
});

const SUBAGENT_BORDER = '.b-card[data-kind="subagent"], .mc[data-kind="subagent"]';
const SESSION_BORDER = '.b-card[data-kind="project"], .b-card[data-kind="chat"], .mc[data-kind="project"], .mc[data-kind="chat"]';

test('a card\'s border is blue for a one-off sub-agent and green for a child session, and status no longer sets it', () => {
  assert.equal(block(SUBAGENT_BORDER).trim(), 'border-color: var(--busy); box-shadow: inset 0 0 0 1px var(--busy);');
  assert.equal(block(SESSION_BORDER).trim(), 'border-color: var(--merged); box-shadow: inset 0 0 0 1px var(--merged);');
  assert.equal(block('.b-card.st-plan, .b-card.st-question, .b-card.st-stuck, .b-card.st-blocked').trim(), 'background: var(--c-soft);');
  assert.equal(block('.mc.st-plan, .mc.st-question, .mc.st-stuck, .mc.st-blocked').trim(), 'background: var(--c-soft);');
});

test('hover and the selected card still show over the kind colour', () => {
  const at = selector => css.indexOf(`\n${selector} {`);
  const hover = at('.b-card:hover');
  for (const selector of ['.b-card:hover', SUBAGENT_BORDER, SESSION_BORDER, '.b-card.is-sel']) assert.notEqual(at(selector), -1, selector);
  assert.ok(hover > at(SUBAGENT_BORDER) && hover > at(SESSION_BORDER), 'hover after the kind rules');
  assert.ok(hover < at('.b-card.is-sel'), 'hover before the selected card');
  assert.equal(block('.b-card:hover').trim(), 'border-color: var(--ink-3);');
  // The selected card's ink inset replaces the kind's inset line: same specificity, later in the file.
  assert.equal(block('.b-card.is-sel').trim(), 'border-color: var(--ink); box-shadow: inset 0 0 0 1px var(--ink);');
  assert.equal(block('.mc[data-open]:hover').trim(), 'border-color: var(--ink-3);');
});

test('a leaving card fades to transparent over CARD_FADE_MS', () => {
  const rule = block('.b-card.is-leaving').trim();
  const match = rule.match(/^animation: card-leave ([\d.]+)s ease-in forwards;$/);
  assert.ok(match, rule);
  assert.equal(Number(match[1]) * 1000, CARD_FADE_MS);
  assert.equal(block('@keyframes card-leave').trim(), 'to { opacity: 0;');
});
