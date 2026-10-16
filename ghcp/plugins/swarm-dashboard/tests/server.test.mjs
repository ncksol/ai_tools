import { request } from 'node:http';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeEngine } from '../engine/fake-engine.mjs';
import { validateSnapshot } from '../engine/schema.mjs';
import { assetsFingerprint, loadAssets, withFingerprint } from '../server/assets.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { get, openEvents } from './helpers/http.mjs';
import { deepFreeze, exampleSnapshot, fixture } from './helpers/ui.mjs';

function spyEngine() {
  const fake = createFakeEngine({ snapshots: [exampleSnapshot()], swarms: fixture('example-swarms.json'), history: fixture('example-history.json'), summaries: [fixture('example-run-summary.json')] });
  const calls = { created: 0, refresh: 0, start: 0, stop: 0 };
  const engine = { ...fake, async refresh() { calls.refresh += 1; }, start() { calls.start += 1; }, stop() { calls.stop += 1; } };
  return { calls, fake, createEngine: () => { calls.created += 1; return engine; } };
}

async function started(createEngine, options = {}) {
  const server = createDashboardServer({ createEngine, version: 'test', hub: { engineIdleMs: 60, heartbeatMs: 1000 }, ...options });
  await server.listen();
  return server;
}

test('only the files in ui/ are served', () => {
  const assets = loadAssets();
  assert.ok(assets.has('/index.html'));
  assert.equal(assets.get('/ui/styles.css').type, 'text/css; charset=utf-8');
  assert.equal(assets.get('/ui/app.mjs').type, 'text/javascript; charset=utf-8');
  for (const path of assets.keys()) assert.match(path, /^\/(index\.html|ui\/[\w.-]+\.(css|mjs|html))$/);
});

test('the page, its assets and health answer only to the dashboard\'s own host', async () => {
  const { createEngine, calls } = spyEngine();
  const server = await started(createEngine);
  try {
    const page = await get(server.port, '/');
    assert.equal(page.status, 200);
    assert.match(page.body, /id="dash"/);
    assert.match(page.headers['content-security-policy'], /default-src 'none'; script-src 'self'/);
    assert.doesNotMatch(page.headers['content-security-policy'], /frame-ancestors/);
    assert.equal(page.headers['x-frame-options'], undefined);
    assert.equal(page.headers['x-content-type-options'], 'nosniff');
    assert.equal((await get(server.port, '/ui/styles.css')).status, 200);
    assert.equal((await get(server.port, '/ui/../engine/schema.mjs')).status, 404);
    assert.equal((await get(server.port, '/engine/schema.mjs')).status, 404);
    const health = JSON.parse((await get(server.port, '/api/health')).body);
    assert.deepEqual({ app: health.app, version: health.version }, { app: 'swarm-dashboard', version: 'test' });
    assert.equal((await get(server.port, '/', { Host: 'evil.example' })).status, 403);
    assert.equal((await get(server.port, '/', { Host: `attacker.example:${server.port}` })).status, 403);
    assert.equal((await get(server.port, '/', { Host: `localhost:${server.port}` })).status, 200);
    assert.equal(calls.created, 0, 'serving the page creates no engine');
  } finally {
    await server.close();
  }
});

test('the data and live-update endpoints refuse requests that another website starts', async () => {
  const { createEngine, calls } = spyEngine();
  const server = await started(createEngine);
  const port = server.port;
  try {
    assert.equal((await get(port, '/api/swarms', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await get(port, '/api/swarms', { 'Sec-Fetch-Site': 'same-site' })).status, 403);
    assert.equal((await get(port, '/api/events', { 'Sec-Fetch-Site': 'cross-site' })).status, 403);
    assert.equal((await get(port, '/api/health', { Origin: 'http://evil.example' })).status, 403);
    assert.equal((await get(port, '/api/snapshot', { Origin: 'null' })).status, 403);
    assert.equal(calls.created, 0, 'a refused request starts no engine');
    assert.equal((await get(port, '/', { 'Sec-Fetch-Site': 'cross-site' })).status, 200);
    assert.equal(calls.created, 0, 'a document load starts no engine');
    assert.equal((await get(port, '/api/swarms', { 'Sec-Fetch-Site': 'same-origin' })).status, 200);
    assert.equal((await get(port, '/api/swarms', { 'Sec-Fetch-Site': 'none' })).status, 200);
    assert.equal((await get(port, '/api/swarms', { Origin: `http://127.0.0.1:${port}` })).status, 200);
    assert.equal((await get(port, '/api/swarms', { Origin: `http://localhost:${port}` })).status, 200);
    assert.equal((await get(port, '/api/swarms')).status, 200);
  } finally {
    await server.close();
  }
});

test('health says which sample data the server shows, if any', async () => {
  const { createEngine } = spyEngine();
  const plain = await started(createEngine);
  const sample = await started(createEngine, { demo: 'example' });
  try {
    assert.equal(JSON.parse((await get(plain.port, '/api/health')).body).demo, null);
    assert.equal(JSON.parse((await get(sample.port, '/api/health')).body).demo, 'example');
  } finally {
    await plain.close();
    await sample.close();
  }
});

test('other methods are refused', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  try {
    const response = await fetch(`${server.url}api/health`, { method: 'POST' });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, HEAD');
  } finally {
    await server.close();
  }
});

