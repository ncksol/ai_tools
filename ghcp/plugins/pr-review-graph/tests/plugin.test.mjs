import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { normalize } from '../skills/review-pull-request/scripts/normalize-context.mjs';
import { buildReviewPlan } from '../skills/review-pull-request/scripts/build-review-plan.mjs';
import { validateFindings } from '../skills/review-pull-request/scripts/validate-findings.mjs';
import { fingerprintFindings } from '../skills/review-pull-request/scripts/fingerprint-findings.mjs';
import { applyDeduplication, prepareDeduplication } from '../skills/review-pull-request/scripts/deduplicate-findings.mjs';
import { buildGitHubReview } from '../skills/review-pull-request/scripts/build-github-review.mjs';
import { buildAzureThreads } from '../skills/review-pull-request/scripts/build-azure-threads.mjs';
import { applyComments } from '../skills/review-pull-request/scripts/apply-comments.mjs';
import {
  discoveryResultFileName,
  finalizeDiscovery,
  ingestDiscoveryResponse,
  recordDiscoveryTransportFailure
} from '../skills/review-pull-request/scripts/process-discovery.mjs';
import {
  extractAgentResponse
} from '../skills/review-pull-request/scripts/extract-agent-response.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture(name) {
  return JSON.parse(await readFile(path.join(root, 'tests/fixtures', name), 'utf8'));
}

function discoveryCandidate(category = 'correctness', overrides = {}) {
  return {
    category,
    severity: 'high',
    confidence: 0.9,
    title: 'Malformed output loses review coverage',
    problem: 'the discovery response cannot be parsed as strict JSON',
    trigger: 'a specialist emits a literal control character inside a string',
    consequence: 'the batch is omitted from discovery coverage',
    evidence: 'the strict parser rejects the response before candidate validation',
    recommendation: 'serialize every string with JSON escapes',
    location: null,
    relatedLocations: [],
    ...overrides
  };
}

