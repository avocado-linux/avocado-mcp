export const URI = "avocado://skills/iterative-deployment";
export const NAME = "iterative-deployment";
export const DESCRIPTION =
  "How to push runtime changes to a device that's ALREADY running, without re-flashing media or re-provisioning. The `avocado deploy` command (shortcut for `avocado runtime deploy`) takes the user from edit → build → live device in seconds, by SSHing in and triggering an OTA-style update from a local HTTP server. Read this whenever the user has a running device and wants to test edits — and consider proactively offering this flow as the default iteration loop after `add-extension` / `add-runtime` / `add-package-to-extension`.";

export const CONTENT = `# Iterative deployment — push edits to a running device

## Prerequisite — the device MUST already be provisioned

\`avocado deploy\` is **sideloading**, not first-time setup. It pushes a runtime update over SSH + HTTP to an Avocado OS install that is already running. If the user hasn't flashed media and booted the device at least once, \`deploy\` cannot work — there is no OS for it to update.

**Before recommending or running \`avocado deploy\` (or the \`/build-and-deploy\` prompt), confirm with the user:**

> "Has this device already been provisioned with Avocado OS, or is this its first time? If it's been provisioned and you have its IP, I can sideload an iterative update. If it's never been provisioned, we need to do the first-time flash via \`/provision-device\` — that's the one-time setup with media (SD / USB / NVMe) and UART verification."

Route based on the answer:

| User's situation | What to do |
|---|---|
| Never provisioned this device | \`/provision-device\` first. Then come back to deploy. |
| Provisioned previously, device on the network, IP known | \`/build-and-deploy\` (this skill). |
| Provisioned previously, device not on the network / unreachable | Diagnose with \`/debug-device\` (UART) — sshd may have crashed, network may be down, /var may be full. Once reachable, resume deploy. |
| Not sure if it's been provisioned | Ask. Don't guess. If the device has never booted or you don't see Avocado OS logs on UART, it hasn't been provisioned. |

## What deploy actually is

\`avocado deploy\` is the fast iteration loop for an Avocado device that is **already running and on the network**. It's the difference between "edit, rebuild, re-flash an SD card, reboot, test" (minutes) and "edit, rebuild, push, test" (seconds).

**You — the coding agent — should proactively offer this as an option** whenever:
- The user is editing \`avocado.yaml\` (after \`add-extension\`, \`add-runtime\`, \`add-package-to-extension\`, or manual edits).
- The user has a device that's been provisioned at least once and is reachable.
- The user is in a dev loop (testing changes, not shipping to production).

Most users don't know this exists. Surface it.

## The iteration loop — build-first, install only when needed

\`avocado install\` is the slow part of the loop (package resolution, downloads). **Don't run it by default.** \`avocado build\` is fast and gives you a clear signal when install IS needed.

### For a human running these in their own terminal

\`\`\`bash
# (Optional) edit avocado.yaml, app sources, overlays, or hook scripts
avocado build
# → if it fails with a missing-package error, run \`avocado install -f\` then re-run build
avocado deploy -r dev -d 192.168.1.42
# → test on the device (UART or SSH)
\`\`\`

The default TUI gives the human nice progress bars and a status spinner.

### For an LLM running via the Bash tool (no terminal)

Use \`--no-tui\` + redirect-to-file + tail/grep slicing on every \`avocado\` call. The default TUI emits ANSI escapes that garble a captured log.

\`\`\`bash
# 1. (Optional) edit avocado.yaml, app sources, overlays, or hook scripts
# 2. Build — fast; tells you whether the existing install is still valid
avocado build --no-tui > /tmp/avocado-build.log 2>&1

#   If build SUCCEEDS → skip install, go straight to deploy.
#   If build FAILS with a missing-package / unresolved-extension signal:
#     → run install, then retry build:
#     avocado install -f --no-tui > /tmp/avocado-install.log 2>&1 \\
#       && avocado build --no-tui > /tmp/avocado-build.log 2>&1

# 3. Deploy — pushes updated images to the running device (no reflash)
avocado deploy -r dev -d 192.168.1.42 --no-tui

# 4. Test on the device (UART or SSH)
\`\`\`

**When does \`avocado build\` need a prior \`avocado install\`?** Only when the YAML has changed in a way that adds something to the SDK or extension package set:

| YAML change | Install needed before build? |
|---|---|
| Added a package under \`extensions.<name>.packages\` | **Yes** |
| Added an entirely new extension to \`extensions:\` | **Yes** |
| Added a package to \`sdk.packages\` | **Yes** |
| Changed \`distro.release\` or \`distro.channel\` | **Yes** |
| Pinned/unpinned a package or extension version | **Yes** |
| Edited app source (\`app/server.py\`, etc.) | No |
| Edited an overlay file (\`app/overlay/...\`) | No |
| Edited a hook script (\`app-compile.sh\`, \`app-install.sh\`) | No |
| Edited a systemd unit in \`app/overlay/usr/lib/systemd/system/\` | No |
| Tweaked an existing package's version in YAML | **Yes** |

The build-first approach handles both cases automatically: if the build doesn't need a new install, it just succeeds (fast). If it does, the failure cleanly tells you to install. Don't pay the install cost speculatively.

The user does NOT need to re-run \`avocado provision\` after the first time. \`provision\` is for first-time setup (flashing SD / USB / NVMe / tegraflash). \`deploy\` is the iterative path afterward.

### Signals that a build failure means "run install"

When parsing a failed \`avocado build\` log, these patterns indicate install (not source/code) is the fix:

- \`nothing provides X needed by Y\` — DNF/dependency resolution couldn't satisfy a package
- \`no package matching\` / \`package X not found\` — a referenced package isn't in the SDK
- \`unable to find a match: <name>\` — extension or package missing from the current install
- \`Error: extension <name> not found\` / similar — extension exists in YAML but isn't installed
- An explicit message from the CLI like "run avocado install first"

Any of those → run \`avocado install -f --no-tui\`, then retry \`avocado build --no-tui\`. Other build errors (compile failures, hook script errors, OOM, schema errors) are NOT install-fixable — pass them to \`explain-build-error\` instead.

## The command

\`\`\`
avocado deploy [OPTIONS] --device <DEVICE> [NAME]
\`\`\`

(\`avocado deploy\` is the top-level shortcut for \`avocado runtime deploy\`.)

| Arg / option | Purpose | Example |
|---|---|---|
| \`[NAME]\` (positional) OR \`-r <NAME>\` | Runtime name from \`avocado.yaml\`'s \`runtimes:\` map. Usually \`dev\`. | \`-r dev\` |
| \`-d, --device <[user@]host[:port]>\` | **Required.** Device address. Defaults: user \`root\`, port \`22\`. | \`-d 192.168.1.42\` or \`-d root@avocado-rpi5.local:22\` |
| \`-t, --target <TARGET>\` | Optional target override. Usually inferred from \`AVOCADO_TARGET\` env or \`default_target\` in YAML. | \`-t raspberrypi5\` |
| \`-C, --config <PATH>\` | Path to \`avocado.yaml\`. Default is the file in CWD. | \`-C ./avocado.yaml\` |
| \`--no-tui\` | Disable TUI output. Useful when running under a non-tty harness (CI, embedded shells). | |

**Common shapes you'll emit:**

\`\`\`bash
# IP-based, dev runtime
avocado deploy -r dev -d 192.168.1.42

# Hostname (mDNS), dev runtime
avocado deploy -r dev -d avocado-raspberrypi4.local

# Custom user + port (rare)
avocado deploy -r dev -d root@10.0.0.5:2222
\`\`\`

## How to read CLI results — collect from \`avocado\`, not from its internals

\`avocado install\`, \`avocado build\`, and \`avocado deploy\` are the orchestrators. Each one runs its work, captures the result, and prints the meaningful summary (success or specific error) to its own stdout/stderr. **That output is the contract.** Whatever internal mechanism the CLI uses to do the actual compile / package-resolve / deploy is an implementation detail you should not depend on.

Today the SDK runs inside a Docker container; that may change. Either way, the rule is the same: read what \`avocado\` prints, not what its internals do.

**Do**:
- Run \`avocado install -f\` (or \`build\`, or \`deploy\`) as a foreground Bash command.
- Wait for it to exit.
- Read the exit code and the output it printed. That is the result.
- Pipe failures into \`explain-build-error\` for cross-channel package lookup.

**Don't**:
- \`docker logs <container>\` — racy, noisy, and ordered against the wrong clock. Also brittle: it stops being available the moment the CLI's container backend changes.
- \`docker ps\` / \`docker exec\` to peek at the SDK container — implementation-detail surfaces.
- \`tail -f\` any host log file — Avocado doesn't write build progress there.
- Background the \`avocado\` command and try to peek at intermediate state before it finishes.

The only legitimate reason to inspect the host's container runtime directly is if \`avocado\` itself fails to *start* (the container backend is broken or absent — typically caught by \`environment-check\` first, not by log-tailing).

### Always pass \`--no-tui\` when collecting output

\`avocado install\`, \`avocado build\`, and \`avocado deploy\` default to a TUI: status spinners, screen redraws, ANSI escapes. That format is fine for a human watching a terminal but it turns a captured log file into garbage that \`grep\` and \`tail\` can't parse. **When you (the LLM) are capturing output to a file, always pass \`--no-tui\`.** It produces clean line-oriented stdout. Only omit it if a human is running the command directly in their own terminal.

### \`avocado provision\` needs a pseudo-TTY — wrap with \`script\`

This is a separate issue from \`--no-tui\` and **the most common reason \`avocado provision\` fails when an LLM runs it via Bash**:

\`\`\`
the input device is not a TTY
\`\`\`

\`avocado provision\` shells out to \`docker run -it\` internally — the \`-t\` flag requires a TTY allocated for the container. The Bash tool runs commands without a TTY, so the call fails immediately. **\`--no-tui\` does NOT fix this** — \`--no-tui\` only affects Avocado's own output rendering, not Docker's TTY requirement.

The fix is to wrap with \`script -q /dev/null\`, which provides a pseudo-TTY:

\`\`\`bash
script -q /dev/null avocado provision -r dev --no-tui > /tmp/avocado-provision.log 2>&1
\`\`\`

\`script\` is in coreutils on Linux and util-linux on macOS — it's almost always already installed. \`-q\` suppresses its banner; \`/dev/null\` discards its typescript file (we already have the redirect to \`/tmp/avocado-provision.log\`).

**Rule:** every \`avocado provision\` invocation you make from Bash needs the wrapper. \`avocado build\`, \`avocado install\`, \`avocado deploy\` do NOT need it (they don't shell out to \`docker run -it\` the same way).

### Filtering noise — required pattern for install/build

\`avocado install\` and \`avocado build\` produce hundreds of lines (package resolution, downloads, compile output). Loading all of that into context burns tokens. The required pattern:

\`\`\`bash
# Capture full output to a file; surface only the slices that matter.
avocado install -f --no-tui > /tmp/avocado-install.log 2>&1
RC=$?
echo "exit: $RC"
tail -40 /tmp/avocado-install.log
echo '---errors---'
grep -iE 'error|failed|nothing provides|broken' /tmp/avocado-install.log | tail -40 || true
\`\`\`

Same pattern for \`avocado build --no-tui > /tmp/avocado-build.log 2>&1\`. You load three small slices: the exit code, the last ~40 lines (where the success/failure summary lives), and any error-like lines. The full log stays on disk for \`explain-build-error\` to ingest if needed.

\`avocado deploy --no-tui\` is shorter (no SDK compile pass) so a plain run is usually fine — but the same redirect-to-file pattern is safe and recommended.

### Surface ✅/❌ status to the user after every step

After each \`avocado\` command finishes, **explicitly tell the user the outcome before running the next one.** A silent run that just summarizes at the end leaves the user not knowing whether to stay attentive or step away. One short line per step:

- \`✅ install succeeded\` / \`❌ install failed (exit N) — <top error>\`
- \`✅ build succeeded\` / \`❌ build failed (exit N) — <top error>\`
- \`✅ deploy succeeded — pushed runtime '<name>' to <device>\` / \`❌ deploy failed at <stage>: <error>\`
- \`✅ <unit> active on device\` / \`❌ <unit> failed: <reason>\`

If any step fails, stop. Don't paper over a failed install by trying to build; don't paper over a failed build by trying to deploy.

## What happens under the hood

When \`avocado deploy\` runs, the CLI:

1. **Computes artifact hashes** from the build output and generates signed TUF metadata for the runtime.
2. **Starts a local HTTP server** on the dev host that serves the update repository.
3. **SSHes into the device** (passwordless root in the \`dev\` runtime).
4. **Runs \`avocadoctl runtime add\`** on the device, pointing it at the local HTTP server. The device pulls only the changed extension images, verifies them against the signed metadata, and merges them via systemd-sysext / systemd-confext.
5. **Tears down** the HTTP server.

End result: the running device now has the updated extensions live, **without a reboot in most cases**. Some extension changes (kernel modules, certain systemd unit additions) may need a restart of the affected service or a reboot — the CLI flags this if so.

## Prerequisites

For \`avocado deploy\` to work:

- **The device must be reachable on the network** from the dev host. \`ping\` and \`ssh root@<host>\` must succeed.
- **The device must be running the \`dev\` runtime** (or any runtime that includes \`avocado-ext-sshd-dev\`). The runtime ships an sshd with a passwordless root login.
- **The dev host must be able to bind a local HTTP port** so the device can pull from it. If the user is on a corporate network with host-firewalled inbound, this fails.
- **The runtime named on \`-r\` must be defined in \`avocado.yaml\`** under \`runtimes:\`.

If any of these fail, \`avocado deploy\` errors out clearly and the user falls back to \`avocado provision\` + re-flash.

## When NOT to use \`avocado deploy\`

- **Device has never been provisioned.** First-time setup needs \`avocado provision\`, not \`deploy\`. There's no OS to update yet.
- **Device is not on the network.** No network = no fast path. Use UART to diagnose why first (\`avocado://skills/device-debugging\`).
- **Changes to the bootloader, kernel, or BSP packages.** These require a full re-flash. \`avocado deploy\` is for extension-level changes (your app, configs, services, runtime packages).
- **The user explicitly wants a clean wipe.** A provision starts from a known-good image; a deploy layers on top of whatever state the device is in.

## Proactively offering deploy after edits

After \`add-extension\`, \`add-runtime\`, \`add-package-to-extension\`, or any manual \`avocado.yaml\` edit, the typical next questions are: "did this build?" and "does it work on my device?" The deploy flow answers both in one short loop. Surface it like this:

> "I've added \`postgresql\` to the \`app\` extension. The next steps are \`avocado install -f && avocado build\`. If your device is already running and reachable (\`192.168.1.42\` from earlier in this conversation), you can push the change to it with \`avocado deploy -r dev -d 192.168.1.42\` — no reflash needed. Want me to run those for you?"

This turns a 5-minute reflash cycle into a 30-second push.

## Verification after deploy

After \`avocado deploy\` reports success, verify on the device. Use whatever channel you've already established:

\`\`\`bash
# Via the UART tmux session
tmux send-keys -t avocado-uart 'systemctl status my-app.service --no-pager -n 20' Enter
sleep 1
tmux capture-pane -t avocado-uart -p -S -100

# Or via SSH (once UART has confirmed device health)
ssh root@<host> 'rpm -q postgresql'
ssh root@<host> 'systemctl is-active my-app.service'
\`\`\`

For new packages: \`rpm -q <name>\` confirms install. For service changes: \`systemctl is-active\` or \`systemctl status\`.

## Comparison: provision vs deploy

| | \`avocado provision\` | \`avocado deploy\` |
|---|---|---|
| Purpose | First-time device setup; clean reflash | Iterative push of changes to running device |
| Output | Bootable image written to media (SD / USB / NVMe / eMMC) | OTA-style update applied via avocadoctl |
| Device state required | None (or media inserted) | Running, on network, sshd reachable |
| Speed | Minutes (full image write) | Seconds (delta push of changed extensions) |
| Reboot required | Yes (to boot into new image) | Usually no (sysext merges live) |
| When to use | First boot; bootloader/kernel/BSP changes; clean wipe | Every iteration after first provision |

If the user is doing dev iteration, \`deploy\` is almost always the right call. \`provision\` is the floor; \`deploy\` is the daily driver.

## When the SDK gets stuck — \`avocado clean\` / \`avocado prune\`

The SDK keeps a fair amount of state across runs: pulled container images, resolved package caches, build artifacts under \`/opt/_avocado/\`, and the project's named Docker volume. Most of the time this is what you want — it's what makes the build-first iteration loop fast. But it can also accumulate stale data that produces confusing failures:

- **"Disk full" / "No space left on device"** during build or install, even though the host has free space.
- **Stale extension or package state** after the user has manually edited the SDK container or rolled the channel back.
- **A build that worked last week and fails today** with no YAML change, often with errors that don't make sense given the current YAML.
- **A provision that times out partway through** and leaves half-written state behind.

In these cases — and ONLY in these cases — clearing SDK state is the right move:

**For a human running these in their own terminal:**

\`\`\`bash
avocado clean        # clear this project's SDK build artifacts + caches
avocado prune        # additionally remove the project's named Docker volume (heavier)
\`\`\`

**For an LLM running via the Bash tool:**

\`\`\`bash
avocado clean --no-tui > /tmp/avocado-clean.log 2>&1 && tail -20 /tmp/avocado-clean.log
\`\`\`

After cleaning, re-run \`avocado install -f && avocado build\` from scratch.

**Do NOT** run \`clean\` / \`prune\` reflexively — they discard the cache the iteration loop relies on, and the next build will be slow. They're a recovery tool, not part of the loop. If \`explain-build-error\` returns a curated diagnosis pointing at the YAML or a specific package, fix that instead.

\`avocado clean --help\` and \`avocado prune --help\` show the per-command options (e.g. \`--all\` to clear caches for every project on the host, not just CWD).
`;
