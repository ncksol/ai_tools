import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildForest } from '../engine/model/forest.mjs';

/*
 * A project session that a chat-like session created (a chat, or a Copilot app Project) has no workspace_parent_links row; the
 * forest nests it under its creator through workspaces.coordinating_creator_session_id, else creator_session_id. Every such
 * workspace nests there, not only the first one. The app clears both columns when it detaches a session, so a detached
 * session stays a top session.
 */

const session = (id, agent = null) => [id, { id, title: id, mode: null, model: null, reasoningEffort: null, isRunning: false, wasInterrupted: false, createdAt: 1, archivedAt: null, agent }];

function workspace(id, createdAt, { creator = null, coordinator = null } = {}) {
  return [id, {
    id, projectId: null, worktreeId: null, name: id, branch: null, createdAt, archivedAt: null, sessionId: `cli-${id}`,
    creatorSessionId: creator, coordinatingCreatorSessionId: coordinator, createdPr: null,
  }];
}

function appWith(workspaces, { sessions = [], parentLinks = [], chatLinks = [] } = {}) {
  return {
    projects: new Map(), worktrees: new Map(), automations: [], diagnostics: [], aliases: [], parentLinks, chatLinks,
    workspaces: new Map(workspaces),
    sessions: new Map([...workspaces.map(([id]) => session(`cli-${id}`)), ...sessions]),
  };
}

test('every workspace that a chat created nests under the chat, in creation order', () => {
  const forest = buildForest(appWith([
    workspace('c', 30, { creator: 'chat', coordinator: 'chat' }),
    workspace('a', 10, { creator: 'chat', coordinator: 'chat' }),
    workspace('b', 20, { creator: 'chat', coordinator: 'chat' }),
  ], { sessions: [session('chat', 'wintermute:hands-on-session-orchestrator')] }));
  assert.deepEqual(forest.roots.map(root => root.id), ['chat']);
  assert.equal(forest.nodes.get('chat').kind, 'chat');
  assert.deepEqual(forest.nodes.get('chat').childIds, ['a', 'b', 'c']);
  for (const id of ['a', 'b', 'c']) assert.equal(forest.nodes.get(id).parentId, 'chat');
});

test('a Project coordinator links every child through coordinating_creator_session_id alone', () => {
  const forest = buildForest(appWith([
    workspace('a', 10, { coordinator: 'project' }),
    workspace('b', 20, { coordinator: 'project' }),
    workspace('c', 30, { coordinator: 'project' }),
  ], { sessions: [session('project')] }));
  assert.deepEqual(forest.roots.map(root => root.id), ['project']);
  assert.deepEqual(forest.nodes.get('project').childIds, ['a', 'b', 'c']);
});

test('a chat that is itself a chat child also gets every workspace it created', () => {
  const forest = buildForest(appWith([
    workspace('a', 10, { creator: 'chat-child', coordinator: 'chat-child' }),
    workspace('b', 20, { creator: 'chat-child', coordinator: 'chat-child' }),
  ], { sessions: [session('chat-root'), session('chat-child')], chatLinks: [{ sessionId: 'chat-child', parentSessionId: 'chat-root' }] }));
  assert.deepEqual(forest.roots.map(root => root.id), ['chat-root']);
  assert.deepEqual(forest.nodes.get('chat-root').childIds, ['chat-child']);
  assert.deepEqual(forest.nodes.get('chat-child').childIds, ['a', 'b']);
});

test('a workspace created by another workspace session, with no parent link, stays a top session', () => {
  const forest = buildForest(appWith([
    workspace('owner', 5),
    workspace('a', 10, { creator: 'cli-owner', coordinator: 'cli-owner' }),
    workspace('b', 20, { creator: 'owner' }),
  ]));
  assert.deepEqual(forest.roots, []);
  for (const id of ['owner', 'a', 'b']) assert.equal(forest.nodes.get(id).parentId, null);
  assert.equal(forest.nodes.has('cli-owner'), false);
});

test('a parent link wins over the creator columns, and a detached session stays a top session', () => {
  const forest = buildForest(appWith([
    workspace('owner', 5),
    workspace('linked', 10, { creator: 'chat', coordinator: 'chat' }),
    workspace('a', 20, { creator: 'chat', coordinator: 'chat' }),
    workspace('detached', 25),
    workspace('b', 30, { creator: 'chat' }),
  ], { sessions: [session('chat')], parentLinks: [{ childId: 'linked', parentId: 'owner' }] }));
  assert.deepEqual(forest.roots.map(root => root.id).sort(), ['chat', 'owner']);
  assert.deepEqual(forest.nodes.get('owner').childIds, ['linked']);
  assert.deepEqual(forest.nodes.get('chat').childIds, ['a', 'b']);
  assert.equal(forest.nodes.get('detached').parentId, null);
});
