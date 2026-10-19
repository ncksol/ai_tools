function makeNode(fields) {
  return { ...fields, currentCliSessionId: fields.cliSessionIds[fields.cliSessionIds.length - 1] ?? null, parentId: null, childIds: [], depth: 0 };
}

/** The agents that follow the swarm dashboard data contract (ghcp/agents/orchestrator.agent.md and session-orchestrator.agent.md). */
export const ORCHESTRATOR_AGENTS = Object.freeze(['orchestrator', 'session-orchestrator']);

/**
 * Session tree. Project sessions nest through workspace_parent_links; chat children through chat_parent_links; a
 * project session created by a chat (which no workspace link can express) nests under that chat. Every node with
 * children and no parent is a swarm root.
 *
 * A top session with no child session yet is a swarm root only when it runs an orchestrator agent (data.db sessions.agent)
 * and either:
 * - it is one of the `candidates` and the engine names it in `waitingRoots`. Candidates are unarchived top sessions with no
 *   child (project sessions, and chats in no workspace) whose current CLI session runs an orchestrator agent; the engine
 *   names those that wait on an open tagged question (see engine.mjs, waitingOrchestrators);
 * - or one of its CLI sessions runs an orchestrator agent and `hasSubagents` says it started a sub-agent, such as an
 *   orchestrator that has used only `task` sub-agents so far (issue #30). Sub-agent work alone is not enough: most
 *   sessions start sub-agents, and they are not swarms (issue #29, item 10). `taskCandidates` lists those CLI sessions,
 *   archived or not, current or older aliases, for the engine to look for sub-agent starts (see engine.mjs, scanTaskStarts).
 */
