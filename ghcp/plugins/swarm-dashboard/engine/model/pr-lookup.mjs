import { execFile } from 'node:child_process';
import { constants, existsSync } from 'node:fs';
import { access, open, readFile, readdir, realpath, stat } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { MINUTE, parseTime } from '../time.mjs';

export const GITHUB_REPO = /^[A-Za-z0-9][\w.-]*\/[\w.-]+$/;
export const ADO_REPO = /^[A-Za-z0-9][\w.-]*\/[^/\r\n]+\/[^/\r\n]+$/;
const EMPTY_INFO = Object.freeze({ state: 'unknown', title: null, openedAt: null, mergedAt: null, closedAt: null, reviewNote: null, url: null });

// Turns off the CLIs' telemetry, update checks, prompts, log files, error recommendations and extension installs; az runs only
// when the azure-devops extension is already installed (see azureExtensionInstalled), and without shell start-up hooks or
// Python start-up overrides (see cliEnv). Accepted exceptions: three things remain that the CLIs do on their own on any use,
// not requests the dashboard makes: they refresh their own sign-in caches; az keeps its config folder up to date (its session
// and cache files and its command index); and after az is installed or upgraded, while its version cache is empty, az fetches
// version metadata from GitHub.
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

/** Variables a shell reads at start-up, which could change what az's launcher runs or exports; az runs without them. */
const SHELL_HOOKS = new Set(['BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PS4', 'BASH_XTRACEFD']);

/**
 * A variable that can change how Python starts: every PYTHON* key (on macOS framework builds PYTHONEXECUTABLE moves the
 * executable and prefix even under -I) and __PYVENV_LAUNCHER__. az runs without them.
 */
const isPythonOverride = key => key.startsWith('PYTHON') || key === '__PYVENV_LAUNCHER__';

/**
 * The environment `command` runs with: `base` with CLI_ENV's settings. For az, shell start-up hooks (SHELL_HOOKS and every
 * exported bash function, BASH_FUNC_*) and Python start-up overrides (see isPythonOverride) are removed, so the launcher's
 * shell runs the line the extension check read, its Python starts as the check derived, and both see the same environment.
 * The launcher runs Python with -I, which is meant to ignore those, so az loses nothing. gh's is not changed.
 */
export function cliEnv(command, base = process.env) {
  const env = { ...base, ...CLI_ENV[command] };
  if (command === 'az') {
    for (const key of Object.keys(env)) if (SHELL_HOOKS.has(key) || key.startsWith('BASH_FUNC_') || isPythonOverride(key)) delete env[key];
  }
  return env;
}

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

/** Python's posixpath.dirname, without normalising. */
function pyDirname(file) {
  const head = file.slice(0, file.lastIndexOf('/') + 1);
  return head && !/^\/+$/.test(head) ? head.replace(/\/+$/, '') : head;
}

/** Python's posixpath.basename. */
const pyBasename = file => file.slice(file.lastIndexOf('/') + 1);

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
 * folder) counts as empty. A file the check does not model is undetermined: one with any character other than printable ASCII,
 * tab, CR or LF (Python's case folding and whitespace differ from JavaScript's), one with a % anywhere (ConfigParser would
 * interpolate any option az reads), one over MAX_CONFIG_BYTES, or one that is not a regular file; so is a parse error.
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
  for (const byte of bytes) {
    if (byte !== 0x09 && byte !== 0x0a && byte !== 0x0d && (byte < 0x20 || byte > 0x7e)) throw undetermined(`${file} has a character outside printable ASCII`);
    if (byte === 0x25) throw undetermined(`${file} has a %`);
  }
  return parseAzConfig(bytes.toString('latin1'));
}

/**
 * A setting of az's [extension] section as knack gets it: the variable AZURE_EXTENSION_<OPTION>, raw, when it is set (even
 * empty); else ConfigParser's get: nothing when the file has no [extension] section (DEFAULT does not count then), else the
 * option from [extension], else from DEFAULT. Returns the value, or null for an empty or missing one.
 */
function rawExtensionSetting(env, config, option) {
  const name = `AZURE_EXTENSION_${option.toUpperCase()}`;
  if (env[name] !== undefined) return String(env[name]) || null;
  const section = config.sections.get('extension');
  return (section ? section.get(option) ?? config.defaults.get(option) : undefined) || null;
}

