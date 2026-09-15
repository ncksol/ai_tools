import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validatePlugin } from '../scripts/validate-plugin.mjs';

const source = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t) {
  const repository = await mkdtemp(path.join(tmpdir(), 'adr-plugin-'));
  t.after(() => rm(repository, { recursive: true, force: true }));
  const root = path.join(repository, 'ghcp/plugins/adr-authoring');
  await cp(source, root, { recursive: true });
  await mkdir(path.join(repository, '.github/plugin'), { recursive: true });
  const marketplace = path.join(repository, '.github/plugin/marketplace.json');
  await writeFile(marketplace, JSON.stringify({
    plugins: [{ name: 'adr-authoring', version: '0.1.0', source: './ghcp/plugins/adr-authoring' }],
  }));
  return { root, repository, marketplace };
}

async function changeJson(file, change) {
  const data = JSON.parse(await readFile(file, 'utf8'));
  change(data);
  await writeFile(file, JSON.stringify(data));
}

test('validates the complete plugin and root marketplace together', async t => {
  const { root, repository } = await fixture(t);
  assert.deepEqual(await validatePlugin(root, repository), []);
});

const changes = [
  ['wrong plugin name', 'plugin.json', data => { data.name = 'unrelated'; }, /name/i],
  ['invalid version', 'plugin.json', data => { data.version = 'next'; }, /version/i],
  ['package version mismatch', 'package.json', data => { data.version = '9.0.0'; }, /version/i],
  ['wrong skill location', 'plugin.json', data => { data.skills = '../elsewhere'; }, /skills/i],
  ['runtime hooks', 'plugin.json', data => { data.hooks = {}; }, /hooks/i],
  ['MCP dependency', 'plugin.json', data => { data.mcpServers = {}; }, /MCP|mcpServers/i],
];

for (const [name, file, change, expected] of changes) {
  test(`rejects ${name}`, async t => {
    const { root, repository } = await fixture(t);
    await changeJson(path.join(root, file), change);
    assert.match((await validatePlugin(root, repository)).join('\n'), expected);
  });
}

test('reports malformed JSON with its file path', async t => {
  const { root, repository } = await fixture(t);
  await writeFile(path.join(root, 'plugin.json'), '{broken');
  assert.match((await validatePlugin(root, repository)).join('\n'), /plugin\.json/);
});

test('rejects duplicate marketplace entries and wrong source/version', async t => {
  const { root, repository, marketplace } = await fixture(t);
  await changeJson(marketplace, data => {
    data.plugins[0].source = './ghcp/plugins/another-plugin';
    data.plugins[0].version = '0.0.1';
  });
  const errors = (await validatePlugin(root, repository)).join('\n');
  assert.match(errors, /source/i);
  assert.match(errors, /version/i);
  await changeJson(marketplace, data => { data.plugins.push(data.plugins[0]); });
  assert.match((await validatePlugin(root, repository)).join('\n'), /exactly one|duplicate/i);
});

test('fails when the root marketplace is absent rather than skipping it', async t => {
  const { root, repository, marketplace } = await fixture(t);
  await rm(marketplace);
  assert.match((await validatePlugin(root, repository)).join('\n'), /marketplace\.json/);
});

test('rejects a plugin-local marketplace manifest', async t => {
  const { root, repository } = await fixture(t);
  await mkdir(path.join(root, '.github/plugin'), { recursive: true });
  await writeFile(path.join(root, '.github/plugin/marketplace.json'), '{}');
  assert.match((await validatePlugin(root, repository)).join('\n'), /local marketplace/i);
});

test('reports missing required resources and broken Markdown links', async t => {
  const { root, repository } = await fixture(t);
  await rm(path.join(root, 'skills/adr-write/references/style-guide.md'));
  const skill = path.join(root, 'skills/adr-write/SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\n[Missing](references/absent.md)\n`);
  const errors = (await validatePlugin(root, repository)).join('\n');
  assert.match(errors, /style-guide\.md/);
  assert.match(errors, /absent\.md/);
});

test('rejects an empty required style resource', async t => {
  const { root, repository } = await fixture(t);
  await writeFile(path.join(root, 'skills/adr-write/references/style-guide.md'), ' \n');
  assert.match((await validatePlugin(root, repository)).join('\n'), /style-guide\.md.*empty/i);
});

test('validates template metadata as well as its headings', async t => {
  const { root, repository } = await fixture(t);
  const template = path.join(root, 'skills/adr-write/references/template.md');
  await writeFile(template, (await readFile(template, 'utf8')).replace('- Date:', '- Recorded:'));
  assert.match((await validatePlugin(root, repository)).join('\n'), /template.*Date/i);
});

test('rejects extra skill frontmatter fields and duplicate keys', async t => {
  const { root, repository } = await fixture(t);
  const skill = path.join(root, 'skills/adr-write/SKILL.md');
  const text = await readFile(skill, 'utf8');
  await writeFile(skill, text.replace('name: adr-write', 'name: adr-write\nname: duplicate\ntools: []'));
  const errors = (await validatePlugin(root, repository)).join('\n');
  assert.match(errors, /duplicate.*name/i);
  assert.match(errors, /tools/);
});

test('rejects a missing agent description and incorrect skill name', async t => {
  const { root, repository } = await fixture(t);
  await writeFile(path.join(root, 'agents/adr-writer.agent.md'), '# No frontmatter\n');
  const skill = path.join(root, 'skills/adr-write/SKILL.md');
  await writeFile(skill, (await readFile(skill, 'utf8')).replace('name: adr-write', 'name: other-skill'));
  const errors = (await validatePlugin(root, repository)).join('\n');
  assert.match(errors, /adr-writer.*frontmatter/i);
  assert.match(errors, /name.*adr-write/i);
});

test('checks example structure, example pairs, and the evaluation case count', async t => {
  const { root, repository } = await fixture(t);
  await writeFile(path.join(root, 'skills/adr-write/examples/01-queue-adr.md'), '# Incomplete\n');
  await rm(path.join(root, 'skills/adr-write/examples/02-region-brief.md'));
  await writeFile(path.join(root, 'evaluations/cases.md'), '# No cases\n');
  const errors = (await validatePlugin(root, repository)).join('\n');
  assert.match(errors, /01-queue-adr/);
  assert.match(errors, /02-region-brief/);
  assert.match(errors, /ten|10/i);
});

test('rejects links escaping the installed plugin resource boundary', async t => {
  const { root, repository } = await fixture(t);
  const skill = path.join(root, 'skills/adr-write/SKILL.md');
  await writeFile(skill, `${await readFile(skill, 'utf8')}\n[Outside](../../../../private.md)\n`);
  assert.match((await validatePlugin(root, repository)).join('\n'), /outside.*plugin/i);
});

test('CLI exits nonzero for invalid packaging without claiming success', async t => {
  const { root } = await fixture(t);
  const script = path.join(root, 'scripts/validate-plugin.mjs');
  const success = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(success.status, 0, success.stderr);
  assert.match(success.stdout, /Plugin validation passed/);
  await rm(path.join(root, 'plugin.json'));
  const failure = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(failure.status, 1);
  assert.match(failure.stderr, /plugin\.json/);
  assert.equal(failure.stdout, '');
});
