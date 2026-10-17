import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
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
const UNDETERMINED_MESSAGE = 'lookup unavailable: could not tell whether the azure-devops extension is installed';

/** A file or folder's stats, or null when it cannot be read. */
const statOf = file => stat(file).catch(() => null);

/** Thrown when the check cannot tell what az would find; the lookup then starts no process. */
class UndeterminedError extends Error {}
const undetermined = reason => new UndeterminedError(reason);

// Python's str.isspace() set, which its strip(), rstrip() and the re module's \s and \S use for str. JS trim() and \s differ:
// they also strip U+FEFF, and miss U+001C to U+001F and U+0085.
const PY_SPACE = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000';
const PY_LEADING = new RegExp(`^[${PY_SPACE}]+`);
const PY_TRAILING = new RegExp(`[${PY_SPACE}]+$`);
const PY_NON_SPACE = new RegExp(`[^${PY_SPACE}]`);
const pyRstrip = text => text.replace(PY_TRAILING, '');
const pyStrip = text => pyRstrip(text.replace(PY_LEADING, ''));

/** Python's os.path.join for two parts, without the normalising that path.join does (the OS resolves the result). */
const pyJoin = (a, b) => (b.startsWith('/') || a === '' ? b : a.endsWith('/') ? a + b : `${a}/${b}`);

/**
 * Python's os.path.expanduser as az runs it: `~` alone or `~/...` takes HOME from the child's environment when it is set (even
 * empty), else the account's home folder; the home loses its trailing slashes, and an empty result is '/'. `~name` would look
 * up another account, so it is undetermined.
 */
function pyExpandUser(value, env) {
  if (!value.startsWith('~')) return value;
  const slash = value.indexOf('/', 1);
  if ((slash < 0 ? value.length : slash) !== 1) throw undetermined(`${value}: ~name is not resolved`);
  let home;
  if (env.HOME !== undefined) home = String(env.HOME);
  else {
    try {
      home = userInfo().homedir;
    } catch {
      throw undetermined('no home folder');
    }
  }
  return home.replace(/\/+$/, '') + value.slice(1) || '/';
}

/**
 * Python 3.12's ConfigParser._read with ConfigParser's defaults, as az reads its config file: delimiters `=` and `:`; `#` and
 * `;` start full-line comments only; empty lines belong to values; strict; option names lower-cased; values right-stripped
 * after their lines are joined with '\n'. `text` is the decoded file; lines end at \r\n, \r or \n (universal newlines).
 * Returns { sections: Map(name -> Map(option -> value)), defaults: Map(option -> value) }; throws UndeterminedError where
 * ConfigParser raises (a missing section header, a duplicate section or option, a line it cannot parse).
 */