/** A folder setting of az's [extension] section (see rawExtensionSetting) with `~` expanded (see pyExpandUser), or null. */
function extensionSetting(env, config, option) {
  const value = rawExtensionSetting(env, config, option);
  return value ? pyExpandUser(value, env) : null;
}

/** Whether `file` is a regular file (after links) that this user may execute. */
async function isExecutableFile(file) {
  if (!(await statOf(file))?.isFile()) return false;
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * The first `name` that a child spawned with `env` from `cwd` finds on PATH by libuv's search (what execFile does): PATH from
 * `env` (unset: /usr/bin:/bin), split on ':'; an empty entry is the child's folder and a relative one is taken from it; the
 * first <entry>/<name> that is a regular file (after links) and executable.
 */
async function findOnPath(name, { env, cwd }) {
  const base = cwd ?? process.cwd();
  const search = env.PATH === undefined ? '/usr/bin:/bin' : String(env.PATH);
  for (const entry of search.split(':')) {
    const candidate = pyJoin(base, pyJoin(entry, name));
    if (await isExecutableFile(candidate)) return candidate;
  }
  return null;
}

/**
 * The first az that a child spawned with `env` from `cwd` would try, or null (see findOnPath). The child runs it unless its
 * interpreter cannot start: execve then fails and the search goes on to the next candidate, so the system folder is derived
 * from this candidate only when its interpreter is known to start (see defaultSystemFolder), and never from a later one.
 * Null on Windows.
 */
export async function findAzLauncher({ env = process.env, cwd = null } = {}) {
  if (process.platform === 'win32') return null;
  return findOnPath('az', { env, cwd });
}

/** Whether `file` starts with `#!` (an unreadable file counts as one, which is the safe answer). */
async function startsWithShebang(file) {
  let handle;
  try {
    handle = await open(file, 'r');
    const { bytesRead, buffer } = await handle.read(Buffer.alloc(2), 0, 2, 0);
    return bytesRead === 2 && buffer.toString('latin1') === '#!';
  } catch {
    return true;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** The first lines of the launchers the check reads: Homebrew's and the plain shells. */
const LAUNCHER_SHEBANGS = new Set(['#!/usr/bin/env bash', '#!/bin/bash', '#!/usr/bin/bash', '#!/bin/sh']);
/**
 * Homebrew's launcher command: an optional AZ_INSTALLER=..., an absolute python, -Im azure.cli "$@". No `exec`: Homebrew does
 * not use it, and an exported function could replace it.
 */
const LAUNCHER_LINE = /^(?:AZ_INSTALLER=[A-Za-z0-9_]+[ \t]+)?(\/[A-Za-z0-9._/+-]+)[ \t]+-Im[ \t]+azure\.cli[ \t]+"\$@"[ \t]*$/;

/**
 * Whether the interpreter of a launcher whose first line is `shebang` (one of LAUNCHER_SHEBANGS) can start: an executable
 * regular file that is not itself a script. For `/usr/bin/env bash`, /usr/bin/env must be executable and the first bash found
 * on the same PATH must be such a file.
 */
async function interpreterStarts(shebang, { env, cwd }) {
  let interpreter = shebang.slice(2);
  if (interpreter === '/usr/bin/env bash') {
    if (!(await isExecutableFile('/usr/bin/env'))) return false;
    interpreter = await findOnPath('bash', { env, cwd });
    if (!interpreter) return false;
  }
  return (await isExecutableFile(interpreter)) && !(await startsWithShebang(interpreter));
}

/**
 * az's system extension folder when no setting names one, derived only from a launcher of the exact Homebrew form, or null
 * (unknown). All of these must hold, else it is unknown:
 * - the first executable az on PATH (see findAzLauncher), followed to its real file, has no \r; its first line is one of
 *   LAUNCHER_SHEBANGS and that interpreter starts (see interpreterStarts);
 * - after the first line, without blank lines and lines whose first non-blank character is #, exactly one line remains, and it
 *   fully matches LAUNCHER_LINE;
 * - the python's name is python, python3 or python3.N, and its real path resolves;
 * - <dirname(dirname(python))>/pyvenv.cfg exists (a venv, whose purelib is in its own lib) and <dirname(python)>/pyvenv.cfg
 *   does not; the prefix is the path as written, not the real path;
 * - the version 3.N is confirmed three ways: the real python's name is python3.N, pyvenv.cfg's version (and version_info,
 *   when given) is 3.N or starts with 3.N. (see pyvenvVersions), and <prefix>/lib/python3.N is a folder;
 * - no Python start-up override (any PYTHON* key or __PYVENV_LAUNCHER__; see isPythonOverride) is set in the environment the
 *   check receives (the lookup's cliEnv removes them, so this guards direct callers).
 * The folder is then <prefix>/lib/python3.N/site-packages/azure-cli-extensions.
 */
async function defaultSystemFolder({ env, cwd }) {
  // for...in, as Node's spawn reads the environment (inherited keys included).
  for (const key in env) if (isPythonOverride(key) && env[key] !== undefined) return null;
  const launcher = await findAzLauncher({ env, cwd });
  if (!launcher) return null;
  let text;
  try {
    const file = await realpath(launcher);
    if ((await statOf(file)).size > 64 * 1024) return null;
    text = await readFile(file, 'latin1');
  } catch {
    return null;
  }
  if (text.includes('\r')) return null;
  const [shebang, ...rest] = text.split('\n');
  if (!LAUNCHER_SHEBANGS.has(shebang) || !(await interpreterStarts(shebang, { env, cwd }))) return null;
  const active = rest.filter(line => !/^[ \t]*$/.test(line) && !/^[ \t]*#/.test(line));
  if (active.length !== 1) return null;
  const match = LAUNCHER_LINE.exec(active[0]);
  if (!match) return null;
  const python = match[1];
  if (!/^python(?:3(?:\.\d+)?)?$/.test(pyBasename(python))) return null;
  let real;
  try {
    real = await realpath(python);
  } catch {
    return null;
  }
  const bin = pyDirname(python);
  const prefix = pyDirname(bin);
  if (!(await statOf(pyJoin(prefix, 'pyvenv.cfg'))) || (await statOf(pyJoin(bin, 'pyvenv.cfg')))) return null;
  // The version must be confirmed three ways: the real python's name, pyvenv.cfg and the lib folder.
  const named = /^python(3\.\d+)$/.exec(pyBasename(real));
  if (!named) return null;
  const [, version] = named;
  const recorded = await pyvenvVersions(pyJoin(prefix, 'pyvenv.cfg'));
  if (!recorded?.length || !recorded.every(value => value === version || value.startsWith(`${version}.`))) return null;
  const lib = pyJoin(pyJoin(prefix, 'lib'), `python${version}`);
  if (!(await statOf(lib))?.isDirectory()) return null;
  return pyJoin(pyJoin(lib, 'site-packages'), 'azure-cli-extensions');
}

/**
 * The `version` and `version_info` values in a venv's pyvenv.cfg, read as CPython's site.py reads the file: strict UTF-8,
 * universal newlines; for each line with an '=', the key is the text before the first '=', stripped and lower-cased, and the
 * value the text after it, stripped; a later line wins. Null when the file cannot be read or decoded, or is over 64 KiB.
 */
async function pyvenvVersions(file) {
  let text;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024) return null;
    text = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(file));
  } catch {
    return null;
  }
  const values = new Map();
  for (const line of text.split(/\r\n|\r|\n/)) {
    const at = line.indexOf('=');
    if (at < 0) continue;
    const key = pyStrip(line.slice(0, at)).toLowerCase();
    if (key === 'version' || key === 'version_info') values.set(key, pyStrip(line.slice(at + 1)));
  }
  return [...values.values()];
}

/** Python's glob.has_magic: a folder path with one of these is not modelled, since az globs inside it without escaping. */
const GLOB_MAGIC = /[*?[]/;

/**
 * Whether the extension folder `dir` holds azure-devops the way az's WheelExtension.get_all lists it, on the path exactly as
 * given (the file system resolves links and `..`): `dir` must be a folder (any stat failure means it holds nothing, as
 * os.path.isdir); it is then listed, and a listing failure is undetermined (os.listdir raises in az); the listing must hold
 * exactly the name azure-devops, which must be a folder whose listing has a name that does not start with a dot and matches
 * `*.*-info` (a failure to list it is no match, as glob gives).
 */
async function hasExtension(dir) {
  if (!(await statOf(dir))?.isDirectory()) return false;
  let names;
  try {
    names = await readdir(dir);
  } catch {
    throw undetermined(`${dir} cannot be listed`);
  }
  if (!names.includes('azure-devops')) return false;
  const extension = pyJoin(dir, 'azure-devops');
  if (!(await statOf(extension))?.isDirectory()) return false;
  try {
    return (await readdir(extension)).some(name => !name.startsWith('.') && /\..*-info$/s.test(name));
  } catch {
    return false;
  }
}

/**
 * Whether az, run with `env` from `cwd`, would list the azure-devops extension (WheelExtension.get_all in az 2.71), for setups
 * the check can model exactly; anything else throws (could not tell), so that a false "installed" is never given. Whether the
 * extension is compatible or loads is not checked: az then runs and fails, and the lookup reports that.
 * Scope: environment variables, config files, folders and launchers that a user or a tool could plausibly set up. Out of
 * scope: a bash, env or python binary that is not what it claims; changes to az's own installed files (.pth files,
 * sitecustomize, a modified azure-cli); dynamic-linker injection (LD_* and DYLD_* variables); files that change while the
 * check runs; and az failing at start-up because of a setting outside the extension settings.
 * - Folders: the user extension folder (AZURE_EXTENSION_DIR, else [extension] dir in the config file, else
 *   <AZURE_CONFIG_DIR, or ~/.azure when that is empty or unset>/cliextensions) and the system one (AZURE_EXTENSION_SYS_DIR,
 *   else [extension] sys_dir, else derived from a Homebrew-form launcher; see defaultSystemFolder).
 * - The config file is <AZURE_CONFIG_DIR>/config when that variable is set (even empty, then `config` in the child's
 *   folder), else ~/.azure/config; see readAzConfig for the files it refuses.
 * - HOME, when set in `env`, must start with '/'; when it is not set, the account's home folder must be readable. Otherwise
 *   could not tell: knack expands the config folder a second time, so a literal ~ or a relative HOME can make az read another
 *   config file. This is checked before any path is built; an absolute HOME is used as Python's expanduser uses it.
 * - Every setting az reads when it loads its extensions (dir, sys_dir, dev_sources) is resolved, and every folder path
 *   built, before any folder is checked. dev_sources set, `~name`, or a folder path with a glob character: could not tell.
 * - Paths are built as Python builds them (see pyJoin; relative ones from `cwd`, the child's folder, null being this
 *   process's) and passed to the file system unchanged, so links and `..` resolve as they do for az. Folders are listed as az
 *   lists them (see hasExtension).
 * Resolves true when the user folder or the system folder holds the extension, and false when neither does; both are listed
 * before any answer, as az lists both. Throws when the system folder is unknown, even when the user folder holds the
 * extension, and when either folder cannot be listed.
 * Read-only: it only stats, lists and reads files.
 */
export async function azureExtensionInstalled({ env = process.env, cwd = null } = {}) {
  // Checked once, before any path is built: knack expands the config folder a second time, so a HOME that is not absolute
  // (a literal ~, a relative path, an empty value) can make az read another config file; it is not modelled.
  if (env.HOME !== undefined) {
    if (!String(env.HOME).startsWith('/')) throw undetermined('HOME is not an absolute path');
  } else {
    try {
      userInfo();
    } catch {
      throw undetermined('HOME is not set and the account has no readable home folder');
    }
  }
  const base = cwd ?? process.cwd();
  const absolute = file => pyJoin(base, file);
  const azureDir = () => pyExpandUser('~/.azure', env);
  const configDir = env.AZURE_CONFIG_DIR !== undefined ? String(env.AZURE_CONFIG_DIR) : azureDir();
  const config = await readAzConfig(absolute(pyJoin(configDir, 'config')));
  // Every setting az reads when it loads its extensions is resolved before any folder is checked.
  if (rawExtensionSetting(env, config, 'dev_sources')) throw undetermined('dev_sources is set');
  const userDir = absolute(extensionSetting(env, config, 'dir') ?? pyJoin(env.AZURE_CONFIG_DIR || azureDir(), 'cliextensions'));
  const sysDir = extensionSetting(env, config, 'sys_dir');
  const systemDir = sysDir ? absolute(sysDir) : await defaultSystemFolder({ env, cwd: base });
  for (const dir of [userDir, systemDir]) if (dir !== null && GLOB_MAGIC.test(dir)) throw undetermined(`${dir} has a glob character`);
  // az lists both folders before it answers (WheelExtension.get_all), so an unknown system folder leaves the answer open even
  // when the user folder holds the extension, and a failure in either folder is a failure of the whole check.
  if (systemDir === null) throw undetermined("az's system extension folder is not known");
  const inUser = await hasExtension(userDir);
  const inSystem = await hasExtension(systemDir);
  return inUser || inSystem;
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
