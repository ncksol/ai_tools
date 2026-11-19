import { readFileSync } from 'node:fs';
import { CANVAS_TITLE, createCanvasHost } from '../../../server/canvas-host.mjs';
import { createDefaultEngine } from '../../../server/engines.mjs';
import { resolvePort } from '../../../server/shared.mjs';

// Runtime 1.0.114 renamed the SDK it maps for extensions from @github/copilot-sdk to @microsoft/copilot-sdk, with no alias.
// Try the new name first and fall back to the old one only when the new package is missing.
async function loadSdk() {
  try {
    return await import('@microsoft/copilot-sdk/extension');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("'@microsoft/copilot-sdk")) throw error;
  }
  try {
    return await import('@github/copilot-sdk/extension');
  } catch (error) {
    if (error?.code !== 'ERR_MODULE_NOT_FOUND' || !String(error.message).includes("'@github/copilot-sdk")) throw error;
    throw new Error("Cannot find the Copilot SDK: neither '@microsoft/copilot-sdk/extension' nor '@github/copilot-sdk/extension' resolves", { cause: error });
  }
}
const { CanvasError, createCanvas, joinSession } = await loadSdk();

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
  displayName: CANVAS_TITLE,
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
