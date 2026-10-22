import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BUCKET_MS, createLedger, pullLedger } from '../engine/readers/ledger.mjs';
import { withReadOnly } from '../engine/sqlite.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS } from './helpers/sqlite-writer.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const row = (id, sessionId, nano, extra = {}) => ({ id, session_id: sessionId, agent_id: null, parent_tool_call_id: null, model: 'claude-sonnet-5', total_nano_aiu: nano, duration_ms: 1000, created_at: new Date(T0 + id * 60_000).toISOString(), ...extra });

test('apply aggregates per session, model, sub-agent call and 5-minute bucket', () => {
  const ledger = createLedger();
  ledger.apply([
    row(1, 'cli-a', 2e9),
    row(2, 'cli-a', 3e9, { model: 'gpt-5.5', parent_tool_call_id: 'call-7', agent_id: 'agent-7' }),
    row(3, 'cli-b', 1e9, { total_nano_aiu: null }),
    row(9, 'cli-b', 4e9),
  ]);
  const a = ledger.session('cli-a');
  assert.equal(a.nanoAiu, 5e9);
  assert.equal(a.calls, 2);
  assert.equal(a.apiMs, 2000);
  assert.deepEqual(a.byModel.get('gpt-5.5'), { nanoAiu: 3e9, calls: 1, apiMs: 1000 });
  assert.deepEqual(a.byParentToolCall.get('call-7'), { nanoAiu: 3e9, calls: 1, apiMs: 1000 });
  assert.equal(a.firstAt, T0 + 60_000);
  assert.equal(a.lastAt, T0 + 120_000);
  assert.equal(a.buckets.get(Math.floor((T0 + 60_000) / BUCKET_MS) * BUCKET_MS), 5e9);
  assert.equal(ledger.session('cli-b').nanoAiu, 4e9);
  assert.equal(ledger.lastId, 9);
  const both = ledger.sumFor(['cli-a', 'cli-b', 'cli-a', 'missing']);
  assert.equal(both.nanoAiu, 9e9);
  assert.equal(both.calls, 4);
  assert.equal(both.byModel.get('claude-sonnet-5').calls, 3);
});

test('rows at or below the watermark are ignored', () => {
  const ledger = createLedger();
  ledger.apply([row(5, 'cli-a', 1e9)]);
  ledger.apply([row(5, 'cli-a', 1e9), row(4, 'cli-a', 1e9)]);
  assert.equal(ledger.session('cli-a').calls, 1);
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: pullLedger reads incrementally in batches`, async () => {
    const home = new CopilotHome();
    home.usage([
      { sessionId: 'cli-a', nanoAiu: 1e9, createdAt: T0 },
      { sessionId: 'cli-a', nanoAiu: 2e9, createdAt: T0 + 1000, parentToolCallId: 'call-1', agentId: 'agent-1', initiator: 'sub-agent' },
      { sessionId: 'cli-b', nanoAiu: 4e9, createdAt: T0 + 2000 },
    ]);
    const ledger = createLedger();
    assert.equal(await withReadOnly(home.storeDb, { backend }, db => pullLedger(db, ledger, { batch: 2 })), 3);
    assert.equal(ledger.sumFor(['cli-a', 'cli-b']).nanoAiu, 7e9);
    home.usage([{ sessionId: 'cli-a', nanoAiu: 8e9, createdAt: T0 + 3000 }]);
    assert.equal(await withReadOnly(home.storeDb, { backend }, db => pullLedger(db, ledger)), 1);
    assert.equal(ledger.session('cli-a').nanoAiu, 11e9);
    assert.equal(ledger.session('cli-a').byParentToolCall.get('call-1').nanoAiu, 2e9);
  });
}
