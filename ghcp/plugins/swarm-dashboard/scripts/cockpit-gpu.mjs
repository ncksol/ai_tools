#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { findBrowser, launchBrowser, openPage } from './lib/cdp.mjs';
import { findPlaywright, launchWebKit } from './lib/webkit.mjs';

export const SIZES = Object.freeze([[1440, 900], [1920, 1080]]);
const BUDGET_MS = 1000 / 30;
export const USAGE = `Usage: cockpit-gpu [--engine chrome|webkit] [--frames <n>]

Measures the swarm cockpit's GPU time per frame on this machine, at 1440 × 900 and 1920 × 1080 with device pixel
ratio 2, on the synthetic example swarm: High redraws the black hole every frame, Balanced every second frame. Each
frame is forced to finish before it is timed. A dev-only test: it reports the cost, and fails only when WebGL2 is
missing, the renderer is a software one, or High at 1440 × 900 cannot hold 30 frames a second. It cannot measure heat.
--engine webkit uses Playwright's WebKit (set PLAYWRIGHT_CORE, as for check-layout). --frames sets frames per run (30). WebKit rounds its timers to 1 ms, so its times are rough.
`;

export function parseArguments(argv) {
  const options = { engine: 'chrome', frames: 30, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--engine') {
      options.engine = argv[++index];
      if (options.engine !== 'chrome' && options.engine !== 'webkit') throw new Error('--engine takes chrome or webkit');
    } else if (arg === '--frames') {
      options.frames = Number(argv[++index]);
      if (!Number.isInteger(options.frames) || options.frames < 10 || options.frames > 300) throw new Error('--frames takes a number from 10 to 300');
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

const round = value => Math.round(value * 100) / 100;
const middle = values => {
  const sorted = [...values].sort((a, b) => a - b);
  const half = sorted.length / 2;
  return sorted.length % 2 ? sorted[Math.floor(half)] : (sorted[half - 1] + sorted[half]) / 2;
};

export function summarise(bench) {
  const sorted = [...bench.times].sort((a, b) => a - b);
  return {
    median: round(middle(bench.times)),
    p90: round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))]),
    mean: round(bench.times.reduce((sum, value) => sum + value, 0) / bench.times.length),
    passes: { holeMs: round(middle(bench.passes.map(pass => pass.holeMs))), bloomMs: round(middle(bench.passes.map(pass => pass.bloomMs))), finalMs: round(middle(bench.passes.map(pass => pass.finalMs))) },
  };
}

export const isSoftware = renderer => /swiftshader|llvmpipe|software/i.test(renderer ?? '');

export function verdict(results) {
  const problems = [];
  for (const result of results) {
    if (!result.renderer) problems.push(`${result.width} × ${result.height}: WebGL2 is not available`);
    else if (isSoftware(result.renderer)) problems.push(`${result.width} × ${result.height}: ${result.renderer} is a software renderer, so the times say nothing about the GPU`);
    else if (result.width === 1440 && result.height === 900 && result.high.median > BUDGET_MS) problems.push(`High takes ${result.high.median} ms a frame at 1440 × 900, so it cannot hold 30 frames a second`);
  }
  return problems;
}

/** The share of each second the GPU is busy at 30 frames a second, in percent: ms × 30 / 1000 × 100. */
const percent = ms => Math.round(ms * 3);
export function describe(result) {
  const { passes } = result.high;
  return `${result.width} × ${result.height} at ${result.dpr}x (${result.size.width} × ${result.size.height}): High ${result.high.median.toFixed(1)} ms median (90th percentile ${result.high.p90.toFixed(1)} ms), `
    + `Balanced ${result.balanced.mean.toFixed(1)} ms a frame on average; black hole ${passes.holeMs.toFixed(1)}, bloom ${passes.bloomMs.toFixed(1)}, final ${passes.finalMs.toFixed(1)} ms. `
    + `At 30 fps the GPU is busy about ${percent(result.high.median)}% of the time on High and ${percent(result.balanced.mean)}% on Balanced.`;
}

