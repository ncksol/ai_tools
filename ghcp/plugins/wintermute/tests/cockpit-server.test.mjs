import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDashboardServer } from '../server/http.mjs';
import { get } from './helpers/http.mjs';

test('the server serves the cockpit at /cockpit with the same headers, and creates no engine for it', async () => {
  let created = 0;
  const server = createDashboardServer({ createEngine: () => { created += 1; throw new Error('no engine'); }, version: 'test' });
  await server.listen();
  try {
    const page = await get(server.port, '/cockpit?swarm=ws-0000-root');
    assert.equal(page.status, 200);
    assert.equal(page.headers['content-type'], 'text/html; charset=utf-8');
    assert.match(page.body, /<title>Swarm cockpit<\/title>/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(server.port, '/cockpit/')).status, 404);
    assert.equal((await get(server.port, '/cockpit/x')).status, 404);
    assert.equal((await get(server.port, '/__proto__')).status, 404);
    assert.equal((await get(server.port, '/cockpit', { Host: 'evil.example' })).status, 403);
    assert.equal(created, 0);
  } finally {
    await server.close();
  }
});
