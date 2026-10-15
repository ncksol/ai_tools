function makeNode(fields) {
  return { ...fields, currentCliSessionId: fields.cliSessionIds[fields.cliSessionIds.length - 1] ?? null, parentId: null, childIds: [], depth: 0 };
}

/**
 * Session tree. Project sessions nest through workspace_parent_links; chat children through chat_parent_links; a
 * project session created by a chat (which no workspace link can express) nests under that chat. Every node with
 * children and no parent is a swarm root.
 */
export function buildForest(app) {
  const nodes = new Map();
  const workspaceOfSession = new Map();
  const aliasesByWorkspace = new Map();
  for (const alias of [...app.aliases].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    if (!alias.sessionId || !alias.workspaceId) continue;
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
  const resolve = id => (!id ? null : nodes.has(id) ? id : workspaceOfSession.get(id) ?? null);
  const chatNode = id => {
    if (!id) return null;
    if (nodes.has(id)) return id;
    const row = app.sessions.get(id);
    if (!row || workspaceOfSession.has(id)) return null;
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
  for (const node of nodes.values()) if (node.parentId) nodes.get(node.parentId).childIds.push(node.id);
  const byCreated = (a, b) => (nodes.get(a).createdAt ?? 0) - (nodes.get(b).createdAt ?? 0) || (a < b ? -1 : a > b ? 1 : 0);
  for (const node of nodes.values()) node.childIds.sort(byCreated);
  const roots = [...nodes.values()].filter(node => !node.parentId && node.childIds.length > 0);
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
  return { nodes, roots, workspaceOfSession };
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
  return forest.workspaceOfSession.get(id) ?? null;
}
