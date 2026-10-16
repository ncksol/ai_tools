import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DENSITIES, activityRows, clockText, costView, dateText, hourlyRate, legend, needRows, nextCheckAt, prRows, runLine, stateWord, tileGrid, tileWord, timeText, unitCounts,
} from '../ui/cockpit-model.mjs';
import { NOW, deepFreeze, exampleSnapshot } from './helpers/ui.mjs';

const example = () => deepFreeze(exampleSnapshot());

test('a state word is the regular state line without its time', () => {
  const s = example();
  assert.equal(stateWord(s.orchestrator), 'Waiting on question');
  assert.equal(stateWord(s.units.find(unit => unit.label === 'I1')), 'Stuck · no events');
  assert.equal(stateWord({ status: 'busy', statusDetail: 'busy' }), 'Busy');
  assert.equal(stateWord({ status: 'idle', statusDetail: 'unknown-detail' }), 'Idle');
  assert.deepEqual(['busy', 'plan', 'question', 'merged', 'archived'].map(tileWord), ['Busy', 'Plan waiting', 'Question', 'Merged', 'Archived']);
});

test('tiles are every child session and the running or stuck sub-agents, attention first', () => {
  const grid = tileGrid(example());
  assert.equal(grid.density, 'two');
  assert.equal(grid.more, 0);
  assert.deepEqual(grid.tiles.map(tile => tile.label), ['I1', 'table-research', 'B2', 'F1', 'B1', 'map-import-module', 'D5', 'F2a', 'B0']);
  const stuck = grid.tiles[1];
  assert.deepEqual({ status: stuck.status, word: stuck.word, attention: stuck.attention, subagent: stuck.subagent }, { status: 'stuck', word: 'Stuck', attention: true, subagent: true });
  assert.equal(grid.tiles.find(tile => tile.label === 'B1').attention, false);
});

test('tile density follows the count, and past 16 the last slot counts the rest', () => {
  const s = exampleSnapshot();
  const template = s.units.find(unit => unit.label === 'B1');
  const withSessions = n => ({ ...s, units: Array.from({ length: n }, (_, i) => ({ ...template, id: `u${i}`, label: `U${i}` })) });
  assert.deepEqual(DENSITIES.map(entry => entry.max), [8, 12, 16]);
  assert.equal(tileGrid(withSessions(8)).density, 'full');
  assert.equal(tileGrid(withSessions(12)).density, 'two');
  assert.equal(tileGrid(withSessions(16)).density, 'one');
  const crowded = tileGrid(withSessions(28));
  assert.deepEqual({ density: crowded.density, shown: crowded.tiles.length, more: crowded.more }, { density: 'one', shown: 15, more: 13 });
});

test('the footer counts child sessions, running sub-agents and finished ones, including those the snapshot leaves out', () => {
  assert.deepEqual(unitCounts(example()), { sessions: 7, running: 2, finished: 3 });
  const s = exampleSnapshot();
  s.omittedSubagents = { done: 4, failed: 1 };
  assert.equal(unitCounts(s).finished, 8);
});

test('the legend is the regular header\'s six buckets', () => {
  const view = legend(example());
  assert.deepEqual(view.rows.map(row => [row.word, row.state, row.count]), [['Working', 'busy', 2], ['Stuck', 'stuck', 2], ['Waiting', 'plan', 2], ['Idle', 'idle', 1], ['Done', 'merged', 3], ['Failed', 'blocked', 2]]);
  assert.deepEqual({ live: view.live, ended: view.ended }, { live: 7, ended: 5 });
});

test('needs keep the regular order, name their units by label and point at a unit when there is one', () => {
  const view = needRows(example());
  assert.equal(view.total, 2);
  assert.deepEqual(view.rows.map(row => [row.who, row.word, row.state, row.unitId]), [['B2', 'Plan to approve', 'plan', 'ws-0004-b2'], ['D5', 'PR to approve', 'pr', 'ws-0007-d5']]);
  const s = exampleSnapshot();
  s.run.stalled = { since: NOW - 600000, reason: 'No unit **moved** for 30 minutes' };
  const stalled = needRows(s);
  assert.equal(stalled.total, 3);
  assert.deepEqual([stalled.rows[0].who, stalled.rows[0].word, stalled.rows[0].text, stalled.rows[0].unitId], ['SB', 'Swarm stalled', 'No unit moved for 30 minutes', null]);
});

test('activity shows the nine latest items with the newest last, coloured by their unit', () => {
  const rows = activityRows(example());
  assert.equal(rows.length, 9);
  assert.equal(rows[8].label, 'map-import-module');
  assert.equal(rows[8].text, 'started explore');
  assert.ok(rows.every((row, i) => !i || rows[i - 1].at <= row.at));
  const sb = rows.find(row => row.label === 'SB');
  assert.deepEqual([sb.status, sb.unitId], ['question', null]);
  assert.equal(rows.find(row => row.label === 'B1').unitId, 'ws-0003-b1');
});

test('PRs list open ones first, then merged, with the regular words', () => {
  const view = prRows(example());
  assert.deepEqual(view.rows.map(row => [row.id, row.word, row.state]), [[418, 'In review', 'busy'], [421, 'Draft', 'idle'], [412, 'Merged', 'merged'], [409, 'Merged', 'merged']]);
  assert.deepEqual({ opened: view.opened, merged: view.merged }, { opened: 4, merged: 2 });
  assert.deepEqual([view.rows[0].title, view.rows[0].who, view.rows[0].unitId], ['Orders and invoices API', 'B1 API', 'ws-0003-b1']);
});

test('the hourly rate interpolates the cost series over the last hour', () => {
  const series = [{ at: 0, credits: 0 }, { at: 2 * 3600000, credits: 200 }, { at: 3 * 3600000, credits: 500 }];
  assert.equal(hourlyRate(series), 300);
  assert.equal(hourlyRate([{ at: 0, credits: 10 }, { at: 1800000, credits: 60 }]), 100);
  assert.equal(hourlyRate([{ at: 0, credits: 10 }, { at: 300000, credits: 60 }]), null);
  assert.equal(hourlyRate([]), null);
  const view = costView(example());
  assert.equal(Math.round(view.perHour), 2339);
  assert.deepEqual(view.models.map(entry => [entry.model, Number(entry.share.toFixed(3))]), [['claude-sonnet-5', 1], ['claude-opus-4.8', 0.605], ['claude-haiku-5.5', 0.141], ['gpt-5.4-mini', 0.128]]);
  const ended = exampleSnapshot();
  ended.run.lifecycle = 'finished';
  ended.run.finishedAt = NOW;
  assert.equal(costView(ended).perHour, null);
});

test('clock, date, times, the next monitor check and the run line', () => {
  const at = new Date(2026, 9, 16, 9, 6, 2).getTime();
  assert.deepEqual(clockText(at), { hm: '09:06', s: '02' });
  assert.equal(dateText(at), 'Fri 16 October');
  assert.equal(timeText(at), '09:06');
  assert.equal(nextCheckAt(example()), NOW + 60000);
  assert.equal(runLine(example()), 'Sample story B · sample-project');
});
