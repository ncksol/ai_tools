import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { MINUTE, parseTime } from '../time.mjs';

export const GITHUB_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export const ADO_REPO = /^[A-Za-z0-9][\w.-]*\/[^/\r\n]+\/[^/\r\n]+$/;
const EMPTY_INFO = Object.freeze({ state: 'unknown', title: null, openedAt: null, mergedAt: null, closedAt: null, reviewNote: null, url: null });

// Turns off the CLIs' telemetry, update checks, prompts, log files, error recommendations and extension installs; az runs only
// when the azure-devops extension is already installed (see azureExtensionInstalled). Accepted exceptions: three things remain
// that the CLIs do on their own on any use, not requests the dashboard makes: they refresh their own sign-in caches; az keeps its
// config folder up to date (its session and cache files and its command index); and after az is installed or upgraded, while
// its version cache is empty, az fetches version metadata from GitHub.
export const CLI_ENV = Object.freeze({
  az: Object.freeze({
    AZURE_EXTENSION_USE_DYNAMIC_INSTALL: 'no',
    AZURE_CORE_COLLECT_TELEMETRY: 'no',
    AZURE_LOGGING_ENABLE_LOG_FILE: 'no',
    AZURE_CORE_SURVEY_MESSAGE: 'no',
    'AZURE_AUTO-UPGRADE_ENABLE': 'no', // knack keeps the hyphen of the auto-upgrade section.
    // az compares this value, upper-cased, with OFF: only 'off' stops the recommendation request after a failed command.
    AZURE_CORE_ERROR_RECOMMENDATION: 'off',
  }),
  gh: Object.freeze({ GH_NO_UPDATE_NOTIFIER: '1', GH_NO_EXTENSION_UPDATE_NOTIFIER: '1', GH_PROMPT_DISABLED: '1', GH_TELEMETRY: 'false' }),
});

export const cliEnv = (command, base = process.env) => ({ ...base, ...CLI_ENV[command] });

// An az that still says the command is unknown has a broken extension install; it is reported like a missing extension.
const MISSING_EXTENSION = /not recognized by the system|requires the extension|az extension add/i;
const MISSING_EXTENSION_MESSAGE = 'lookup unavailable: azure-devops extension not installed';

/** A file or folder's stats, or null when it cannot be read. */
const statOf = file => stat(file).catch(() => null);

/** Python's os.path.expanduser for a leading ~ alone or ~/; `home` is the HOME that az sees. */
const expandHome = (value, home) => (value === '~' || value.startsWith('~/') ? path.join(home, value.slice(1)) : value);

/**
 * One option of an INI file, as Python's configparser reads az's config file: section names match exactly, option names in any
 * case, `=` or `:` separates the value, lines that start with # or ; are comments, and the DEFAULT section applies to every
 * section. Returns undefined when the option is not set.
 */
function iniOption(text, section, option) {
  let current = null;
  const found = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1];
      continue;
    }
    if (current !== section && current !== 'DEFAULT') continue;
    const separator = line.search(/[=:]/);
    if (separator <= 0 || line.slice(0, separator).trim().toLowerCase() !== option) continue;
    found.set(current, line.slice(separator + 1).trim());
  }
  return found.get(section) ?? found.get('DEFAULT');
}

/**
 * The folders az reads for a setting of its [extension] section, as knack does: the variable AZURE_EXTENSION_<OPTION> wins, even
 * when empty; else the option in <config folder>/config. A value has a leading ~ expanded; an empty or missing one gives null.
 */
function extensionSetting(env, configText, option, home) {
  const name = `AZURE_EXTENSION_${option.toUpperCase()}`;
  const value = Object.hasOwn(env, name) ? env[name] : configText === null ? undefined : iniOption(configText, 'extension', option);
  return value ? expandHome(value, home) : null;
}

/**
 * az's system extension folder when no setting names one: azure-cli-extensions in the purelib of the Python that az runs. Best
 * effort: the first az on PATH, followed to its real file, must be a launcher script that names that Python (as Homebrew's and
 * the Linux packages' do), or a script whose #! line is that Python; the folder is then azure-cli-extensions in
 * <dirname(dirname(python))>/lib/python3.N/site-packages. Empty when any step fails.
 */
