import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../ui/styles.css', import.meta.url), 'utf8');
const declarations = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([a-z-]+)\s*:\s*([^;{}]+)[;}]/g)].map(([, prop, value]) => [prop, value.trim()]);

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
    if (!/^(gap|row-gap|column-gap|padding(-top|-right|-bottom|-left)?|margin(-top|-right|-bottom|-left)?)$/.test(prop)) continue;
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