function parseAzConfig(text) {
  const lines = text.split(/\r\n|\r|\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  const sections = new Map();
  const defaults = new Map();
  const added = new Set();
  let cursect = null;
  let sectname = null;
  let optname = null;
  let indentLevel = 0;
  for (const line of lines) {
    const stripped = pyStrip(line);
    const comment = stripped.startsWith('#') || stripped.startsWith(';');
    const value = comment ? '' : stripped;
    if (!value) {
      // An empty line is part of the current value; a comment line is not.
      if (!comment && cursect && optname) cursect.get(optname).push('');
      continue;
    }
    const indent = line.search(PY_NON_SPACE);
    if (cursect && optname && indent > indentLevel) {
      cursect.get(optname).push(value);
      continue;
    }
    indentLevel = indent;
    // SECTCRE: `\[(?P<header>.+)\]` as a prefix match; the greedy name runs to the last ], and the rest of the line is ignored.
    const header = /^\[(.+)\]/s.exec(value);
    if (header) {
      sectname = header[1];
      if (sections.has(sectname)) throw undetermined(`duplicate section ${sectname}`);
      if (sectname === 'DEFAULT') cursect = defaults;
      else {
        cursect = new Map();
        sections.set(sectname, cursect);
      }
      optname = null;
      continue;
    }
    if (!cursect) throw undetermined('an option before any section header');
    // OPTCRE: the name runs to the first delimiter, without trailing whitespace; the value is the rest, stripped.
    const at = value.search(/[=:]/);
    if (at < 0) throw undetermined('a line with no delimiter');
    const name = pyRstrip(value.slice(0, at)).toLowerCase();
    if (!name) throw undetermined('an option with an empty name');
    const key = JSON.stringify([sectname, name]);
    if (added.has(key)) throw undetermined(`duplicate option ${name}`);
    added.add(key);
    optname = name;
    cursect.set(name, [pyStrip(value.slice(at + 1))]);
  }
  const join = options => new Map([...options].map(([name, parts]) => [name, pyRstrip(parts.join('\n'))]));
  return { sections: new Map([...sections].map(([name, options]) => [name, join(options)])), defaults: join(defaults) };
}

/** Largest config file read; a bigger one is undetermined. */
const MAX_CONFIG_BYTES = 1024 * 1024;

/**
 * az's config file, parsed (see parseAzConfig). As knack reads it: a file that does not exist or cannot be opened (including a
 * folder) counts as empty; it is decoded as strict UTF-8 with a leading byte order mark kept. A decode error, a parse error,
 * a file over MAX_CONFIG_BYTES or one that is not a regular file is undetermined.
 */
async function readAzConfig(file) {
  const info = await statOf(file);
  if (!info || info.isDirectory()) return parseAzConfig('');
  if (!info.isFile()) throw undetermined(`${file} is not a regular file`);
  if (info.size > MAX_CONFIG_BYTES) throw undetermined(`${file} is too large`);
  let bytes;
  try {
    bytes = await readFile(file);
  } catch {
    return parseAzConfig('');
  }
  if (bytes.length > MAX_CONFIG_BYTES) throw undetermined(`${file} is too large`);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw undetermined(`${file} is not valid UTF-8`);
  }
  return parseAzConfig(text);
}

/**
 * A setting of az's [extension] section as knack gets it: the variable AZURE_EXTENSION_<OPTION>, raw, when it is set (even
 * empty); else ConfigParser's get: nothing when the file has no [extension] section (DEFAULT does not count then), else the
 * option from [extension], else from DEFAULT. A file value with a % is undetermined (ConfigParser would interpolate it).
 * Returns the folder with `~` expanded (see pyExpandUser), or null for an empty or missing value.
 */
function extensionSetting(env, config, option) {
  const name = `AZURE_EXTENSION_${option.toUpperCase()}`;
  let value;
  if (env[name] !== undefined) value = String(env[name]);
  else {
    const section = config.sections.get('extension');
    value = section ? section.get(option) ?? config.defaults.get(option) : undefined;
    if (value?.includes('%')) throw undetermined(`[extension] ${option} has a %`);
  }
  return value ? pyExpandUser(value, env) : null;
}

/**
 * The az program that a child spawned with `env` from `cwd` would run, or null, by libuv's search (what execFile does): PATH
 * from `env` (unset: /usr/bin:/bin), split on ':'; an empty entry is the child's folder and a relative one is taken from it;
 * the first <entry>/az that is a regular file (after links) and executable. Others are skipped. Null on Windows.
 */
export async function findAzLauncher({ env = process.env, cwd = null } = {}) {
  if (process.platform === 'win32') return null;
  const base = cwd ?? process.cwd();
  const search = env.PATH === undefined ? '/usr/bin:/bin' : String(env.PATH);
  for (const entry of search.split(':')) {
    const candidate = pyJoin(base, pyJoin(entry, 'az'));
    if (!(await statOf(candidate))?.isFile()) continue;
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // not executable: the search goes on
    }
  }
  return null;
}