function agentEventStream(content, options = {}) {
  const turnId = options.turnId ?? 'turn-final';
  const events = [
    ...(options.preceding ?? []),
    {
      type: 'assistant.turn_start',
      data: { turnId, interactionId: `interaction-${turnId}` }
    },
    ...(options.beforePayload ?? []),
    {
      type: 'assistant.message',
      data: { turnId, content, toolRequests: options.toolRequests ?? [] }
    },
    {
      type: 'assistant.turn_end',
      data: { turnId }
    },
    ...(options.following ?? []),
    {
      type: 'result',
      exitCode: options.exitCode ?? 0
    }
  ];
  return `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
}

test('agent response transport preserves long array and object payloads exactly', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-transport-'));
  try {
    const payloads = [
      JSON.stringify([discoveryCandidate('correctness', {
        title: 'x'.repeat(500),
        evidence: 'first line\nsecond line\rthird line\twith a tab\0and a nul'
      })]),
      JSON.stringify({
        comments: [{
          fingerprint: 'a'.repeat(64),
          comment: `line one\nline two ${'y'.repeat(500)}`
        }]
      })
    ];

    for (const [index, payload] of payloads.entries()) {
      const eventsFile = path.join(directory, `events-${index}.jsonl`);
      const responseFile = path.join(directory, `response-${index}.json`);
      const statusFile = path.join(directory, `status-${index}.json`);
      await writeFile(eventsFile, agentEventStream(payload), { mode: 0o600 });

      const result = await extractAgentResponse(eventsFile, responseFile, statusFile);

      assert.equal(result.status, 'complete');
      assert.equal(await readFile(responseFile, 'utf8'), payload);
      assert.equal((await stat(responseFile)).mode & 0o777, 0o600);
      assert.equal((await stat(statusFile)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(statusFile, 'utf8')), {
        schemaVersion: '1.0',
        status: 'complete'
      });
      await assert.rejects(access(eventsFile), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent response transport accepts structural tool events before the final payload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-tool-transport-'));
  try {
    const eventsFile = path.join(directory, 'events.jsonl');
    const responseFile = path.join(directory, 'response.json');
    const statusFile = path.join(directory, 'status.json');
    const payload = JSON.stringify({ verdict: 'rejected', reason: 'No reachable failure path.' });
    await writeFile(eventsFile, agentEventStream(payload, {
      preceding: [
        { type: 'assistant.turn_start', data: { turnId: 'turn-tool' } },
        {
          type: 'assistant.message',
          data: {
            turnId: 'turn-tool',
            content: '',
            toolRequests: [{ toolCallId: 'call-1', name: 'skill' }]
          }
        },
        {
          type: 'tool.execution_start',
          data: { turnId: 'turn-tool', toolCallId: 'call-1', toolName: 'skill' }
        },
        {
          type: 'tool.execution_complete',
          data: { turnId: 'turn-tool', toolCallId: 'call-1', success: true }
        },
        { type: 'assistant.turn_end', data: { turnId: 'turn-tool' } }
      ]
    }), { mode: 0o600 });

    const result = await extractAgentResponse(eventsFile, responseFile, statusFile);

    assert.equal(result.status, 'complete');
    assert.equal(await readFile(responseFile, 'utf8'), payload);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent response transport ignores an empty tool-free reasoning frame', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-empty-frame-'));
  try {
    const eventsFile = path.join(directory, 'events.jsonl');
    const responseFile = path.join(directory, 'response.json');
    const statusFile = path.join(directory, 'status.json');
    await writeFile(eventsFile, agentEventStream('[]', {
      beforePayload: [{
        type: 'assistant.message',
        data: {
          turnId: 'turn-final',
          content: '',
          toolRequests: [],
          encryptedContent: 'synthetic-encrypted-frame',
          reasoningOpaque: 'synthetic-reasoning-frame'
        }
      }]
    }), { mode: 0o600 });

    const result = await extractAgentResponse(eventsFile, responseFile, statusFile);

    assert.equal(result.status, 'complete');
    assert.equal(await readFile(responseFile, 'utf8'), '[]');
    assert.deepEqual(JSON.parse(await readFile(statusFile, 'utf8')), {
      schemaVersion: '1.0',
      status: 'complete'
    });
    await assert.rejects(access(eventsFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('captured reliability stream shape extracts and ingests the final candidate array', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-reliability-shape-'));
  try {
    const eventsFile = path.join(directory, 'events.jsonl');
    const responseFile = path.join(directory, 'response.json');
    const statusFile = path.join(directory, 'status.json');
    const candidate = discoveryCandidate('reliability', {
      title: 'Terminal payload survives empty reasoning frames',
      problem: 'valid final discovery output is discarded before strict ingestion',
      trigger: 'a long Copilot turn emits empty tool-free reasoning frames',
      consequence: 'the planned reliability batch is recorded as failed',
      evidence: 'the terminal assistant payload remains a strict candidate array',
      recommendation: 'exclude empty assistant frames from payload candidacy'
    });
    const payload = JSON.stringify([candidate]);
    const reasoningFrames = Array.from({ length: 7 }, (_, index) => ({
      type: 'assistant.message',
      data: {
        turnId: 'turn-final',
        content: '',
        toolRequests: [],
        encryptedContent: `synthetic-encrypted-${index + 1}`,
        reasoningOpaque: `synthetic-reasoning-${index + 1}`
      }
    }));
    await writeFile(eventsFile, agentEventStream(payload, {
      preceding: [
        { type: 'assistant.turn_start', data: { turnId: 'turn-tool' } },
        {
          type: 'assistant.message',
          data: {
            turnId: 'turn-tool',
            content: '',
            toolRequests: [{ toolCallId: 'call-1', name: 'skill' }]
          }
        },
        {
          type: 'tool.execution_start',
          data: { turnId: 'turn-tool', toolCallId: 'call-1', toolName: 'skill' }
        },
        {
          type: 'tool.execution_complete',
          data: { turnId: 'turn-tool', toolCallId: 'call-1', success: true }
        },
        { type: 'assistant.turn_end', data: { turnId: 'turn-tool' } }
      ],
      beforePayload: reasoningFrames
    }), { mode: 0o600 });

    const transport = await extractAgentResponse(eventsFile, responseFile, statusFile);
    assert.equal(transport.status, 'complete');
    assert.equal(await readFile(responseFile, 'utf8'), payload);

    const ingestion = await ingestDiscoveryResponse(
      responseFile,
      path.join(directory, 'results'),
      path.join(directory, 'diagnostics'),
      { agent: 'prg-reliability', batch: 1, attempt: 1 }
    );
    assert.equal(ingestion.status, 'complete');
    assert.deepEqual(ingestion.findings, [candidate]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('agent response transport fails closed on ambiguous or rendered streams', async () => {
  const preamble = [
    { type: 'assistant.turn_start', data: { turnId: 'turn-preamble' } },
    {
      type: 'assistant.message',
      data: {
        turnId: 'turn-preamble',
        content: 'Using strict-code-review to inspect this response.',
        toolRequests: []
      }
    },
    { type: 'assistant.turn_end', data: { turnId: 'turn-preamble' } }
  ];
  const finalTurn = [
    { type: 'assistant.turn_start', data: { turnId: 'turn-final' } },
    {
      type: 'assistant.message',
      data: { turnId: 'turn-final', content: '[]', toolRequests: [] }
    },
    { type: 'assistant.turn_end', data: { turnId: 'turn-final' } }
  ];
  const resultEvent = { type: 'result', exitCode: 0 };
  const asJsonl = events => `${events.map(event => JSON.stringify(event)).join('\n')}\n`;
  const cases = [
    {
      label: 'rendered text',
      stream: 'Using strict-code-review to inspect this response.\n[]\n',
      kind: 'transport-invalid-jsonl'
    },
    {
      label: 'contentful preamble',
      stream: asJsonl([...preamble, ...finalTurn, resultEvent]),
      kind: 'transport-multiple-payloads'
    },
    {
      label: 'contentful preamble before object',
      stream: asJsonl([
        ...preamble,
        { type: 'assistant.turn_start', data: { turnId: 'turn-object' } },
        {
          type: 'assistant.message',
          data: {
            turnId: 'turn-object',
            content: '{"comments":[]}',
            toolRequests: []
          }
        },
        { type: 'assistant.turn_end', data: { turnId: 'turn-object' } },
        resultEvent
      ]),
      kind: 'transport-multiple-payloads'
    },
    {
      label: 'failed result',
      stream: agentEventStream('[]', { exitCode: 1 }),
      kind: 'transport-unsuccessful-result'
    },
    {
      label: 'missing result',
      stream: asJsonl(finalTurn),
      kind: 'transport-missing-result'
    },
    {
      label: 'multiple results',
      stream: asJsonl([...finalTurn, resultEvent, resultEvent]),
      kind: 'transport-multiple-results'
    },
    {
      label: 'missing payload',
      stream: agentEventStream('', {
        toolRequests: [{ toolCallId: 'call-1', name: 'skill' }]
      }),
      kind: 'transport-missing-payload'
    },
    {
      // Characterization: a valid completed turn whose only assistant
      // message is empty and tool-free has no payload candidate at all.
      // The corrected extractor already returns transport-missing-payload
      // for this shape; this fixture pins that behavior rather than
      // driving a new implementation change.
      label: 'sole assistant message is an empty tool-free frame',
      stream: agentEventStream(''),
      kind: 'transport-missing-payload'
    },
    {
      label: 'content and tool request',
      stream: agentEventStream('[]', {
        toolRequests: [{ toolCallId: 'call-1', name: 'skill' }]
      }),
      kind: 'transport-invalid-event'
    },
    {
      label: 'message outside a turn',
      stream: asJsonl([
        {
          type: 'assistant.message',
          data: { turnId: 'turn-missing', content: '[]', toolRequests: [] }
        },
        resultEvent
      ]),
      kind: 'transport-non-terminal-payload'
    },
    {
      label: 'payload in a non-final turn',
      stream: agentEventStream('[]', {
        following: [
          { type: 'assistant.turn_start', data: { turnId: 'turn-later' } },
          {
            type: 'assistant.message',
            data: {
              turnId: 'turn-later',
              content: '',
              toolRequests: [{ toolCallId: 'call-later', name: 'skill' }]
            }
          },
          { type: 'assistant.turn_end', data: { turnId: 'turn-later' } }
        ]
      }),
      kind: 'transport-non-terminal-payload'
    },
    {
      label: 'malformed event object',
      stream: asJsonl([{}, ...finalTurn, resultEvent]),
      kind: 'transport-invalid-event'
    },
    {
      label: 'empty tool-free message outside a turn',
      stream: asJsonl([{
        type: 'assistant.message',
        data: {
          turnId: 'turn-orphan',
          content: '',
          toolRequests: [],
          encryptedContent: 'synthetic-encrypted-frame',
          reasoningOpaque: 'synthetic-reasoning-frame'
        }
      }, ...finalTurn, resultEvent]),
      kind: 'transport-non-terminal-payload'
    }
  ];

  for (const [index, fixture] of cases.entries()) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `prg-agent-invalid-${index}-`));
    try {
      const eventsFile = path.join(directory, 'events.jsonl');
      const responseFile = path.join(directory, 'response.json');
      const statusFile = path.join(directory, 'status.json');
      await writeFile(eventsFile, fixture.stream, { mode: 0o600 });

      const result = await extractAgentResponse(eventsFile, responseFile, statusFile);

      assert.equal(result.status, 'invalid', fixture.label);
      assert.equal(result.failure.kind, fixture.kind, fixture.label);
      await assert.rejects(access(responseFile), { code: 'ENOENT' });
      await assert.rejects(access(eventsFile), { code: 'ENOENT' });
      const persisted = await readFile(statusFile, 'utf8');
      assert.deepEqual(JSON.parse(persisted), result);
      assert.doesNotMatch(
        persisted,
        /Using strict-code-review|inspect this response|\[\]/,
        fixture.label
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('agent response transport CLI feeds array and object stage consumers', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-agent-transport-cli-'));
  try {
    const extractor = 'skills/review-pull-request/scripts/extract-agent-response.mjs';
    async function extract(label, payload) {
      const eventsFile = path.join(directory, `${label}.jsonl`);
      const responseFile = path.join(directory, `${label}.response.json`);
      const statusFile = path.join(directory, `${label}.status.json`);
      await writeFile(eventsFile, agentEventStream(payload), { mode: 0o600 });
      const cli = spawnSync(process.execPath, [
        extractor,
        eventsFile,
        responseFile,
        statusFile
      ], { cwd: root, encoding: 'utf8' });
      assert.equal(cli.status, 0, `${label}: ${cli.stdout}${cli.stderr}`);
      assert.equal(JSON.parse(await readFile(statusFile, 'utf8')).status, 'complete');
      await assert.rejects(access(eventsFile), { code: 'ENOENT' });
      return responseFile;
    }

    const candidate = discoveryCandidate('correctness', {
      evidence: `first line\nsecond line ${'x'.repeat(500)}`
    });
    const discoveryFile = await extract('discovery', JSON.stringify([candidate]));
    const discovery = await ingestDiscoveryResponse(
      discoveryFile,
      path.join(directory, 'discovery-results'),
      path.join(directory, 'discovery-diagnostics'),
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );
    assert.deepEqual(discovery.findings, [candidate]);

    const verifierFile = await extract('verifier', JSON.stringify({
      verdict: 'rejected',
      confidence: 0.97,
      reason: 'The supplied guard prevents the claimed trigger.',
      finding: candidate
    }));
    const verifier = JSON.parse(await readFile(verifierFile, 'utf8'));
    assert.equal(verifier.verdict, 'rejected');
    assert.equal(typeof verifier.confidence, 'number');
    assert.equal(typeof verifier.reason, 'string');
    assert.deepEqual(verifier.finding, candidate);

    const fingerprint = 'a'.repeat(64);
    const fingerprinted = { ...candidate, fingerprint };
    const prepared = {
      schemaVersion: '1.0',
      findings: [fingerprinted],
      existingThreadCount: 1,
      batches: [{
        batchId: 'batch-001',
        findingFingerprints: [fingerprint],
        existingThreads: [{
          id: '501',
          body: 'An unrelated existing review comment.'
        }]
      }],
      suppressed: []
    };
    const deduplicatorFile = await extract('deduplicator', JSON.stringify({
      batchId: 'batch-001',
      decisions: [{
        fingerprint,
        verdict: 'distinct',
        matchedThreadIds: [],
        reason: `No existing comment reports this failure. ${'y'.repeat(500)}`
      }]
    }));
    const deduplicated = applyDeduplication(
      prepared,
      JSON.parse(await readFile(deduplicatorFile, 'utf8'))
    );
    assert.equal(deduplicated.findings.length, 1);

    const editorFile = await extract('editor', JSON.stringify({
      comments: [{
        fingerprint,
        comment: `This path still fails for the supplied trigger. ${'z'.repeat(500)}`
      }]
    }));
    const edited = applyComments(
      deduplicated,
      JSON.parse(await readFile(editorFile, 'utf8'))
    );
    assert.equal(edited.length, 1);
    assert.match(edited[0].comment, /supplied trigger/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('static plugin validation passes and declares no MCP integration', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'plugin.json'), 'utf8'));
  const marketplace = JSON.parse(await readFile(
    path.resolve(root, '../../..', '.github/plugin/marketplace.json'),
    'utf8'
  ));
  const validator = await readFile(path.join(root, 'scripts/validate-plugin.mjs'), 'utf8');
  assert.equal(manifest.name, 'pr-review-graph');
  assert.equal(manifest.version, '0.2.8');
  assert.equal(
    marketplace.plugins.find(plugin => plugin.name === manifest.name)?.version,
    manifest.version
  );
  assert.equal(manifest.mcpServers, undefined);
  assert.equal(manifest.hooks, undefined);
  assert.match(validator, /extract-agent-response\.mjs/);
  assert.match(validator, /--output-format json --stream off --silent/);

  const result = spawnSync(process.execPath, ['scripts/validate-plugin.mjs'], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});

test('both provider adapters delegate CLI conventions to external skills', async () => {
  const skill = await readFile(path.join(root, 'skills/review-pull-request/SKILL.md'), 'utf8');
  const github = await readFile(path.join(root, 'skills/review-pull-request/references/github-gh-cli-provider.md'), 'utf8');
  const azure = await readFile(path.join(root, 'skills/review-pull-request/references/azure-devops-cli-provider.md'), 'utf8');
  assert.match(skill, /separately installed `gh-cli` skill/);
  assert.match(skill, /separately installed `azure-devops-cli` skill/);
  assert.match(github, /First load and follow the separately installed `gh-cli` skill/);
  assert.match(azure, /Load and follow the separately installed `azure-devops-cli` skill/);
});

test('subprocess transport loads the plugin explicitly without auto-updating', async () => {
  const skill = await readFile(path.join(root, 'skills/review-pull-request/SKILL.md'), 'utf8');
  const start = skill.indexOf('## Machine-response transport');
  const end = skill.indexOf('## Phase 1: Resolve and snapshot');
  const transport = skill.slice(start, end);

  assert.match(transport, /PLUGIN_DIR="\$\(cd "<SKILL_DIR>\/\.\.\/\.\." && pwd -P\)"/);
  assert.match(
    transport,
    /COPILOT_AUTO_UPDATE=false \\\n\s*copilot --plugin-dir "\$PLUGIN_DIR" \\/
  );
  assert.match(transport, /--no-auto-update/);
});

test('machine-response transport is required for every tool-less agent stage', async () => {
  const skill = await readFile(path.join(root, 'skills/review-pull-request/SKILL.md'), 'utf8');
  const graph = await readFile(
    path.join(root, 'skills/review-pull-request/references/review-graph.md'),
    'utf8'
  );
  const superpowers = await readFile(
    path.join(root, 'skills/review-pull-request/references/superpowers-compatibility.md'),
    'utf8'
  );
  const readme = await readFile(path.join(root, 'README.md'), 'utf8');

  assert.match(skill, /--output-format json --stream off --silent/);
  assert.match(skill, /extract-agent-response\.mjs/);
  assert.match(skill, /rendered transcript[^.]*never ingestible/i);
  assert.match(skill, /explicit raw final-response field/i);
  for (const agent of ['prg-verifier', 'prg-deduplicator', 'prg-editor']) {
    const dispatch = skill.indexOf(`\`${agent}\``);
    assert.notEqual(dispatch, -1, agent);
    assert.match(skill.slice(dispatch, dispatch + 1_800), /extract-agent-response\.mjs/, agent);
  }
  assert.match(graph, /verification transport failure[^.]*reject/i);
  assert.match(graph, /deduplication transport failure[^.]*retry once[^.]*hold/i);
  assert.match(graph, /editor transport failure[^.]*retry once[^.]*stop/i);
  assert.match(superpowers, /skill narration[^.]*JSONL event/i);
  assert.match(skill, /empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i);
  assert.match(graph, /empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i);
  assert.match(readme, /empty assistant messages[^.]*structural frames[^.]*regardless of tool requests/i);
  assert.match(readme, /## Opt-in transport smoke/);
  assert.match(readme, /EXPECTED_BASE/);
  assert.match(readme, /pr-review-graph:prg-reliability/);
  assert.match(readme, /normalize-context\.mjs/);

  // Current-repo binding: REPO must be asserted against this checkout, not
  // an arbitrary value.
  assert.match(readme, /git remote get-url origin/);
  assert.match(readme, /gh repo view --json nameWithOwner/);
  assert.match(readme, /\[ "\$REPO" = "\$origin_repo" \]/);
  assert.match(readme, /\[ "\$REPO" = "\$gh_repo" \]/);

  // Pull-ref fetch to FETCH_HEAD so fork PRs and missing objects work,
  // before the cat-file checks, with no persistent custom ref.
  const fetchIndex = readme.indexOf('git fetch --no-tags --quiet origin "refs/pull/${PR}/head"');
  const catFileIndex = readme.indexOf('git cat-file -e "${EXPECTED_BASE}^{commit}"');
  assert.notEqual(fetchIndex, -1);
  assert.notEqual(catFileIndex, -1);
  assert.ok(fetchIndex < catFileIndex, 'PR-head fetch must precede the cat-file checks');
  assert.match(readme, /FETCH_HEAD/);
  assert.match(readme, /no persistent ref/);

  // Full lowercase 40-hex SHA format required for both identities.
  assert.match(readme, /\^\[0-9a-f\]\{40\}\$/);
  assert.match(readme, /EXPECTED_BASE.*=~ \^\[0-9a-f\]\{40\}\$/);
  assert.match(readme, /EXPECTED_HEAD.*=~ \^\[0-9a-f\]\{40\}\$/);

  // Executable jq -e checks binding the remote, packet, and plan identity —
  // not prose-only verification — plus exactly one prg-reliability plan
  // entry containing the selected batch.
  assert.match(readme, /jq -e --arg b "\$EXPECTED_BASE" --arg h "\$EXPECTED_HEAD" \\\n\s*'\.baseRefOid == \$b and \.headRefOid == \$h' "\$scratch\/pull-request\.json"/);
  assert.match(readme, /'\.pullRequest\.base\.sha == \$b and \.pullRequest\.head\.sha == \$h'/);
  assert.match(readme, /'\.snapshot\.baseSha == \$b and \.snapshot\.headSha == \$h'/);
  assert.match(readme, /select\(\.name == "prg-reliability"\)\] as \$reliability\s*\n\s*\| \(\$reliability \| length\) == 1/);
  assert.match(readme, /'\.baseRefOid == \$b and \.headRefOid == \$h' "\$scratch\/final-shas\.json"/);

  // Structural diagnostics: the safe count object must print before its gate.
  const structuralPrintIndex = readme.indexOf('jq . "$scratch/structural.json"');
  const structuralGateIndex = readme.indexOf("jq -e '.opaqueEmptyNoToolFrames >= 1");
  assert.notEqual(structuralPrintIndex, -1);
  assert.notEqual(structuralGateIndex, -1);
  assert.ok(structuralPrintIndex < structuralGateIndex, 'structural counts must print before the topology gate');

  // Safe extractor/ingestion failure handling: only the fixed status/kind
  // from the private JSON, never payload/candidate content, then exit
  // non-zero.
  assert.match(readme, /extract_exit=\$\?/);
  assert.match(readme, /ingest_exit=\$\?/);
  assert.match(readme, /if \[ "\$extract_exit" -ne 0 \]; then\s*\n\s*jq -r '\.failure\.kind' "\$scratch\/transport-status\.json"\s*\n\s*exit 1/);
  assert.match(readme, /if \[ "\$ingest_exit" -ne 0 \]; then\s*\n\s*jq -r '\.failure\.kind' "\$result_file"\s*\n\s*exit 1/);
  assert.match(readme, /Never print payload, candidate, or packet content/);

  // Immutable-PRG-agent / SHA-guarded markers, and the single non-interactive
  // shell + SKILL.md Phase 2 cross-reference.
  assert.match(readme, /SHA-guarded/i);
  assert.match(readme, /one non-interactive shell/);
  assert.match(readme, /Phase 2: Build the graph\]\(skills\/review-pull-request\/SKILL\.md#phase-2-build-the-graph\)/);
  assert.match(readme, /no added capabilities/);

  // The superseded short synthetic skill-only smoke must be fully gone.
  assert.doesNotMatch(readme, /--available-tools=skill --allow-tool=skill/);
  assert.doesNotMatch(readme, /emptyNoToolFrames\b/);
  assert.doesNotMatch(readme, /toolBearingEmptyFrames\b/);
  assert.doesNotMatch(readme, /nonEmptyPayloads\b/);
  assert.doesNotMatch(readme, /return exactly \[\]/i);
  assert.doesNotMatch(readme, /\(\.findings \| length\) == 0/);
});

