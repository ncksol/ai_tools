import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../scripts/validate-plugin.mjs';
import { POLICY_AGENT, policyBlocks } from '../scripts/lib/validate-skills.mjs';
import { tempDir } from './helpers/temp.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(pluginRoot, '../../..');
const coreText = readFileSync(path.join(pluginRoot, POLICY_AGENT), 'utf8');
const policy = policyBlocks(coreText);
const tableRows = policy.table.split('\n');

/** A copy of the plugin and the root marketplace in a scratch repository, with `from` replaced by `to` in wintermute-core. */
function sandbox(from, to) {
  const changed = coreText.replace(from, to);
  assert.notEqual(changed, coreText, 'the fixture edit changed nothing');
  const repo = tempDir('swarm-skills-plugin-');
  const root = path.join(repo, 'ghcp/plugins/wintermute');
  mkdirSync(path.dirname(root), { recursive: true });
  cpSync(pluginRoot, root, { recursive: true });
  mkdirSync(path.join(repo, '.github/plugin'), { recursive: true });
  cpSync(path.join(repositoryRoot, '.github/plugin/marketplace.json'), path.join(repo, '.github/plugin/marketplace.json'));
  writeFileSync(path.join(root, POLICY_AGENT), changed);
  return { repo, root };
}

test('npm run validate reports drift between wintermute-core and the wintermute-project skill', async () => {
  const lastRow = tableRows.at(-1);
  const cases = [
    [policy.table, [...tableRows.slice(0, -1), `${lastRow.replace(/\|\s*$/, '')} changed only in wintermute-core |`].join('\n'), `the tier table differs from ${POLICY_AGENT} at its line ${tableRows.length}`],
    [policy.neverUse, `${policy.neverUse}\n\n- Haiku at \`max\`: added only in wintermute-core.`, 'the "Never use these:" list differs from'],
  ];
  for (const [from, to, expected] of cases) {
    const { repo, root } = sandbox(from, to);
    const errors = await validatePlugin(root, repo);
    assert.ok(errors.some(error => error.includes(expected)), `${expected} in\n${errors.join('\n')}`);
  }
});