test('API calls create the engine on demand and drop it when idle', async () => {
  const { createEngine, calls } = spyEngine();
  let idle = 0;
  const server = await started(createEngine, { onIdle: () => { idle += 1; } });
  try {
    const history = JSON.parse((await get(server.port, '/api/history')).body);
    assert.equal(history.length, 2);
    assert.equal(calls.created, 1);
    assert.equal(calls.refresh, 1);
    assert.equal(calls.start, 0, 'no polling without a connected page');
    assert.equal(JSON.parse((await get(server.port, '/api/runs/ws-1000-root')).body).id, 'ws-1000-root');
    assert.equal((await get(server.port, '/api/runs/nope')).status, 404);
    const { snapshot } = JSON.parse((await get(server.port, '/api/snapshot')).body);
    assert.equal(snapshot.run.id, 'ws-0000-root');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.equal(idle, 1);
    assert.equal(calls.stop, 1, 'the dropped engine is stopped');
    await get(server.port, '/api/swarms');
    assert.equal(calls.created, 2, 'a new engine after the old one was dropped');
    await server.close();
    assert.equal(calls.stop, 2, 'closing the server stops the engine it holds');
  } finally {
    await server.close();
  }
});

test('a HEAD request for the event stream opens no connection', async () => {
  const { createEngine, calls } = spyEngine();
  const server = await started(createEngine);
  try {
    const response = await fetch(`${server.url}api/events`, { method: 'HEAD' });
    assert.equal(response.status, 200);
    assert.equal(server.clientCount(), 0);
    assert.equal(calls.created, 0);
  } finally {
    await server.close();
  }
});

test('a page hears hello before anything else', async () => {
  const { fake } = spyEngine();
  const engine = { ...fake, async refresh() { const next = exampleSnapshot(); next.revision += 1; fake.push(next); } };
  const server = await started(() => engine);
  const page = openEvents(server.port, '/api/events');
  try {
    await page.waitFor(entry => entry.event === 'snapshot');
    assert.deepEqual(page.events.slice(0, 3).map(entry => entry.event), ['hello', 'swarms', 'snapshot']);
  } finally {
    page.close();
    await server.close();
  }
});

test('an engine dropped while a request reads from it is stopped again afterwards', async () => {
  const { fake } = spyEngine();
  let stops = 0;
  let open;
  const gate = new Promise(resolve => { open = resolve; });
  const engine = { ...fake, stop() { stops += 1; }, async listHistory() { await gate; return fake.listHistory(); } };
  const server = await started(() => engine);
  try {
    const request = get(server.port, '/api/history').catch(() => null);
    await new Promise(resolve => setTimeout(resolve, 50));
    await server.close();
    assert.equal(stops, 1);
    open();
    await request;
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(stops, 2, 'the request stops the engine it used once it ends');
  } finally {
    open();
    await server.close();
  }
});

test('a page gets hello, swarms and its snapshot, then pushes only for its swarm', async () => {
  const { createEngine, calls, fake } = spyEngine();
  const server = await started(createEngine);
  const page = openEvents(server.port, '/api/events');
  try {
    const hello = await page.waitFor(entry => entry.event === 'hello');
    assert.equal(hello.data.demo, false);
    assert.equal((await page.waitFor(entry => entry.event === 'swarms')).data.length, 2);
    const first = await page.waitFor(entry => entry.event === 'snapshot');
    assert.deepEqual(validateSnapshot(first.data.snapshot), []);
    assert.equal(calls.start, 1);
    const changed = exampleSnapshot();
    changed.revision += 1;
    changed.run.name = 'Renamed';
    fake.push(changed);
    const second = await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot.revision === changed.revision);
    assert.equal(second.data.snapshot.run.name, 'Renamed');
    const other = exampleSnapshot();
    other.run.id = 'ws-other';
    fake.push(other);
    await page.waitFor(entry => entry.event === 'swarms' && entry.data.some(swarm => swarm.id === 'ws-other'));
    assert.equal(page.events.filter(entry => entry.event === 'snapshot').length, 2);
  } finally {
    page.close();
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(calls.stop >= 1, true, 'polling stops when the last page leaves');
    await server.close();
  }
});

