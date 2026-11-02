import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// These are static checks on prompt text. They show what the agents are told, not what a running session does.

const agent = name => readFileSync(new URL(`../com.github.copilot/agents/${name}.agent.md`, import.meta.url), 'utf8');
const ORCHESTRATORS = ['hands-on-orchestrator', 'hands-on-session-orchestrator'];
const AGENTS = [...ORCHESTRATORS, 'session-worker', 'orchestrator-worker'];

const NO_WATCH_RULE = '- Don\'t have a child watch a PR after it opens or publishes one, draft or ready: no PR monitor, session automation, event subscription, polling loop, background script or heartbeat, and no other agent to do it. Don\'t watch a PR yourself either, your own unit\'s included: no polling loop, background script or heartbeat. The child reports, then goes on only with its assigned work and the required review and validation gates; don\'t keep it alive only to watch a PR. When you or the user need a PR\'s current state, CI or review comments, ask the owner for one check, or read them yourself as a quick job. A check is one read and schedules no other. The one exception is CI that a required gate needs and that is still running: the owner, or you for your own unit, may wait for it once with one blocking command that has a time limit of about 30 minutes, such as `gh pr checks --watch`, then report the result, or report CI as pending if the limit passes. Nothing reacts to new reviewer activity on its own: when you learn of review comments, send them to the owner as owned work.';
const KICKOFF_LINE = '- tell the child to send you its evidence and wait for your go-ahead before it opens a PR, takes one out of draft, or merges, and to report as soon as it opens a PR, without setting up anything to watch it afterwards. Once its PR is open and its assigned gates are done, it sends `complete`; when asked to check a PR, it reads it once and reports;';
const WORKER_RULE = '- After you open a PR, draft or ready, don\'t set up anything to watch it: no PR monitor, session automation, event subscription, polling loop or background script. Report, then go on only with your assigned work and the required review and validation gates, and send `complete` once they are done. When you are asked to check a PR\'s state, CI or review comments, read them once and report; don\'t schedule another check or promise to handle future review comments. When a required gate needs CI that is still running, you may wait for it once with one blocking command that has a time limit of about 30 minutes, such as `gh pr checks --watch`, then report the result, or report CI as pending if the limit passes.';

test('no agent prompt asks for a PR monitor to be started, kept or stopped', () => {
  for (const name of AGENTS) {
    assert.doesNotMatch(agent(name), /start monitoring|stop its PR monitor|PR monitoring|needs monitoring|monitor runs/i, name);
  }
});

test('both orchestrators forbid PR watching with the same words, in the rule and in every kickoff', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    assert.ok(text.includes(NO_WATCH_RULE), `${name}: no-watch rule`);
    assert.ok(text.includes(KICKOFF_LINE), `${name}: kickoff line`);
  }
});

test('session-worker forbids PR watching and keeps one-shot PR checks', () => {
  assert.ok(agent('session-worker').includes(WORKER_RULE));
});

test('a status-check reply while only waiting for PR reviews is complete, in all three report blocks', () => {
  const line = '- Send only results, blockers and questions. A reply to a status check from the orchestrator, when work continues and nothing is needed, is progress. When your objective is done and you are only waiting, for example for reviews of your open PR, the reply is complete.';
  for (const name of [...ORCHESTRATORS, 'session-worker']) assert.ok(agent(name).includes(line), name);
});