test('GitHub raw data normalizes into an immutable canonical packet', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  assert.equal(packet.provider, 'github');
  assert.equal(packet.repository.id, 'acme/widgets');
  assert.equal(packet.pullRequest.number, 42);
  assert.equal(packet.pullRequest.head.sha, '2222222222222222222222222222222222222222');
  assert.equal(packet.files[0].path, 'src/user.js');
  assert.match(packet.files[0].patch, /req\.query\.id/);
  assert.deepEqual(packet.existingThreads.map(thread => thread.type), ['review-comment', 'review', 'issue-comment']);
  assert.equal(packet.existingThreads[0].url, 'https://github.com/acme/widgets/pull/42#discussion_r501');
  assert.deepEqual(packet.limits.warnings, []);
});

test('risk router selects only relevant conditional specialists', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const plan = buildReviewPlan(packet);
  const names = plan.agents.map(agent => agent.name);
  assert.deepEqual(names.slice(0, 3), ['prg-contract', 'prg-correctness', 'prg-tests']);
  assert.ok(names.includes('prg-security'));
  assert.ok(!names.includes('prg-data-compatibility'));
  assert.ok(!names.includes('prg-reliability'));
});

test('finding validation enforces verification and security confidence', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const findings = await fixture('findings.json');
  const valid = validateFindings(findings, { mode: 'verified', packet });
  assert.equal(valid.valid, true, valid.errors.join('\n'));
  assert.ok(valid.warnings.some(warning => warning.includes('summary-only')));

  const lowConfidence = structuredClone(findings);
  lowConfidence[0].confidence = 0.84;
  const invalid = validateFindings(lowConfidence, { mode: 'verified', packet });
  assert.equal(invalid.valid, false);
  assert.ok(invalid.errors.some(error => error.includes('below 0.85')));
});

