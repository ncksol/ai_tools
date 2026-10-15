import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dateRange } from '../ui/format.mjs';
import { historyHtml, runHtml } from '../ui/history.mjs';
import { fixture } from './helpers/ui.mjs';

const text = html => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

test('the history list shows each finished run with time and cost first', () => {
  const runs = fixture('example-history.json');
  const html = historyHtml(runs);
  assert.match(text(html), /^Finished runs 2 runs Run Dates Took Busy Cost Merged/);
  assert.deepEqual([...html.matchAll(/data-run="([^"]+)"/g)].map(match => match[1]), ['ws-1000-root', 'ws-2000-root']);
  assert.ok(text(html).includes(`Sample story A sample-project ${dateRange(runs[0].startedAt, runs[0].finishedAt)} Took 72h 10m Busy 50h 30m 49,160 cr · ≈$492 Merged 3 of 4`));
  assert.ok(text(html).includes('Took 8h 45m Busy — 6,320 cr · ≈$63 Merged —'));
  assert.match(historyHtml(null), /Loading finished runs…/);
  assert.match(text(historyHtml([])), /No finished runs yet A run moves here once nothing has happened in it for 2 hours\./);
});

test('the run summary answers how long it took and what it cost', () => {
  const summary = fixture('example-run-summary.json');
  const html = runHtml(summary);
  const words = text(html);
  assert.match(html, /<button type="button" class="link" data-page="history">← All runs<\/button>/);
  assert.match(words, /Sample story A sample-project · finished/);
  assert.ok(words.includes(`Took, start to finish 72h 10m ${dateRange(summary.startedAt, summary.finishedAt)}`));
  assert.match(words, /Cost 49,160 cr · ≈\$492 orchestrator, 4 children and 23 sub-agents/);
  assert.match(words, /Agent busy time 50h 30m Waiting on you 7h 40m Children 4, 3 merged Sub-agents 23 First child 18m after the start/);
});

test('time by unit draws start-to-finish spans with busy time, and marks units closed without merging', () => {
  const html = runHtml(fixture('example-run-summary.json'));
  assert.equal((html.match(/<div class="g-row">/g) ?? []).length, 5);
  assert.match(text(html), /SA orchestrator busy 19h 24m/);
  assert.match(text(html), /P1 perf busy 5h 12m, not merged/);
  assert.match(html, /<span class="g-span no" style="left:69\.28%;width:22\.17%"><\/span>/);
  assert.match(html, /<span class="g-span" style="left:0\.00%;width:100\.00%"><\/span>/);
  assert.deepEqual([...html.matchAll(/<span style="left:[\d.]+%">(\d+h)<\/span>/g)].map(match => match[1]), ['0h', '12h', '24h', '36h', '48h', '60h', '72h']);
});

test('cost breaks down by unit, by model and by sub-agent type', () => {
  const html = runHtml(fixture('example-run-summary.json'));
  const byUnit = html.split('<h3>Cost by unit</h3>')[1].split('</section>')[0];
  assert.deepEqual([...byUnit.matchAll(/<span class="hb-l">([^<]+)<\/span>/g)].map(match => match[1]), ['SA orchestrator', 'A3 API', 'S1 security', 'A1 model', 'P1 perf']);
  assert.match(text(html), /claude-sonnet-5 30,160 cr · ≈\$301\.60 · 5h 00m/);
  assert.match(text(html), /23 runs, 1h 25m, 5,900 cr\. Already included in the unit costs\./);
  assert.match(text(html), /code-review · 9 runs · 0h 45m 4,100 cr · ≈\$41\.00/);
});

test('loading, missing and empty summaries', () => {
  assert.match(runHtml(null), /Loading the run summary…/);
  assert.match(text(runHtml(false)), /← All runs This run's summary is not available\./);
  const summary = { ...fixture('example-run-summary.json'), models: [], subagentTypes: [], firstChildAt: null };
  const words = text(runHtml(summary));
  assert.match(words, /No model calls recorded\./);
  assert.match(words, /No sub-agents in this run\./);
  assert.match(words, /First child none/);
});
