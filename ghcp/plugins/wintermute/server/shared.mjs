import { APP_ID } from './http.mjs';
import { REFRESH_CHECK_MS, REFRESH_LIMIT_MS } from './hub.mjs';

/**
 * A dashboard whose refresh has made no progress for this long has not recovered by itself: its hub replaces an engine
 * that made no progress for REFRESH_LIMIT_MS once file system calls are known to work, and checks every REFRESH_CHECK_MS.
 */
export const STALE_REFRESH_MS = REFRESH_LIMIT_MS + 2 * REFRESH_CHECK_MS;

/** When a dashboard's running refresh last made progress, from its health answer. */
export function quietSince(health) {
  return Math.max(health.refreshStartedAt, typeof health.progressAt === 'number' ? health.progressAt : -Infinity);
}

/** The dashboard's fixed loopback port (IANA-unassigned, below macOS's ephemeral range). */
export const DEFAULT_PORT = 7927;

export function resolvePort(env = process.env) {
  const raw = env.SWARM_DASHBOARD_PORT;
  if (raw === undefined || raw === '') return DEFAULT_PORT;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`SWARM_DASHBOARD_PORT must be a port number from 1 to 65535, not ${raw}`);
  return port;
}

/**
 * Who holds the port: our dashboard ('ours', with its health answer), nobody ('free'), another program ('other'), or
 * something that accepts connections but does not answer in time ('unresponsive'). A dashboard that answers but can no
 * longer refresh is 'unresponsive' too, with its health and a reason: 'broken' when its file system calls stopped
 * finishing, 'stale' when its refresh has made no progress (since it started, or since its progressAt) for longer than
 * staleAfterMs. A dashboard with no refresh running is never stale. Only a direct 200 answer from the port counts; a
 * redirect means another program.
 */
export async function probePort(port, { timeoutMs = 2500, staleAfterMs = STALE_REFRESH_MS } = {}) {
  try {
    // Only a direct answer from this loopback port counts: a redirect could name another listener, or leave the machine.
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      return { state: 'other' };
    }
    const body = await response.json().catch(() => null);
    if (!body || body.app !== APP_ID) return { state: 'other' };
    if (body.pool === 'broken') return { state: 'unresponsive', reason: 'broken', health: body };
    if (typeof body.refreshStartedAt === 'number' && Date.now() - quietSince(body) > staleAfterMs) return { state: 'unresponsive', reason: 'stale', health: body };
    return { state: 'ours', health: body };
  } catch (error) {
    if ((error?.cause?.code ?? error?.code) === 'ECONNREFUSED') return { state: 'free' };
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { state: 'unresponsive' };
    return { state: 'other' };
  }
}

/**
 * Bind the shared port with a new server, or identify whoever holds it. The OS settles races: a loser gets EADDRINUSE,
 * probes the winner and reuses it if it is a dashboard. A dashboard that can no longer refresh is not reused: this
 * tries to bind in case it lets the port go meanwhile, and otherwise returns 'unresponsive' with its reason and health.
 */
export async function listenShared({ port, makeServer, probe = probePort, attempts = 3, pauseMs = 300 }) {
  const unresponsive = found => (found.reason ? { status: 'unresponsive', reason: found.reason, health: found.health } : { status: 'unresponsive' });
  // Look before binding: macOS lets a loopback bind succeed beside a program that holds the port on every address.
  const holder = await probe(port);
  if (holder.state === 'ours') return { status: 'running', health: holder.health };
  if (holder.state === 'other') return { status: 'taken' };
  if (holder.state === 'unresponsive' && !holder.health) return unresponsive(holder);
  let last = holder.state === 'unresponsive' ? holder : null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const server = makeServer();
    try {
      await server.listen();
      return { status: 'started', server };
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    }
    const found = await probe(port);
    if (found.state === 'ours') return { status: 'running', health: found.health };
    if (found.state === 'other') return { status: 'taken' };
    last = found.state === 'unresponsive' ? found : null;
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return last ? unresponsive(last) : { status: 'taken' };
}
