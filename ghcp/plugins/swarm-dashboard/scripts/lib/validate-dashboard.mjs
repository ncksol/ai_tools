import { access, readFile } from 'node:fs/promises';
import path from 'node:path';

export const AGENT_PLUGINS_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const EXTENSION_DIR = 'com.github.copilot/extensions/swarm-dashboard';
export const DASHBOARD_FILES = [
  `${EXTENSION_DIR}/extension.mjs`, `${EXTENSION_DIR}/copilot-extension.json`,
  'server/assets.mjs', 'server/canvas-host.mjs', 'server/demo-engine.mjs', 'server/demo-scenarios.mjs', 'server/engines.mjs',
  'server/http.mjs', 'server/hub.mjs', 'server/shared.mjs',
  'ui/index.html', 'ui/styles.css', 'ui/app.mjs', 'ui/format.mjs', 'ui/history.mjs', 'ui/live.mjs', 'ui/main.mjs', 'ui/model.mjs',
  'ui/morph.mjs', 'ui/parts.mjs', 'ui/plan.mjs', 'ui/timeline.mjs',
  'scripts/swarm-dashboard.mjs', 'scripts/check-layout.mjs', 'scripts/lib/cdp.mjs', 'scripts/lib/page-audit.mjs', 'scripts/lib/webkit.mjs',
  'tests/fixtures/layout-good.html', 'tests/fixtures/layout-bad.html',
];
const SCRIPTS = { start: 'node scripts/swarm-dashboard.mjs', 'check:layout': 'node scripts/check-layout.mjs' };

/** The dashboard's checks: canvas packaging, UI, server and launcher files, and the two commands. */
export async function validateDashboard(root, manifest, pkg) {
  const errors = [];
  if (manifest.$schema !== AGENT_PLUGINS_SCHEMA) errors.push(`plugin.json must declare "$schema": "${AGENT_PLUGINS_SCHEMA}" so Copilot finds the canvas`);
  const client = manifest.extensions?.['com.github.copilot'];
  if (!client || typeof client !== 'object' || Array.isArray(client)) errors.push('plugin.json must declare "extensions": { "com.github.copilot": {} }');
  for (const [name, command] of Object.entries(SCRIPTS)) {
    if (pkg.scripts?.[name] !== command) errors.push(`package.json must expose the ${name} command`);
  }
  for (const file of DASHBOARD_FILES) {
    try {
      await access(path.join(root, file));
    } catch {
      errors.push(`${file}: required file is missing`);
    }
  }
  try {
    const marker = JSON.parse(await readFile(path.join(root, EXTENSION_DIR, 'copilot-extension.json'), 'utf8'));
    if (marker?.name !== 'swarm-dashboard' || marker?.version !== 1) errors.push(`${EXTENSION_DIR}/copilot-extension.json must be { "name": "swarm-dashboard", "version": 1 }`);
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(`${EXTENSION_DIR}/copilot-extension.json: ${error.message}`);
  }
  try {
    const source = await readFile(path.join(root, EXTENSION_DIR, 'extension.mjs'), 'utf8');
    // Match the specifier alone: PR 1's import guard scans scripts/ for import statements and would count a quoted one.
    if (!source.includes("'@github/copilot-sdk/extension'") || !/\bjoinSession\(/.test(source) || !source.includes("id: 'swarm-dashboard'")) {
      errors.push(`${EXTENSION_DIR}/extension.mjs must join the session with the swarm-dashboard canvas`);
    }
    if (/console\.(log|info|debug|dir|table)\(|process\.stdout/.test(source)) errors.push(`${EXTENSION_DIR}/extension.mjs must not write to stdout`);
  } catch (error) {
    if (error.code !== 'ENOENT') errors.push(`${EXTENSION_DIR}/extension.mjs: ${error.message}`);
  }
  return errors;
}
