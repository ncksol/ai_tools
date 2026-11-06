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
  '  - Every claims check goes to a claims checker at the claims check row, with its model and effort set explicitly: a new one, or the unit\'s idle claims checker from an earlier check of the same unit, which checks the new head from its own fresh fetch. This includes a request to refresh earlier claims, and the claims check of your own unit. Never give a claims check to a reviewer, a judge or any other agent because it already has the context, and never give a claims checker a reviewer\'s model or effort. A model or effort the user named for claims checks overrides the row.',
  '  - The claims check brief gives the scope to check, the repo, the branch, the exact pushed head commit, the target or base branch, and the evidence to send back: the tests run at that commit with their counts, CI at that commit, and the scope compared with the brief.',
  '  - A review brief covers only the review. The reviewer may still run tests, read CI or reproduce a failure when it needs that to establish a finding. Those results don\'t count as the claims check.',
  '  - If a reviewer reports that it was sent a claims job, start a claims checker for it. Don\'t count the check as done or as not needed.',
].join('\n');
const REUSE_CLAUSE = 'A claims check goes only to a claims checker, never to another idle agent because it has the context: start a new one, or use the unit\'s idle claims checker (see "Claims check" in "Evidence and review").';
const RECHECK_CLAUSE = 'A re-check covers only the review of the new diff: the claims check for the new commit goes to a claims checker (see "Claims check"), unless "Follow-up jobs" lets you skip it.';
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
    assert.ok(text.includes('- The last five rows are review rows. The claims check row above them is a check, not a review row.'), `${name}: review rows counted without the claims check row`);
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

const LIGHT_ROW = '| Light review | Sol at `high`, Sonnet at `xhigh` or Argon at `high`, never from the author\'s vendor | The review of a small follow-up with real logic that meets no critical-unit trigger (see "Follow-up jobs" in "Evidence and review"). Never a unit\'s first review. |';
const FOLLOW_UP_TIER_LINE = '- A follow-up job you hand out, such as a review, a claims check or a helper, gets the tier or review row that fits its own scope and risk, not the unit\'s (see "Follow-up jobs" in "Evidence and review"). A small fix in a critical unit doesn\'t get the critical review row, and a risky follow-up in a regular unit can. The owner\'s own fixes and rebases stay with the owner, at its model.';
const CRITICAL_POINTER = 'Size each follow-up job on its own (see "Follow-up jobs" in "Evidence and review"): a critical unit\'s follow-ups aren\'t critical by default, and a follow-up that meets a trigger gets critical scrutiny even in a regular unit.';
const CLAIMS_EXCEPTION = 'A follow-up commit may skip its claims check only as "Follow-up jobs" allows.';
const FINDINGS_POINTER = 'That PR is a follow-up: "Follow-up jobs" decides its review, its claims check and whether the panel re-checks it.';

const followUpRule = text => {
  const start = text.indexOf('\n- **Follow-up jobs**:');
  const end = text.indexOf('\n- **Re-checks**:', start);
  return start >= 0 && end > start ? text.slice(start + 1, end) : null;
};

test('both orchestrators have the same Follow-up jobs rule, just before Re-checks', () => {
  const rules = ORCHESTRATORS.map(name => followUpRule(agent(name)));
  for (const [i, rule] of rules.entries()) {
    assert.ok(rule, `${ORCHESTRATORS[i]}: rule before Re-checks`);
    assert.equal(rule.split('\n').filter(l => l.startsWith('- ')).length, 1, `${ORCHESTRATORS[i]}: rule is the bullet right before Re-checks`);
  }
  assert.equal(rules[0], rules[1]);
});

test('the follow-up rule covers every follow-up type, both directions, its safeguards and the recorded reason', () => {
  const rule = followUpRule(agent('hands-on-session-orchestrator'));
  for (const phrase of [
    'fixes, reviewer re-checks, panel re-checks, claims checks and rebases, and any other later job',
    'A follow-up doesn\'t inherit the unit\'s tier, review rows, number of reviewers or critical status.',
    'The owner\'s description alone is not enough to lower the scrutiny',
    'needs no reviewer re-check',
    'gets at most one reviewer',
    'start one at the light review row',
    'gets a critical review of the change',
    'gets more scrutiny than the unit had',
    'The vendor rule, security routing, the claims check rules, required human or project reviews and the user\'s explicit choices apply at whatever level you choose.',
    'Lower the scrutiny only on evidence you state. If unsure, choose the higher level.',
    'in the unit\'s `child_notes` row, or in `own_units` for your own unit',
    'The owner still does the fixes and rebases on its own work, at its own model, which can\'t change: sizing sets their review and checks.',
  ]) assert.ok(rule.includes(phrase), phrase);
});

test('a follow-up skips its claims check only after an earlier pass, on a mechanical diff, with a test job that ran at the exact head', () => {
  const rule = followUpRule(agent('hands-on-session-orchestrator'));
  for (const phrase of [
    'an earlier claims check passed for this unit',
    'the whole change from the commit that check passed at to the new head is mechanical, touches no build, CI or test configuration, and removes or skips no tests',
    'CI\'s test job ran at the exact new head commit and passed, not skipped',
    'Read that CI result yourself as a quick job; this read is not a claims check.',
    'Otherwise the claims check runs.',
  ]) assert.ok(rule.includes(phrase), phrase);
});

test('the light review row sits between the claims check and regular review rows in both orchestrators', () => {
  for (const name of ORCHESTRATORS) {
    const lines = agent(name).split('\n');
    const at = lines.indexOf(CLAIMS_ROW);
    assert.ok(at >= 0, `${name}: claims row`);
    assert.equal(lines[at + 1], LIGHT_ROW, `${name}: light row follows the claims row`);
    assert.ok(lines[at + 2].startsWith('| Regular review |'), `${name}: regular row follows the light row`);
  }
});

test('the rules that follow-ups touch point to Follow-up jobs in both orchestrators', () => {
  for (const name of ORCHESTRATORS) {
    const text = agent(name);
    const line = start => text.split('\n').find(l => l.startsWith(start)) ?? '';
    assert.ok(line('- **Re-checks**').includes('gets the scrutiny that "Follow-up jobs" sizes for it'), `${name}: re-checks`);
    assert.ok(line('- **Re-checks**').includes('and only when it can affect how units work together or the spec as a whole'), `${name}: panel re-check`);
    assert.ok(line('  Record a one-line reason in the unit').includes(CRITICAL_POINTER), `${name}: critical units`);
    assert.ok(line('- **Claims check**').includes(CLAIMS_EXCEPTION), `${name}: claims check`);
    assert.ok(text.includes(FOLLOW_UP_TIER_LINE), `${name}: models and effort`);
    assert.ok(text.includes(FINDINGS_POINTER), `${name}: fix PR for a panel finding`);
    assert.doesNotMatch(text, /goes back to the same reviewer/, `${name}: old re-check rule removed`);
  }
});

test('each orchestrator keeps a unit\'s claims checker for its later claims checks', () => {
  assert.ok(agent('hands-on-orchestrator').includes('Run it as a one-off, read-only sub-agent. Start it with `mode: "background"`, so that it can take the unit\'s later claims checks.'));
  assert.ok(agent('hands-on-session-orchestrator').includes('created with `base_branch` set to that branch. Keep it until the unit merges, so that it can take the unit\'s later claims checks.'));
});
