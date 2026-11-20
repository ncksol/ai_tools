/** How long an engine refresh may go without progress, while file system calls still finish, before the engine is replaced. */
export const REFRESH_LIMIT_MS = 60000;
/** How often the hub checks the running refresh's progress. */
export const REFRESH_CHECK_MS = 5000;
/**
 * How many engines in a row the hub replaces before one finishes a refresh. A replacement that gets stuck on the same
 * file holds another file system thread, so the hub stops replacing and says so, until a refresh finishes again.
 */
export const REFRESH_MAX_RESTARTS = 3;

const NO_REFRESH = { stage: null, refreshStartedAt: null, progressAt: null, lastRefreshAt: null };

/**
 * Live page connections (Server-Sent Events) and the engine's lifetime. The engine is created when the first page
 * connects or an API call needs it, polls only while a page is connected, and is dropped engineIdleMs after the last
 * page leaves, so an idle server holds no engine memory. At most maxClients pages connect at once, and a page whose
 * socket stays backed up for stallMs is dropped, so a page that stops reading never holds more than one frame here.
 * Each page gets a heartbeat with the time of the last finished refresh, so it can tell when its data stops changing.
 * A refresh that makes no progress (see the engine's status()) for refreshLimitMs, while poolPassedSince(its last
 * progress) says file system calls still finish, is stuck on something a new engine does not share: the hub logs where,
 * retires the engine and starts another, at most maxRestarts times in a row. Reads waiting on a replaced engine move to
 * its replacement. An engine the hub drops for good, replaced, idle or closed, is retired, so a refresh still in flight
 * in it stores nothing over what a later engine stores. Never writes to stdout.
 */
export function createHub({
  createEngine, now = Date.now, intervalMs = 3000, engineIdleMs = 300000, heartbeatMs = 1000, maxClients = 32, stallMs = 30000,
  refreshLimitMs = REFRESH_LIMIT_MS, refreshCheckMs = REFRESH_CHECK_MS, maxRestarts = REFRESH_MAX_RESTARTS, poolPassedSince = () => true,
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
  // Kept across engines (wall-clock ms): the last refresh any engine finished; while engines are replaced before one
  // finishes, when the first of their refreshes started and how many were replaced; and whether the hub gave up.
  let lastRefreshAt = null;
  let chainStartedAt = null;
  let restarts = 0;
  let gaveUp = false;
  let closed = false;
  // Reads in progress: the engine each one runs on, and wake(reason), which ends its wait when that engine is dropped.
  // A read leaves the set when it ends, so nothing here keeps a finished read's result alive.
  const reads = new Set();
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

  function endChain() {
    chainStartedAt = null;
    restarts = 0;
    gaveUp = false;
  }

  /** Takes in the current engine's finished refresh: one that finishes ends a streak of replacements. */
  function settle(current) {
    const finished = current?.lastRefreshAt;
    if (typeof finished !== 'number') return;
    if (lastRefreshAt === null || finished > lastRefreshAt) lastRefreshAt = finished;
    endChain();
  }

  /** Engine refreshes read Date.now(), not `now`, so this check does too. */
  function checkRefresh() {
    const current = engine?.status?.();
    if (!current) return;
    settle(current);
    const startedAt = current.refreshStartedAt;
    if (typeof startedAt !== 'number') return;
    const quietSince = Math.max(startedAt, typeof current.progressAt === 'number' ? current.progressAt : startedAt);
    if (Date.now() - quietSince <= refreshLimitMs || !poolPassedSince(quietSince)) return;
    const where = `${Math.round((Date.now() - quietSince) / 1000)} s, stuck in ${current.stage ?? 'an unknown step'}`;
    if (restarts >= maxRestarts) {
      if (!gaveUp) {
        gaveUp = true;
        log({ level: 'error', source: 'server', message: `A refresh made no progress for ${where}, after ${restarts} new engines in a row got stuck too; the dashboard stops replacing the engine until a refresh finishes` });
      }
      return;
    }
    log({ level: 'warn', source: 'server', message: `A refresh made no progress for ${where}; replacing the engine` });
    chainStartedAt ??= startedAt;
    restarts += 1;
    replaceEngine();
  }

  /**
   * Drops an engine for good: retire() stops it and keeps a refresh still in flight from storing anything over what a
   * later engine stores. Reads running on it wake with `reason`: 'replaced' runs them again, 'closed' fails them.
   */
  function discard(old, reason) {
    if (old.retire) old.retire();
    else old.stop();
    for (const read of reads) if (read.engine === old) read.wake(reason);
  }

  function replaceEngine() {
    const old = engine;
    const wake = abandon;
    unsubscribe?.();
    discard(old, 'replaced');
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

  /**
   * Where the engine's running refresh is and when it last made progress (see the engine's status()), when the wait for
   * fresh data began (the first refresh of a streak of replaced engines, or the running one), when any engine last
   * finished a refresh, and how many engines in a row were replaced.
   */
  function status() {
    const current = engine?.status?.() ?? NO_REFRESH;
    settle(current);
    return {
      stage: current.stage ?? null,
      refreshStartedAt: chainStartedAt ?? current.refreshStartedAt ?? null,
      progressAt: current.progressAt ?? null,
      lastRefreshAt,
      restarts,
    };
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
    // An engine that a read still uses is not idle; the read schedules the release again when it ends.
    if (clients.size || reads.size || !engine) return;
    settle(engine.status?.());
    unsubscribe?.();
    discard(engine, 'closed');
    stopWatchdog();
    endChain();
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

  const closing = () => Object.assign(new Error('The dashboard server is closing'), { retriable: true });

  /**
   * Run fn with the engine, creating it if needed; the engine is kept while fn runs, and one with no connected page is
   * dropped later. When the engine is replaced while fn waits on it, fn runs again on the new engine; when the hub closes,
   * this fails with an error whose `retriable` is true.
   */
  async function withEngine(fn) {
    const read = { engine: null, wake: null };
    reads.add(read);
    try {
      for (;;) {
        if (closed) throw closing();
        const current = await acquire();
        if (closed) throw closing();
        const woken = new Promise(resolve => { read.wake = resolve; });
        read.engine = current;
        const work = Promise.resolve().then(() => fn(current));
        // An engine dropped, replaced or closed while fn ran may have reopened its read-only connections, so stop it
        // again once fn ends, even when this no longer waits for it.
        const ended = () => {
          if (current !== engine) current.stop();
        };
        work.then(ended, ended);
        const outcome = await Promise.race([work.then(value => ({ value })), woken]);
        if (outcome === 'closed') throw closing();
        if (outcome !== 'replaced') return outcome.value;
      }
    } finally {
      reads.delete(read);
      scheduleRelease();
    }
  }

  function close() {
    closed = true;
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
      unsubscribe?.();
      discard(engine, 'closed');
    }
    endChain();
    abandon?.();
    engine = null;
    ready = null;
    abandon = null;
  }

  /** Bytes written to live pages that their sockets have not taken yet (a diagnostic for tests). */
  const queuedBytes = () => [...clients].reduce((sum, client) => sum + (client.res.writableLength ?? 0), 0);

  return {
    add, withEngine, close, status, clientCount: () => clients.size, hasEngine: () => engine !== null, queuedBytes,
    // Reads in progress (a diagnostic for tests).
    pendingReads: () => reads.size,
  };
}