/** The Python a launcher's text names in the known launcher shape (`<absolute python> <flags> azure.cli`), when it names one. */
const LAUNCHER_PYTHON = /(\/[^\s"']*\/python[\d.]*)["']?(?:\s+-\w+)+\s+azure\.cli\b/g;

/**
 * az's system extension folder when no setting names one: azure-cli-extensions in the purelib of the Python that az runs, or
 * null. Only the launcher that would run (see findAzLauncher), followed to its real file, is read. It must be a script that
 * names exactly one Python in the launcher shape of Homebrew and the Linux packages; the folder is then
 * <dirname(dirname(python))>/lib/<version>/site-packages/azure-cli-extensions, where the version is the Python's real file
 * name when that is python3.N, else the only python3.N folder in that lib. Null when any step fails.
 */
async function defaultSystemFolder({ env, cwd }) {
  const launcher = await findAzLauncher({ env, cwd });
  if (!launcher) return null;
  let text;
  try {
    const file = await realpath(launcher);
    if ((await statOf(file)).size > 64 * 1024) return null;
    text = await readFile(file, 'utf8');
  } catch {
    return null;
  }
  if (!text.startsWith('#!')) return null;
  const pythons = new Set([...text.matchAll(LAUNCHER_PYTHON)].map(match => match[1]));
  if (pythons.size !== 1) return null;
  const [python] = pythons;
  const lib = path.join(path.dirname(path.dirname(python)), 'lib');
  const isVersion = name => /^python3\.\d+$/.test(name);
  let version = null;
  try {
    const name = path.basename(await realpath(python));
    if (isVersion(name)) version = name;
  } catch {
    // no real file: the lib folder decides
  }
  if (!version) {
    try {
      const found = (await readdir(lib)).filter(isVersion);
      if (found.length === 1) [version] = found;
    } catch {
      return null;
    }
  }
  return version ? path.join(lib, version, 'site-packages', 'azure-cli-extensions') : null;
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
 * that the az launcher which would run names; see defaultSystemFolder). As az takes them: the config file is
 * <AZURE_CONFIG_DIR>/config when that variable is set (even empty, then
 * `config` in the child's folder), else ~/.azure/config, read as ConfigParser reads it (see readAzConfig); the default
 * extension folder's parent is AZURE_CONFIG_DIR when it is not empty, else ~/.azure; relative paths are taken from `cwd` (the
 * child's folder; null is this process's). Resolves true or false; throws when it cannot tell what az would do (a config
 * file az would fail to read, a value it would interpolate, `~name`), so that a false "installed" is never given.
 * Read-only: it only stats, lists and reads these paths.
 */
export async function azureExtensionInstalled({ env = process.env, cwd = null } = {}) {
  const base = cwd ?? process.cwd();
  const absolute = file => pyJoin(base, file);
  const azureDir = () => pyExpandUser('~/.azure', env);
  const configDir = env.AZURE_CONFIG_DIR !== undefined ? String(env.AZURE_CONFIG_DIR) : azureDir();
  const config = await readAzConfig(absolute(pyJoin(configDir, 'config')));
  const userDir = extensionSetting(env, config, 'dir') ?? pyJoin(env.AZURE_CONFIG_DIR || azureDir(), 'cliextensions');
  if (await hasExtension(absolute(userDir))) return true;
  const sysDir = extensionSetting(env, config, 'sys_dir');
  const systemDir = sysDir ? absolute(sysDir) : await defaultSystemFolder({ env, cwd: base });
  return systemDir !== null && hasExtension(systemDir);
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
 * azure-devops extension; otherwise, or when the check cannot tell (it throws), it fails with no process started, and a request
 * after the TTL checks the disk again.
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
      // The dashboard never installs the extension, and without it az would only fail after its own start-up work. A check
      // that cannot tell starts no process either.
      if (ado) {
        let installed;
        try {
          installed = await hasAzureExtension({ env: commandEnv, cwd });
        } catch {
          throw new Error(UNDETERMINED_MESSAGE);
        }
        if (!installed) throw new Error(MISSING_EXTENSION_MESSAGE);
      }
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