test('fingerprints are stable and suppress already-published comments', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const findings = await fixture('findings.json');
  const first = fingerprintFindings(packet, findings);
  const second = fingerprintFindings(packet, findings);
  assert.equal(first.findings[0].fingerprint, second.findings[0].fingerprint);
  assert.match(first.findings[0].fingerprint, /^[a-f0-9]{64}$/);

  packet.existingThreads.push({ fingerprint: first.findings[0].fingerprint });
  const suppressed = fingerprintFindings(packet, findings);
  assert.equal(suppressed.findings.length, 1);
  assert.equal(suppressed.suppressed[0].reason, 'already-commented');
});

test('semantic duplicate from another engineer is suppressed with its review reference', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  assert.equal(prepared.existingThreadCount, 3);
  assert.equal(prepared.batches.flatMap(batch => batch.existingThreads).length, 3);

  const decisions = prepared.batches.map(batch => ({
    batchId: batch.batchId,
    decisions: fingerprinted.findings.map((finding, index) => index === 0
      ? {
          fingerprint: finding.fingerprint,
          verdict: 'duplicate',
          matchedThreadIds: ['501'],
          reason: 'Both findings report attacker-controlled input being inserted into the SQL query.'
        }
      : {
          fingerprint: finding.fingerprint,
          verdict: 'distinct',
          matchedThreadIds: [],
          reason: 'No existing comment reports the numeric identifier contract defect.'
        })
  }));

  const result = applyDeduplication(prepared, decisions);
  assert.equal(result.findings.length, 1);
  assert.equal(result.suppressed.at(-1).reason, 'existing-review-duplicate');
  assert.equal(result.suppressed.at(-1).matches[0].id, '501');
  assert.equal(result.suppressed.at(-1).matches[0].author, 'engineer-one');
  assert.equal(result.suppressed.at(-1).matches[0].url, 'https://github.com/acme/widgets/pull/42#discussion_r501');
});

test('CLI pipeline excludes a prior semantic duplicate from the GitHub review payload', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-dedupe-cli-'));
  try {
    const packetFile = path.join(directory, 'packet.json');
    const findingsFile = path.join(directory, 'findings.json');
    const fingerprintedFile = path.join(directory, 'fingerprinted.json');
    const checksFile = path.join(directory, 'checks.json');
    const decisionsFile = path.join(directory, 'decisions.json');
    const dedupedFile = path.join(directory, 'deduped.json');
    const payloadFile = path.join(directory, 'review.json');
    await writeFile(packetFile, JSON.stringify(normalize(await fixture('github-raw.json'))));
    await writeFile(findingsFile, JSON.stringify(await fixture('findings.json')));

    let result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/fingerprint-findings.mjs',
      packetFile,
      findingsFile,
      fingerprintedFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/deduplicate-findings.mjs',
      'prepare',
      packetFile,
      fingerprintedFile,
      checksFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const checks = JSON.parse(await readFile(checksFile, 'utf8'));
    const [securityFingerprint, contractFingerprint] = checks.findings.map(finding => finding.fingerprint);
    await writeFile(decisionsFile, JSON.stringify({
      batches: checks.batches.map(batch => ({
        batchId: batch.batchId,
        decisions: [
          {
            fingerprint: securityFingerprint,
            verdict: 'duplicate',
            matchedThreadIds: ['501'],
            reason: 'Both report SQL injection caused by interpolating the request identifier.'
          },
          {
            fingerprint: contractFingerprint,
            verdict: 'distinct',
            matchedThreadIds: [],
            reason: 'No prior feedback identifies the missing numeric identifier validation.'
          }
        ]
      }))
    }));

    result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/deduplicate-findings.mjs',
      'apply',
      checksFile,
      decisionsFile,
      dedupedFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/build-github-review.mjs',
      packetFile,
      dedupedFile,
      payloadFile
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);

    const deduped = JSON.parse(await readFile(dedupedFile, 'utf8'));
    const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
    assert.equal(deduped.findings.length, 1);
    assert.equal(deduped.suppressed.at(-1).matches[0].author, 'engineer-one');
    assert.equal(payload.comments.length, 0);
    assert.doesNotMatch(payload.body, /SQL injection|interpolat/i);
    assert.match(payload.body, /numeric identifier contract/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('uncertain or incomplete duplicate checks are held and never publishable', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  const [first, second] = fingerprinted.findings;
  const decisions = [{
    batchId: prepared.batches[0].batchId,
    decisions: [{
      fingerprint: first.fingerprint,
      verdict: 'uncertain',
      matchedThreadIds: ['501'],
      reason: 'The existing comment is similar but does not clearly state the same consequence.'
    }]
  }];

  const result = applyDeduplication(prepared, decisions);
  assert.equal(result.findings.length, 0);
  assert.equal(result.held.length, 2);
  assert.equal(result.held.find(item => item.fingerprint === first.fingerprint).reason, 'possible-existing-review-duplicate');
  assert.equal(result.held.find(item => item.fingerprint === second.fingerprint).reason, 'incomplete-deduplication');
  assert.throws(() => buildGitHubReview(packet, [first]), /has not passed existing-review deduplication/);
});

test('a duplicate in any comment batch suppresses the finding', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [
    { id: 'a', type: 'review', body: 'x'.repeat(4_900), path: null },
    { id: 'b', type: 'review-comment', body: 'This raw id is concatenated into SQL and permits injection.', path: 'src/user.js', line: 11 }
  ];
  const fingerprinted = fingerprintFindings(packet, [await fixture('findings.json').then(items => items[0])]);
  const prepared = prepareDeduplication(packet, fingerprinted, { maxBatchChars: 5_000 });
  assert.equal(prepared.batches.length, 2);
  const finding = fingerprinted.findings[0];
  const decisions = [
    { batchId: 'batch-001', decisions: [{ fingerprint: finding.fingerprint, verdict: 'distinct', matchedThreadIds: [], reason: 'The first comment is unrelated.' }] },
    { batchId: 'batch-002', decisions: [{ fingerprint: finding.fingerprint, verdict: 'duplicate', matchedThreadIds: ['b'], reason: 'Both identify SQL injection from raw request input.' }] }
  ];
  const result = applyDeduplication(prepared, decisions);
  assert.equal(result.findings.length, 0);
  assert.equal(result.suppressed.at(-1).matches[0].id, 'b');
});

