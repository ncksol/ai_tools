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

const ROUTING = [
  '  - Before you choose who does a job, decide whether it is a review or a claims check. A review looks for defects. A claims check confirms what the owner says it delivered, at the pushed commit; the owner\'s own report is not that proof. If a request asks for both, such as "re-check the fix and refresh the test claims", split it into two jobs: the review part goes to its reviewer, and the claims part goes to a claims checker.',
  '  - Every claims check goes to a new claims checker at the claims check row, with its model and effort set explicitly. This includes a request to refresh earlier claims, and the claims check of your own unit. Never give a claims check to a reviewer, a judge or any other agent because it already has the context, and never give a claims checker a reviewer\'s model or effort. A model or effort the user named for claims checks overrides the row.',
  '  - The claims check brief gives the scope to check, the repo, the branch, the exact pushed head commit, the target or base branch, and the evidence to send back: the tests run at that commit with their counts, CI at that commit, and the scope compared with the brief.',
  '  - A review brief covers only the review. The reviewer may still run tests, read CI or reproduce a failure when it needs that to establish a finding. Those results don\'t count as the claims check.',
  '  - If a reviewer reports that it was sent a claims job, start a claims checker for it. Don\'t count the check as done or as not needed.',
].join('\n');
const REUSE_CLAUSE = 'A claims check never goes to an idle agent because it has the context: start a new claims checker (see "Claims check" in "Evidence and review").';
const RECHECK_CLAUSE = 'A re-check covers only the review of the new diff: the claims check for the new commit goes to a new claims checker (see "Claims check").';
const OWN_UNIT_LINE = '- Start its claims check and its regular or critical review yourself, as separate jobs, as you would for a child\'s unit (see "Evidence and review").';
const CLAIMS_ROW = '| Claims check | Sol at `medium`; Opus at `low` if Sol isn\'t listed | The check before every merge, publish and "done". A check, not a review. |';

test('both orchestrators have the same claims routing rule under the Claims check bullet', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    const at = text.indexOf('- **Claims check**:');
    assert.ok(at >= 0, `${name}: claims bullet`);
    const bulletEnd = text.indexOf('\n', at);
    assert.equal(text.slice(bulletEnd + 1, bulletEnd + 1 + ROUTING.length), ROUTING, `${name}: routing follows the bullet`);
  }
});

test('combined review-and-claims requests are split, and claims refreshes and own units get a new checker', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    assert.match(text, /split it into two jobs/, name);
    assert.match(text, /a request to refresh earlier claims, and the claims check of your own unit/, name);
    assert.ok(text.includes(OWN_UNIT_LINE), `${name}: own-unit line`);
  }
});

test('each orchestrator runs the claims checker as its own delegation type', () => {
  assert.ok(agent('hands-on-orchestrator').includes('Run it as a one-off, read-only sub-agent.'));
  assert.ok(agent('hands-on-orchestrator').includes('Start every sub-agent as `wintermute:orchestrator-worker`.'));
  assert.ok(agent('hands-on-session-orchestrator').includes('Run it as a one-off, read-only session, created with `base_branch` set to that branch.'));
  assert.ok(agent('hands-on-session-orchestrator').includes('Create every child, owner or one-off, with `kickoff.agent: "wintermute:session-worker"`'));
});

test('reuse of idle agents and re-checks exclude claims checks', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    const reuse = text.split('\n').find(l => l.startsWith('- Send a follow-up to an idle '));
    assert.ok(reuse && reuse.includes(REUSE_CLAUSE), `${name}: split-work reuse rule`);
    const recheck = text.split('\n').find(l => l.startsWith('- **Re-checks**'));
    assert.ok(recheck && recheck.includes(RECHECK_CLAUSE), `${name}: re-check rule`);
  }
  const step4 = agent('hands-on-session-orchestrator').split('\n').find(l => l.startsWith('4. If an idle session'));
  assert.ok(step4 && step4.includes(REUSE_CLAUSE), 'helper request step 4');
});

test('the claims check row keeps its models and is no longer called a review row', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    assert.ok(text.includes(CLAIMS_ROW), `${name}: row unchanged`);
    assert.doesNotMatch(text, /last five rows are review rows/, name);
    assert.doesNotMatch(text, /a claims check, a review or a judge gets its review row/, name);
    assert.match(text, /a claims check gets the claims check row, a review or a judge gets its review row/, name);
  }
});

const MISROUTE_HEAD = '- A claims check is a separate job from a review. If you are a reviewer and your brief or a follow-up also asks you to verify the author\'s claims for a merge, publish or "done", for example "refresh the test and lint claims", do the review and leave the claims job undone.';
const MISROUTE_TAIL = 'Don\'t do the claims job anyway, don\'t count it as done or as not needed, and don\'t start another agent for it. You may still run tests, read CI or reproduce a failure when your review needs that to establish a finding.';

test('both workers hand a misrouted claims job back and keep tests for findings', () => {
  const where = { 'orchestrator-worker': 'Under **Blockers or questions**, say that a claims job was sent to you and needs a separate claims checker.', 'session-worker': 'In your report, under `Blockers:`, say that a claims job was sent to you and needs a separate claims checker.' };
  for (const [name, middle] of Object.entries(where)) {
    assert.ok(agent(name).includes(`${MISROUTE_HEAD} ${middle} ${MISROUTE_TAIL}`), name);
  }
});
