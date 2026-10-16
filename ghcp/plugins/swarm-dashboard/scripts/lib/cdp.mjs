import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge',
];
const PLAYWRIGHT = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  'chrome-linux/chrome',
];

/** A local Chromium-based browser: CHROME_PATH, a standard install, or Playwright's cached Chromium. */
export function findBrowser(env = process.env) {
  if (env.CHROME_PATH) return existsSync(env.CHROME_PATH) ? env.CHROME_PATH : null;
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  for (const cache of [path.join(homedir(), 'Library/Caches/ms-playwright'), path.join(homedir(), '.cache/ms-playwright')]) {
    if (!existsSync(cache)) continue;
    for (const dir of readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort().reverse()) {
      for (const relative of PLAYWRIGHT) {
        const full = path.join(cache, dir, relative);
        if (existsSync(full)) return full;
      }
    }
  }
  return null;
}

/**
 * The headless browser's arguments for a temporary profile. A mock keychain keeps the first navigation from waiting on
 * the macOS keychain, which can hang when HOME is isolated.
 */
export function browserArguments(profile) {
  return [
    '--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-extensions', '--hide-scrollbars', '--mute-audio', '--use-mock-keychain', 'about:blank',
  ];
}

/**
 * Start the browser headless and speak the DevTools protocol over a pipe (file descriptors 3 and 4), so no WebSocket
 * client or npm package is needed. close() ends the browser and deletes its temporary profile.
 */
export async function launchBrowser(executable) {
  const profile = mkdtempSync(path.join(tmpdir(), 'swarm-layout-'));
  const child = spawn(executable, browserArguments(profile), { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
  const input = child.stdio[3];
  const output = child.stdio[4];
  const pending = new Map();
  const handlers = new Set();
  let buffer = '';
  let nextId = 0;
  const exited = new Promise(resolve => child.once('exit', resolve));
  // If this process ends early (Ctrl+C or an exception), take the browser and its profile with it.
  const cleanUp = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    rmSync(profile, { recursive: true, force: true });
  };
  process.once('exit', cleanUp);
  child.once('exit', () => {
    for (const { reject } of pending.values()) reject(new Error('The browser exited.'));
    pending.clear();
  });
  output.setEncoding('utf8');
  output.on('data', chunk => {
    buffer += chunk;
    for (let end = buffer.indexOf('\0'); end >= 0; end = buffer.indexOf('\0')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      if (message.id !== undefined && pending.has(message.id)) {
        const { resolve, reject } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) reject(new Error(`${message.error.message} (${message.error.code})`));
        else resolve(message.result);
      } else if (message.method) {
        for (const handler of handlers) handler(message);
      }
    }
  });
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    nextId += 1;
    pending.set(nextId, { resolve, reject });
    input.write(`${JSON.stringify(sessionId ? { id: nextId, method, params, sessionId } : { id: nextId, method, params })}\0`);
  });
  const { product } = await send('Browser.getVersion');
  return {
    product,
    send,
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    async close() {
      await send('Browser.close').catch(() => {});
      await Promise.race([exited, new Promise(resolve => setTimeout(resolve, 3000))]);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL');
        await exited;
      }
      process.off('exit', cleanUp);
      rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** One tab with reduced motion, collecting exceptions, console errors and error log entries in `errors`. */
export async function openPage(browser) {
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params = {}) => browser.send(method, params, sessionId);
  const errors = [];
  browser.onEvent(message => {
    if (message.sessionId !== sessionId) return;
    const { method, params } = message;
    if (method === 'Runtime.exceptionThrown') errors.push(params.exceptionDetails.exception?.description ?? params.exceptionDetails.text);
    if (method === 'Runtime.consoleAPICalled' && params.type === 'error') errors.push(params.args.map(arg => arg.value ?? arg.description ?? '').join(' '));
    if (method === 'Log.entryAdded' && params.entry.level === 'error') errors.push(params.entry.text);
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  const page = {
    send,
    errors,
    async goto(url, width, height = 900) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await send('Page.navigate', { url });
    },
    async evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    },
    async waitFor(expression, timeoutMs = 8000) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        if (await page.evaluate(expression).catch(() => false)) return;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      throw new Error(`Timed out waiting for ${expression}`);
    },
    async screenshot() {
      const { data } = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
      return Buffer.from(data, 'base64');
    },
    async setReducedMotion(reduce) {
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: reduce ? 'reduce' : 'no-preference' }] });
    },
  };
  return page;
}