test('GitHub builder batches inline findings and moves unstable locations to summary', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [];
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  const findings = applyDeduplication(prepared, []).findings;
  const payload = buildGitHubReview(packet, findings);
  assert.equal(payload.event, 'COMMENT');
  assert.equal(payload.commit_id, packet.pullRequest.head.sha);
  assert.equal(payload.comments.length, 1);
  assert.equal(payload.comments[0].line, 11);
  assert.match(payload.comments[0].body, /<!-- pr-review-graph:[a-f0-9]{64} -->/);
  assert.match(payload.body, /without a stable inline position/);
});

test('Azure builder preserves iteration and change tracking context', async () => {
  const packet = normalize(await fixture('azure-raw.json'));
  const finding = {
    category: 'data-compatibility',
    severity: 'high',
    confidence: 0.92,
    title: 'NOT NULL column breaks rolling deployment',
    problem: 'the migration requires a value before old writers provide one',
    trigger: 'the migration runs while the previous application version is still writing users',
    consequence: 'old application instances fail every user insert',
    evidence: 'the new email column is NOT NULL and has no database default',
    recommendation: 'use an expand-and-contract migration before enforcing the constraint',
    location: { path: 'db/schema.sql', line: 3, side: 'RIGHT' },
    verification: { verdict: 'verified', reason: 'The supplied rolling-deployment requirement establishes version overlap.' }
  };
  const fingerprinted = fingerprintFindings(packet, [finding]);
  const finalFinding = applyDeduplication(prepareDeduplication(packet, fingerprinted), []).findings;
  const threads = buildAzureThreads(packet, finalFinding);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].inline, true);
  assert.equal(threads[0].payload.threadContext.filePath, '/db/schema.sql');
  assert.equal(threads[0].payload.pullRequestThreadContext.changeTrackingId, 9);
  assert.equal(threads[0].payload.pullRequestThreadContext.iterationContext.secondComparingIteration, 2);
});

