import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function sources(dir) {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? sources(full) : full.endsWith('.mjs') ? [full] : [];
  });
}
const engineFiles = sources(path.join(root, 'engine'));
const shipped = [...engineFiles, ...sources(path.join(root, 'scripts'))];
const name = file => path.relative(root, file);

test('the engine never writes to stdout', () => {
  for (const file of engineFiles) assert.doesNotMatch(readFileSync(file, 'utf8'), /console\.(log|info|debug|dir|table)\(|process\.stdout/, name(file));
});

test('only the history store writes files', () => {
  const writes = /\b(writeFile|writeFileSync|appendFile|appendFileSync|createWriteStream|rename|renameSync|mkdir|mkdirSync|rm|rmSync|unlink|unlinkSync|copyFile|copyFileSync|truncate|truncateSync|utimes|utimesSync)\s*\(/;
  for (const file of engineFiles) {
    if (file.endsWith(path.join('model', 'history.mjs'))) continue;
    assert.doesNotMatch(readFileSync(file, 'utf8'), writes, name(file));
  }
});

test('SQL selects named columns and never touches secrets', () => {
  for (const file of engineFiles) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!/\bSELECT\b|\bFROM\b/.test(line)) continue;
      assert.doesNotMatch(line, /SELECT\s+\*|settings|token/i, `${name(file)}: ${line.trim()}`);
    }
  }
});

test('shipped code imports only Node built-ins and its own modules', () => {
  for (const file of shipped) {
    for (const match of readFileSync(file, 'utf8').matchAll(/\bfrom\s+'([^']+)'|import\(\s*'([^']+)'\s*\)/g)) {
      const specifier = match[1] ?? match[2];
      assert.ok(specifier.startsWith('node:') || specifier.startsWith('.'), `${name(file)} imports ${specifier}`);
    }
  }
});

test('shipped code avoids APIs newer than Node 18', () => {
  const newer = /\.toSorted\(|\.toReversed\(|\.toSpliced\(|Object\.groupBy|Map\.groupBy|Promise\.withResolvers|Array\.fromAsync|\.isSubsetOf\(|\.union\(|\.intersection\(/;
  for (const file of shipped) assert.doesNotMatch(readFileSync(file, 'utf8'), newer, name(file));
});
