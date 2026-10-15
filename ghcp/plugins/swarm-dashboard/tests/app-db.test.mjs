import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_QUERIES, readAppDb } from '../engine/readers/app-db.mjs';
import { buildForest, descendants, resolveNodeId, treeNodes } from '../engine/model/forest.mjs';
import { withReadOnly } from '../engine/sqlite.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS } from './helpers/sqlite-writer.mjs';

const T0 = Date.UTC(2026, 9, 15, 8, 0, 0);
const home = new CopilotHome();
home.project({ id: 'project-1', name: 'sample-project' });
home.workspace({ id: 'ws-root', projectId: 'project-1', name: 'Sample story', createdAt: T0, sessionId: 'cli-root-2', branch: 'story', baseBranch: 'main' });
home.alias('cli-root-1', 'ws-root', T0 - 1000);
home.session({ id: 'cli-root-1', title: 'analysis', createdAt: T0 - 1000 });
home.workspace({ id: 'ws-a', projectId: 'project-1', name: 'Story a1 api', createdAt: T0 + 1000, parentId: 'ws-root', creatorSessionId: 'cli-root-2', branch: 'feature/a1', baseBranch: 'story' });
home.workspace({ id: 'ws-b', projectId: 'project-1', name: 'Story b1 docs', createdAt: T0 + 2000, parentId: 'ws-root', creatorSessionId: 'cli-root-2', archivedAt: T0 + 9000 });
home.workspace({ id: 'ws-c', name: 'Story c1 nested', createdAt: T0 + 3000, parentId: 'ws-a', creatorSessionId: 'ws-a' });
home.chat({ id: 'chat-1', parentSessionId: 'cli-root-2', title: 'Research chat', createdAt: T0 + 4000 });
home.session({ id: 'chat-root', title: 'Chat orchestrator', createdAt: T0 + 5000 });
home.workspace({ id: 'ws-d', name: 'Chat child', createdAt: T0 + 6000, creatorSessionId: 'chat-root' });
home.workspace({ id: 'ws-solo', name: 'Solo', createdAt: T0 + 7000 });
home.automation({ sessionId: 'ws-a', nextRunAt: T0 + 600_000 });

test('the app queries select named columns only and never touch secrets', () => {
  for (const sql of Object.values(APP_QUERIES)) {
    assert.doesNotMatch(sql, /\*/);
    assert.doesNotMatch(sql, /settings|token/i);
  }
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: reads the app database and builds the session tree`, async () => {
    const app = await withReadOnly(home.dataDb, { backend }, readAppDb);
    assert.deepEqual(app.diagnostics, []);
    assert.equal(app.projects.get('project-1').name, 'sample-project');
    assert.equal(app.workspaces.get('ws-b').archivedAt, T0 + 9000);
    assert.deepEqual(app.automations, [{ sessionId: 'ws-a', interval: 'minutes', everyMinutes: 10, lastRunAt: null, nextRunAt: T0 + 600_000, pausedAt: null, name: 'PR monitor' }]);

    const forest = buildForest(app);
    assert.deepEqual(forest.roots.map(root => root.id), ['chat-root', 'ws-root']);
    const root = forest.nodes.get('ws-root');
    assert.deepEqual(root.cliSessionIds, ['cli-root-1', 'cli-root-2']);
    assert.equal(root.currentCliSessionId, 'cli-root-2');
    assert.deepEqual(descendants(forest, 'ws-root').map(node => [node.id, node.depth]), [['ws-a', 1], ['ws-c', 2], ['ws-b', 1], ['chat-1', 1]]);
    assert.deepEqual(treeNodes(forest, 'ws-root').map(node => node.id), ['ws-root', 'ws-a', 'ws-c', 'ws-b', 'chat-1']);
    const chat = forest.nodes.get('chat-1');
    assert.equal(chat.kind, 'chat');
    assert.equal(chat.parentId, 'ws-root');
    assert.equal(chat.name, 'Research chat');
    assert.equal(forest.nodes.get('ws-d').parentId, 'chat-root');
    assert.equal(forest.nodes.get('chat-root').kind, 'chat');
    assert.equal(forest.nodes.get('ws-solo').parentId, null);
    assert.equal(forest.nodes.get('ws-a').baseBranch, 'story');
    assert.equal(forest.nodes.get('ws-a').branch, 'feature/a1');
    assert.equal(resolveNodeId(forest, 'cli-root-1'), 'ws-root');
    assert.equal(resolveNodeId(forest, 'unknown'), null);
  });
}

test('a missing table becomes a warning and an empty list', async () => {
  const db = { all: async sql => { if (sql.includes('session_automations')) throw new Error('no such table: session_automations'); return []; } };
  const app = await readAppDb(db);
  assert.deepEqual(app.automations, []);
  assert.deepEqual(app.diagnostics, [{ level: 'warn', source: 'data.db', message: 'automations: no such table: session_automations' }]);
});

test('parent cycles are broken instead of looping', () => {
  const app = {
    projects: new Map(), worktrees: new Map(), sessions: new Map(), automations: [], chatLinks: [], diagnostics: [],
    aliases: [], parentLinks: [{ childId: 'a', parentId: 'b' }, { childId: 'b', parentId: 'a' }],
    workspaces: new Map(['a', 'b'].map(id => [id, { id, projectId: null, worktreeId: null, name: id, branch: null, createdAt: 1, archivedAt: null, sessionId: null, creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null }])),
  };
  const forest = buildForest(app);
  assert.equal(forest.roots.length, 1);
  assert.equal(descendants(forest, forest.roots[0].id).length, 1);
});
