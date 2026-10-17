import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * Playwright, for the optional WebKit mode of the layout check. It is not a dependency of this plugin: point
 * PLAYWRIGHT_CORE at a playwright-core package installed outside the repository, or install it where Node finds it.
 */
export function findPlaywright(env = process.env) {
  if (env.PLAYWRIGHT_CORE) {
    const entry = path.join(env.PLAYWRIGHT_CORE, 'index.mjs');
    return existsSync(entry) ? pathToFileURL(entry).href : null;
  }
  try {
    return pathToFileURL(createRequire(import.meta.url).resolve('playwright-core')).href;
  } catch {
    return null;
  }
}

/** Headless WebKit through Playwright, or why it cannot start: { browser } or { skip }. */
export async function launchWebKit(entry) {
  const playwright = await import(entry);
  const webkit = playwright.webkit ?? playwright.default?.webkit;
  if (!webkit) return { skip: `${fileURLToPath(entry)} is not playwright-core.` };
  if (!existsSync(webkit.executablePath())) return { skip: `Playwright's WebKit browser is not downloaded. Run: node ${fileURLToPath(new URL('./cli.js', entry))} install webkit` };
  const browser = await webkit.launch({ headless: true });
  return { browser: { product: `WebKit/${browser.version()}`, playwright: browser, close: () => browser.close() } };
}

/**
 * One WebKit page with the same interface as the Chrome page in cdp.mjs. A console error keeps the URL WebKit reports
 * for it: the resource of a failed request, or the script that logged it.
 */
export async function openWebKitPage(browser) {
  const context = await browser.playwright.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push({ message: error.message, url: null }));
  page.on('console', message => {
    if (message.type() === 'error') errors.push({ message: message.text(), url: message.location()?.url || null });
  });
  return {
    errors,
    async goto(url, width, height = 900) {
      await page.setViewportSize({ width, height });
      await page.goto(url);
    },
    evaluate: expression => page.evaluate(expression),
    // waitForFunction would compile the expression inside the page, which the dashboard's CSP refuses; poll instead.
    async waitFor(expression, timeoutMs = 8000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        if (await page.evaluate(expression).catch(() => false)) return;
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${expression}`);
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    },
    screenshot: () => page.screenshot(),
    setReducedMotion: reduce => page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' }),
  };
}