test('Azure CLI builder writes one payload per finding and an index', async () => {
  const packet = normalize(await fixture('azure-raw.json'));
  const finding = {
    category: 'data-compatibility', severity: 'high', confidence: 0.9,
    title: 'Schema transition is not backward compatible',
    problem: 'old writers cannot satisfy the new required field',
    trigger: 'old and new versions run during deployment',
    consequence: 'writes from old instances fail',
    evidence: 'the added field is required without a default',
    recommendation: 'stage the constraint after all writers are upgraded',
    location: null,
    verification: { verdict: 'verified', reason: 'The transition contradicts the supplied rollout requirement.' }
  };
  const fingerprinted = fingerprintFindings(packet, [finding]);
  const value = applyDeduplication(prepareDeduplication(packet, fingerprinted), []);
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-test-'));
  try {
    const packetFile = path.join(directory, 'packet.json');
    const findingsFile = path.join(directory, 'findings.json');
    const payloadDirectory = path.join(directory, 'payloads');
    await writeFile(packetFile, JSON.stringify(packet));
    await writeFile(findingsFile, JSON.stringify(value));
    const result = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/build-azure-threads.mjs',
      packetFile,
      findingsFile,
      payloadDirectory
    ], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const index = JSON.parse(await readFile(path.join(payloadDirectory, 'index.json'), 'utf8'));
    assert.equal(index.threads.length, 1);
    assert.equal(index.threads[0].inline, false);
    const threads = buildAzureThreads(packet, value);
    assert.equal(threads[0].inline, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

async function dedupedFindings() {
  const packet = normalize(await fixture('github-raw.json'));
  packet.existingThreads = [];
  const fingerprinted = fingerprintFindings(packet, await fixture('findings.json'));
  const prepared = prepareDeduplication(packet, fingerprinted);
  return { packet, findings: applyDeduplication(prepared, []).findings };
}

test('comment join attaches editor text and makes the findings publishable', async () => {
  const { packet, findings } = await dedupedFindings();
  const editorOutput = {
    comments: findings.map((finding, index) => ({
      fingerprint: finding.fingerprint,
      comment: `Edited comment ${index}`
    }))
  };

  const final = applyComments({ findings }, editorOutput);

  assert.equal(final.length, findings.length);
  assert.equal(final[0].comment, 'Edited comment 0');
  assert.equal(final[0].fingerprint, findings[0].fingerprint);
  assert.equal(final[0].deduplication.verdict, 'distinct');
  assert.equal(final[0].title, findings[0].title);

  const payload = buildGitHubReview(packet, final);
  const published = [payload.body, ...payload.comments.map(comment => comment.body)].join('\n');
  assert.match(published, /Edited comment 0/);
  assert.match(published, /Edited comment 1/);
  assert.equal(payload.comments.length, 1);
  assert.match(payload.comments[0].body, /<!-- pr-review-graph:[a-f0-9]{64} -->/);
});

test('comment join rejects a comment for an unknown finding', async () => {
  const { findings } = await dedupedFindings();
  const editorOutput = {
    comments: [
      ...findings.map(finding => ({ fingerprint: finding.fingerprint, comment: 'Edited comment' })),
      { fingerprint: 'f'.repeat(64), comment: 'Invented finding' }
    ]
  };

  assert.throws(() => applyComments({ findings }, editorOutput), /unknown findings/);
});

test('comment join rejects a finding left without usable comment text', async () => {
  const { findings } = await dedupedFindings();
  const withBlank = {
    comments: findings.map((finding, index) => ({
      fingerprint: finding.fingerprint,
      comment: index === 0 ? '   ' : 'Edited comment'
    }))
  };
  const withOmission = {
    comments: findings.slice(1).map(finding => ({ fingerprint: finding.fingerprint, comment: 'Edited comment' }))
  };

  assert.throws(() => applyComments({ findings }, withBlank), /no usable comment/);
  assert.throws(() => applyComments({ findings }, withOmission), /no usable comment/);
});

test('builders reject raw editor output instead of producing an empty review', async () => {
  const packet = normalize(await fixture('github-raw.json'));
  const azurePacket = normalize(await fixture('azure-raw.json'));
  const editorOutput = { comments: [{ fingerprint: 'a'.repeat(64), comment: 'Edited comment' }] };

  assert.throws(() => buildGitHubReview(packet, editorOutput), /apply-comments\.mjs/);
  assert.throws(() => buildAzureThreads(azurePacket, editorOutput), /apply-comments\.mjs/);
});

test('comment join rejects duplicate fingerprints in editor output', async () => {
  const { findings } = await dedupedFindings();
  const editorOutput = {
    comments: [
      ...findings.map((finding, index) => ({ fingerprint: finding.fingerprint, comment: `Edited comment ${index}` })),
      { fingerprint: findings[0].fingerprint, comment: 'Duplicate for first finding' }
    ]
  };

  assert.throws(() => applyComments({ findings }, editorOutput), /more than one comment/);
});

test('discovery ingestion accepts escaped multiline and control characters', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-ingest-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const evidence = 'first line\nsecond line\twith a tab\0and a nul';
    await writeFile(rawFile, JSON.stringify([
      discoveryCandidate('correctness', { evidence })
    ]), { mode: 0o600 });

    const result = await ingestDiscoveryResponse(
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );

    assert.equal(result.status, 'complete');
    assert.equal(result.findings[0].evidence, evidence);
    const persisted = await readFile(path.join(
      resultDirectory,
      discoveryResultFileName('prg-correctness', 1, 1)
    ), 'utf8');
    assert.match(persisted, /first line\\nsecond line\\twith a tab\\u0000and a nul/);
    await assert.rejects(access(rawFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery ingestion rejects literal controls and retains only redacted diagnostics', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-invalid-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const githubToken = ['ghp', 'abcdefghijklmnopqrstuvwxyz1234567890ABCD'].join('_');
    const candidate = discoveryCandidate('correctness', {
      evidence: 'first line\nsecond line',
      recommendation: `Authorization: bearer-secret; token=${githubToken}`,
      debug: {
        password: 'password-secret',
        private_key: '-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----'
      }
    });
    const malformed = JSON.stringify([candidate]).replace(
      'first line\\nsecond line',
      'first line\nsecond line'
    );
    await writeFile(rawFile, malformed, { mode: 0o600 });

    const result = await ingestDiscoveryResponse(
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );

    assert.equal(result.status, 'invalid');
    assert.equal(result.failure.kind, 'invalid-json');
    const diagnosticText = await readFile(result.failure.diagnostic, 'utf8');
    const diagnostic = JSON.parse(diagnosticText);
    assert.equal(diagnostic.failureKind, 'invalid-json');
    assert.match(diagnosticText, /first line\\nsecond line/);
    for (const secret of ['bearer-secret', githubToken, 'password-secret', 'ZmFrZQ==']) {
      assert.doesNotMatch(diagnostic.response, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
    assert.match(diagnostic.response, /<redacted/);
    await assert.rejects(access(rawFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('JWT redaction uses precise regex and does not overmatch', async () => {
  const { redactDiagnosticText } = await import('../skills/review-pull-request/scripts/process-discovery.mjs');

  const validJwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
  const anotherValidJwt = 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlMTIzNDU2.aGFzQWZvdXJ0aFNlZ21lbnQ1NjU';
  const notAJwt = 'not.a.jwt.string';
  const falsePositiveJwt = 'some.thing.else';

  const redacted = redactDiagnosticText(
    `Valid: ${validJwt} Another: ${anotherValidJwt} Not-JWT: ${notAJwt} False: ${falsePositiveJwt}`
  );

  assert.doesNotMatch(redacted, new RegExp(validJwt));
  assert.doesNotMatch(redacted, new RegExp(anotherValidJwt));
  assert.match(redacted, /Valid: <redacted-jwt>/);
  assert.match(redacted, /Another: <redacted-jwt>/);
  assert.match(redacted, /Not-JWT: not\.a\.jwt\.string/);
  assert.match(redacted, /False: some\.thing\.else/);
});

test('discovery ingestion cleans up diagnostic if result write fails', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cleanup-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    const candidate = discoveryCandidate('correctness', {
      evidence: 'escaped\\nstring',
      recommendation: 'no secrets here'
    });
    const malformed = JSON.stringify([candidate]).replace(
      'escaped\\nstring',
      'escaped\nstring'
    );
    await writeFile(rawFile, malformed, { mode: 0o600 });

    await mkdir(resultDirectory, { recursive: true, mode: 0o700 });
    const resultPath = path.join(resultDirectory, 'prg-correctness-batch-001-attempt-1.json');
    await writeFile(resultPath, '{}', { mode: 0o600 });

    const ingestPromise = ingestDiscoveryResponse(
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );

    try {
      await ingestPromise;
      assert.fail('Expected EEXIST error');
    } catch (error) {
      assert.equal(error.code, 'EEXIST');
      const diagnosticPath = path.join(diagnosticsDirectory, 'prg-correctness-batch-001-attempt-1.failure.json');
      await assert.rejects(access(diagnosticPath), { code: 'ENOENT' });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function discoveryPlan(agent, batchCount) {
  const files = Array.from({ length: batchCount }, (_, index) => `file-${index + 1}.js`);
  return {
    schemaVersion: '1.0',
    agents: [{
      name: agent,
      files,
      batches: files.map(file => [file])
    }]
  };
}

async function ingestText(directory, text, metadata) {
  const rawFile = path.join(
    directory,
    `${metadata.agent}-${metadata.batch}-${metadata.attempt}.raw`
  );
  await writeFile(rawFile, text, { mode: 0o600 });
  return ingestDiscoveryResponse(
    rawFile,
    path.join(directory, 'results'),
    path.join(directory, 'diagnostics'),
    metadata
  );
}

test('discovery finalization treats a valid retry as complete coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-retry-'));
  try {
    const candidate = discoveryCandidate();
    const malformed = JSON.stringify([{
      ...candidate,
      evidence: 'first line\nsecond line'
    }]).replace('first line\\nsecond line', 'first line\nsecond line');
    await ingestText(directory, malformed, {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'complete');
    assert.deepEqual(result.coverage.scopes[0], {
      agent: 'prg-correctness',
      status: 'complete',
      expectedBatches: 1,
      completedBatches: 1,
      recoveredBatches: 1,
      failedBatches: 0
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.coverage.failures[0].attempts[0].attempt, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery transport failure can recover on the one allowed retry', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-transport-retry-'));
  try {
    const eventsFile = path.join(directory, 'events.jsonl');
    const responseFile = path.join(directory, 'response.json');
    const statusFile = path.join(directory, 'transport-status.json');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    await writeFile(eventsFile, agentEventStream('[]', {
      preceding: [
        { type: 'assistant.turn_start', data: { turnId: 'turn-preamble' } },
        {
          type: 'assistant.message',
          data: {
            turnId: 'turn-preamble',
            content: 'Using strict-code-review to inspect this response.',
            toolRequests: []
          }
        },
        { type: 'assistant.turn_end', data: { turnId: 'turn-preamble' } }
      ]
    }), { mode: 0o600 });
    const transport = await extractAgentResponse(eventsFile, responseFile, statusFile);
    assert.equal(transport.status, 'invalid');

    const first = await recordDiscoveryTransportFailure(
      statusFile,
      resultDirectory,
      diagnosticsDirectory,
      { agent: 'prg-correctness', batch: 1, attempt: 1 }
    );
    const candidate = discoveryCandidate();
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });
    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      resultDirectory
    );

    assert.equal(first.status, 'invalid');
    assert.equal(first.failure.kind, 'transport-multiple-payloads');
    assert.equal(result.coverage.status, 'complete');
    assert.equal(result.coverage.scopes[0].recoveredBatches, 1);
    assert.deepEqual(result.findings, [candidate]);
    const diagnostic = JSON.parse(await readFile(first.failure.diagnostic, 'utf8'));
    assert.equal(diagnostic.failureKind, 'transport-multiple-payloads');
    assert.deepEqual(diagnostic.transport, { count: 2 });
    assert.equal(diagnostic.response, undefined);
    assert.doesNotMatch(JSON.stringify(diagnostic), /Using strict-code-review|\[\]/);
    await assert.rejects(access(statusFile), { code: 'ENOENT' });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery transport failure CLI records a structural invalid attempt', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-transport-cli-'));
  try {
    const statusFile = path.join(directory, 'transport-status.json');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    await writeFile(statusFile, JSON.stringify({
      schemaVersion: '1.0',
      status: 'invalid',
      failure: {
        kind: 'transport-invalid-jsonl',
        line: 1
      }
    }), { mode: 0o600 });

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'transport-failure',
      statusFile,
      resultDirectory,
      diagnosticsDirectory,
      '--agent', 'prg-correctness',
      '--batch', '1',
      '--attempt', '1'
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    const result = JSON.parse(await readFile(path.join(
      resultDirectory,
      discoveryResultFileName('prg-correctness', 1, 1)
    ), 'utf8'));
    assert.equal(result.status, 'invalid');
    assert.equal(result.failure.kind, 'transport-invalid-jsonl');
    const diagnostic = JSON.parse(await readFile(result.failure.diagnostic, 'utf8'));
    assert.deepEqual(diagnostic.transport, { line: 1 });
    assert.equal(diagnostic.response, undefined);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery transport failures remain terminal after two attempts', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-transport-terminal-'));
  try {
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    for (const attempt of [1, 2]) {
      const statusFile = path.join(directory, `transport-${attempt}.json`);
      await writeFile(statusFile, JSON.stringify({
        schemaVersion: '1.0',
        status: 'invalid',
        failure: { kind: 'transport-missing-payload' }
      }), { mode: 0o600 });
      await recordDiscoveryTransportFailure(
        statusFile,
        resultDirectory,
        diagnosticsDirectory,
        { agent: 'prg-correctness', batch: 1, attempt }
      );
    }

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      resultDirectory
    );

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'failed');
    assert.equal(result.coverage.failures[0].attempts.length, 2);
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery transport failure rejects unsafe or malformed status', async () => {
  const invalidStatuses = [
    '{',
    JSON.stringify({
      schemaVersion: '1.0',
      status: 'invalid',
      failure: { kind: 'transport-unknown' }
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      status: 'invalid',
      failure: {
        kind: 'transport-invalid-event',
        eventType: 'authorization: bearer-secret'
      }
    }),
    JSON.stringify({
      schemaVersion: '1.0',
      status: 'invalid',
      failure: {
        kind: 'transport-invalid-jsonl',
        payload: 'Using strict-code-review...'
      }
    })
  ];

  for (const [index, value] of invalidStatuses.entries()) {
    const directory = await mkdtemp(path.join(os.tmpdir(), `prg-transport-status-${index}-`));
    try {
      const statusFile = path.join(directory, 'transport-status.json');
      const resultDirectory = path.join(directory, 'results');
      await writeFile(statusFile, value, { mode: 0o600 });

      await assert.rejects(
        recordDiscoveryTransportFailure(
          statusFile,
          resultDirectory,
          path.join(directory, 'diagnostics'),
          { agent: 'prg-correctness', batch: 1, attempt: 1 }
        ),
        /Transport status|transport failure/i
      );
      await assert.rejects(
        access(path.join(resultDirectory, discoveryResultFileName(
          'prg-correctness', 1, 1
        ))),
        { code: 'ENOENT' }
      );
      await assert.rejects(access(statusFile), { code: 'ENOENT' });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('discovery finalization fails closed when one batch remains invalid', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-partial-'));
  try {
    await ingestText(directory, '[]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    for (const attempt of [1, 2]) {
      await ingestText(directory, '[{"evidence":"literal\nnewline"}]', {
        agent: 'prg-correctness', batch: 2, attempt
      });
    }

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 2),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'incomplete');
    assert.equal(result.coverage.scopes[0].completedBatches, 1);
    assert.equal(result.coverage.scopes[0].failedBatches, 1);
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization rejects an empty file batch', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-empty-file-batch-'));
  try {
    await ingestText(directory, '[]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    const result = await finalizeDiscovery({
      schemaVersion: '1.0',
      agents: [{
        name: 'prg-correctness',
        files: [],
        batches: [[]]
      }]
    }, path.join(directory, 'results'));

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.findings, null);
    assert.ok(result.coverage.planProblems.some(problem => problem.includes('non-empty file paths')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization requires batches to exactly cover declared files once', async () => {
  const invalidPlans = [
    {
      label: 'missing file',
      files: ['a.js', 'b.js', 'c.js'],
      batches: [['a.js']]
    },
    {
      label: 'extra file',
      files: ['a.js'],
      batches: [['a.js', 'b.js']]
    },
    {
      label: 'duplicate file',
      files: ['a.js'],
      batches: [['a.js'], ['a.js']]
    }
  ];

  for (const invalidPlan of invalidPlans) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-file-coverage-'));
    try {
      for (let batch = 1; batch <= invalidPlan.batches.length; batch += 1) {
        await ingestText(directory, '[]', {
          agent: 'prg-correctness', batch, attempt: 1
        });
      }
      const result = await finalizeDiscovery({
        schemaVersion: '1.0',
        agents: [{
          name: 'prg-correctness',
          files: invalidPlan.files,
          batches: invalidPlan.batches
        }]
      }, path.join(directory, 'results'));

      assert.equal(result.coverage.status, 'failed', invalidPlan.label);
      assert.equal(result.findings, null, invalidPlan.label);
      assert.ok(
        result.coverage.planProblems.some(problem => problem.includes('exactly once')),
        invalidPlan.label
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('discovery finalize CLI removes stale candidates on failed coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cli-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await writeFile(planFile, JSON.stringify(discoveryPlan('prg-correctness', 1)));
    await writeFile(candidatesFile, '[]\n');
    await ingestText(directory, '[{"evidence":"literal\nnewline"}]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    await ingestText(directory, '[{"evidence":"literal\nnewline"}]', {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stderr);
    await assert.rejects(access(candidatesFile), { code: 'ENOENT' });
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    assert.equal(coverage.status, 'failed');
    assert.equal(coverage.scopes[0].status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalize CLI reports a corrupt complete envelope and removes stale candidates', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-corrupt-envelope-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await mkdir(resultDirectory);
    await writeFile(planFile, JSON.stringify(discoveryPlan('prg-correctness', 1)));
    await writeFile(path.join(
      resultDirectory,
      discoveryResultFileName('prg-correctness', 1, 1)
    ), JSON.stringify({
      schemaVersion: '1.0',
      agent: 'prg-correctness',
      category: 'correctness',
      batch: 1,
      attempt: 1,
      status: 'complete',
      findings: {}
    }));
    await writeFile(candidatesFile, '["stale"]\n');

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    await assert.rejects(access(candidatesFile), { code: 'ENOENT' });
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    assert.equal(coverage.status, 'failed');
    assert.equal(coverage.scopes[0].status, 'failed');
    assert.ok(coverage.failures.some(failure => failure.reason === 'corrupt-envelope'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalize CLI emits an authoritative empty array only for complete coverage', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-empty-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await writeFile(planFile, JSON.stringify(discoveryPlan('prg-correctness', 1)));
    await ingestText(directory, '[]', {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(await readFile(candidatesFile, 'utf8')), []);
    assert.equal(JSON.parse(await readFile(coverageFile, 'utf8')).status, 'complete');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization fails closed when a routed agent has zero planned batches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-zerobatch-'));
  try {
    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 0),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'failed');
    assert.equal(result.coverage.scopes[0].expectedBatches, 0);
    assert.ok(result.coverage.failures.some(failure => failure.reason === 'zero-expected-batches'));
    assert.ok(result.coverage.planProblems.some(problem => problem.includes('zero expected batches')));
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization fails closed for a plan with no routed agents', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-noagents-'));
  try {
    const result = await finalizeDiscovery(
      { schemaVersion: '1.0', agents: [] },
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.deepEqual(result.coverage.scopes, []);
    assert.ok(result.coverage.planProblems.some(problem => problem.includes('at least one routed agent')));
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization fails closed for a plan missing the agents array', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-malformed-'));
  try {
    const result = await finalizeDiscovery(
      { schemaVersion: '1.0' },
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.deepEqual(result.coverage.scopes, []);
    assert.ok(result.coverage.planProblems.some(problem => problem.includes('agents array')));
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalize CLI fails closed and removes stale candidates for a wrong/empty plan', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cli-wrongplan-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await writeFile(planFile, JSON.stringify({ schemaVersion: '1.0', agents: [] }));
    await writeFile(candidatesFile, '[]\n');

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    await assert.rejects(access(candidatesFile), { code: 'ENOENT' });
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    assert.equal(coverage.status, 'failed');
    assert.ok(coverage.planProblems.some(problem => problem.includes('at least one routed agent')));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalize CLI fails closed on a binary-only plan with zero expected batches', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cli-zerobatch-'));
  try {
    const planFile = path.join(directory, 'plan.json');
    const resultDirectory = path.join(directory, 'results');
    const candidatesFile = path.join(directory, 'candidates.json');
    const coverageFile = path.join(directory, 'coverage.json');
    await writeFile(planFile, JSON.stringify(discoveryPlan('prg-correctness', 0)));
    await writeFile(candidatesFile, '[]\n');

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'finalize',
      planFile,
      resultDirectory,
      candidatesFile,
      coverageFile
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    await assert.rejects(access(candidatesFile), { code: 'ENOENT' });
    const coverage = JSON.parse(await readFile(coverageFile, 'utf8'));
    assert.equal(coverage.status, 'failed');
    assert.equal(coverage.scopes[0].status, 'failed');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery ingestion rejects a bare CLI batch or attempt flag instead of coercing it to 1', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-bareflag-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');

    await writeFile(rawFile, '[]', { mode: 0o600 });
    await assert.rejects(
      ingestDiscoveryResponse(rawFile, resultDirectory, diagnosticsDirectory, {
        agent: 'prg-correctness', batch: true, attempt: 1
      }),
      /Batch must be a positive integer/
    );

    await writeFile(rawFile, '[]', { mode: 0o600 });
    await assert.rejects(
      ingestDiscoveryResponse(rawFile, resultDirectory, diagnosticsDirectory, {
        agent: 'prg-correctness', batch: 1, attempt: undefined
      }),
      /Attempt must be 1 or 2/
    );

    await assert.rejects(
      access(path.join(resultDirectory, discoveryResultFileName('prg-correctness', 1, 1))),
      { code: 'ENOENT' }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery ingest CLI rejects a trailing --batch flag with no value', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-cli-bareflag-'));
  try {
    const rawFile = path.join(directory, 'raw.txt');
    const resultDirectory = path.join(directory, 'results');
    const diagnosticsDirectory = path.join(directory, 'diagnostics');
    await writeFile(rawFile, '[]', { mode: 0o600 });

    const cli = spawnSync(process.execPath, [
      'skills/review-pull-request/scripts/process-discovery.mjs',
      'ingest',
      rawFile,
      resultDirectory,
      diagnosticsDirectory,
      '--agent', 'prg-correctness',
      '--attempt', '1',
      '--batch'
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(cli.status, 1, cli.stdout + cli.stderr);
    assert.match(cli.stderr, /Batch must be a positive integer/);
    await assert.rejects(
      access(path.join(resultDirectory, discoveryResultFileName('prg-correctness', 1, 1))),
      { code: 'ENOENT' }
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('discovery finalization classifies complete-first-plus-second as failed with explicit reason', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-reason-'));
  try {
    const candidate = discoveryCandidate();
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 2
    });

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      path.join(directory, 'results')
    );

    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'failed');
    assert.equal(result.coverage.failures[0].recovered, false);
    assert.equal(result.coverage.failures[0].reason, 'complete-first-unexpected-retry');
    assert.deepEqual(result.coverage.failures[0].attempts, []);
    assert.equal(result.findings, null);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('validateAttemptEnvelope rejects an envelope when expected category is not a known discovery category', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'prg-discovery-badcat-'));
  try {
    const candidate = discoveryCandidate('correctness');
    await ingestText(directory, JSON.stringify([candidate]), {
      agent: 'prg-correctness', batch: 1, attempt: 1
    });

    // Remove the category field from the stored result envelope so that
    // value.category is undefined; validateAttemptEnvelope's field loop will
    // flag it as corrupt (category does not match) before the findings check.
    const resultFile = path.join(
      directory, 'results',
      discoveryResultFileName('prg-correctness', 1, 1)
    );
    const envelope = JSON.parse(await readFile(resultFile, 'utf8'));
    delete envelope.category;
    await writeFile(resultFile, JSON.stringify(envelope), { mode: 0o600 });

    const result = await finalizeDiscovery(
      discoveryPlan('prg-correctness', 1),
      path.join(directory, 'results')
    );
    assert.equal(result.coverage.status, 'failed');
    assert.equal(result.coverage.scopes[0].status, 'failed');
    assert.equal(result.coverage.failures[0].reason, 'corrupt-envelope');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});


test('discovery agents require escaped JSON arrays without fences', async () => {
  const agents = [
    'prg-contract',
    'prg-correctness',
    'prg-tests',
    'prg-security',
    'prg-data-compatibility',
    'prg-reliability'
  ];
  for (const agent of agents) {
    const text = await readFile(path.join(root, 'agents', `${agent}.agent.md`), 'utf8');
    assert.match(text, /Return exactly one JSON array/);
    assert.match(text, /Do not wrap the array in a Markdown code fence/);
    assert.ok(text.includes('\\u0000'), `${agent} must require escaped control characters`);
    assert.match(text, /```json\s*\[/);
  }
});

const BASH4_ONLY = [
  { pattern: /\bmapfile\b/, name: 'mapfile (use a `while IFS= read -r` loop)' },
  { pattern: /\breadarray\b/, name: 'readarray (use a `while IFS= read -r` loop)' },
  { pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*,/, name: 'lowercase expansion ${var,} or ${var,,} (use tr)' },
  { pattern: /\$\{[A-Za-z_][A-Za-z0-9_]*\^/, name: 'uppercase expansion ${var^} or ${var^^} (use tr)' },
  { pattern: /\b(declare|local|typeset)\s+-[A-Za-z]*A/, name: 'associative array declaration' }
];

async function shellScripts(directory) {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...(await shellScripts(full)));
    else if (entry.name.endsWith('.sh')) found.push(full);
  }
  return found;
}

test('shell scripts avoid Bash 4 constructs so they run on the stock macOS Bash 3.2', async () => {
  const scripts = await shellScripts(root);
  assert.ok(scripts.length >= 2, `expected to find the collector scripts, found ${scripts.length}`);

  const offences = [];
  for (const file of scripts) {
    const lines = (await readFile(file, 'utf8')).split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const { pattern, name } of BASH4_ONLY) {
        if (pattern.test(line)) {
          offences.push(`${path.relative(root, file)}:${index + 1} uses ${name}`);
        }
      }
    });
  }

  assert.deepEqual(offences, [], `macOS ships Bash 3.2, and SKILL.md invokes these scripts as plain \`bash\`, so Bash 4 syntax makes them fail at runtime:\n${offences.join('\n')}`);
});

test('a truncated Azure change list is reported as a packet warning', async () => {
  const raw = await fixture('azure-raw.json');
  const untruncated = normalize(raw);
  assert.equal(untruncated.limits.warnings.some(warning => /change list is truncated/.test(warning)), false);

  const truncated = normalize({ ...raw, changes: { ...raw.changes, nextSkip: 2000, nextTop: 2000 } });
  assert.equal(truncated.limits.warnings.some(warning => /change list is truncated/.test(warning)), true);
  assert.equal(truncated.files.length, untruncated.files.length);
});
