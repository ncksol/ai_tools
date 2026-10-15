import { readFileSync } from 'node:fs';
import { createFakeEngine } from '../engine/fake-engine.mjs';
import { stressScenario } from './demo-scenarios.mjs';

const FIXTURES = new URL('../tests/fixtures/', import.meta.url);
const TIME_KEY = /^(at|since|start|end)$|At$/;
const MIN = 60000;
const BUCKET = 5 * MIN;
const SCENARIOS = ['example', 'stress'];
const AGENTS = [['explore', 'gpt-5.4-mini', 'Map the module'], ['task', 'claude-haiku-5.5', 'Run the test suite'], ['code-review', 'claude-sonnet-5', 'Review the diff']];
const REPORTS = ['Review fixes pushed.', 'Tests pass on the branch.', 'Edge cases are covered.', 'Docs updated for the new endpoint.'];
const round1 = value => Math.round(value * 10) / 10;

/** PR 1's synthetic example swarm, swarm list, history and run summary. */
export function loadFixtures(dir = FIXTURES) {
  const read = name => JSON.parse(readFileSync(new URL(name, dir), 'utf8'));
  return {
    snapshots: [read('example-snapshot.json')],
    swarms: read('example-swarms.json'),
    history: read('example-history.json'),
    summaries: [read('example-run-summary.json')],
  };
}

/** A copy with every epoch-millisecond time moved by delta. Durations are never epoch values, so they stay. */
export function shiftTimes(value, delta) {
  if (Array.isArray(value)) return value.map(item => shiftTimes(item, delta));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = TIME_KEY.test(key) && Number.isInteger(item) && item > 1e12 ? item + delta : shiftTimes(item, delta);
  }
  return out;
}

function addFeed(snapshot, session, kind, text, now) {
  const item = { id: `${session.id}:${kind}:demo-${snapshot.revision}`, at: now, unitId: session.id, label: session.label, kind, text };
  snapshot.feed = [item, ...snapshot.feed].slice(0, 200);
  session.recent = [item, ...session.recent].slice(0, 6);
  session.lastEventAt = now;
  session.activity.lastEventAt = now;
}

function addCost(snapshot, session, amount, now) {
  session.cost.credits = round1(session.cost.credits + amount);
  session.cost.calls += 1;
  const cost = snapshot.cost;
  cost.credits = round1(cost.credits + amount);
  cost.usd = Math.round(cost.credits) / 100;
  cost.maxUnitCredits = Math.max(0, ...snapshot.units.map(unit => unit.cost.credits));
  const model = cost.byModel.find(entry => entry.model === session.model);
  if (model) {
    model.credits = round1(model.credits + amount);
    model.calls += 1;
  }
  const bucket = now - (now % BUCKET);
  const last = cost.series[cost.series.length - 1];
  if (last && bucket <= last.at) last.credits = cost.credits;
  else cost.series.push({ at: bucket, credits: cost.credits });
}

function startSubagent(snapshot, session, [type, model, task], now) {
  const id = `demo-call-${snapshot.revision}`;
  session.subagents.unshift({ id, name: task.toLowerCase().replace(/[^a-z0-9]+/g, '-'), type, model, mode: 'background', status: 'running', startedAt: now, endedAt: null, durationMs: null, credits: 0, task });
  session.timeline.subagents.push({ id, start: now, end: null, type });
  addFeed(snapshot, session, 'subagent-start', `started ${type}: ${task.toLowerCase()}`, now);
}

function finishSubagent(snapshot, session, sub, credits, now) {
  Object.assign(sub, { status: 'completed', endedAt: now, durationMs: now - sub.startedAt, credits });
  const running = session.subagents.filter(item => item.status === 'running');
  const done = session.subagents.filter(item => item.status !== 'running').sort((a, b) => (b.endedAt ?? b.startedAt) - (a.endedAt ?? a.startedAt));
  session.subagents = [...running, ...done];
  const bar = session.timeline.subagents.find(item => item.id === sub.id);
  if (bar) bar.end = now;
  addCost(snapshot, session, credits, now);
  addFeed(snapshot, session, 'subagent-done', `${sub.type} finished`, now);
}

function addReport(snapshot, session, text, now) {
  session.report = { status: 'progress', source: 'contract', at: now, title: text, summary: text, evidence: ['Tests pass on the branch'], blockers: [], body: null, unit: session.label, commit: null };
  if (session.progress && session.progress.done < session.progress.total) session.progress.done += 1;
  session.timeline.marks.push({ at: now, kind: 'report', text, status: 'progress' });
  addFeed(snapshot, session, 'report', `reported progress: ${text}`, now);
}

function checkMonitor(snapshot, unit, now) {
  const monitor = unit.monitor;
  if (monitor.state !== 'alive' || !monitor.nextCheckAt || monitor.nextCheckAt > now) return;
  monitor.lastCheckAt = now;
  monitor.nextCheckAt = now + (monitor.everyMinutes ?? 10) * MIN;
  unit.timeline.marks.push({ at: now, kind: 'monitor', text: 'PR monitor check', status: null });
  addFeed(snapshot, unit, 'monitor-check', 'PR monitor check', now);
}

/** One simulated step: due monitor checks, cost on an active session, and sometimes a sub-agent change or a report. */
export function simulateStep(snapshot, now, random = Math.random) {
  const next = structuredClone(snapshot);
  const pick = list => list[Math.min(list.length - 1, Math.floor(random() * list.length))];
  next.generatedAt = now;
  next.revision += 1;
  next.run.lastActivityAt = now;
  for (const unit of next.units) checkMonitor(next, unit, now);
  const active = [next.orchestrator, ...next.units].filter(session => session.status === 'busy' || session.subagents.some(sub => sub.status === 'running'));
  if (!active.length) return next;
  const session = pick(active);
  addCost(next, session, 20 + Math.round(random() * 130), now);
  const running = session.subagents.filter(sub => sub.status === 'running');
  const roll = random();
  if (roll < 0.3 && running.length < 2) startSubagent(next, session, pick(AGENTS), now);
  else if (roll < 0.55 && running.length) finishSubagent(next, session, running[running.length - 1], 30 + Math.round(random() * 400), now);
  else if (roll < 0.7 && session !== next.orchestrator && session.status === 'busy') addReport(next, session, pick(REPORTS), now);
  return next;
}

/**
 * A SwarmEngine over synthetic data with times moved to the present, so clocks and ages look live. It never reads
 * Copilot data. With simulate, start() changes the first swarm every stepMs; stop() ends that.
 */
export function createDemoEngine({ scenario = 'example', now = Date.now, simulate = true, random = Math.random, stepMs = 4000, fixtures = loadFixtures() } = {}) {
  if (!SCENARIOS.includes(scenario)) throw new Error(`Unknown demo scenario: ${scenario}`);
  const base = scenario === 'stress' ? stressScenario(fixtures) : fixtures;
  const data = shiftTimes(base, now() - base.snapshots[0].generatedAt);
  const fake = createFakeEngine(data);
  let current = data.snapshots[0];
  let timer = null;
  const step = () => {
    current = simulateStep(current, now(), random);
    fake.push(current);
    return current;
  };
  return {
    ...fake,
    isDemo: true,
    step,
    start() {
      if (!simulate || timer) return;
      timer = setInterval(step, stepMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