test('a page can ask for a swarm by id or by one of its sessions', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  const byId = openEvents(server.port, '/api/events?swarm=missing');
  const bySession = openEvents(server.port, '/api/events?session=cli-0003-b1');
  try {
    assert.equal((await byId.waitFor(entry => entry.event === 'snapshot')).data.snapshot, null);
    assert.equal((await bySession.waitFor(entry => entry.event === 'snapshot')).data.snapshot.run.id, 'ws-0000-root');
  } finally {
    byId.close();
    bySession.close();
    await server.close();
  }
});

test('a page that asked for no swarm follows the default once its swarm has ended', async () => {
  const { createEngine, fake } = spyEngine();
  const server = await started(createEngine);
  const page = openEvents(server.port, '/api/events');
  const bySession = openEvents(server.port, '/api/events?session=cli-0003-b1');
  try {
    assert.equal((await page.waitFor(entry => entry.event === 'snapshot')).data.snapshot.run.id, 'ws-0000-root');
    assert.equal((await bySession.waitFor(entry => entry.event === 'snapshot')).data.snapshot.run.id, 'ws-0000-root');
    const next = exampleSnapshot();
    next.run.id = 'ws-next';
    next.run.lastActivityAt += 60000;
    fake.push(next);
    await page.waitFor(entry => entry.event === 'swarms' && entry.data.some(swarm => swarm.id === 'ws-next'));
    assert.equal(page.events.filter(entry => entry.event === 'snapshot').length, 1, 'a live swarm does not take the page over');
    const ended = exampleSnapshot();
    ended.revision += 1;
    ended.run.lifecycle = 'finished';
    ended.run.finishedAt = ended.run.lastActivityAt;
    fake.push(ended);
    await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot.run.id === 'ws-next');
    const kept = await bySession.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot.revision === ended.revision);
    assert.equal(kept.data.snapshot.run.id, 'ws-0000-root');
    assert.equal(bySession.events.some(entry => entry.event === 'snapshot' && entry.data.snapshot.run.id === 'ws-next'), false);
  } finally {
    page.close();
    bySession.close();
    await server.close();
  }
});

test('the server never changes the snapshot objects the engine hands out', async () => {
  const fake = createFakeEngine({ snapshots: [exampleSnapshot()], swarms: fixture('example-swarms.json') });
  const frozen = deepFreeze(exampleSnapshot());
  const engine = { ...fake, getSnapshot: async () => frozen, findSwarm: async () => frozen.run.id };
  const server = await started(() => engine);
  const page = openEvents(server.port, '/api/events?session=cli-0003-b1');
  try {
    assert.deepEqual((await page.waitFor(entry => entry.event === 'snapshot')).data.snapshot, exampleSnapshot());
    assert.deepEqual(JSON.parse((await get(server.port, '/api/snapshot')).body).snapshot, exampleSnapshot());
  } finally {
    page.close();
    await server.close();
  }
});

test('a page opened from a session outside any swarm follows that session once it joins one', async () => {
  const { createEngine, fake } = spyEngine();
  const server = await started(createEngine);
  const page = openEvents(server.port, '/api/events?session=cli-new');
  try {
    assert.equal((await page.waitFor(entry => entry.event === 'snapshot')).data.snapshot.run.id, 'ws-0000-root');
    const joined = exampleSnapshot();
    joined.run.id = 'ws-new';
    joined.orchestrator.cliSessionIds = ['cli-new'];
    fake.push(joined);
    await page.waitFor(entry => entry.event === 'snapshot' && entry.data.snapshot.run.id === 'ws-new');
  } finally {
    page.close();
    await server.close();
  }
});

test('close ends live connections and frees the port', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  const port = server.port;
  const page = openEvents(port, '/api/events');
  await page.waitFor(entry => entry.event === 'snapshot');
  await server.close();
  await assert.rejects(get(port, '/api/health'));
});