async function defaultSystemFolders(env) {
  let launcher = null;
  for (const dir of String(env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'az');
    if ((await statOf(candidate))?.isFile()) {
      launcher = candidate;
      break;
    }
  }
  if (!launcher) return [];
  let text;
  try {
    const file = await realpath(launcher);
    if ((await statOf(file)).size > 64 * 1024) return [];
    text = await readFile(file, 'utf8');
  } catch {
    return [];
  }
  if (!text.startsWith('#!')) return [];
  const match = /(\/[^\s"']*\/python[\d.]*)["']?(?:\s+-\w+)+\s+azure\.cli\b/.exec(text) ?? /^#!\s*(\/\S*\/python[\d.]*)\s*$/m.exec(text.split('\n')[0]);
  if (!match) return [];
  const prefix = path.dirname(path.dirname(match[1]));
  const lib = path.join(prefix, 'lib');
  let versions;
  try {
    versions = (await readdir(lib)).filter(name => /^python3\.\d+$/.test(name));
  } catch {
    return [];
  }
  return versions.map(version => path.join(lib, version, 'site-packages', 'azure-cli-extensions'));
}

/** Whether `<dir>/azure-devops` is a folder holding an entry that az's glob `*.*-info` matches (glob skips names that start with a dot). */
async function hasExtension(dir) {
  const folder = path.join(dir, 'azure-devops');
  if (!(await statOf(folder))?.isDirectory()) return false;
  try {
    return (await readdir(folder)).some(name => !name.startsWith('.') && /\..*-info$/s.test(name));
  } catch {
    return false;
  }
}

/**
 * Whether az, run with `env` from `cwd`, has the azure-devops extension installed, judged as az 2.71 does from the folders it
 * reads: the user extension folder (AZURE_EXTENSION_DIR, else [extension] dir in the config file, else
 * <config folder>/cliextensions) and the system one (AZURE_EXTENSION_SYS_DIR, else [extension] sys_dir, else beside the Python
 * that az runs). The config folder is AZURE_CONFIG_DIR, else ~/.azure. Read-only: it only stats, lists and reads these paths.
 */
export async function azureExtensionInstalled({ env = process.env, cwd = null } = {}) {
  const home = env.HOME || homedir();
  const base = cwd ?? process.cwd();
  const configDir = path.resolve(base, env.AZURE_CONFIG_DIR || path.join(home, '.azure'));
  let configText = null;
  try {
    configText = await readFile(path.join(configDir, 'config'), 'utf8');
  } catch {
    // no config file: the defaults apply
  }
  const userDir = extensionSetting(env, configText, 'dir', home);
  if (await hasExtension(path.resolve(base, userDir ?? path.join(configDir, 'cliextensions')))) return true;
  const sysDir = extensionSetting(env, configText, 'sys_dir', home);
  const sysDirs = sysDir ? [path.resolve(base, sysDir)] : await defaultSystemFolders(env);
  for (const dir of sysDirs) if (await hasExtension(dir)) return true;
  return false;
}

export function runCommand(command, args, { cwd, timeoutMs, env }) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, env, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const failure = new Error(`${command} failed: ${String(stderr || error.message).trim().split('\n')[0].slice(0, 200)}`);
        failure.code = error.code;
        reject(failure);
        return;
      }
      resolve(String(stdout));
    });
  });
}

const adoOrg = pr => (typeof pr.repo === 'string' && ADO_REPO.test(pr.repo) ? pr.repo.split('/')[0] : null);

/** The repository a lookup can name on the command line, or null when it has to run in the unit's worktree. */
export const targetOf = pr => (pr.provider === 'ado' ? adoOrg(pr) : typeof pr.repo === 'string' && GITHUB_REPO.test(pr.repo) ? pr.repo : null);

/** Cache key. A PR without a usable repository is resolved in its worktree, so the worktree is part of its identity. */
export const prKey = (pr, cwd = null) => (targetOf(pr) ? `${pr.provider}:${pr.repo}:${pr.id}` : `${pr.provider}:@${cwd ?? ''}:${pr.id}`);

export function adoArgs(pr) {
  const args = ['repos', 'pr', 'show', '--id', String(pr.id), '--output', 'json'];
  const org = adoOrg(pr);
  if (org) args.push('--organization', `https://dev.azure.com/${org}`, '--detect', 'false');
  return args;
}

export function githubArgs(pr) {
  const args = ['pr', 'view', String(pr.id), '--json', 'state,isDraft,title,createdAt,mergedAt,closedAt,reviewDecision,url'];
  if (pr.repo && GITHUB_REPO.test(pr.repo)) args.push('--repo', pr.repo);
  return args;
}

export function mapAdo(json) {
  const status = String(json.status ?? '').toLowerCase();
  const state = status === 'completed' ? 'merged' : status === 'abandoned' ? 'closed' : status === 'active' ? (json.isDraft ? 'draft' : 'open') : 'unknown';
  const votes = Array.isArray(json.reviewers) ? json.reviewers.map(reviewer => Number(reviewer.vote) || 0) : [];
  const approvals = votes.filter(vote => vote >= 5).length;
  const reviewNote = votes.includes(-10) ? 'rejected' : votes.includes(-5) ? 'waiting for the author'
    : approvals ? `${approvals} approval${approvals === 1 ? '' : 's'}` : 'no approvals yet';
  const webUrl = json.repository?.webUrl;
  return {
    state, title: typeof json.title === 'string' ? json.title : null, openedAt: parseTime(json.creationDate),
    mergedAt: state === 'merged' ? parseTime(json.closedDate) : null, closedAt: parseTime(json.closedDate), reviewNote,
    url: typeof webUrl === 'string' && json.pullRequestId ? `${webUrl}/pullrequest/${json.pullRequestId}` : null,
  };
}

