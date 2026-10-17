import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_TABLES, SCHEMA_SQL, readAppDb } from '../engine/readers/app-db.mjs';
import { buildForest, descendants, resolveNodeId, treeNodes } from '../engine/model/forest.mjs';
import { withReadOnly } from '../engine/sqlite.mjs';
import { CopilotHome } from './helpers/copilot-home.mjs';
import { TEST_BACKENDS, execSql } from './helpers/sqlite-writer.mjs';
import { tempDir } from './helpers/temp.mjs';
import path from 'node:path';

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

/** A fake db that answers SCHEMA_SQL from `missing` ({table: [columns]}; true drops the table) and records every SQL string. */
function fakeDb({ missing = {}, rows = {} } = {}) {
  const sqls = [];
  const schema = [];
  for (const { table, columns } of Object.values(APP_TABLES)) {
    if (missing[table] === true) continue;
    for (const column of columns) if (!(missing[table] ?? []).includes(column)) schema.push({ table_name: table, column_name: column });
  }
  return {
    sqls,
    all: async sql => {
      sqls.push(sql);
      if (sql === SCHEMA_SQL) return schema;
      const table = /FROM (\w+)/.exec(sql)?.[1];
      return rows[table] ?? [];
    },
  };
}

test('the app queries select named columns only and never touch secrets', async () => {
  for (const { table, columns } of Object.values(APP_TABLES)) {
    for (const name of [table, ...columns]) {
      assert.match(name, /^[a-z_]+$/);
      assert.doesNotMatch(name, /settings|token/i);
    }
  }
  assert.doesNotMatch(SCHEMA_SQL, /\*/);
  assert.doesNotMatch(SCHEMA_SQL, /settings|token/i);
  const db = fakeDb();
  await readAppDb(db);
  assert.ok(db.sqls.length > 1);
  for (const sql of db.sqls) {
    assert.match(sql, /^\s*SELECT/);
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
  const app = await readAppDb(fakeDb({ missing: { session_automations: true } }));
  assert.deepEqual(app.automations, []);
  assert.deepEqual(app.diagnostics, [{ level: 'warn', source: 'data.db', message: 'automations: table session_automations not found' }]);
});

test('missing optional columns are read as empty', async () => {
  const db = fakeDb({
    missing: { workspaces: ['coordinating_creator_session_id', 'created_pr_state'] },
    rows: { workspaces: [{ id: 'ws-1', name: 'One', created_pr_number: 5 }] },
  });
  const app = await readAppDb(db);
  const select = db.sqls.find(sql => /FROM workspaces/.test(sql));
  assert.doesNotMatch(select, /coordinating_creator_session_id|created_pr_state/);
  const ws = app.workspaces.get('ws-1');
  assert.equal(ws.coordinatingCreatorSessionId, null);
  assert.equal(ws.createdPr.state, null);
  assert.equal(ws.createdPr.number, 5);
  assert.deepEqual(app.diagnostics, [{ level: 'info', source: 'data.db', message: 'workspaces: column(s) not found, read as empty: coordinating_creator_session_id, created_pr_state' }]);
});

test('a missing required column skips the table', async () => {
  const app = await readAppDb(fakeDb({ missing: { workspace_parent_links: ['parent_workspace_id'] } }));
  assert.deepEqual(app.parentLinks, []);
  assert.deepEqual(app.diagnostics, [{ level: 'warn', source: 'data.db', message: 'parentLinks: missing column(s) parent_workspace_id' }]);
});

for (const backend of TEST_BACKENDS) {
  test(`${backend}: a minimal database degrades instead of failing`, async () => {
    const file = path.join(tempDir('swarm-minimal-'), 'data.db');
    execSql(file, "CREATE TABLE workspaces (id TEXT, name TEXT, created_at TEXT); INSERT INTO workspaces (id, name, created_at) VALUES ('ws-1', 'One', '2026-10-15T08:00:00.000Z')");
    const app = await withReadOnly(file, { backend }, readAppDb);
    const ws = app.workspaces.get('ws-1');
    assert.equal(ws.name, 'One');
    assert.equal(ws.createdAt, T0);
    assert.equal(ws.branch, null);
    assert.equal(ws.createdPr, null);
    assert.equal(app.workspaces.size, 1);
    for (const key of ['projects', 'worktrees', 'sessions']) assert.equal(app[key].size, 0);
    for (const key of ['parentLinks', 'aliases', 'chatLinks', 'automations']) assert.deepEqual(app[key], []);
    const tables = ['projects', 'worktrees', 'workspace_parent_links', 'workspace_session_aliases', 'chat_parent_links', 'sessions', 'session_automations'];
    const keys = ['projects', 'worktrees', 'parentLinks', 'aliases', 'chatLinks', 'sessions', 'automations'];
    const warns = keys.map((key, i) => ({ level: 'warn', source: 'data.db', message: `${key}: table ${tables[i]} not found` }));
    const info = { level: 'info', source: 'data.db', message: 'workspaces: column(s) not found, read as empty: project_id, worktree_id, branch, archived_at, session_id, creator_session_id, coordinating_creator_session_id, created_pr_repo_full_name, created_pr_number, created_pr_html_url, created_pr_state, created_pr_merged_at' };
    assert.equal(app.diagnostics.length, 8);
    for (const d of [...warns, info]) assert.ok(app.diagnostics.some(x => x.level === d.level && x.message === d.message), d.message);
  });
}

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

test('orphan aliases and links to them do not break the tree', () => {
  const ws = { id: 'ws-1', projectId: null, worktreeId: null, name: 'One', branch: null, createdAt: 1, archivedAt: null, sessionId: 'cli-1', creatorSessionId: null, coordinatingCreatorSessionId: null, createdPr: null };
  const session = id => [id, { id, title: id, mode: null, model: null, reasoningEffort: null, isRunning: false, wasInterrupted: false, createdAt: 2, archivedAt: null }];
  const app = {
    projects: new Map(), worktrees: new Map(), automations: [], diagnostics: [], parentLinks: [],
    workspaces: new Map([['ws-1', ws]]),
    aliases: [{ sessionId: 'cli-gone', workspaceId: 'ws-gone', createdAt: 1 }],
    sessions: new Map([session('cli-gone'), session('chat-x')]),
    chatLinks: [{ sessionId: 'chat-x', parentSessionId: 'cli-gone' }],
  };
  const forest = buildForest(app);
  assert.equal(forest.nodes.has('cli-gone'), false);
  assert.equal(forest.nodes.get('chat-x').parentId, null);
  assert.equal(resolveNodeId(forest, 'cli-gone'), null);
  assert.equal(resolveNodeId(forest, 'cli-1'), 'ws-1');
});
