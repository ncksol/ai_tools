/** How long one engine refresh may run, while file system calls still finish, before the engine is replaced. */
export const REFRESH_LIMIT_MS = 60000;
/** How often the hub checks how long the running refresh has taken. */
export const REFRESH_CHECK_MS = 5000;

const NO_REFRESH = { stage: null, refreshStartedAt: null, lastRefreshAt: null };

/**
 * Live page connections (Server-Sent Events) and the engine's lifetime. The engine is created when the first page
 * connects or an API call needs it, polls only while a page is connected, and is dropped engineIdleMs after the last
 * page leaves, so an idle server holds no engine memory. At most maxClients pages connect at once, and a page whose
 * socket stays backed up for stallMs is dropped, so a page that stops reading never holds more than one frame here.
 * Each page gets a heartbeat with the time of the engine's last finished refresh, so it can tell when its data stops
 * changing. A refresh that runs longer than refreshLimitMs, while poolPassedSince(its start) says file system calls
 * still finish, is stuck on something a new engine does not share: the hub logs where and replaces the engine.
 * Never writes to stdout.
 */
export function createHub({
  createEngine, now = Date.now, intervalMs = 3000, engineIdleMs = 300000, heartbeatMs = 1000, maxClients = 32, stallMs = 30000,
  refreshLimitMs = REFRESH_LIMIT_MS, refreshCheckMs = REFRESH_CHECK_MS, poolPassedSince = () => true,
  log = () => {}, onIdle = () => {}, ui = null, version = null,
}) {
  const clients = new Set();
  let engine = null;
  let ready = null;
  // Settles `ready` early when its engine is replaced, so callers waiting on a stuck refresh move to the new engine.
  let abandon = null;
  let unsubscribe = null;
  let idleTimer = null;
  let heartbeat = null;
  let watchdog = null;
  let polling = false;
  let swarmsKey = '';
  let refusedAt = -Infinity;
  const warn = error => log({ level: 'warn', source: 'server', message: error?.message ?? String(error) });

  function createCurrent() {
    const created = createEngine();
    engine = created;
    unsubscribe = created.subscribe(change => { changed(change).catch(warn); });
    const abandoned = new Promise(resolve => { abandon = resolve; });
    ready = Promise.race([Promise.resolve(created.refresh()).catch(warn), abandoned]);
    if (!watchdog) {
      watchdog = setInterval(checkRefresh, refreshCheckMs);
      watchdog.unref?.();
    }
  }

  async function acquire() {
    clearTimeout(idleTimer);
    idleTimer = null;
    for (;;) {
      if (!engine) createCurrent();
      const current = engine;
      await ready;
      // Wait again only for an engine that replaced this one; a dropped engine is the caller's to stop.
      if (current === engine || !engine) return current;
    }
  }

  function stopWatchdog() {
    clearInterval(watchdog);
    watchdog = null;
  }

  /** Engine refreshes read Date.now(), not `now`, so this check does too. */
  function checkRefresh() {
    const status = engine?.status?.();
    const startedAt = status?.refreshStartedAt;
    if (typeof startedAt !== 'number' || Date.now() - startedAt <= refreshLimitMs || !poolPassedSince(startedAt)) return;
    log({ level: 'warn', source: 'server', message: `A refresh has run for ${Math.round((Date.now() - startedAt) / 1000)} s, stuck in ${status.stage ?? 'an unknown step'}; replacing the engine` });
    replaceEngine();
  }

  function replaceEngine() {
    const old = engine;
    const wake = abandon;
    old.stop();
    unsubscribe?.();
    createCurrent();
    wake?.();
    const current = engine;
    if (polling) current.start({ intervalMs });
    swarmsKey = '';
    for (const client of clients) client.lastKey = null;
    ready.then(() => {
      if (current !== engine) return;
      sendSwarms(true);
      for (const client of clients) if (client.greeted) push(client);
    });
  }

  function startPolling() {
    if (polling || !engine) return;
    polling = true;
    engine.start({ intervalMs });
    heartbeat = setInterval(() => {
      const refreshedAt = status().lastRefreshAt;
      for (const client of clients) {
        if (client.blocked) continue;
        if (client.greeted) send(client, 'heartbeat', () => ({ serverNow: now(), refreshedAt }));
        else write(client, ': ping\n\n');
      }
    }, heartbeatMs);
    heartbeat.unref?.();
  }

  /** Where the engine's running refresh is, and when the last one finished (see the engine's status()). */
  function status() {
    const current = engine?.status?.();
    return current ? { stage: current.stage ?? null, refreshStartedAt: current.refreshStartedAt ?? null, lastRefreshAt: current.lastRefreshAt ?? null } : { ...NO_REFRESH };
  }

  function scheduleRelease() {
    if (clients.size) return;
    if (polling) {
      engine?.stop();
      polling = false;
      clearInterval(heartbeat);
      heartbeat = null;
    }
    if (!engine || idleTimer) return;
    idleTimer = setTimeout(release, engineIdleMs);
    idleTimer.unref?.();
  }

  function release() {
    idleTimer = null;
    if (clients.size || !engine) return;
    engine.stop();
    unsubscribe?.();
    stopWatchdog();
    abandon?.();
    engine = null;
    ready = null;
    abandon = null;
    unsubscribe = null;
    swarmsKey = '';
    onIdle();
  }

  /**
   * Write to one page. When its socket is backed up, write nothing more until 'drain', and drop the page if that takes
   * longer than stallMs: it reconnects by itself and gets the current snapshot. So a page never has more than one frame
   * queued in the server.
   */
  function write(client, text) {
    if (client.closed || client.res.write(text)) return;
    client.blocked = true;
    client.stallTimer = setTimeout(() => drop(client), stallMs);
    client.stallTimer.unref?.();
  }

  /** Send an event. While the page is behind, only the newest payload of each event waits; payload() runs when written. */
  function send(client, event, payload) {
    if (client.closed) return;
    if (client.blocked) {
      client.pending.delete(event);
      client.pending.set(event, payload);
      return;
    }
    write(client, `event: ${event}\ndata: ${JSON.stringify(payload())}\n\n`);
  }

  function drained(client) {
    clearTimeout(client.stallTimer);
    client.stallTimer = null;
    client.blocked = false;
    for (const [event, payload] of client.pending) {
      client.pending.delete(event);
      send(client, event, payload);
      if (client.blocked) return;
    }
  }

  function forget(client) {
    if (client.closed) return;
    client.closed = true;
    clearTimeout(client.stallTimer);
    client.stallTimer = null;
    client.pending.clear();
    clients.delete(client);
    scheduleRelease();
  }

  function drop(client) {
    if (client.closed) return;
    log({ level: 'warn', source: 'server', message: `Dropped a live page that read nothing for ${Math.round(stallMs / 1000)} s; it reconnects by itself` });
    forget(client);
    client.res.destroy();
  }

  function sendSwarms(force, target) {
    if (!engine) return;
    const swarms = engine.listSwarms();
    const key = JSON.stringify(swarms.map(swarm => [swarm.id, swarm.name, swarm.lifecycle]));
    if (!force && key === swarmsKey) return;
    swarmsKey = key;
    for (const client of target ? [target] : [...clients].filter(item => item.greeted)) send(client, 'swarms', () => swarms);
  }

  async function push(client) {
    const mine = engine;
    if (!mine || client.closed) return;
    // A push still waiting on a replaced engine does not hold up one for the current engine.
    if (client.busy === mine) {
      client.again = true;
      return;
    }
    client.busy = mine;
    try {
      do {
        client.again = false;
        const pinned = client.pinned;
        const current = engine;
        if (current !== mine || client.closed) return;
        const fromSession = !client.swarm && !pinned && client.session ? await current.findSwarm(client.session) : null;
        const asked = client.swarm ?? pinned ?? fromSession;
        // A page opened for a session that is in no swarm gets no snapshot, never the default swarm, so it can say so.
        const snapshot = asked || !client.session ? await current.getSnapshot(asked ?? undefined) : null;
        if (current !== engine) {
          // An engine dropped or closed meanwhile may have reopened its read-only connections, so stop it again.
          current.stop();
          return;
        }
        if (client.closed) return;
        // Pin a page to the swarm it was first shown, so the default does not jump between swarms; changed() unpins a
        // default page whose swarm is no longer live while another is. A page opened from a session that is in no swarm
        // yet stays unpinned with no snapshot, and follows that session once it joins one.
        if (snapshot && !client.swarm && !pinned && !client.pinned && (fromSession || !client.session)) client.pinned = snapshot.run.id;
        const key = snapshot ? `${snapshot.run.id}#${snapshot.revision}` : 'none';
        if (key !== client.lastKey) {
          client.lastKey = key;
          send(client, 'snapshot', () => ({ serverNow: now(), snapshot }));
        }
      } while (client.again && !client.closed);
    } catch (error) {
      warn(error);
    } finally {
      if (client.busy === mine) client.busy = false;
    }
  }

  async function changed(change) {
    sendSwarms(false);
    const live = new Set(engine ? engine.listSwarms().filter(swarm => swarm.lifecycle === 'live').map(swarm => swarm.id) : []);
    for (const client of clients) {
      // add() sends a page its swarms and snapshot after hello.
      if (!client.greeted) continue;
      // A page that asked for no swarm follows the default again once its swarm is no longer live while another is.
      if (!client.swarm && !client.session && client.pinned && live.size && !live.has(client.pinned)) client.pinned = null;
      const shown = client.swarm ?? client.pinned;
      if (!shown || change.swarmIds.includes(shown)) push(client);
    }
  }

  /** Serve one page's event stream. swarm: the swarm it asked for; session: a session whose swarm it wants. */
  async function add(req, res, { swarm = null, session = null } = {}) {
    if (clients.size >= maxClients) {
      // A refused page retries every few seconds, so say so at most once a minute.
      if (now() - refusedAt > 60000) {
        refusedAt = now();
        log({ level: 'warn', source: 'server', message: `Refused a live page: ${maxClients} are already connected` });
      }
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'Retry-After': '5' });
      res.end('Too many live pages');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    const client = { res, swarm, session, pinned: null, lastKey: null, busy: false, again: false, closed: false, greeted: false, blocked: false, pending: new Map(), stallTimer: null };
    clients.add(client);
    res.on('drain', () => drained(client));
    req.on('close', () => forget(client));
    write(client, 'retry: 2000\n\n');
    const current = await acquire();
    if (client.closed) return;
    send(client, 'hello', () => ({ serverNow: now(), demo: Boolean(current.isDemo), ui, version, pollMs: intervalMs, refreshedAt: status().lastRefreshAt }));
    client.greeted = true;
    startPolling();
    sendSwarms(true, client);
    await push(client);
  }

  /** Run fn with the engine, creating it if needed; an engine with no connected page is dropped later. */
  async function withEngine(fn) {
    const current = await acquire();
    try {
      return await fn(current);
    } finally {
      // An engine dropped or closed while fn ran may have reopened its read-only connections, so stop it again.
      if (current !== engine) current.stop();
      scheduleRelease();
    }
  }

  function close() {
    for (const client of clients) {
      client.closed = true;
      clearTimeout(client.stallTimer);
      client.res.end();
    }
    clients.clear();
    clearTimeout(idleTimer);
    clearInterval(heartbeat);
    stopWatchdog();
    idleTimer = null;
    heartbeat = null;
    polling = false;
    if (engine) {
      engine.stop();
      unsubscribe?.();
    }
    abandon?.();
    engine = null;
    ready = null;
    abandon = null;
  }

  /** Bytes written to live pages that their sockets have not taken yet (a diagnostic for tests). */
  const queuedBytes = () => [...clients].reduce((sum, client) => sum + (client.res.writableLength ?? 0), 0);

  return { add, withEngine, close, status, clientCount: () => clients.size, hasEngine: () => engine !== null, queuedBytes };
}
