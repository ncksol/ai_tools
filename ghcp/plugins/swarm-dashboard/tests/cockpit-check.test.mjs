import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHECKS, COCKPIT_AUDIT, COCKPIT_SIZES, SMALL_SIZE, cockpitIssues, expandAll } from '../scripts/lib/cockpit-check.mjs';
import { parseArguments } from '../scripts/check-cockpit.mjs';
import { COCKPIT_SIZES as FIT_SIZES } from './helpers/cockpit.mjs';

test('the cockpit is checked at the window sizes the arrangement is tested at, and in a small window', () => {
  assert.deepEqual(COCKPIT_SIZES, FIT_SIZES);
  assert.deepEqual(SMALL_SIZE, [1024, 700]);
  assert.deepEqual([...CHECKS.keys()], ['scene', 'layout', 'motion']);
});

test('the audit uses the approved type scale plus the clock, and even padding for panels and tiles', () => {
  assert.equal(COCKPIT_AUDIT.root, '.ck');
  assert.equal(COCKPIT_AUDIT.minContrast, 4.5);
  assert.deepEqual(COCKPIT_AUDIT.sizes, [12, 14, 18, 36]);
  assert.deepEqual(COCKPIT_AUDIT.weights, [400, 500]);
  assert.deepEqual(COCKPIT_AUDIT.padding, { '.ck-panel': 16, '.d-full > .ck-tile': 12, '.d-two > .ck-tile': 8, '.d-one > .ck-tile': 8, '.ck-need': 8, '.ck-note': 16 });
});

test('monospace is not a font-family issue; everything else is kept', () => {
  const issues = [
    { rule: 'font-family', target: 'span.ck-mono', detail: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace' },
    { rule: 'font-family', target: 'span', detail: 'Georgia, serif' },
    { rule: 'contrast', target: 'span', detail: '3.20:1' },
  ];
  assert.deepEqual(cockpitIssues(issues).map(issue => issue.rule), ['font-family', 'contrast']);
});

test('rectangles grow by the camera\'s reach before the scene is sampled', () => {
  assert.deepEqual(expandAll({ a: { left: 10, top: 20, right: 30, bottom: 40 } }, 32), { a: { left: -22, top: -12, right: 62, bottom: 72 } });
});

test('the command can save screenshots of the synthetic swarms', () => {
  assert.equal(parseArguments(['--screenshots', '/tmp/x']).screenshots, '/tmp/x');
  assert.throws(() => parseArguments(['--screenshots']), /--screenshots takes a folder/);
});
