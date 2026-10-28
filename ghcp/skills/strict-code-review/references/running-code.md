# Running code from the change

Part of the `strict-code-review` skill. Read it with `SKILL.md`: every rule there still applies, including "Running code, network and credentials". Read this file before you run any code from the change: tests, scripts, builds or probes.

## When to run code

Run code only to settle a candidate that would be Must fix or Should fix and that reading can't settle. Use the smallest check that settles it, such as one test file or a probe script, not the full suite. If CI ran the same check at the head commit, use its result.

Running code from the change runs code that the change's author controls, so it happens only in the way this file describes. If you have no head commit to export (a pasted diff, or a GitHub PR read without a clone), don't run code from the change. If a command can't work within these limits, don't run it; say so under `Not verified`.

Decide early whether the check can run. An exported copy has no installed dependencies, build output or virtual environment (no `node_modules`, no `.venv`). If the check needs them and the user hasn't allowed installs, don't export or try: say under `Not verified` what you didn't run and why.

## Export the head commit

Run code only in an exported copy of the head commit inside your scratch directory. Write the archive to a file, then extract it, and check that each command succeeds; piping `git archive` into `tar` can end in a false SIGPIPE failure. Start the code with an empty environment and with `HOME` inside scratch, so that it gets no tokens from environment variables and keeps its configuration and caches in scratch. Add any other variable the command needs, but never a token, a key or your real home directory.

```bash
mkdir -p <SCRATCH_DIR>/head <SCRATCH_DIR>/home <SCRATCH_DIR>/tmp
git archive --format=tar --output=<SCRATCH_DIR>/head.tar <HEAD_SHA>
tar -x -f <SCRATCH_DIR>/head.tar -C <SCRATCH_DIR>/head
cd <SCRATCH_DIR>/head && env -i PATH="$PATH" HOME=<SCRATCH_DIR>/home TMPDIR=<SCRATCH_DIR>/tmp <command>
```

This protects the user's checkout and your environment variables, but it is not a sandbox. The code can still read files by absolute path, including in your real home directory, follow symbolic links out of the copy, and use the network.

You may edit files in scratch to check a finding or a fix. Before a probe that may write outside its target folder, work out each path it will write to, after resolving `../`, absolute paths and symbolic links, and check that every one is inside scratch. Nesting the target folder doesn't contain an escape. If you can't establish that, don't run the probe.

## What the user can allow

By default you install nothing and the code uses no network. Each exception needs permission in the user's request, and a permission covers only what it names:

- **Installing dependencies:** only if the user allows installs or says that the code is trusted. The install may download what it installs. Install only into scratch (the exported copy's `node_modules`), never globally. Follow "Installing dependencies" below.
- **Network use by the code you run:** only if the user allows network access or says that the code is trusted.
- **Documentation sites and web searches:** only if the user allows network access.

So permission to install does not let the code use the network, permission for network access does not allow installs, and a statement that the code is trusted does not allow documentation sites or web searches.

## Installing dependencies

Use this only when the user allows installs.

1. If the change edits package-manager configuration (a project `.npmrc`, or a registry setting in `package.json`), don't install. Say so under `Not verified`.
2. Make a separate install HOME in scratch, for example `<SCRATCH_DIR>/install-home`. If the package manager needs registry, proxy or certificate settings from the user's configuration to reach its registry (for example `registry`, `proxy`, `https-proxy` or `cafile` in `~/.npmrc`), copy only those lines into the same file under the install HOME.
3. Never copy sign-in data: auth lines and tokens (`_auth`, `_authToken`, `_password`, `username`, `password`, any `//<host>/:` line), or a proxy or registry URL that contains credentials (`https://<user>:<secret>@...`). If the registry needs them, don't install. If the proxy is set in environment variables instead (`HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`), pass them to the install command only, and only when they contain no credentials.
4. A private feed that needs the user's sign-in (for example, an authenticated npm feed) is not installed. Say under `Not verified` that the install needs sign-in.
5. Install only with npm, from the lockfile, into the exported copy, with lifecycle scripts turned off:

   ```bash
   cd <SCRATCH_DIR>/head && env -i PATH="$PATH" HOME=<SCRATCH_DIR>/install-home TMPDIR=<SCRATCH_DIR>/tmp npm ci --ignore-scripts
   ```

   `--ignore-scripts` stops the lifecycle scripts of the package and its registry dependencies, but the install still runs code that the change controls: for example, a Git dependency's build step may still run. Treat the install as running the change's code: the same scratch location, the empty environment, no tokens, and the same warning that this is not a sandbox. Don't install with other package managers. If the check needs another package manager, or the install fails, say so under `Not verified`.
6. Run the code with the clean scratch HOME from "Export the head commit", not with the install HOME.

## Report

List under `Code run` every command that ran code from the change, including installs: the command, where it ran, and its result. List under `Not verified` what you didn't run and why.
