import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MIN_WINDOW, PANELS, SPACING, TOP_BAND, fitPanels, overlapProblems } from '../ui/cockpit-fit.mjs';
import { COCKPIT_SIZES, PANEL_TABS } from './helpers/cockpit.mjs';

test('every panel in the shell has a fixed size', () => {
  assert.deepEqual(Object.keys(PANELS).sort(), Object.keys(PANEL_TABS).sort());
  assert.deepEqual(MIN_WINDOW, { width: 1100, height: 800 });
});

test('the arrangement fits at common window sizes, with exact gaps that match on both sides', () => {
  for (const [width, height] of COCKPIT_SIZES) {
    const fit = fitPanels(width, height);
    assert.equal(fit.fits, true, `${width} × ${height}: ${fit.problems.join('; ')}`);
    const r = fit.rects;
    const s = fit.stage.scale;
    const near = (got, want, what) => assert.ok(Math.abs(got - want) < 0.5, `${width} × ${height}: ${what} is ${got.toFixed(2)} px, not ${want.toFixed(2)}`);
    near((r['ck-units'].left + r['ck-units'].right) / 2, width / 2, "the centre console's middle");
    near(r['ck-activity'].left, width - r['ck-prs'].right, "the left console's margin against the right one's");
    near(r['ck-units'].left - r['ck-activity'].right, SPACING.consoleGap * s, 'the gap left of the centre console');
    near(r['ck-prs'].left - r['ck-units'].right, SPACING.consoleGap * s, 'the gap right of the centre console');
    near(r['ck-activity'].top - r['ck-cost'].bottom, SPACING.upperAbove * s, 'the gap above the activity console');
    near(r['ck-prs'].top - r['ck-status'].bottom, SPACING.upperAbove * s, 'the gap above the PR console');
    near(r['ck-cost'].top - r['ck-clock'].bottom, SPACING.upperGap * s, 'the gap inside the left stack');
    near(r['ck-status'].top - r['ck-needs'].bottom, SPACING.upperGap * s, 'the gap inside the right stack');
    for (const id of ['ck-clock', 'ck-needs']) assert.ok(r[id].top >= TOP_BAND, `${id} stays under the top line`);
  }
});

test('a window that fits keeps fitting as it grows wider', () => {
  for (const height of [800, 900, 1000, 1080, 1200, 1360, 1440, 1600]) {
    let fitted = false;
    for (let width = 1100; width <= 3200; width += 40) {
      const fits = fitPanels(width, height).fits;
      if (fitted) assert.equal(fits, true, `${width} × ${height} stops fitting although a narrower window fits`);
      fitted = fitted || fits;
    }
    const comfortable = Math.max(1100, Math.ceil(height * 1.4));
    assert.equal(fitPanels(comfortable, height).fits, true, `${comfortable} × ${height}`);
  }
});

test('below the minimum window, or too narrow for its height, the cockpit says so instead', () => {
  assert.equal(fitPanels(1099, 800).reason, 'small');
  assert.equal(fitPanels(1280, 799).reason, 'small');
  const narrow = fitPanels(1100, 1000);
  assert.deepEqual([narrow.fits, narrow.reason], [false, 'crowded']);
  assert.ok(narrow.problems.some(problem => problem.includes('ck-activity')));
});

test('overlapProblems reports overlaps, panels off the screen and panels in the top band', () => {
  const rects = { a: { left: 10, top: 60, right: 110, bottom: 160 }, b: { left: 100, top: 100, right: 200, bottom: 200 }, c: { left: 900, top: 20, right: 1100, bottom: 80 } };
  const problems = overlapProblems(rects, { width: 1000, height: 800, top: 48, edge: 8, clear: 8 });
  assert.deepEqual(problems, ['c leaves the screen', 'a overlaps b']);
  assert.deepEqual(overlapProblems({ a: rects.a }, { width: 1000, height: 800, top: 48, edge: 8, clear: 8 }), []);
});