/** Open the cockpit at a size with device pixel ratio 2, wait until it is ready, and run fn(evaluate). */
async function atSize(engine, browser, url, [width, height], fn) {
  if (engine === 'webkit') {
    const context = await browser.playwright.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    try {
      const page = await context.newPage();
      await page.goto(url);
      // waitForFunction would compile its expression in the page, which the page's CSP refuses; poll instead.
      const deadline = Date.now() + 15000;
      while (await page.evaluate("document.documentElement.dataset.ready === '1'") !== true) {
        if (Date.now() > deadline) throw new Error('The cockpit did not get ready within 15 s');
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      return await fn(expression => page.evaluate(expression));
    } finally {
      await context.close();
    }
  }
  const page = await openPage(browser);
  try {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await page.send('Page.navigate', { url });
    await page.waitFor("document.documentElement.dataset.ready === '1'", 15000);
    return await fn(expression => page.evaluate(expression));
  } finally {
    // The CDP wrapper has no close method; close this target through the page session.
    await page.send('Page.close');
  }
}

export async function main(argv, { stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    stderr.write(`${error.message}\n\n${USAGE}`);
    return 2;
  }
  if (options.help) {
    stdout.write(USAGE);
    return 0;
  }
  let browser = null;
  let launching = null;
  let stop = null;
  // A stop closes the browser the normal way (it waits for the browser to exit, then deletes its profile), waiting for
  // a launch in progress first, and exits with 130. Playwright handles its own browser in WebKit.
  const interrupt = () => {
    stop ??= Promise.race([
      Promise.resolve(browser ?? launching).then(open => open?.close()),
      new Promise(resolve => setTimeout(resolve, 8000)),
    ]).catch(() => {}).finally(() => process.exit(130));
  };
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let server = null;
  try {
    if (options.engine === 'webkit') {
      const entry = findPlaywright(env);
      const launched = entry ? await launchWebKit(entry) : { skip: 'Playwright is not available; set PLAYWRIGHT_CORE (see the README).' };
      if (launched.skip) {
        stderr.write(`${launched.skip}\n`);
        return 2;
      }
      browser = launched.browser;
    } else {
      const executable = findBrowser(env);
      if (!executable) {
        stderr.write('No local Chrome, Chromium or Edge was found. Install one or set CHROME_PATH.\n');
        return 2;
      }
      launching = launchBrowser(executable);
      browser = await launching;
    }
    server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: false }), port: 0, version: 'cockpit-gpu' });
    await server.listen();
    const url = `${server.url}cockpit?debug=1&quality=high`;
    const results = [];
    for (const size of SIZES) {
      const result = await atSize(options.engine, browser, url, size, async evaluate => {
        const high = await evaluate(`cockpitDebug.bench(${options.frames}, 1)`);
        const balanced = await evaluate(`cockpitDebug.bench(${options.frames}, 2)`);
        return { high, balanced };
      });
      if (!result.high) {
        results.push({ width: size[0], height: size[1], renderer: null });
        continue;
      }
      results.push({ width: size[0], height: size[1], dpr: result.high.dpr, size: result.high.size, renderer: result.high.info.renderer, hdr: result.high.info.hdr, high: summarise(result.high), balanced: summarise(result.balanced) });
    }
    const first = results.find(result => result.renderer);
    stdout.write(`Browser: ${browser.product}\nRenderer: ${first ? `${first.renderer}, ${first.hdr ? 'HDR' : '8-bit'} targets` : 'none'}\n`);
    if (options.engine === 'webkit') stdout.write('WebKit rounds its timers to 1 ms, so these times are within ±1 ms and the pass breakdown is rough.\n');
    for (const result of results.filter(item => item.renderer)) stdout.write(`${describe(result)}\n`);
    const problems = verdict(results);
    for (const problem of problems) stderr.write(`${problem}\n`);
    return problems.length ? 1 : 0;
  } catch (error) {
    if (stop) await stop;
    throw error;
  } finally {
    if (stop) await stop;
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
    await server?.close();
    await browser?.close();
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