test('a paused reader leaves at most one frame queued in the server, and gets the newest snapshot when it reads again', async () => {
  const big = exampleSnapshot();
  for (const unit of big.units) if (unit.report) unit.report.body = 'x'.repeat(20000);
  deepFreeze(big);
  const frameBytes = Buffer.byteLength(JSON.stringify({ serverNow: 0, snapshot: big })) + 64;
  assert.ok(frameBytes > 100000, `a frame of ${frameBytes} bytes is too small to back up a socket`);
  const engine = createFakeEngine({ snapshots: [big] });
  const server = await started(() => engine, { hub: { engineIdleMs: 60, heartbeatMs: 1000, stallMs: 10000 } });
  let response = null;
  const req = request({ host: '127.0.0.1', port: server.port, path: '/api/events' }, res => { response = res; res.pause(); });
  req.on('error', () => {});
  req.end();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    for (let waited = 0; server.clientCount() !== 1 && waited < 2000; waited += 10) await wait(10);
    assert.equal(server.clientCount(), 1);
    await wait(100);
    for (let i = 1; i <= 80; i += 1) {
      const next = structuredClone(big);
      next.revision = i;
      engine.push(next);
      await wait(5);
    }
    await wait(100);
    const queued = server.queuedBytes();
    assert.ok(queued <= frameBytes + 65536, `the server holds ${queued} bytes for one paused page; a frame is ${frameBytes}`);
    assert.equal(server.clientCount(), 1);

    const events = [];
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event = /^event: (.+)$/m.exec(block)?.[1];
        const data = /^data: (.+)$/m.exec(block)?.[1];
        if (event) events.push({ event, data: JSON.parse(data) });
      }
    });
    response.resume();
    const newest = entry => entry.event === 'snapshot' && entry.data.snapshot.revision === 80;
    for (let waited = 0; !events.some(newest) && waited < 3000; waited += 10) await wait(10);
    assert.ok(events.some(newest), `no snapshot of revision 80 in ${events.length} events`);
  } finally {
    req.destroy();
    await server.close();
  }
});

test('the UI fingerprint changes when any served file changes', () => {
  const files = (styles) => new Map([
    ['/ui/styles.css', { type: 'text/css', body: Buffer.from(styles) }],
    ['/index.html', { type: 'text/html', body: Buffer.from('<p>page</p>') }],
  ]);
  assert.equal(assetsFingerprint(files('a{}')), assetsFingerprint(files('a{}')));
  assert.match(assetsFingerprint(files('a{}')), /^[0-9a-f]{16}$/);
  assert.notEqual(assetsFingerprint(files('a{}')), assetsFingerprint(files('b{}')));
  assert.equal(assetsFingerprint(loadAssets()), assetsFingerprint(loadAssets()));
});

const pageFingerprint = body => /<meta name="swarm-ui" content="([^"]*)">/.exec(body)?.[1];

test('the page and its hello carry the same UI fingerprint, and every UI file is served no-store', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine);
  const page = openEvents(server.port, '/api/events');
  try {
    const shell = await get(server.port, '/');
    const own = pageFingerprint(shell.body);
    assert.match(own, /^[0-9a-f]{16}$/);
    assert.equal(own, assetsFingerprint(loadAssets()));
    assert.equal((await page.waitFor(entry => entry.event === 'hello')).data.ui, own);
    for (const path of ['/', ...loadAssets().keys()]) assert.equal((await get(server.port, path)).headers['cache-control'], 'no-store', path);
  } finally {
    page.close();
    await server.close();
  }
});

test('a forced UI fingerprint reaches both the page and hello', async () => {
  const { createEngine } = spyEngine();
  const server = await started(createEngine, { uiFingerprint: 'forced' });
  const page = openEvents(server.port, '/api/events');
  try {
    assert.equal(pageFingerprint((await get(server.port, '/')).body), 'forced');
    assert.equal((await get(server.port, '/index.html')).body, (await get(server.port, '/')).body);
    assert.equal((await page.waitFor(entry => entry.event === 'hello')).data.ui, 'forced');
  } finally {
    page.close();
    await server.close();
  }
});

test('the page shell gets its fingerprint, and a shell without the placeholder fails loudly', () => {
  assert.equal(withFingerprint('<head><meta name="swarm-ui" content=""></head>', 'abc'), '<head><meta name="swarm-ui" content="abc"></head>');
  assert.throws(() => withFingerprint('<head></head>', 'abc'), /ui\/index\.html must contain <meta name="swarm-ui" content="">, the placeholder for the UI fingerprint/);
});
