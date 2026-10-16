import { APP_ID } from './http.mjs';

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
 * something that accepts connections but does not answer in time ('unresponsive'). Only a direct 200 answer from the
 * port counts; a redirect means another program.
 */
export async function probePort(port, { timeoutMs = 2500 } = {}) {
  const url = `http://127.0.0.1:${port}/api/health`;
  try {
    // Only a direct answer from this loopback port counts: a redirect could name another listener, or leave the machine.
    // The URL is written out again in the call so the packaging test can see that the server only calls loopback.
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    const direct = response.status === 200 && !response.redirected && response.url === url;
    if (!direct) {
      await response.body?.cancel().catch(() => {});
      return { state: 'other' };
    }
    const body = await response.json().catch(() => null);
    return body && body.app === APP_ID ? { state: 'ours', health: body } : { state: 'other' };
  } catch (error) {
    if ((error?.cause?.code ?? error?.code) === 'ECONNREFUSED') return { state: 'free' };
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return { state: 'unresponsive' };
    return { state: 'other' };
  }
}

/**
 * Bind the shared port with a new server, or identify whoever holds it. The OS settles races: a loser gets EADDRINUSE,
 * probes the winner and reuses it if it is a dashboard.
 */
export async function listenShared({ port, makeServer, probe = probePort, attempts = 3, pauseMs = 300 }) {
  // Look before binding: macOS lets a loopback bind succeed beside a program that holds the port on every address.
  const holder = await probe(port);
  if (holder.state === 'ours') return { status: 'running', health: holder.health };
  if (holder.state === 'other') return { status: 'taken' };
  if (holder.state === 'unresponsive') return { status: 'unresponsive' };
  let status = 'taken';
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
    status = found.state === 'unresponsive' ? 'unresponsive' : 'taken';
    if (attempt < attempts - 1) await new Promise(resolve => setTimeout(resolve, pauseMs));
  }
  return { status };
}
