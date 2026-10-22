import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AGENT_PLUGINS_SCHEMA, EXTENSION_DIR, validateDashboard } from '../scripts/lib/validate-dashboard.mjs';
import { tempDir } from './helpers/temp.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = file => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const name = file => path.relative(root, file);
function sources(dir, pattern = /\.mjs$/) {
  return readdirSync(dir).flatMap(entry => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? sources(full, pattern) : pattern.test(entry) ? [full] : [];
  });
}
const serverFiles = sources(path.join(root, 'server'));
const uiFiles = sources(path.join(root, 'ui'));
const extensionFile = path.join(root, EXTENSION_DIR, 'extension.mjs');

/** A copy of the plugin to break one thing in. */
function sandbox() {
  const dir = path.join(tempDir('swarm-packaging-'), 'swarm-dashboard');
  mkdirSync(dir);
  cpSync(root, dir, { recursive: true });
  return dir;
}
const validate = dir => validateDashboard(dir, JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')), JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8')));

test('the plugin declares its canvas the way Copilot discovers it', async () => {
  const manifest = readJson('plugin.json');
  assert.equal(manifest.$schema, AGENT_PLUGINS_SCHEMA);
  assert.deepEqual(manifest.extensions, { 'com.github.copilot': {} });
  assert.deepEqual(readJson(`${EXTENSION_DIR}/copilot-extension.json`), { name: 'swarm-dashboard', version: 1 });
  assert.deepEqual(await validateDashboard(root, manifest, readJson('package.json')), []);
});

test('the validator reports a missing schema, extensions field, command, file or marker', async () => {
  const dir = sandbox();
  const manifest = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8'));
  delete manifest.$schema;
  manifest.extensions = 'extensions';
  writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  const pkg = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  delete pkg.scripts.start;
  writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg));
  rmSync(path.join(dir, 'ui', 'main.mjs'));
  writeFileSync(path.join(dir, EXTENSION_DIR, 'copilot-extension.json'), '{ "name": "other", "version": 1 }');
  const errors = await validate(dir);
  for (const expected of ['"$schema"', '"extensions"', 'the start command', 'ui/main.mjs: required file is missing', 'copilot-extension.json must be']) {
    assert.ok(errors.some(error => error.includes(expected)), `${expected} in\n${errors.join('\n')}`);
  }
});

test('the validator rejects an extension that writes to stdout or declares no canvas', async () => {
  const dir = sandbox();
  writeFileSync(path.join(dir, EXTENSION_DIR, 'extension.mjs'), "console.log('hello');\n");
  const errors = await validate(dir);
  assert.ok(errors.some(error => error.includes('must join the session with the swarm-dashboard canvas')), errors.join('\n'));
  assert.ok(errors.some(error => error.includes('must not write to stdout')), errors.join('\n'));
});

test('the server and the extension never write to stdout', () => {
  for (const file of [...serverFiles, extensionFile]) {
    assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.(log|info|debug|dir|table)\(|process\.stdout/, name(file));
  }
});

test('the server, the UI and the extension write no files', () => {
  const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|utimes|utimesSync)\s*\(/;
  for (const file of [...serverFiles, ...uiFiles, extensionFile]) assert.doesNotMatch(readFileSync(file, 'utf8'), writes, name(file));
});

test('the server and the UI import only Node built-ins and their own modules; the extension adds only the SDK', () => {
  const imports = /\bfrom\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g;
  for (const file of [...serverFiles, ...uiFiles, extensionFile]) {
    for (const match of readFileSync(file, 'utf8').matchAll(imports)) {
      const specifier = match[1] ?? match[2];
      const allowed = specifier.startsWith('.') || (!file.startsWith(path.join(root, 'ui')) && specifier.startsWith('node:')) || (file === extensionFile && specifier === '@github/copilot-sdk/extension');
      assert.ok(allowed, `${name(file)} imports ${specifier}`);
    }
  }
});

test('the server, the UI and the extension avoid APIs newer than Node 18', () => {
  const newer = /\.toSorted\(|\.toReversed\(|\.toSpliced\(|Object\.groupBy|Map\.groupBy|Promise\.withResolvers|Array\.fromAsync|\.isSubsetOf\(|\.union\(|\.intersection\(/;
  for (const file of [...serverFiles, ...uiFiles, extensionFile]) assert.doesNotMatch(readFileSync(file, 'utf8'), newer, name(file));
});

test('the page loads nothing from elsewhere and the server only calls itself', () => {
  for (const file of sources(path.join(root, 'ui'), /\.(mjs|css|html)$/)) assert.doesNotMatch(readFileSync(file, 'utf8'), /https?:\/\//, name(file));
  for (const file of serverFiles) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfetch\(([^,)]*)/g)) assert.match(match[1], /^`http:\/\/127\.0\.0\.1:/, `${name(file)}: fetch(${match[1]}`);
  }
});
