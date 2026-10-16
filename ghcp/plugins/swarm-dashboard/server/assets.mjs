import { createHash } from 'node:crypto';
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

/** A short fingerprint of the served UI files: it changes when any file changes. */
export function assetsFingerprint(assets) {
  const hash = createHash('sha256');
  for (const [path, { body }] of [...assets].sort(([a], [b]) => (a < b ? -1 : 1))) hash.update(path).update('\0').update(body).update('\0');
  return hash.digest('hex').slice(0, 16);
}
