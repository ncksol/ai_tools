import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AUDIT_DEFAULTS, auditScript, composite, contrastRatio, cutsBox, oklchToSrgb, parseColor, showsEllipsis } from '../scripts/lib/page-audit.mjs';

const close = (actual, expected, tolerance = 0.005) => assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} is not about ${expected}`);

test('colours parse from the computed formats Chrome returns', () => {
  assert.deepEqual(parseColor('rgb(118, 118, 118)'), { r: 118 / 255, g: 118 / 255, b: 118 / 255, a: 1 });
  assert.deepEqual(parseColor('rgba(0, 0, 0, 0)'), { r: 0, g: 0, b: 0, a: 0 });
  const white = parseColor('oklch(1 0 0)');
  close(white.r, 1);
  close(white.g, 1);
  close(white.b, 1);
  assert.equal(parseColor('oklch(0.92784 0.01136 239.2 / 0.5)').a, 0.5);
  assert.equal(parseColor('oklch(50% 0.1 none)').a, 1);
  assert.deepEqual(parseColor('color(srgb 1 0 0)'), { r: 1, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('lab(50 20 30)'), null);
});

test('contrast follows WCAG 2 and reproduces the palette\'s round-2 measurements', () => {
  close(contrastRatio({ r: 0, g: 0, b: 0 }, { r: 1, g: 1, b: 1 }), 21);
  close(contrastRatio(parseColor('rgb(118, 118, 118)'), { r: 1, g: 1, b: 1 }), 4.542, 0.01);
  const surface = oklchToSrgb(0.993, 0.002, 250);
  close(contrastRatio(oklchToSrgb(0.30, 0.02, 255), surface), 13.36, 0.05);
  const archived = contrastRatio(oklchToSrgb(0.55, 0.012, 250), surface);
  assert.ok(archived >= 4.5 && archived < 4.9, `archived text on a board card: ${archived}`);
  close(composite({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 1, g: 1, b: 1, a: 1 }).r, 0.5);
});

test('only block containers show an ellipsis, so text a flex row cuts counts as cut', () => {
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'block' }), true);
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'inline-block' }), true);
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'flex' }), false);
  assert.equal(showsEllipsis({ textOverflow: 'ellipsis', display: 'inline-grid' }), false);
  assert.equal(showsEllipsis({ textOverflow: 'clip', display: 'block' }), false);
});

test('an ancestor cuts a box across unless it shows an ellipsis, and down always', () => {
  const area = { left: 0, top: 0, right: 100, bottom: 20 };
  const wide = { left: 10, top: 0, right: 160, bottom: 20 };
  const tall = { left: 10, top: 0, right: 90, bottom: 40 };
  const hidden = { overflowX: 'hidden', overflowY: 'hidden', textOverflow: 'clip', display: 'flex' };
  assert.equal(cutsBox(wide, area, hidden), true);
  assert.equal(cutsBox(tall, area, hidden), true);
  assert.equal(cutsBox({ left: 10, top: 0, right: 100.4, bottom: 20.4 }, area, hidden), false);
  const ellipsis = { ...hidden, textOverflow: 'ellipsis', display: 'block' };
  assert.equal(cutsBox(wide, area, ellipsis), false);
  assert.equal(cutsBox(tall, area, ellipsis), true);
  assert.equal(cutsBox(wide, area, { ...hidden, overflowX: 'visible', overflowY: 'visible' }), false);
  assert.equal(cutsBox(wide, area, { ...hidden, overflowX: 'auto' }), false);
  assert.equal(cutsBox(wide, area, { ...hidden, overflowX: 'clip' }), true);
});

test('the audit script is self-contained and carries its options', () => {
  const script = auditScript(AUDIT_DEFAULTS);
  assert.match(script, /^\(\(\) => \{/);
  assert.match(script, /function auditPage\(options\)/);
  assert.match(script, /"minContrast":4\.5/);
  assert.doesNotMatch(script, /\bimport\b|\bexport\b/);
  assert.doesNotThrow(() => new Function(script));
});

test('the dashboard audit holds the Cards note to the cards\' gap and text edge', () => {
  assert.deepEqual(AUDIT_DEFAULTS.follows, [{ item: '.cards-note', ref: '.b-card', gapOf: '.b-grid' }]);
  assert.ok(auditScript(AUDIT_DEFAULTS).includes('.cards-note'));
});