export function buildForest(app, { waitingRoots = new Set(), hasSubagents = () => false } = {}) {
  const nodes = new Map();
  const workspaceOfSession = new Map();
  const aliasesByWorkspace = new Map();
  const orphanSessions = new Set();
  for (const alias of [...app.aliases].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    if (!alias.sessionId || !alias.workspaceId) continue;
    if (!app.workspaces.has(alias.workspaceId)) {
      orphanSessions.add(alias.sessionId);
      continue;
    }
    workspaceOfSession.set(alias.sessionId, alias.workspaceId);
    if (!aliasesByWorkspace.has(alias.workspaceId)) aliasesByWorkspace.set(alias.workspaceId, []);
    aliasesByWorkspace.get(alias.workspaceId).push(alias.sessionId);
  }
  for (const ws of app.workspaces.values()) {
    const ids = [...(aliasesByWorkspace.get(ws.id) ?? [])];
    if (ws.sessionId) {
      workspaceOfSession.set(ws.sessionId, ws.id);
      const index = ids.indexOf(ws.sessionId);
      if (index >= 0) ids.splice(index, 1);
      ids.push(ws.sessionId);
    }
    const worktree = ws.worktreeId ? app.worktrees.get(ws.worktreeId) ?? null : null;
    nodes.set(ws.id, makeNode({
      id: ws.id, kind: 'project', name: ws.name, projectId: ws.projectId, branch: ws.branch ?? worktree?.branch ?? null,
      baseBranch: worktree?.baseBranch ?? null, createdAt: ws.createdAt, archivedAt: ws.archivedAt, cliSessionIds: ids, createdPr: ws.createdPr,
    }));
  }
  const resolve = id => {
    if (!id) return null;
    if (nodes.has(id)) return id;
    const mapped = workspaceOfSession.get(id);
    return mapped && nodes.has(mapped) ? mapped : null;
  };
  const chatNode = id => {
    if (!id) return null;
    if (nodes.has(id)) return id;
    const row = app.sessions.get(id);
    if (!row || workspaceOfSession.has(id) || orphanSessions.has(id)) return null;
    nodes.set(id, makeNode({
      id, kind: 'chat', name: row.title, projectId: null, branch: null, baseBranch: null, createdAt: row.createdAt,
      archivedAt: row.archivedAt, cliSessionIds: [id], createdPr: null,
    }));
    return id;
  };
  const link = (childId, parentId) => {
    const child = nodes.get(childId);
    if (child && parentId && childId !== parentId && !child.parentId) child.parentId = parentId;
  };
  for (const item of app.parentLinks) if (nodes.has(item.childId) && nodes.has(item.parentId)) link(item.childId, item.parentId);
  for (const item of app.chatLinks) {
    const child = chatNode(item.sessionId);
    const parent = resolve(item.parentSessionId) ?? chatNode(item.parentSessionId);
    if (child && parent) link(child, parent);
  }
  for (const ws of app.workspaces.values()) {
    if (nodes.get(ws.id).parentId) continue;
    const creator = ws.coordinatingCreatorSessionId ?? ws.creatorSessionId;
    if (!creator || resolve(creator)) continue;
    const parent = chatNode(creator);
    if (parent) link(ws.id, parent);
  }
  for (const node of nodes.values()) {
    const seen = new Set([node.id]);
    for (let cursor = node.parentId; cursor; cursor = nodes.get(cursor)?.parentId ?? null) {
      if (seen.has(cursor)) {
        node.parentId = null;
        break;
      }
      seen.add(cursor);
    }
  }
  for (const node of nodes.values()) {
    if (!node.parentId) continue;
    const parent = nodes.get(node.parentId);
    if (parent) parent.childIds.push(node.id);
    else node.parentId = null;
  }
  const byCreated = (a, b) => (nodes.get(a).createdAt ?? 0) - (nodes.get(b).createdAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  for (const node of nodes.values()) node.childIds.sort(byCreated);
  const orchestrator = cliId => ORCHESTRATOR_AGENTS.includes(app.sessions.get(cliId)?.agent);
  const candidates = [];
  for (const node of nodes.values()) {
    if (!node.parentId && !node.childIds.length && node.archivedAt == null && orchestrator(node.currentCliSessionId)) candidates.push({ id: node.id, cliId: node.currentCliSessionId });
  }
  for (const row of app.sessions.values()) {
    if (nodes.has(row.id) || workspaceOfSession.has(row.id) || orphanSessions.has(row.id) || row.archivedAt != null || !orchestrator(row.id)) continue;
    candidates.push({ id: row.id, cliId: row.id });
  }
  const promoted = new Set(candidates.filter(item => waitingRoots.has(item.id)).map(item => chatNode(item.id)));
  const working = cliIds => cliIds.some(cliId => orchestrator(cliId) && hasSubagents(cliId));
  // Every CLI session that sub-agent work would make a root: one running an orchestrator agent, of a top session with no
  // child, archived or not, current or an older alias. The engine looks for sub-agent starts in their logs.
  const taskCandidates = new Set();
  for (const node of [...nodes.values()]) {
    if (node.parentId || node.childIds.length) continue;
    for (const cliId of node.cliSessionIds) if (orchestrator(cliId)) taskCandidates.add(cliId);
    if (working(node.cliSessionIds)) promoted.add(node.id);
  }
  for (const row of app.sessions.values()) {
    if (nodes.has(row.id) || workspaceOfSession.has(row.id) || orphanSessions.has(row.id) || !orchestrator(row.id)) continue;
    taskCandidates.add(row.id);
    if (working([row.id])) promoted.add(chatNode(row.id));
  }
  const roots = [...nodes.values()].filter(node => !node.parentId && (node.childIds.length > 0 || promoted.has(node.id)));
  for (const root of roots) {
    const stack = [[root.id, 0]];
    while (stack.length) {
      const [id, depth] = stack.pop();
      const node = nodes.get(id);
      node.depth = depth;
      for (const child of node.childIds) stack.push([child, depth + 1]);
    }
  }
  roots.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
  return { nodes, roots, workspaceOfSession, candidates, taskCandidates: [...taskCandidates] };
}

export function descendants(forest, rootId) {
  const out = [];
  const visit = id => {
    for (const child of forest.nodes.get(id)?.childIds ?? []) {
      out.push(forest.nodes.get(child));
      visit(child);
    }
  };
  visit(rootId);
  return out;
}

export function treeNodes(forest, rootId) {
  const root = forest.nodes.get(rootId);
  return root ? [root, ...descendants(forest, rootId)] : [];
}

export function resolveNodeId(forest, id) {
  if (!id) return null;
  if (forest.nodes.has(id)) return id;
  const mapped = forest.workspaceOfSession.get(id);
  return mapped && forest.nodes.has(mapped) ? mapped : null;
}
