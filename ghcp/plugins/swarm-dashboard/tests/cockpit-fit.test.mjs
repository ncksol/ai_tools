import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_WINDOW, PANELS, SPACING, TOP_BAND, fitPanels, overlapProblems } from '../ui/cockpit-fit.mjs';
import { PANEL_TABS } from './cockpit-shell.test.mjs';

export const COCKPIT_SIZES = [[1100, 800], [1280, 800], [1440, 900], [1512, 900], [1680, 1050], [1920, 1080], [2560, 1440]];

test('every panel in the shell has a fixed size', () => {
  assert.deepEqual(Object.keys(PANELS).sort(), Object.keys(PANEL_TABS).sort());
  assert.deepEqual(MIN_WINDOW, { width: 1100, height: 800 });
});

test('the arrangement fits at common window sizes, without overlap and with even gaps', () => {
  for (const [width, height] of COCKPIT_SIZES) {
    const fit = fitPanels(width, height);
    assert.equal(fit.fits, true, `${width} × ${height}: ${fit.problems.join('; ')}`);
    const r = fit.rects;
    const s = fit.stage.scale;
    assert.ok(Math.abs((r['ck-units'].left + r['ck-units'].right) / 2 - width / 2) < 0.5, 'the centre console is centred');
    assert.ok(Math.abs(r['ck-activity'].left - (width - r['ck-prs'].right)) < 1, 'the side consoles mirror each other');
    assert.ok(r['ck-units'].left - r['ck-activity'].right >= SPACING.consoleGap * s - 0.01);
    assert.ok(r['ck-prs'].left - r['ck-units'].right >= SPACING.consoleGap * s - 0.01);
    assert.ok(r['ck-cost'].bottom <= r['ck-activity'].top - SPACING.upperAbove * s + 0.01);
    assert.ok(r['ck-clock'].bottom <= r['ck-cost'].top - SPACING.upperGap * s + 0.01);
    assert.ok(r['ck-status'].bottom <= r['ck-prs'].top - SPACING.upperAbove * s + 0.01);
    assert.ok(r['ck-needs'].bottom <= r['ck-status'].top - SPACING.upperGap * s + 0.01);
    for (const id of ['ck-clock', 'ck-needs']) assert.ok(r[id].top >= TOP_BAND, `${id} stays under the top line`);
  }
});

test('below the minimum window, or too narrow for its height, the cockpit says so instead', () => {
  assert.equal(fitPanels(1099, 800).reason, 'small');
  assert.equal(fitPanels(1280, 799).reason, 'small');
  const narrow = fitPanels(1100, 900);
  assert.deepEqual([narrow.fits, narrow.reason], [false, 'crowded']);
  assert.ok(narrow.problems.some(problem => problem.includes('ck-activity')));
});

test('overlapProblems reports overlaps, panels off the screen and panels in the top band', () => {
  const rects = { a: { left: 10, top: 60, right: 110, bottom: 160 }, b: { left: 100, top: 100, right: 200, bottom: 200 }, c: { left: 900, top: 20, right: 1100, bottom: 80 } };
  const problems = overlapProblems(rects, { width: 1000, height: 800, top: 48, edge: 8, clear: 8 });
  assert.deepEqual(problems, ['c leaves the screen', 'a overlaps b']);
  assert.deepEqual(overlapProblems({ a: rects.a }, { width: 1000, height: 800, top: 48, edge: 8, clear: 8 }), []);
});
