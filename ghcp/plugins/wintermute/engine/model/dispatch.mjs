/**
 * Work the orchestrator gives other sessions for a unit (issue #127). A unit that asked the orchestrator for input waits on it
 * only until the orchestrator acts. It can act without a message to the unit: for example, it starts the unit's review and
 * claims check in other sessions. The dashboard then shows what the unit waits for, not an unanswered request.
 */

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function namesPr(text, { provider, id }) {
  const n = `${id}(?!\\d)`;
  const shared = [`\\bpr=${provider}:${n}`, `\\bPR\\s*#?${n}`, `\\bpull\\s+request\\s*#?${n}`];
  const own = provider === 'ado' ? [`(?<![\\w!])!${n}`, `/pullrequest/${n}`] : [`(?<![\\w&#])#${n}`, `/pull/${n}`];
  return new RegExp([...shared, ...own].join('|'), 'i').test(text);
}

function namesCommit(text, commit) {
  const sha = commit.toLowerCase();
  for (const [token] of text.matchAll(/(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi)) {
    const word = token.toLowerCase();
    if (sha.startsWith(word) || word.startsWith(sha)) return true;
  }
  return false;
}

/**
 * Whether a message names a unit: its label as a whole word (case-sensitive, as labels are), its PR (`!123`, `/pullrequest/123`,
 * `#123`, `/pull/123`, `PR 123`, `pr=ado:123`), or a commit that its report gave (a prefix of 7 or more hex digits either way).
 */
export function namesUnit(text, { label = null, pr = null, commit = null } = {}) {
  if (typeof text !== 'string' || !text) return false;
  if (label && new RegExp(`(?<![\\w-])${escapeRe(label)}(?![\\w-])`).test(text)) return true;
  if (pr && pr.provider && Number.isInteger(pr.id) && namesPr(text, pr)) return true;
  if (commit && /^[0-9a-f]{7,40}$/i.test(commit) && namesCommit(text, commit)) return true;
  return false;
}

/**
 * The sessions that the orchestrator gave work for a unit after `since`, from what the engine already reads:
 * - `sent`: the orchestrator's sent messages ({ at, target, message, failed });
 * - `inbound`: for each other session, its messages from the orchestrator ({ nodeId, at, content }), which outlast the
 *   orchestrator's shorter rolling list;
 * - `created`: the sessions it started ({ at, name, prompt, failed }), matched to a node by `nodeOfCreated`.
 * `nodeOf(id)` gives the node id of a session id in this swarm, else null. A message or a kickoff counts when it names the unit
 * (see namesUnit); messages to the unit itself, to the orchestrator, or outside the swarm do not.
 * @returns {Map<string|null, number>} node id (null for a started session not seen yet) -> the time of its first such work.
 */
export function dispatchesFor({ since, refs, unitId, rootId, sent = [], inbound = [], created = [], nodeOf, nodeOfCreated }) {
  const found = new Map();
  const add = (nodeId, at) => {
    if (nodeId === unitId || nodeId === rootId) return;
    if (!found.has(nodeId) || at < found.get(nodeId)) found.set(nodeId, at);
  };
  for (const item of sent) {
    if (item.failed || !item.target || !(item.at > since) || !namesUnit(item.message, refs)) continue;
    const nodeId = nodeOf(item.target);
    if (nodeId) add(nodeId, item.at);
  }
  for (const item of inbound) if (item.at > since && namesUnit(item.content, refs)) add(item.nodeId, item.at);
  for (const item of created) {
    if (item.failed || !(item.at > since) || !namesUnit(item.prompt, refs)) continue;
    add(nodeOfCreated(item) ?? null, item.at);
  }
  return found;
}
