import { readFileSync } from 'node:fs';
import { CanvasError, createCanvas, joinSession } from '@github/copilot-sdk/extension';
import { createCanvasHost } from '../../../server/canvas-host.mjs';
import { createDefaultEngine } from '../../../server/engines.mjs';
import { resolvePort } from '../../../server/shared.mjs';

// The runtime talks JSON-RPC over this process's stdout, so every log line goes to stderr.
const log = entry => process.stderr.write(`swarm-dashboard ${entry.level} ${entry.source}: ${entry.message}\n`);
const { version } = JSON.parse(readFileSync(new URL('../../../plugin.json', import.meta.url), 'utf8'));

let portError = null;
let port = null;
try {
  port = resolvePort();
} catch (error) {
  portError = error;
}

/** Exported for tests; the runtime ignores exports. Starts nothing until a canvas opens. */
export const canvasHost = port === null ? null : createCanvasHost({ port, version, log, createEngine: () => createDefaultEngine({ log }) });

export const canvas = createCanvas({
  id: 'swarm-dashboard',
  displayName: 'Swarm dashboard',
  description: 'Watch an agentic swarm: what each session and sub-agent is doing, its progress and cost, and what needs you.',
  inputSchema: {
    type: 'object',
    properties: {
      swarm: { type: 'string', description: 'Root session id of the swarm to show. Default: the swarm of the session the canvas opens in.' },
    },
    additionalProperties: false,
  },
  async open(ctx) {
    if (portError) throw new CanvasError('bad_port', portError.message);
    try {
      return await canvasHost.open(ctx);
    } catch (error) {
      throw new CanvasError(error.code ?? 'open_failed', error.message);
    }
  },
  onClose(ctx) {
    canvasHost?.onClose(ctx);
  },
});

// When the CLI stops this extension, close the server first, and with it the engine's read-only database connections,
// then end the way the signal would have ended the process.
process.once('SIGTERM', () => {
  Promise.resolve(canvasHost?.dispose()).finally(() => process.kill(process.pid, 'SIGTERM'));
});

await joinSession({ canvases: [canvas] });
