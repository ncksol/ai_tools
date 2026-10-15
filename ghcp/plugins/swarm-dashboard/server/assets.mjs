import { readFileSync, readdirSync } from 'node:fs';

const UI = new URL('../ui/', import.meta.url);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8' };

/** The only files the server serves: index.html at "/" and the other ui/ files under /ui/. Read once at start. */
export function loadAssets(dir = UI) {
  const assets = new Map();
  for (const name of readdirSync(dir).sort()) {
    const type = TYPES[name.slice(name.lastIndexOf('.'))];
    if (!type || !/^[\w.-]+$/.test(name)) continue;
    assets.set(name === 'index.html' ? '/index.html' : `/ui/${name}`, { type, body: readFileSync(new URL(name, dir)) });
  }
  return assets;
}
