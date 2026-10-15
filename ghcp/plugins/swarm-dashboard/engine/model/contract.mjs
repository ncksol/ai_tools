import { OUTCOMES, PR_PROVIDERS, REPORT_STATUSES } from '../schema.mjs';
import { parseTime } from '../time.mjs';

export const UNIT_LABEL_RE = /^[A-Za-z0-9._-]{1,32}$/;
export const STATUS_LINE_PREFIX = 'swarm-status:';
const PURPOSE_STATUS = { handoff: 'complete', progress: 'progress', needs_input: 'needs_input', error: 'blocked' };
const NEEDS = new Set(['question', 'plan', 'pr']);
const LABEL_RE = /^(summary|evidence|blockers):[ \t]*(.*)$/i;

export function purposeToStatus(purpose) {
  return Object.prototype.hasOwnProperty.call(PURPOSE_STATUS, purpose) ? PURPOSE_STATUS[purpose] : null;
}

/** Contract v1 status line, read from the first line of a report. */
export function parseStatusLine(text) {
  if (typeof text !== 'string') return null;
  const first = text.split(/\r?\n/, 1)[0].trim();
  if (!first.startsWith(STATUS_LINE_PREFIX)) return null;
  const [status, ...tokens] = first.slice(STATUS_LINE_PREFIX.length).trim().split(/\s+/);
  if (!REPORT_STATUSES.includes(status)) return null;
  const fields = new Map();
  for (const token of tokens) {
    const eq = token.indexOf('=');
    if (eq > 0 && !fields.has(token.slice(0, eq))) fields.set(token.slice(0, eq), token.slice(eq + 1));
  }
  const unit = fields.get('unit');
  if (!unit || !UNIT_LABEL_RE.test(unit)) return null;
  const pr = /^(ado|github):([1-9]\d{0,9})$/.exec(fields.get('pr') ?? '');
  const commit = fields.get('commit') ?? '';
  return { status, unit, pr: pr ? { provider: pr[1], id: Number(pr[2]) } : null, commit: /^[0-9a-f]{7,40}$/.test(commit) ? commit : null };
}

/** Summary, Evidence and Blockers fields; text before the first label is free text. */
export function parseReportBody(text) {
  const sections = new Map();
  const free = [];
  let current = null;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = LABEL_RE.exec(line);
    if (match) {
      const key = match[1].toLowerCase();
      if (!sections.has(key)) sections.set(key, { inline: match[2].trim(), lines: [] });
      current = sections.get(key);
      continue;
    }
    if (current) current.lines.push(line);
    else free.push(line);
  }
  const items = section => {
    if (!section) return [];
    const out = section.inline ? [section.inline] : [];
    for (const raw of section.lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith('- ')) out.push(line.slice(2).trim());
      else if (/^\s/.test(raw) && out.length) out[out.length - 1] = `${out[out.length - 1]} ${line}`;
      else out.push(line);
    }
    return out;
  };
  const blockers = items(sections.get('blockers'));
  const freeText = free.join('\n').trim();
  return {
    summary: sections.has('summary') ? items(sections.get('summary')).join(' ').trim() || null : null,
    evidence: items(sections.get('evidence')),
    blockers: !sections.has('blockers') ? null : blockers.length === 1 && /^none\.?$/i.test(blockers[0]) ? [] : blockers,
    freeText: freeText || null,
  };
}

/** "[unit=<unit>[,<unit>...]|* [need=question|plan|pr]] <question>". Strict: anything else is untagged. */
export function parseQuestionTag(question) {
  if (typeof question !== 'string') return null;
  const match = /^\s*\[([^\]\n]*)\]\s*/.exec(question);
  if (!match) return null;
  const fields = new Map();
  for (const token of match[1].trim().split(/\s+/)) {
    const eq = token.indexOf('=');
    if (eq <= 0) return null;
    const key = token.slice(0, eq);
    if (fields.has(key) || (key !== 'unit' && key !== 'need')) return null;
    fields.set(key, token.slice(eq + 1));
  }
  const unit = fields.get('unit');
  if (!unit) return null;
  const units = unit === '*' ? ['*'] : unit.split(',');
  if (unit !== '*' && !units.every(label => UNIT_LABEL_RE.test(label))) return null;
  const need = fields.get('need') ?? 'question';
  if (!NEEDS.has(need)) return null;
  return { units, need, text: question.slice(match[0].length).trim() };
}

const textOrNull = value => (typeof value === 'string' && value.trim() ? value.trim() : null);

function registryRow(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const unit = typeof raw.unit === 'string' ? raw.unit : '';
  const sessionId = textOrNull(raw.session_id);
  const title = textOrNull(raw.title);
  const createdAt = parseTime(raw.created_at);
  const updatedAt = parseTime(raw.updated_at);
  if (!UNIT_LABEL_RE.test(unit) || !sessionId || !title || createdAt === null || updatedAt === null) return null;
  const prId = raw.pr_id === null || raw.pr_id === undefined || raw.pr_id === '' ? null : Number(raw.pr_id);
  const validPr = PR_PROVIDERS.includes(raw.pr_provider) && Number.isInteger(prId) && prId > 0;
  const outcome = OUTCOMES.includes(raw.outcome) ? raw.outcome : null;
  return {
    unit, sessionId, title, todoId: textOrNull(raw.todo_id), branch: textOrNull(raw.branch), baseBranch: textOrNull(raw.base_branch),
    prProvider: validPr ? raw.pr_provider : null, prRepo: textOrNull(raw.pr_repo), prId: validPr ? prId : null, prUrl: textOrNull(raw.pr_url),
    outcome, createdAt, updatedAt, endedAt: outcome ? parseTime(raw.ended_at) : null,
  };
}

/** The `children` registry rows of every CLI session of the orchestrator, merged by unit. */
export function normaliseRegistry(rowSets) {
  const units = new Map();
  let invalid = 0;
  for (const rows of rowSets) {
    for (const raw of rows ?? []) {
      const row = registryRow(raw);
      if (!row) {
        invalid += 1;
        continue;
      }
      const key = row.unit.toLowerCase();
      const previous = units.get(key);
      if (!previous || row.updatedAt > previous.updatedAt) units.set(key, row);
    }
  }
  return { units, invalid };
}
