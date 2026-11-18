/**
 * Work the orchestrator gives other sessions for a unit (issue #127). A unit that asked the orchestrator for other sessions' work,
 * such as its planned review and claims check, waits on the orchestrator only until it starts that work. The orchestrator can
 * start it without a message to the unit. The dashboard then shows what the unit waits for, not an unanswered request. A request
 * that also needs a decision, an approval or an answer stays the orchestrator's until it replies to the unit.
 */

/** The key prefix of a started session that isn't in the swarm (yet). */
export const NEW_SESSION = 'new-session:';

const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that ask for work by other sessions, and words that ask the orchestrator or the user to decide, approve or answer.
const ASKS_FOR_WORK = /\b(?:re-?reviews?|reviews?|reviewers?|claims[ -]check(?:er)?s?|helpers?|second opinions?|panels?|judges?)\b|^\s*Job:/im;
const ASKS_TO_DECIDE = /\b(?:go-?ahead|approv(?:e|es|ed|al|als|ing)|decid(?:e|es|ed|ing)|decisions?|questions?|permission|confirm(?:s|ed|ation)?|choose|answer|should (?:I|we)|may I|can I|ok(?:ay)? to)\b|\?/i;
// A message that names the unit only to put its work off.
const STANDS_DOWN = /\b(?:do not|don't|not yet|no need to)\s+(?:start|begin|review|check)\b|\bwait (?:until|for (?:my|the user|the owner|approval|an? (?:answer|decision)))\b|\bhold off\b|\bstand(?:s|ing)? down\b|\bstill waiting\b|\bon hold\b/i;

/**
 * Whether a needs_input report asks only for other sessions' work: its blockers (else its summary) name a review, a claims check
 * or a helper, and ask no decision, approval or question. Only such a request can be handled without a reply to the unit.
 */
export function asksOnlyForWork(report) {
  const text = (report?.blockers?.length ? report.blockers.join('\n') : report?.summary) ?? '';
  return ASKS_FOR_WORK.test(text) && !ASKS_TO_DECIDE.test(text);
}

const sameRepo = (a, b) => {
  const norm = text => { try { return decodeURIComponent(text).toLowerCase(); } catch { return text.toLowerCase(); } };
  return norm(a) === norm(b);
};

// PR references that carry their repository: GitHub and Azure DevOps URLs, and GitHub's owner/repo#123.
const QUALIFIED = [
  { provider: 'github', re: /https?:\/\/[^\s/]+\/([^\s/]+)\/([^\s/#?]+)\/pull\/(\d+)/gi, repo: m => `${m[1]}/${m[2]}`, id: m => m[3] },
  { provider: 'ado', re: /https?:\/\/dev\.azure\.com\/([^\s/]+)\/([^\s/]+)\/_git\/([^\s/]+)\/pullrequest\/(\d+)/gi, repo: m => `${m[1]}/${m[2]}/${m[3]}`, id: m => m[4] },
  {
    provider: 'ado', re: /https?:\/\/([^\s/.]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^\s/]+)\/_git\/([^\s/]+)\/pullrequest\/(\d+)/gi,
    repo: m => `${m[1]}/${m[2]}/${m[3]}`, id: m => m[4],
  },
  { provider: 'github', re: /(?<![\w./-])([\w.-]+)\/([\w.-]+)#(\d+)/g, repo: m => `${m[1]}/${m[2]}`, id: m => m[3] },
];

/**
 * A qualified reference names the PR only when its provider, repository and number all match; a unit with no known repository
 * matches on provider and number. Unqualified forms (`!123`, `#123`, `PR 123`, `pull request 123`, `pr=ado:123`) count only outside
 * URLs and qualified references, so a reference to another repository's PR with the same number never matches.
 */
function namesPr(text, { provider, id, repo = null }) {
  let rest = text;
  for (const form of QUALIFIED) {
    for (const match of text.matchAll(form.re)) {
      if (form.provider === provider && Number(form.id(match)) === id && (!repo || sameRepo(form.repo(match), repo))) return true;
    }
    rest = rest.replace(form.re, ' ');
  }
  rest = rest.replace(/https?:\/\/\S+/gi, ' ');
  const n = `${id}(?!\\d)`;
  const forms = [`\\bpr=${provider}:${n}`, `\\bPR\\s*#?${n}`, `\\bpull\\s+request\\s*#?${n}`, provider === 'ado' ? `(?<![\\w!])!${n}` : `(?<![\\w&#/])#${n}`];
  return new RegExp(forms.join('|'), 'i').test(rest);
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
 * Whether a message names a unit: its label as a whole label (case-sensitive; label characters are letters, digits, `.`, `_` and
 * `-`, and a trailing `.` that ends a sentence still counts), its PR (see namesPr), or a commit that its report gave (a prefix of
 * 7 or more hex digits either way).
 */
export function namesUnit(text, { label = null, pr = null, commit = null } = {}) {
  if (typeof text !== 'string' || !text) return false;
  if (label && new RegExp(`(?<![A-Za-z0-9._-])${escapeRe(label)}(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`).test(text)) return true;
  if (pr && pr.provider && Number.isInteger(pr.id) && namesPr(text, pr)) return true;
  if (commit && /^[0-9a-f]{7,40}$/i.test(commit) && namesCommit(text, commit)) return true;
  return false;
}

/** Whether a message names the unit to give work for it, not to put its work off. */
const givesWork = (text, refs) => namesUnit(text, refs) && !STANDS_DOWN.test(text);

/**
 * The sessions that the orchestrator gave work for a unit after `since`, timed by when the orchestrator sent or started it:
 * - `sent`: the orchestrator's sent messages ({ at, target, message, failed });
 * - `inbound`: other sessions' messages from the orchestrator ({ nodeId, sourceToolCallId, content }). These outlast the
 *   orchestrator's shorter `sent` list. Each counts only at its send time in `sendTimes` ({ toolCallId, at, failed }); a copy
 *   whose send isn't there can't be timed and doesn't count;
 * - `created`: the sessions it started ({ at, name, prompt, sessionId, failed }), matched to a node by `nodeOfCreated`.
 * `nodeOf(id)` gives the node id of a session id in this swarm, else null. Work counts when its text names the unit and doesn't put
 * it off, and its session `accepts(nodeId)` (for example, isn't another unit's owner). Messages to the unit itself, to the
 * orchestrator, or outside the swarm don't count.
 * @returns {Map<string, number>} node id, or NEW_SESSION + tool call id for a started session not found -> the time of its first such work.
 */
export function dispatchesFor({ since, refs, unitId, rootId, sent = [], inbound = [], sendTimes = [], created = [], nodeOf, nodeOfCreated, accepts = () => true }) {
  const found = new Map();
  const add = (nodeId, at) => {
    if (nodeId === unitId || nodeId === rootId || (!nodeId.startsWith(NEW_SESSION) && !accepts(nodeId))) return;
    if (!found.has(nodeId) || at < found.get(nodeId)) found.set(nodeId, at);
  };
  for (const item of sent) {
    if (item.failed || !item.target || !(item.at > since) || !givesWork(item.message, refs)) continue;
    const nodeId = nodeOf(item.target);
    if (nodeId) add(nodeId, item.at);
  }
  const sends = new Map(sendTimes.map((item, index) => [item.toolCallId, { ...item, index }]));
  const copies = [];
  for (const item of inbound) {
    const send = item.sourceToolCallId ? sends.get(item.sourceToolCallId) : null;
    if (send && !send.failed && send.at > since && givesWork(item.content, refs)) copies.push({ nodeId: item.nodeId, send });
  }
  // In send order, so sessions given work at the same time keep the order the orchestrator sent it in.
  for (const { nodeId, send } of copies.sort((a, b) => a.send.at - b.send.at || a.send.index - b.send.index)) add(nodeId, send.at);
  for (const item of created) {
    if (item.failed || !(item.at > since) || !givesWork(item.prompt, refs)) continue;
    add(nodeOfCreated(item) ?? `${NEW_SESSION}${item.toolCallId}`, item.at);
  }
  return found;
}