export function mapGithub(json) {
  const raw = String(json.state ?? '').toUpperCase();
  const state = raw === 'MERGED' ? 'merged' : raw === 'CLOSED' ? 'closed' : raw === 'OPEN' ? (json.isDraft ? 'draft' : 'open') : 'unknown';
  const reviewNote = { APPROVED: 'approved', CHANGES_REQUESTED: 'changes requested', REVIEW_REQUIRED: 'review required' }[json.reviewDecision] ?? null;
  return {
    state, title: typeof json.title === 'string' ? json.title : null, openedAt: parseTime(json.createdAt),
    mergedAt: parseTime(json.mergedAt), closedAt: parseTime(json.closedAt), reviewNote, url: typeof json.url === 'string' ? json.url : null,
  };
}

/**
 * Cached, read-only PR state through `az repos pr show` and `gh pr view`. Only a merged result is final. A closed or abandoned PR can
 * be reopened or reactivated, so it is checked again after the TTL like an open one.
 * `env` is the base environment of both CLIs (see cliEnv). An ADO lookup starts az only when `azureExtensionInstalled` finds the
 * azure-devops extension; otherwise it fails with no process started, and a request after the TTL checks the disk again.
 */
export function createPrLookup({
  run = runCommand, now = Date.now, ttlMs = 5 * MINUTE, timeoutMs = 20_000, concurrency = 2, exists = existsSync,
  env = process.env, azureExtensionInstalled: hasAzureExtension = azureExtensionInstalled,
} = {}) {
  const cache = new Map();
  const queue = [];
  const inflight = new Set();
  let active = 0;
  let waiters = [];
  const isFinal = info => info.state === 'merged';
  const due = key => {
    const info = cache.get(key)?.info;
    return !info || (!isFinal(info) && now() - info.checkedAt >= ttlMs);
  };

  async function lookup({ pr, key, label, cwd }) {
    const store = info => cache.set(key, { label, info });
    try {
      if (cwd && !exists(cwd)) throw new Error('its worktree is gone, so its repository is unknown');
      const ado = pr.provider === 'ado';
      const command = ado ? 'az' : 'gh';
      const commandEnv = cliEnv(command, env);
      // The dashboard never installs the extension, and without it az would only fail after its own start-up work.
      if (ado && !(await hasAzureExtension({ env: commandEnv, cwd }))) throw new Error(MISSING_EXTENSION_MESSAGE);
      let stdout;
      try {
        stdout = await run(command, ado ? adoArgs(pr) : githubArgs(pr), { cwd: cwd ?? undefined, timeoutMs, env: commandEnv });
      } catch (error) {
        if (ado && MISSING_EXTENSION.test(error.message)) throw new Error(MISSING_EXTENSION_MESSAGE);
        throw error;
      }
      store({ ...(ado ? mapAdo : mapGithub)(JSON.parse(stdout)), checkedAt: now(), error: null });
    } catch (error) {
      store({ ...(cache.get(key)?.info ?? EMPTY_INFO), checkedAt: now(), error: error.message });
    }
  }

  function pump() {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      lookup(job).finally(() => {
        active -= 1;
        inflight.delete(job.key);
        if (queue.length) {
          pump();
        } else if (!active) {
          const list = waiters;
          waiters = [];
          for (const resolve of list) resolve();
        }
      });
    }
  }

  function request(pr, { cwd = null } = {}) {
    if (!pr || !Number.isInteger(pr.id) || pr.id <= 0 || (pr.provider !== 'ado' && pr.provider !== 'github')) return;
    const target = targetOf(pr);
    if (!target && !cwd) return;
    const key = prKey(pr, cwd);
    if (inflight.has(key) || !due(key)) return;
    inflight.add(key);
    // The label goes into diagnostics, so it never holds the worktree path, nor a repository value that is not a usable repository.
    queue.push({ pr, key, label: `${pr.provider}:${target ? pr.repo : 'worktree'}:${pr.id}`, cwd: target ? null : cwd });
    pump();
  }

  return {
    get: (pr, { cwd = null } = {}) => cache.get(prKey(pr, cwd))?.info ?? null,
    request,
    pending: (pr, { cwd = null } = {}) => Boolean(pr) && inflight.has(prKey(pr, cwd)),
    settle: () => (active || queue.length ? new Promise(resolve => waiters.push(resolve)) : Promise.resolve()),
    errors: () => [...cache.values()].filter(({ info }) => info.error).map(({ label, info }) => ({ key: label, error: info.error })),
  };
}
