import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { PANEL_TABS } from './helpers/cockpit.mjs';

const html = readFileSync(new URL('../ui/cockpit.html', import.meta.url), 'utf8');

test('the cockpit shell loads only its own stylesheet and one module, with nothing inline', () => {
  assert.match(html, /<link rel="stylesheet" href="\/ui\/cockpit\.css">/);
  assert.match(html, /<script type="module" src="\/ui\/cockpit\.mjs"><\/script>/);
  assert.equal([...html.matchAll(/<script\b/g)].length, 1);
  assert.doesNotMatch(html, /<style\b|\son[a-z]+=|https?:\/\//);
  assert.match(html, /<title>Swarm cockpit<\/title>/);
});

test('the shell has the canvas, the top line, the quality switch, the note and every panel with its tab', () => {
  assert.match(html, /<canvas id="ck-gl" aria-hidden="true"><\/canvas>/);
  assert.match(html, /<main class="ck" id="ck">/);
  for (const id of ['ck-hud', 'ck-qual', 'ck-stage', 'ck-world', 'ck-note']) assert.match(html, new RegExp(`id="${id}"`));
  for (const [id, tab] of Object.entries(PANEL_TABS)) assert.match(html, new RegExp(`<section class="ck-panel [a-z-]+" id="${id}" data-tab="${tab}" aria-label="[A-Z][^"]+"></section>`));
});
