import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Static checks on the Projects skills' text. They show what a Project and its children are told, not what a running session does.

const skill = name => readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8');
const COORDINATOR = skill('wintermute-project');
const WORKER = skill('wintermute-project-worker');

test('a carry-forward counts only when it was recorded and read back before the publish or merge at the new head', () => {
  assert.ok(COORDINATOR.includes('the earlier verdict stands for the new head only in the same unit and repository, only if its base branch and merge base are the ones the verdict named, and only once that carry-forward is recorded in `child_notes` and read back, before any publish or merge at the new head'));
  assert.ok(COORDINATOR.includes("A carry-forward recorded after the publish or merge doesn't count: that action ran without checks at its head."));
  assert.ok(COORDINATOR.includes('or a carry-forward that you recorded before the merge covers that head, at the same base branch and merge base (see "Follow-up jobs").'));
});

test('a carry-forward is a saved row only when the write changed exactly one row and a read shows it', () => {
  assert.ok(COORDINATOR.includes('Record it with one `sql` write, then read it back with a `SELECT`, both before the action. It counts only when the write reports exactly one row inserted or updated and the `SELECT` shows exactly one row for this unit with all of those values.'));
  assert.ok(COORDINATOR.includes('A write that fails or changes no row, such as an `UPDATE` whose `WHERE` names the wrong unit, records nothing.'));
});

test('nothing carries forward across a new base branch or merge base, and no rebase is mechanical in advance', () => {
  assert.ok(COORDINATOR.includes('A new base branch or merge base, as after a rebase or a retarget, ends it: size the new review and claims check from that change and run them, and never decide before a rebase that it will be mechanical, because a conflict resolved by hand is not.'));
  assert.ok(COORDINATOR.includes('such as a rename or a documentation change, on the same base branch and merge base, needs no review re-check.'));
  assert.doesNotMatch(COORDINATOR, /or a rebase with no new code and no conflicts resolved by hand, needs no review re-check/);
});

test('one rule decides which head a verdict covers, and the assignment, the gates and the supersession rule all use it', () => {
  assert.ok(COORDINATOR.includes('- **Which head a verdict covers.** A review, claims check or panel verdict covers a head only in its own unit and repository, at the base branch and merge base it names, and only when it checked that head, or when a carry-forward of the whole change from the head it checked to that head was recorded before the action (see "Follow-up jobs"). Anything else doesn\'t cover the head: it is superseded and checked again.'));
  assert.ok(COORDINATOR.includes("A new commit that you don't cover with a recorded carry-forward, a retarget of the PR to another base branch, or a new merge base, for example after its stacked parent was rebased, supersedes the unit's earlier review, claims check and panel verdicts: mark them `superseded`, and size the new check against the new head and base (see \"Follow-up jobs\")."));
  assert.ok(COORDINATOR.includes('To publish or merge, it is a head that the unit\'s verdicts cover (see "Which head a verdict covers" in "Reports and gates"), and the assignment also names the base branch and merge base they checked.'));
  assert.ok(COORDINATOR.includes('4. Publish: when the review and the claims check are clean at the same commit, base and merge base, or carried forward to that commit (see "Which head a verdict covers"), get the go-ahead'));
  assert.ok(COORDINATOR.includes('the final panel are all clean at the PR\'s head, base and merge base, or carried forward to that head (see "Which head a verdict covers"), get the go-ahead to merge,'));
  assert.ok(COORDINATOR.includes('a claims checker confirms the owner\'s claims at the pushed commit, or an earlier claims check covers that commit through a carry-forward (see "Which head a verdict covers" in "Reports and gates"), against the unit\'s PR base:'));
  assert.doesNotMatch(COORDINATOR, /it is the head at which the unit's checks passed/);
  assert.doesNotMatch(COORDINATOR, /A new commit on a unit, a retarget of its PR to another base branch, or a new merge base/);
  assert.doesNotMatch(COORDINATOR, /the earlier verdict stands for the new head\. /);
});
