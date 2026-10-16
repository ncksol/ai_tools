import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PANELS } from '../ui/cockpit-fit.mjs';

const css = readFileSync(new URL('../ui/cockpit.css', import.meta.url), 'utf8');
const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => [selector.trim(), body]);
const declarations = rules.flatMap(([selector, body]) => [...body.matchAll(/([a-z-]+)\s*:\s*([^;]+);?/g)].map(([, prop, value]) => [selector, prop, value.trim()]));

test('every panel has the size the arrangement uses, centred on its origin', () => {
  for (const [id, { width, height }] of Object.entries(PANELS)) {
    const body = rules.find(([selector]) => selector === `#${id}`)?.[1];
    assert.ok(body, id);
    assert.match(body, new RegExp(`width: ${width}px; height: ${height}px; left: ${-width / 2}px; top: ${-height / 2}px;`), id);
  }
});

test('type uses the approved sizes and weights; only the clock is larger; no italic, capitals or spacing', () => {
  for (const [selector, prop, value] of declarations) {
    if (prop === 'font-size') assert.ok(['12px', '14px', '18px'].includes(value) || (selector === '.ck-hm' && value === '36px'), `${selector} font-size: ${value}`);
    if (prop === 'line-height') assert.ok(['16px', '20px', '24px'].includes(value) || (selector === '.ck-hm' && value === '40px'), `${selector} line-height: ${value}`);
    if (prop === 'font-weight') assert.match(value, /^(400|500)$/, `${selector} font-weight: ${value}`);
    if (prop === 'font' && value !== 'inherit') assert.match(value, /^(400|500) (12|14|18)px\/(16|20|24)px /, `${selector} font: ${value}`);
    assert.notEqual(prop, 'letter-spacing', selector);
    assert.notEqual(prop, 'text-transform', selector);
    if (prop === 'font-style') assert.equal(value, 'normal', selector);
  }
  assert.doesNotMatch(bare, /italic|uppercase|text-shadow/);
});

test('spacing stays on the 4 px grid', () => {
  for (const [selector, prop, value] of declarations) {
    if (!/^(gap|row-gap|column-gap|padding(-[a-z]+)?|margin(-[a-z]+)?)$/.test(prop)) continue;
    for (const [, number] of value.matchAll(/(-?\d+(?:\.\d+)?)px/g)) assert.equal(Number(number) % 4, 0, `${selector} ${prop}: ${value}`);
  }
});

test('the status colours are the approved pastels on dark glass, with idle and archived dimmed', () => {
  for (const [name, value] of Object.entries({ busy: '0.84 0.07 238', idle: '0.80 0.012 250', plan: '0.89 0.08 92', question: '0.85 0.07 300', stuck: '0.78 0.11 25', blocked: '0.85 0.085 62', merged: '0.86 0.07 160', archived: '0.70 0.008 250' })) {
    assert.ok(css.includes(`--${name}: oklch(${value});`), name);
  }
  for (const state of ['busy', 'idle', 'plan', 'question', 'stuck', 'blocked', 'merged', 'done', 'archived', 'pr']) assert.match(bare, new RegExp(`\\.st-${state} \\{ --c: var\\(--`), state);
});

test('panels are glass with a drawn frame, motion stops on request, and nothing loads from outside', () => {
  const panel = rules.find(([selector]) => selector === '.ck-panel')[1];
  assert.match(panel, /background-color: var\(--glass\);/);
  assert.match(panel, /box-shadow: inset 0 0 0 1px var\(--line\)/);
  assert.doesNotMatch(panel, /border:/);
  assert.match(bare, /@media \(prefers-reduced-motion: reduce\) \{\s*\*, \*::before, \*::after \{ animation: none !important; transition: none !important; \}/);
  assert.doesNotMatch(bare, /@import|url\(/);
  for (const state of ['html[data-flat] .ck-panel', 'html[data-gl="off"] body', 'html[data-fit="small"] .ck-stage', '.ck-note[hidden]']) assert.ok(bare.includes(state), state);
});
