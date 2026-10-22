import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { createSwarmEngine } from '../engine/engine.mjs';
import { reportFromMessage } from '../engine/model/swarm.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { MINUTE } from '../engine/time.mjs';
import { reportKind, reportTitle } from '../ui/model.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { EventLog } from './helpers/event-log.mjs';
import { NO_SUCH_PID, T0, alwaysAlive, at } from './helpers/scenario.mjs';
import { tempDir } from './helpers/temp.mjs';

// Report shapes from a real swarm without the contract: a leading "Status: <status>" line, often with nothing else on it.
const shown = report => [reportKind(report), reportTitle(report)];

test('a report that opens with a bare "Status: complete" line takes its title from the next line', () => {
  const report = reportFromMessage('Status: complete\n\nVerdict: Ready to merge\n\nNo confirmed security issue.', 'handoff', T0);
  assert.equal(report.title, 'Verdict: Ready to merge');
  assert.deepEqual(shown(report), ['complete', 'Verdict: Ready to merge']);
  assert.deepEqual(shown(reportFromMessage('Status: complete.\nVerdict: Ready to merge.', 'handoff', T0)), ['complete', 'Verdict: Ready to merge.']);
});

test('without a status line or a purpose, a leading "Status: <status>" line sets the report status', () => {
  assert.deepEqual(shown(reportFromMessage('Status: complete. #18 is merged.\n- Merge commit d319898 on main.', undefined, T0)), ['complete', '#18 is merged.']);
  assert.deepEqual(shown(reportFromMessage('Status: complete\n\nVerdict: Ready to merge', undefined, T0)), ['complete', 'Verdict: Ready to merge']);
  assert.deepEqual(shown(reportFromMessage('Status: complete (angle: prompt robustness)\n\nVerdict: Needs fixes', undefined, T0)), ['complete', '(angle: prompt robustness)']);
  assert.deepEqual(shown(reportFromMessage('status: complete\nSummary: Drafted the outline.', undefined, T0)), ['complete', 'Drafted the outline.']);
  assert.deepEqual(shown(reportFromMessage('Status: needs input\nWhich branch should I use?', undefined, T0)), ['needs_input', 'Which branch should I use?']);
  assert.deepEqual(shown(reportFromMessage('Status: needs_input — which branch?', undefined, T0)), ['needs_input', 'which branch?']);
  assert.deepEqual(shown(reportFromMessage('Status: blocked\nCI is down.', undefined, T0)), ['blocked', 'CI is down.']);
  assert.equal(reportFromMessage('Status: complete\nDone.', undefined, T0).source, 'message');
});

test('a leading status line still counts when it carries Markdown emphasis, code or a list marker', () => {
  assert.deepEqual(shown(reportFromMessage('- **Status**: `complete`\n- Twelve tools were available.', undefined, T0)), ['complete', 'Twelve tools were available.']);
  assert.deepEqual(shown(reportFromMessage('**Status: complete.** Review of 84e1615; worktree clean.', undefined, T0)), ['complete', 'Review of 84e1615; worktree clean.']);
  assert.deepEqual(shown(reportFromMessage('**Status:** blocked\n\nThe build fails.', undefined, T0)), ['blocked', 'The build fails.']);
});

test('a leading status line is a fallback: the contract status line and the purpose take precedence', () => {
  const contract = reportFromMessage('swarm-status: blocked unit=api\nStatus: complete\nSummary: Waiting on CI.', 'handoff', T0);
  assert.deepEqual([contract.status, contract.source, contract.title], ['blocked', 'contract', 'Waiting on CI.']);
  const purpose = reportFromMessage('Status: complete\nWhich branch should I merge into?', 'needs_input', T0);
  assert.deepEqual([purpose.status, purpose.source, purpose.title], ['needs_input', 'purpose', 'Which branch should I merge into?']);
});

test('text that only looks like a status line leaves the report as progress with its own title', () => {
  for (const text of ['Status: completed the move', 'Status: green across the board', 'Status of the API: complete', 'The status: complete', 'Done.\nStatus: complete']) {
    const report = reportFromMessage(text, undefined, T0);
    assert.deepEqual([report.status, report.title], ['progress', text.split('\n')[0]], text);
  }
  assert.deepEqual(shown(reportFromMessage('Status: complete', undefined, T0)), ['complete', 'Untitled report'], 'nothing follows the status line');
});

function homeWithReport(message) {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root' });
  home.workspace({ id: 'ws-unit', projectId: 'project-1', name: 'Sample r1 review', createdAt: at(1), sessionId: 'cli-unit', parentId: 'ws-root', creatorSessionId: 'cli-root' });
  const root = new EventLog(T0);
  root.start(); root.turnStart(); root.at(at(2)); root.turnEnd();
  home.writeEvents('cli-root', root.events);
  const unit = new EventLog(at(1));
  unit.start(); unit.turnStart(); unit.at(at(5));
  unit.report('ws-root', message);
  unit.turnEnd();
  home.writeEvents('cli-unit', unit.events);
  home.lock('cli-root', NO_SUCH_PID + 1, T0);
  home.lock('cli-unit', NO_SUCH_PID + 2, at(1));
  return home;
}

test('a unit whose report opens "Status: complete" without a purpose reads as complete, not as stalled after a progress report', async () => {
  const home = homeWithReport('Status: complete\n\nVerdict: Ready to merge\n\nNo new findings.');
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-report-'), 'h'), now: () => at(5) + 45 * MINUTE, processProbe: alwaysAlive, prLookup: 'off' });
  const snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(validateSnapshot(snapshot), []);
  const unit = snapshot.units.find(item => item.label === 'r1');
  assert.deepEqual([unit.report.status, unit.report.source, unit.report.title], ['complete', 'message', 'Verdict: Ready to merge']);
  assert.equal(unit.statusDetail, 'idle');
  assert.ok(snapshot.feed.some(item => item.text === 'reported complete: Verdict: Ready to merge'), 'the feed names the report by its next line');
});

test('a sub-agent whose final answer opens with a bare status line takes its title from the next line', async () => {
  const home = new CopilotHome();
  home.project({ id: 'project-1', name: 'sample-project' });
  home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root' });
  home.workspace({ id: 'ws-kid', projectId: 'project-1', name: 'Sample k1 kid', createdAt: at(1), sessionId: 'cli-kid', parentId: 'ws-root', creatorSessionId: 'cli-root' });
  const kid = new EventLog(at(1));
  kid.start(); kid.turnStart(); kid.wait(MINUTE); kid.turnEnd();
  home.writeEvents('cli-kid', kid.events);
  const root = new EventLog(T0);
  root.start(); root.at(at(1));
  const call = root.subagent({ name: 'scout', type: 'explore', mode: 'background', agentId: 'ag-scout' });
  root.at(at(2)); root.sub(call, 'assistant.message', { content: '- **Status**: complete\n- 2 of the 286 items match.' });
  root.subagentDone(call, { durationMs: MINUTE, agentId: 'ag-scout' });
  home.writeEvents('cli-root', root.events);
  const engine = createSwarmEngine({ copilotHome: home.root, historyDir: path.join(tempDir('swarm-report-'), 'h'), now: () => at(3), processProbe: alwaysAlive, prLookup: 'off' });
  const snapshot = await engine.getSnapshot('ws-root');
  assert.deepEqual(validateSnapshot(snapshot), []);
  const unit = snapshot.units.find(item => item.kind === 'subagent');
  assert.deepEqual(shown(unit.report), ['complete', '2 of the 286 items match.']);
});
