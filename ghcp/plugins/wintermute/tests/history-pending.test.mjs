import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { createPrLookup } from '../engine/model/pr-lookup.mjs';
import { HOUR, MINUTE } from '../engine/time.mjs';
import { historyHtml } from '../ui/history.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { T0, alwaysAlive, at } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

/** A run whose only unit reports an ADO PR that merged; the run's last event is at(20). */
function prHome() {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-pr', projectId: 'project-1', name: 'PR story', createdAt: T0, sessionId: 'cli-pr' });
  home.workspace({ id: 'ws-pr-unit', projectId: 'project-1', name: 'Sample p1 unit', createdAt: at(5), sessionId: 'cli-pr-unit', parentId: 'ws-pr', creatorSessionId: 'cli-pr', branch: 'feature/p1', baseBranch: 'main' });
  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.at(at(10)); root.turnEnd();
  home.writeEvents('cli-pr', root.events);
  const unit = new EventLog(at(5));
  unit.start(); unit.turnStart(); unit.at(at(20));
  unit.report('ws-pr', 'Opened PR !4711 for review.', 'handoff');
  unit.turnEnd();
  home.writeEvents('cli-pr-unit', unit.events);
  home.workspaceYaml('cli-pr-unit', { cwd: '/synthetic/worktrees/p1', hostType: 'ado', repository: 'sample-org/sample-project/sample-repo' });
  return home;
}

const MERGED_REPLY = JSON.stringify({ status: 'completed', title: 'Sample PR', creationDate: '2026-10-15T08:30:00Z', closedDate: '2026-10-15T09:00:00Z' });

function gatedLookup(clock) {
  const gate = { release: null };
  const run = () => new Promise(resolve => { gate.release = resolve; });
  return { gate, lookup: createPrLookup({ run, now: () => clock(), azureExtensionInstalled: async () => true }) };
}

const item = async engine => (await engine.listHistory()).find(run => run.id === 'ws-pr');
const mergedCell = run => historyHtml([run]).match(/<span class="k">Merged <\/span>([^<]*)</)[1];

test('the History list shows no merged count for a finished run until its first PR lookups finish', async t => {
  await t.test('a live, tracked run turns finished while its lookup is pending', async () => {
    const historyDir = path.join(tempDir('swarm-history-pending-'), 'history');
    let clock = at(30);
    const { gate, lookup } = gatedLookup(() => clock);
    const engine = createSwarmEngine({ copilotHome: prHome().root, historyDir, now: () => clock, processProbe: alwaysAlive, prLookup: lookup, persistHistory: true });
    await engine.refresh();
    clock = at(20) + 2 * HOUR + MINUTE;
    await engine.refresh();
    const pending = await item(engine);
    assert.equal(pending.merged, null);
    assert.equal(pending.summarized, false);
    assert.equal(mergedCell(pending), '—');
    assert.equal(existsSync(path.join(historyDir, 'runs', 'ws-pr.json')), false, 'no summary is stored with a merged count that is not known yet');
    gate.release(MERGED_REPLY);
    await lookup.settle();
    await engine.refresh();
    const settled = await item(engine);
    assert.equal(settled.merged, 1);
    assert.equal(mergedCell(settled), '1 of 1');
  });

  await t.test('getRunSummary on a finished run that was never tracked', async () => {
    const historyDir = path.join(tempDir('swarm-history-pending-'), 'history');
    const clock = () => at(20) + 3 * HOUR;
    const { gate, lookup } = gatedLookup(clock);
    const engine = createSwarmEngine({ copilotHome: prHome().root, historyDir, now: clock, processProbe: alwaysAlive, prLookup: lookup, persistHistory: true });
    await engine.getRunSummary('ws-pr');
    assert.equal(lookup.pending({ provider: 'ado', id: 4711, repo: 'sample-org/sample-project/sample-repo' }), true);
    const pending = await item(engine);
    assert.equal(pending.merged, null);
    assert.equal(mergedCell(pending), '—');
    gate.release(MERGED_REPLY);
    await lookup.settle();
    await engine.refresh();
    assert.equal((await item(engine)).merged, 1);
  });
});
