#!/usr/bin/env node
import { realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createDemoEngine } from '../server/demo-engine.mjs';
import { createDashboardServer } from '../server/http.mjs';
import { findBrowser, launchBrowser, openPage } from './lib/cdp.mjs';
import { CHECKS, runCockpitChecks } from './lib/cockpit-check.mjs';
import { findPlaywright, launchWebKit, openWebKitPage } from './lib/webkit.mjs';

export const USAGE = `Usage: check-cockpit [--engine chrome|webkit] [--only <check>] [--print-metrics]

Checks the swarm cockpit in a local headless Chrome, Chromium or Edge (CHROME_PATH picks one), or in Playwright's
WebKit with --engine webkit (PLAYWRIGHT_CORE, as for check-layout), against the synthetic example swarm.
--only runs one check: ${[...CHECKS.keys()].join(', ')}. --print-metrics prints the scene's measurements.
npm run check:layout runs these checks too.
`;

export function parseArguments(argv) {
  const options = { engine: 'chrome', only: null, printMetrics: false, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--print-metrics') options.printMetrics = true;
    else if (arg === '--engine') {
      options.engine = argv[++index];
      if (options.engine !== 'chrome' && options.engine !== 'webkit') throw new Error('--engine takes chrome or webkit');
    } else if (arg === '--only') {
      options.only = argv[++index];
      if (!CHECKS.has(options.only)) throw new Error(`--only takes ${[...CHECKS.keys()].join(', ')}`);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  return options;
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
  let browser;
  if (options.engine === 'webkit') {
    const entry = findPlaywright(env);
    const launched = entry ? await launchWebKit(entry) : { skip: 'Playwright is not available. Install playwright-core outside this repository and set PLAYWRIGHT_CORE (see the README).' };
    if (launched.skip) {
      stdout.write(`WebKit check skipped: ${launched.skip}\n`);
      return 0;
    }
    browser = launched.browser;
  } else {
    const executable = findBrowser(env);
    if (!executable) {
      stderr.write('No local Chrome, Chromium or Edge was found. Install one or set CHROME_PATH.\n');
      return 2;
    }
    browser = await launchBrowser(executable);
  }
  const server = createDashboardServer({ createEngine: () => createDemoEngine({ scenario: 'example', simulate: false }), port: 0, version: 'cockpit-check', hub: { engineIdleMs: 600000 } });
  try {
    await server.listen();
    stdout.write(`Browser: ${browser.product}\n`);
    const page = options.engine === 'webkit' ? await openWebKitPage(browser) : await openPage(browser);
    const { issues } = await runCockpitChecks({ page, browser, engine: options.engine, urls: { example: server.url }, options, stdout, stderr });
    return issues ? 1 : 0;
  } finally {
    await server.close();
    await browser.close();
  }
}

if (process.argv[1] && await realpath(fileURLToPath(import.meta.url)) === await realpath(process.argv[1])) {
  process.exitCode = await main(process.argv.slice(2));
}
