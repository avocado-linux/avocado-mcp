import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Pre-built workflows the user can invoke by name from their MCP client.
 * Each prompt returns a message sequence that orients Claude to use the
 * MCP's tools in the right order — these are essentially "macros" for the
 * common flows.
 */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    "debug-device",
    "Debug a running Avocado OS device. **Always starts with UART over a tmux-driven serial session.** SSH is a fallback for steady-state work after UART confirms the device is healthy enough to use it. Do NOT skip UART because the user mentioned an IP — an IP only means the device claimed to be on the network, not that it booted cleanly or that services are healthy.",
    {
      target: z
        .string()
        .optional()
        .describe(
          "Target name the user is debugging (e.g. 'raspberrypi5'). If unknown, ask the user before running.",
        ),
      symptom: z
        .string()
        .optional()
        .describe(
          "What's broken or unexpected, in the user's own words. Helps Claude prioritise which diagnostic commands to run first.",
        ),
    },
    ({ target, symptom }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Help me debug my Avocado OS device.${target ? ` Target: \`${target}\`.` : ""}${symptom ? ` Symptom: ${symptom}.` : ""}`,
              "",
              "**Critical rule — read first:** UART is the default debug channel. Even if I mentioned an IP, an SSH session, or a `journalctl` snippet, **start with UART**. SSH is unsafe to rely on for diagnostics — it requires the device to have booted AND networking to be up AND sshd to be running AND DNS/route to be sane. Any of those can be the bug you're trying to diagnose. UART shows you the truth from boot onward. Only switch to SSH if I explicitly opt out of UART, or after UART has confirmed the device is healthy enough that SSH is reliable.",
              "",
              "**Serial parameters are canonical, not negotiable.** 115200 baud, 8N1, no flow control is the default for every Avocado target. `get-device-connection-info` returns the exact values and any per-target caveats. Do NOT ask me to confirm baud/parity/data-bits — read the tool output and use it directly.",
              "",
              "**Login handling on a fresh UART session.** If `tmux capture-pane` shows a `login:` prompt, send `root` then Enter — the `dev` runtime has a passwordless root account. If you already see a `#` prompt, you're in; don't re-login. Do NOT send diagnostic commands before checking for a login prompt — they'll be typed as the username and fail.",
              "",
              "**Conserve tokens aggressively when reading from the UART session.** Every captured line costs context. Strict rules:",
              "  - **Always bound `journalctl`** with `--no-pager` AND a tail/since constraint. `journalctl -xeu my-app.service --no-pager | tail -50` or `journalctl -p err -b --no-pager --since '5 min ago'`. Never run unbounded.",
              "  - **Always bound `dmesg`** with `| tail -30` (or `| grep -i error | tail -20` if symptom-targeted).",
              "  - **Pipe through `grep` whenever you know what you're looking for.** `grep -i 'failed\\|error\\|denied'` beats reading the whole log.",
              "  - **`tmux capture-pane -S -200` is the default scrollback window.** Only go higher if you specifically need earlier output and know how many lines back. Don't reflexively use `-S -5000`.",
              "  - **Never run interactive commands.** No `vi`, `nano`, `htop`, `top`, `less`. They don't return. Use `top -bn1 | head -20` if you need a process snapshot.",
              "  - **Use `systemctl status <unit> --no-pager -n 20`** to cap the log tail systemctl includes.",
              "  - **Don't `cat` large files.** Use `head -N`, `tail -N`, or `grep <pattern>`.",
              "  - **Don't `ls -R` or `find /`.** Target a specific directory.",
              "  - **Never use `sleep N` with N ≥ 10 to wait for slow things** (boot, service start, long commands). Claude Code blocks long sleeps. Use an `until`-loop on a real condition: `until tmux capture-pane -t avocado-uart -p -S -50 | grep -qE 'login:|root@|# $'; do sleep 2; done`. If the Monitor tool is available, run the loop through it so you're notified on exit instead of blocking a turn. Short `sleep 1` / `sleep 2` between send-keys and capture is fine (synchronization beat, not a wait).",
              "",
              "Please follow this flow:",
              "",
              "1. Read the `avocado://skills/device-debugging` resource (UART-first rationale + when SSH is appropriate).",
              "2. Read `avocado://skills/tmux-uart-bridge` for the exact tmux-over-emulator pattern.",
              "3. Read `avocado://skills/avocado-runtime-details` so you know what tools the device actually has (BusyBox vs GNU, systemd is full, etc.).",
              "4. Call `detect-serial-ports`. This returns BOTH the candidate ports AND which serial terminal emulators (`tio`, `picocom`, `minicom`) are installed. If none is installed, stop and ask me to install one (recommend `tio`) — tmux alone cannot talk to a serial device.",
              "5. Call `get-device-connection-info` to get the target's exact serial parameters (baud, voltage, pinout) and credentials. Use these as-is.",
              "6. Call `get-tmux-uart-snippet` with the chosen `emulator` (preference tio > picocom > minicom) and run the returned `tmux new-session` command in Bash to bridge the console.",
              "7. Send the standard diagnostic battery into the session and capture results: `systemctl --failed`, `systemctl status <suspect-unit> --no-pager -n 30`, `journalctl -xeu <suspect-unit> --no-pager -b | tail -100`, `journalctl -p err -b --no-pager | tail -50`, `dmesg --color=never | tail -30`, and anything tailored to the symptom.",
              "8. **If on-device logs don't explain the symptom, iterate on the project itself.** You have full edit access to the app source under `app/` in the user's project. Common moves: escalate log level to DEBUG (Python `logging.basicConfig`, Rust `RUST_LOG=debug` via the systemd unit, Node `LOG_LEVEL=debug`), add targeted log statements at suspect lines, or change the systemd unit's `ExecStart` to pass `--verbose`. Then rebuild + redeploy with the `/build-and-deploy` prompt (or invoke `avocado build` then `avocado deploy -r dev -d <ip>` directly per `avocado://skills/avocado-cli-execution`), restart the unit on the device, reproduce the symptom, and re-read the logs. See `avocado://skills/device-debugging` for per-language recipes. **Always clean up debug logging** before declaring the fix done.",
              "9. **Only after** the above confirms the device is reachable + healthy enough, AND if I want more comfortable interactive work, switch to SSH (`ssh root@<host> '<command>'` via Bash directly — no MCP tool needed).",
              "",
              "Summarise findings clearly, with next-step suggestions, after running the diagnostics. If you added debug logging during the session, note what you added and where so I can review or revert.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "debug-build-failure",
    "Recover from a failed `avocado install` or `avocado build`. Walks you through log-pattern analysis, cross-channel package lookup, hook-script triage, and host/arch checks.",
    {
      target: z
        .string()
        .optional()
        .describe(
          "Target the user was building for (e.g. 'jetson-orin-nano-devkit'). Strongly recommended — unlocks cross-channel package lookup.",
        ),
      log: z
        .string()
        .optional()
        .describe(
          "Full build/install log output, verbatim if available. If absent, the LLM should ask the user to paste it.",
        ),
    },
    ({ target, log }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `My \`avocado install\` / \`avocado build\` failed.${target ? ` Target: \`${target}\`.` : ""}${log ? "" : " I'll paste the log when you ask."}`,
              "",
              "Please walk me through recovery:",
              "",
              "1. If I haven't pasted the log yet, ask for it now. **If I have output from a recent failed run, use what already exists** — don't re-run `avocado install` / `avocado build` just to capture output; they're slow and noisy. Where to look depends on the execution channel (see `avocado://skills/avocado-cli-execution`): on the `bash` channel, read `/tmp/avocado-install.log` / `/tmp/avocado-build.log` with `Read` or `tail -200`; on the `host-tool` channel, call `avocado_cli_status` with the most-recent `run_id` (bump `tailLines` if needed). If neither is available, ask me to paste the log.",
              "2. Call `explain-build-error` with the log AND `targets` set to mine. The tool will: (a) match against pattern fingerprints, (b) extract failing package names and look them up on the `edge` channel of both releases (`2024` and `2026`) — the streams almost everyone is on.",
              "3. **If the result includes any `Hook script:` pattern, branch HERE — this is a user-code failure, not an Avocado bug.** Read `avocado://skills/extension-build-debugging`. Then: (a) Read the failing hook file (path is in the error) at the indicated line. (b) Call `get-reference-file` on a closely related reference's same hook (e.g. `python-flask/app-install.sh`) to compare patterns. (c) Apply the fix from the skill's failure-mode table. Do NOT continue with SDK / cross-channel investigation — those don't apply to hook failures.",
              "4. If the package investigation shows the package present on one-or-more streams AND the log mentions `libc` / `GLIBC` / SONAMEs, this points at host-arch / arch-metadata. Run `uname -m` and `sw_vers` (or `lsb_release -a`) via Bash to capture my host details, then advise on host swap (e.g. x86_64 Linux for aarch64-broken paths).",
              "5. If the investigation shows the package is present on the other release's `edge` (e.g. on `2026/edge` but not `2024/edge`), tell me to set `distro.release` in `avocado.yaml` to match that release and re-run `avocado install` — newer hardware/packages often live only on `2026`.",
              "6. If everything is inconclusive, summarise what you ruled out, what you'd need next (e.g. the full log, the failing extension's source), and suggest filing a bug.",
              "",
              log ? `\nHere is the log:\n\n\`\`\`\n${log}\n\`\`\`` : "",
            ]
              .filter((s) => s !== "")
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "build-and-deploy",
    "Build the current Avocado OS project and push it to a running device — fully automated. Optimised loop: tries `avocado build` first; only falls back to `avocado install -f` if the build fails with a missing-package signal. Then `avocado deploy -r <runtime> -d <device>` and on-device verification. This is the canonical iteration loop after the first provision; the user shouldn't need to copy-paste commands.",
    {
      device: z
        .string()
        .optional()
        .describe(
          "Device address as `[user@]host[:port]` (e.g. '192.168.1.42', 'root@avocado-rpi5.local', '10.0.0.5:2222'). If omitted, ask the user before proceeding.",
        ),
      runtime: z
        .string()
        .optional()
        .describe(
          "Runtime name from `avocado.yaml`'s `runtimes:` map. Defaults to 'dev' if not provided. Inspect the YAML to confirm the runtime exists before running.",
        ),
      target: z
        .string()
        .optional()
        .describe(
          "Target architecture override. Usually inferred from `default_target` in the YAML or the `AVOCADO_TARGET` env var; only pass this if you need to override.",
        ),
      forceInstall: z
        .string()
        .optional()
        .describe(
          "Pass 'true' to run `avocado install -f` unconditionally before building. Default behaviour (any other value, or omitted): try `avocado build` first and only run install if the build fails with a signal that install is needed (missing package, unresolved extension). Set 'true' when you KNOW the user has just edited the YAML to add packages/extensions and want to short-circuit the build-fail-retry roundtrip.",
        ),
    },
    ({ device, runtime, target, forceInstall: forceInstallStr }) => {
      const forceInstall = forceInstallStr === "true";
      const r = runtime ?? "dev";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Build and deploy my Avocado OS project to ${device ? `\`${device}\`` : "my device"}.${target ? ` Target override: \`${target}\`.` : ""}`,
                "",
                "**Do this fully automated** — don't just print commands for me to run. Execute each step yourself and report progress between them.",
                "",
                "**See it through. Don't hand back mid-flow.** install / build / provision are slow (minutes; provision flash writes can take 10-30 min). **Drive the wait with `await_avocado_cli`** — kick off the run, then call `await_avocado_cli` with the returned `run_id`; the host blocks the response until the run actually finishes and wakes the call within milliseconds of process exit. If the response has `timedOut: true` (run still going after 240s), loop the await. Use `avocado_cli_status` only for one-shot snapshots, never as a wait. Pivot to `schedule_task` only for genuinely long flashes (you've already awaited ~10 minutes and the output makes clear it's still going). See `avocado://skills/avocado-cli-execution` for the full pattern. **Never** end your turn with \"ping me when it's done\" without either (a) being inside an active `await_avocado_cli` call, or (b) having scheduled a follow-up.",
                "",
                "**Set your execution channel before the first `avocado` call.** Call `environment-check` once this session if you haven't already — its **Execution channel** section says whether to invoke `avocado <args>` via the host MCP's `run_avocado_cli` tool (host-tool channel) or via your Bash tool (bash channel). Read `avocado://skills/avocado-cli-execution` for the contract of both channels: exact tool arguments, where output lives, how to poll, status reporting, log-path conventions. **Stick with the selected channel for the rest of this prompt** — don't mix.",
                "",
                "**Collect and filter the `avocado` CLI's own output. Do not inspect its internals.** The `avocado` CLI (`install` / `build` / `deploy`) is the orchestrator and the single source of truth for what happened: it prints the meaningful result — success, failure, specific package errors — to its own stdout/stderr. Run the command, wait for it to exit, and read the exit code + what it printed. Whatever internal mechanism the CLI uses to do the work (today: a Docker SDK container; in the future: possibly something else) is an implementation detail that's NOT part of your contract with it. Never try to peek into the SDK container, never tail Docker logs, never `docker logs` / `docker ps` / `docker exec` to second-guess the CLI. Those approaches are racy, noisy, and will break when the implementation changes.",
                "",
                "1. **Confirm the device has already been provisioned.** `avocado deploy` is sideloading — it pushes a runtime update OVER an existing Avocado OS install via SSH + HTTP. It does NOT do first-time setup. If I haven't done a first-time provision (flash to SD/USB/NVMe via `avocado provision`, with the device booted at least once), STOP and tell me: _\"It looks like this device hasn't been provisioned yet. Deploy is the iterative path — it requires the device to already be running Avocado OS and reachable over SSH. Use the `/provision-device` prompt first to flash the device, then come back here to deploy iteration updates.\"_ Don't proceed with deploy until I confirm the device has been provisioned at least once.",
                "2. Read `avocado://skills/iterative-deployment` for the full mechanics if you haven't already.",
                device
                  ? `3. Confirm the device at \`${device}\` is reachable: \`ping -c 1\` (timeout 2s) and \`ssh -o ConnectTimeout=5 -o BatchMode=yes root@${device.replace(/^[^@]+@/, "").replace(/:.*$/, "")} true\` (the second one is the load-bearing check — \`avocado deploy\` needs sshd). If unreachable, stop and tell me what failed; **a network-unreachable device is also a signal it might not be provisioned** — ask me to confirm.`
                  : `3. Ask me for the device IP / hostname if I haven't provided one. Then confirm it's reachable: \`ping -c 1\` (timeout 2s) and \`ssh -o ConnectTimeout=5 -o BatchMode=yes root@<host> true\`. If unreachable, stop — and check whether the device has been provisioned at all.`,
                `4. Verify the project's \`avocado.yaml\` exists and that the \`${r}\` runtime is declared under \`runtimes:\` (use \`list-yaml-extensions\` or read the file directly). If the runtime isn't there, ask me which runtime to use.`,
                forceInstall
                  ? `5. **Install forced.** Invoke \`avocado install -f\` per \`avocado://skills/avocado-cli-execution\`. Status: \`✅ install succeeded\` or \`❌ install failed (exit N)\`. If failed, surface the top errors, pass the output to \`explain-build-error\` with my target, and STOP.`
                  : `5. **Skip install — start with build.** \`avocado install\` is the slow part of the loop and is NOT needed when only source files / overlays / hook scripts have changed. The default is to skip it. Only run install if step 6 (build) tells us it's needed.`,
                `6. Invoke \`avocado build\` per \`avocado://skills/avocado-cli-execution\`. Status: \`✅ build succeeded — image at <path if shown>\` or \`❌ build failed (exit N)\`.

   **If build failed, decide:** does the captured error look like a missing-package / unresolved-extension / "needs install" signal? Specifically: \`nothing provides X\`, \`no package matching\`, \`package X not found\`, \`unable to find a match\`, or an explicit CLI message asking the user to run \`avocado install\`?

   - **If yes (install needed):** tell me \`🔄 build failed because of a missing dependency — running install and retrying\`, then invoke \`avocado install -f\` (same channel). Report install ✅/❌. If install succeeded, re-run \`avocado build\` and report build ✅/❌ again. If the retried build still fails, surface to \`explain-build-error\` and STOP — don't proceed to deploy.
   - **If no (real build error):** pass the output to \`explain-build-error\` with my target and STOP — running install won't help. Don't proceed to deploy.`,
                `7. Invoke \`avocado deploy -r ${r} ${device ? `-d ${device}` : "-d <device>"}${target ? ` -t ${target}` : ""}\` per \`avocado://skills/avocado-cli-execution\`. The deploy is staged via a local HTTP server and SSH-triggered on the device. Status: \`✅ deploy succeeded — pushed runtime '${r}' to <device>\` or \`❌ deploy failed (exit N)\`. If it failed mid-stream, name the stage that failed (TUF metadata generation, HTTP server bind, SSH to device, \`avocadoctl runtime add\` on device).`,
                `8. **Verify on the device.** Use whatever channel is already established (UART tmux session or SSH). Targeted check: \`systemctl is-active <relevant-unit>\`, \`rpm -q <newly-added-package>\`, or whatever fits the change just deployed. Bound your output (\`--no-pager -n 20\`, \`| tail -20\`) per the token-discipline rules in \`avocado://skills/tmux-uart-bridge\`. Status: \`✅ <unit> active\` / \`❌ <unit> failed: <reason>\`.`,
                `9. Final summary paragraph: confirm build ✅/❌ (and install ✅/❌ if it was run), deploy ✅/❌, on-device verification ✅/❌. Call out anything I should test manually next.`,
                "",
                "**Status reporting is not optional.** After every \`avocado\` command (install, build, deploy), and after on-device verification, surface a one-line ✅/❌ status before moving on. I'm watching for these to know whether to stay attentive or step away. A silent run that just ends with a summary at step 9 is a regression.",
                "",
                "**Failure handling:** stop at the first failed step. Don't paper over an install failure by deploying anyway; don't paper over a deploy failure by claiming success. If something breaks, surface the actual error and the diagnostic tool to use next.",
              ]
                .filter((s) => s !== "")
                .join("\n"),
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "debug-device-ssh",
    "Debug a running Avocado OS device over SSH. **Use only when the device is already known healthy and on the network** — `/debug-device` (UART) is the default and is the only safe channel for pre-boot, pre-network, or sshd-related symptoms. The `dev` runtime ships a passwordless root account, so `ssh root@<host>` works without keys or prompts. Multi-command flows, file inspection, and steady-state log scans are all easier here than over UART.",
    {
      device: z
        .string()
        .optional()
        .describe(
          "Device address as `[user@]host[:port]` (e.g. '192.168.1.42', 'root@avocado-rpi5.local', '10.0.0.5:2222'). User defaults to `root` (passwordless in dev runtime). If omitted, ask the user before proceeding.",
        ),
      symptom: z
        .string()
        .optional()
        .describe(
          "What's broken or unexpected, in the user's own words. Helps prioritise which diagnostics to run.",
        ),
    },
    ({ device, symptom }) => {
      const host = device
        ? device.replace(/^[^@]+@/, "").replace(/:.*$/, "")
        : "<host>";
      const sshTarget = device ?? "root@<host>";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Help me debug my Avocado OS device over SSH${device ? ` (\`${device}\`)` : ""}.${symptom ? ` Symptom: ${symptom}.` : ""}`,
                "",
                "**When SSH is appropriate vs when to switch to UART.** SSH is safe when the device booted cleanly, networking is up, and sshd is running. Use it for steady-state work: long log scans, multi-command flows, file inspection, `scp`. **Switch to `/debug-device` (UART) if any of these are part of the symptom you're investigating:** the device won't boot, network is flaky, services crash at startup, sshd itself is unreliable. SSH requires the very thing those bugs break.",
                "",
                "**Passwordless root.** The `dev` runtime ships `avocado-ext-sshd-dev` with a passwordless root account. `ssh root@<host>` should connect without keys or prompts. If a password prompt appears, the device isn't running the dev runtime — stop and tell me.",
                "",
                "**Conserve tokens — same discipline as UART.** Every line you bring back into context costs. Strict rules:",
                "  - **Always bound `journalctl`** with `--no-pager` AND a tail/since constraint. Never run unbounded.",
                "  - **Always bound `dmesg`** with `| tail -30` (or `| grep -i error | tail -20`).",
                "  - **Pipe through `grep`** whenever you know what you're looking for.",
                "  - **Use `systemctl status <unit> --no-pager -n 20`** to cap the included log tail.",
                "  - **Don't `cat` large files** or `ls -R`/`find /`. Target specific paths.",
                "  - **Never run interactive commands** (`vi`, `nano`, `htop`, `top`, `less`) — they hang the ssh call. Use `top -bn1 | head -20` for a one-shot process snapshot.",
                "",
                "Please follow this flow:",
                "",
                `1. **Verify reachability** before any diagnostics: \`ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new ${sshTarget} true\`. Status: \`✅ ssh ok\` or \`❌ ssh unreachable: <reason>\`. If unreachable, STOP — switch to \`/debug-device\` (UART) to figure out why the device isn't on the network.`,
                "2. Read `avocado://skills/device-debugging` (for the diagnostic battery + closed-loop debug cycle) and `avocado://skills/avocado-runtime-details` (so you know what tools exist on the device — BusyBox vs GNU quirks).",
                `3. **Diagnostic battery** — run each as a separate \`ssh\` call so each command's output stays contained. Use this template:`,
                "",
                "```bash",
                `ssh ${sshTarget} 'systemctl --failed --no-pager'`,
                `ssh ${sshTarget} 'systemctl status <suspect-unit> --no-pager -n 30'   # tailor to symptom`,
                `ssh ${sshTarget} 'journalctl -xeu <suspect-unit> --no-pager -b | tail -100'`,
                `ssh ${sshTarget} 'journalctl -p err -b --no-pager | tail -50'`,
                `ssh ${sshTarget} 'dmesg --color=never | tail -50'`,
                `ssh ${sshTarget} 'ip a; ip r'                                          # if networking is the symptom`,
                "```",
                "",
                "4. **If on-device logs don't explain the symptom**, iterate on the project itself: add log statements / bump log level / change the systemd unit's `Environment=`, then run `/build-and-deploy` with my device address to push the change. Re-run the relevant `ssh` diagnostic. See `avocado://skills/device-debugging` for per-language logging recipes. **Clean up debug logging before declaring the fix done.**",
                "5. **If the symptom shifts to sshd / network / boot during the session** (commands start hanging, ssh reconnects fail, services that worked stop responding), switch to `/debug-device` (UART). SSH is no longer trustworthy. Don't try to diagnose sshd over sshd.",
                "6. **Summarise findings** with `✅` / `❌` per check and propose next steps. If you added debug logging during the session, note what you added and where so I can review or revert.",
                "",
                "**Status reporting after each diagnostic** (not just at the end). One short line: `✅ <unit> active` / `❌ <unit> failed: <reason>` / `⚠️ <unit> degraded — 12 restarts in last 10 min`.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "provision-device",
    "First-time flash of an Avocado OS device — fully automated except for the physical handoff. Verifies host environment, validates target, looks up the per-target provisioning profile + caveats, runs `avocado build`, runs `avocado provision`, and walks the user through power-on + initial UART verification. Use this BEFORE `/build-and-deploy` (which assumes the device is already running). After first provision, switch to `/build-and-deploy` for the iteration loop.",
    {
      target: z
        .string()
        .optional()
        .describe(
          "Target name (e.g. 'raspberrypi5', 'jetson-orin-nano-devkit', 'qemuarm64'). If omitted, the prompt will ask before proceeding. Must match an entry from `list-targets`.",
        ),
      runtime: z
        .string()
        .optional()
        .describe(
          "Runtime name from `avocado.yaml`'s `runtimes:` map. Defaults to 'dev' (the runtime that ships passwordless root + SSH + UART debug tooling).",
        ),
    },
    ({ target, runtime }) => {
      const r = runtime ?? "dev";
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `Provision my Avocado OS device for the first time${target ? ` (target: \`${target}\`)` : ""}. This is the initial flash, not an iterative deploy.`,
                "",
                "**Do this fully automated** — run each step via Bash and report progress between them. The only manual steps will be the physical handoffs (inserting media, putting the device in recovery mode, powering on). When those moments come up, STOP and tell me exactly what to do.",
                "",
                "**Collect and filter the `avocado` CLI's own output. Do not inspect its internals.** The CLI is the source of truth for what happened; whatever container/build mechanism it uses is an implementation detail. Run `avocado` commands as foreground Bash commands and read their stdout/stderr/exit code.",
                "",
                "**Always pass `--no-tui`** to `avocado build` and `avocado provision` when running under Bash with captured output — the default TUI renders ANSI escapes that garble captured log files.",
                "",
                "**`avocado provision` needs a TTY.** It shells out to `docker run -it` internally, which fails under a non-TTY harness with `the input device is not a TTY`. Wrap it with `script -q /dev/null` to give it a pseudo-TTY: `script -q /dev/null avocado provision ... --no-tui`. This is required when you (the LLM) are running it via Bash. If a human is running it directly in a terminal, the wrap is unnecessary.",
                "",
                "**Filter the noise** — `avocado build` and `avocado provision` are extremely verbose. Use this pattern:",
                "",
                "```bash",
                "# Capture full output to a file, surface only what matters",
                "<command> > /tmp/avocado-<step>.log 2>&1",
                "RC=$?",
                'echo "exit: $RC"',
                "tail -40 /tmp/avocado-<step>.log",
                "echo '---errors---'",
                "grep -iE 'error|failed|nothing provides|broken' /tmp/avocado-<step>.log | tail -40 || true",
                "```",
                "",
                "**Status reporting is not optional.** After every `avocado` command (build, provision), surface a one-line `✅` / `❌` to me before moving on. Don't go silent.",
                "",
                "Please follow this flow:",
                "",
                "1. Read `avocado://skills/getting-started` if you haven't already, then `avocado://skills/device-debugging` (for the UART-USB requirement) and `avocado://skills/filesystem-model` (so I understand what gets flashed vs what's runtime-writable).",
                "2. Call `environment-check` to make sure that I have the `avocado` CLI, a working container engine, and ≥8 GB free disk. On macOS and Windows, the container engine is the avocado-vm and Docker Desktop is not required. On Linux, it is the native Docker Engine. For more information, see `avocado://skills/container-backend`. If something is missing, show the fix and STOP.",
                target
                  ? `3. Confirm \`${target}\` is a supported target via \`list-targets({ query: "${target}" })\`. If it doesn't appear, STOP — don't try to substitute.`
                  : `3. Ask me what target I'm provisioning. Use \`list-targets({ query: "..." })\` to confirm the slug is canonical. Only proceed once we agree on a supported target.`,
                `4. Call \`get-provisioning-steps\` with the chosen target. This returns the provisioning profile (\`sd\` / \`usb\` / \`tegraflash\` / \`default\`), the media required, the host-OS constraints (Jetson needs Linux), and per-target caveats (Linux auto-mount, Jetson recovery mode, x86 RS-232 voltage levels, etc.). **Read every caveat aloud to me before going further** — these are the gotchas that brick boards.`,
                "5. **Pre-flight check — STOP and ask me to confirm each of these before any flashing:**",
                "   - **UART-USB adapter wired into the device's debug UART** (3.3V TTL for most; x86 may need RS-232; QEMU exempt). Without it I can't see boot output or recover from failures.",
                "   - **Media on hand** if the profile needs it (microSD / USB / NVMe — `get-provisioning-steps` tells you which).",
                "   - **Host OS compatible** with the profile (tegraflash → Linux only; auto-mount disabled on Linux desktops; macOS works for SD/USB but never for tegraflash).",
                "   - **Device in the right state** for the profile (Jetson: recovery mode with FC REC shorted to GND, USB-C connected; x86: BIOS set to boot from the chosen media; SD-card targets: card NOT yet inserted into target).",
                "   - For QEMU targets: none of the above — the VM runs on this host.",
                `6. Verify the project's \`avocado.yaml\` exists in CWD and that the \`${r}\` runtime is declared. If not, ask me which runtime to use.`,
                `7. Run \`avocado build --no-tui\` with the redirect-to-file pattern above. Status: \`✅ build succeeded\` or \`❌ build failed (exit N)\`. **If build failed because of a missing-package / unresolved-extension signal** (\`nothing provides\`, \`no package matching\`, \`unable to find a match\`), tell me \`🔄 build failed because of a missing dependency — running install and retrying\`, then run \`avocado install -f --no-tui\` and retry build. **If real build error** (compile / hook / OOM / schema), pass log to \`explain-build-error\` and STOP. Don't proceed to provision if build failed.`,
                `8. Run the provision command. Look up the exact invocation from \`get-provisioning-steps\` — it varies by target (\`avocado provision -r ${r}\` for default, \`avocado provision -r ${r} --profile sd\` for SD-card targets, etc.). Wrap with \`script\` and capture: \`script -q /dev/null avocado provision -r ${r} [--profile <prof>] --no-tui > /tmp/avocado-provision.log 2>&1\`. Status: \`✅ provision succeeded\` or \`❌ provision failed (exit N)\`. If failed, pass log to \`diagnose-provision-log\` and STOP.`,
                "9. **Physical handoff.** Tell me the exact action(s) to take to boot the device, target-specific:",
                "   - SD-card targets: eject the SD card from the host, insert it into the target, apply power. Note any LED behaviour to watch for.",
                "   - USB targets: same pattern with the USB drive; mention BIOS boot-from-USB if needed.",
                "   - Tegraflash (Jetson): the device is already connected via USB recovery; remove the FC REC short, power-cycle, the device should now boot from internal media.",
                "   - QEMU: launch the VM with `avocado sdk run -iE vm dev` (the console will come to the launching terminal — no UART needed).",
                "10. **First-boot verification.** Once I confirm I've taken the physical action, set up a UART tmux bridge per `avocado://skills/tmux-uart-bridge` (`detect-serial-ports` → `get-device-connection-info` → `get-tmux-uart-snippet`) and capture the boot. Look for: kernel boot messages, systemd reaching `default.target`, the login prompt. Status: `✅ device booted to login prompt` / `❌ boot stalled at <stage>`. For QEMU: skip the UART setup; the boot logs are already in the launching terminal.",
                "11. **Final summary**: confirm build ✅/❌, provision ✅/❌, first-boot ✅/❌. Tell me what to do next (typically: `/build-and-deploy` for the iteration loop, now that the device is running).",
                "",
                "**Failure handling:** stop at the first failed step. Don't paper over a failed build by trying to provision; don't paper over a failed provision by claiming the device will boot. If something breaks, surface the actual error and name the diagnostic tool to use next.",
              ].join("\n"),
            },
          },
        ],
      };
    },
  );

  server.prompt(
    "start-avocado-project",
    "Set up a brand new Avocado OS project from scratch — verifies the host environment, picks a target, generates avocado.yaml, and explains the next steps.",
    {
      hardware: z
        .string()
        .optional()
        .describe(
          "Hardware the user has on hand, in their own words (e.g. 'a Raspberry Pi 5', 'NVIDIA Jetson Orin Nano dev kit'). Leave blank to start by listing supported targets.",
        ),
    },
    ({ hardware }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I want to start a new Avocado OS project. ${hardware ? `My hardware: ${hardware}.` : "I haven't picked hardware yet."}`,
              "",
              "Please walk me through the setup. Specifically:",
              "",
              "1. Read the `avocado://skills/getting-started` resource to ground yourself in the workflow.",
              "2. Call `environment-check`. It confirms prerequisites AND sets the avocado-cli execution channel for this session (see its **Execution channel** section + `avocado://skills/avocado-cli-execution`). If anything's missing, surface the fix and stop — don't proceed until the user confirms it's resolved.",
              "3. Run `list-targets({ query: \"...\" })` with my hardware in my own words (e.g. 'rpi4', 'jetson orin nano'). Only pick a target from the supported list — if my hardware isn't on the list, **tell me it's not currently supported** and don't try to substitute a 'close enough' target without my explicit confirmation. If I haven't named hardware, summarise the options and ask.",
              "4. **If the chosen target is NOT a QEMU target,** ask me whether I have a USB-to-UART adapter wired into the device's debug UART. This is a hard prerequisite for provisioning and debugging — without it I can't see boot output or recover from failures. If I don't have one, suggest starting with a QEMU target instead (`qemuarm64` / `qemux86-64`) until I get the adapter.",
              "5. Call `init-project` with the chosen `target` AND `task` (my task in my own words). The tool will search the reference catalog first and prefer a matching reference — that's almost always faster than from-scratch. If a reference is shown with ⚠️ unlisted compatibility for my target, surface that warning to me; references not tested on my hardware may need extra debugging. If `init-project` returns a reference scaffold command, also call `get-reference` for that slug so you understand what it sets up before suggesting edits.",
              "6. Call `get-provisioning-steps` so I know exactly which `avocado provision` invocation to run for my target.",
              "",
              "Finish by giving me the exact commands I should run next: `avocado install` (resolves packages, required before build), then `avocado build`, then the provisioning command. Explain what each does and what to expect. **Also tell me** about the faster iteration loop for after the first provision: once the device is on the network, `avocado deploy -r dev -d <device-ip>` pushes subsequent changes in seconds without re-flashing — see `avocado://skills/iterative-deployment`.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "setup-connect",
    "Initialize an Avocado project for fleet OTA updates via Avocado Connect. Guides through auth check → org/project/cohort selection → `avocado connect init` → rebuild.",
    {
      directory: z
        .string()
        .optional()
        .describe(
          "Absolute path to the Avocado project directory. If omitted, the agent will ask.",
        ),
      runtime: z
        .string()
        .optional()
        .describe(
          "Runtime name in avocado.yaml to wire Connect into (defaults to 'dev').",
        ),
    },
    ({ directory, runtime }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I want to set up Avocado Connect OTA fleet management for my project.${directory ? ` Project directory: \`${directory}\`.` : ""}${runtime ? ` Runtime: \`${runtime}\`.` : ""}`,
              "",
              "Please walk me through the initialization. Follow this exact order:",
              "",
              "1. Call `environment-check` and read `avocado://skills/avocado-cli-execution` to establish the execution channel for this session. **If the channel is `host-tool`, stop** — the Connect tools run `avocado` locally and can't reach the Mac's CLI/credentials/project from inside the VM. Tell me to run `/setup-connect` from a workstation (bash) session, or to run `avocado connect …` directly on the Mac.",
              "2. Read `avocado://skills/avocado-connect` — this is the authoritative reference for Connect concepts, the upload/deploy lifecycle, and the correct tool sequence.",
              "3. Call `connect-auth-status`. If `logged_in` is false, stop and tell me to run `avocado connect auth login` first. If `token_valid` is false, tell me the token may be expired and to re-login.",
              "4. Call `connect-list-resources { resource: 'orgs' }`. Present the org list. If only one org, auto-select it (tell me which one). If multiple, ask me to choose.",
              "5. Call `connect-list-resources { resource: 'projects', org: '<id>' }` with the chosen org. Present the project list. If only one, auto-select; if multiple, ask me to choose.",
              "6. Call `connect-list-resources { resource: 'cohorts', org: '<id>', project: '<id>' }` with the chosen project. Present the cohort list. If only one, auto-select; if multiple, ask me to choose. If no cohorts exist, tell me to create one in the Connect web UI first.",
              "7. Confirm the selections with me before proceeding.",
              "8. Call `connect-init` with the confirmed `directory`, `org`, `project`, `cohort`, and `runtime`.",
              "9. On success, tell me: (a) which files were modified in `avocado.yaml`, (b) that I need to run `avocado build` to compile the new Connect extension into my runtime, and (c) that after provisioning a device with this build, it will self-enroll into the cohort at first boot.",
              "",
              "If `connect-init` fails, surface the exact error message and suggest remediation (re-login, check org/project/cohort IDs, etc.).",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "package-coverage",
    "Analyze a containerized app for migration off Docker onto Avocado OS. Ingests a Dockerfile OR an SBOM (CycloneDX / SPDX), resolves the feed stream (target + release + channel — from avocado.yaml, or interactively when there's no project), extracts runtime dependencies, batch-checks them all against the live feed with `check-package-coverage`, researches gaps on the open web, and writes a shareable `package-coverage.md` — a per-dependency present/missing table with upstream links and a headline coverage %. The report is written for an Avocado OS feed maintainer.",
    {
      input: z
        .string()
        .optional()
        .describe(
          "Path to the user's Dockerfile or SBOM file (CycloneDX/SPDX JSON), or the pasted contents. If omitted, ask the user for it.",
        ),
      inputType: z
        .string()
        .optional()
        .describe(
          "One of 'dockerfile', 'cyclonedx', 'spdx'. If omitted, infer from the file name/contents and confirm with the user.",
        ),
      target: z
        .string()
        .optional()
        .describe(
          "Avocado target slug (e.g. 'jetson-orin-nano-devkit'). If omitted or given as prose hardware, resolve it in Step 0 (from avocado.yaml if present, else interactively via `list-targets` + the docs support matrix).",
        ),
      release: z
        .string()
        .optional()
        .describe(
          "Feed release (e.g. '2024' or '2026'). If omitted, resolve in Step 0 — read it from avocado.yaml's `distro.release`, or pick per the support matrix (default to the newest release the target supports).",
        ),
      channel: z
        .string()
        .optional()
        .describe(
          "Feed channel: 'next' | 'edge' | 'stable'. If omitted, resolve in Step 0 — read from avocado.yaml's `distro.channel`, or recommend 'edge' and ask.",
        ),
      includeBuildTime: z
        .string()
        .optional()
        .describe(
          "Pass 'true' to also analyze build-time-only dependencies (compilers, -dev headers, build tools) in a separate table. Default: runtime dependencies only — the meaningful coverage number for what ships on-device.",
        ),
    },
    ({ input, inputType, target, release, channel, includeBuildTime }) => {
      const buildTime = includeBuildTime === "true";
      const streamGiven = Boolean(release || channel);
      return {
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: [
                `I want to move a Docker-based application onto Avocado OS. Produce a **package coverage report** for it.${
                  target ? ` Target: \`${target}\`.` : ""
                }${release ? ` Release: \`${release}\`.` : ""}${channel ? ` Channel: \`${channel}\`.` : ""}${inputType ? ` Input type: ${inputType}.` : ""}`,
                "",
                "**Read `avocado://skills/package-coverage` first** — it is the authoritative method (stream resolution, input parsing, the runtime-only scope rule, feed name-normalization, the batch `check-package-coverage` tool, web research for gaps, and the exact `package-coverage.md` format). Follow it precisely.",
                "",
                "**Step 0 — resolve the target + feed stream.** The feed is per-(target, release, channel), and targets differ per stream (some hardware ships only on a newer release, e.g. NVIDIA Thor on 2026 not 2024). So pin down all three first:",
                "- **If I have an `avocado.yaml`,** read it — take the target from `default_target`/`supported_targets` and the stream from `distro.release`/`distro.channel`. Confirm the resolved `(target, release, channel)` back to me in one line.",
                streamGiven
                  ? "- I've given you stream values above — confirm they're consistent with my project (if any) and use them."
                  : "- **If I have NO project,** resolve interactively: (a) resolve my hardware to a canonical slug with `list-targets` and confirm; (b) check which release supports it via the docs support matrix (https://docs.peridio.com/hardware/support-matrix#supported — use `search-docs`/`get-doc` or `WebFetch`), corroborating with `list-targets({ query, release })` per stream — if supported on both 2024 and 2026, ask me but **default to / recommend the newest (2026)**; (c) **recommend the `edge` channel** but ask if I'd prefer `next`, `edge`, or `stable` (next = nightly, may break / packages go missing; edge = RC, good for dev; stable = pre-prod/prod, normally behind edge). Confirm the final `(target, release, channel)` before running lookups.",
                "",
                "Then execute the method from the skill:",
                "",
                input
                  ? `1. **Ingest the dependency source** — provided: \`${input}\`. Determine whether it's a Dockerfile, CycloneDX, or SPDX (read the file if it's a path). If it's a Dockerfile referencing a manifest (\`requirements.txt\`, \`package.json\`, \`Cargo.toml\`), read that too.`
                  : "1. **Ingest the dependency source** — ask me for my Dockerfile or SBOM (CycloneDX / SPDX). Accept a file path or pasted contents.",
                "2. **Extract** the de-duplicated dependency set. Scope is **runtime dependencies only** — drop build-time-only tooling (compilers, `make`/`cmake`/`meson`, `-dev`/`-devel` headers, `build-essential`, `pkg-config`, test/lint frameworks)." +
                  (buildTime
                    ? " I also want build-time deps — capture them too, but in a SEPARATE 'Build-time (SDK) dependencies' table so the runtime coverage number stays honest."
                    : "") +
                  " For a Dockerfile, use explicitly-declared installs only — do NOT expand the base image's full transitive OS closure. Tell me the extracted count.",
                "3. **Batch-check the feed** with a single `check-package-coverage({ target, release, channel, dependencies: [...] })` call (NOT one `search-packages` per dependency). For each dependency, YOU supply the `queries` array — the normalized name variants (strip `lib`/`-dev`/ABI suffixes; try `python3-`/`nodejs-` prefixes AND bare names; add a keyword form). The tool returns per-dependency status + confidence (`exact`/`strong`/`fuzzy`) + best match + alternatives, and an overall coverage summary. If it returns `targetAvailable: false`, the target isn't in that stream — go back to Step 0 and pick the release that supports it. Re-run just the `missing` ones with better `queries` if you suspect a different feed name.",
                "4. **Research every MISSING package** on the open web (`WebSearch` / `WebFetch`; `gh`/`curl` per `avocado://skills/upstream-sources` if it's an avocado-linux thing). Capture what it is, canonical upstream repo URL (+ 1–2 secondary links: homepage / PyPI / npm / crates.io / distro package page), license (SPDX id), latest version, and whether an existing OE/Yocto/Fedora recipe exists. **Never invent a link** — if you can't find a canonical source, say so. **If web-research tools aren't available this session, don't stall or guess** — still produce the report, but note per missing package that upstream research wasn't performed (no web access) so the maintainer knows to follow up.",
                "5. **Write the report** to the current working directory (unless I name another path) as `package-coverage-<target>.md` when the target is known — so running this for a second board doesn't overwrite the first — in the exact format from the skill: header block (app, input type, target, **feed stream `<release>/<channel>`**, base image, date), a Summary with the **headline coverage %** (present/total, shown as a fraction, e.g. `18/22 = 82%`, and if any 'present' rows are fuzzy, say how many so the number stays honest), the per-dependency Coverage detail table (with the Match confidence column), a 'Missing packages — maintainer detail' section with one subsection per gap, and (optionally) an 'Excluded (build-time only)' list. The report must stand alone for an Avocado OS feed maintainer.",
                "",
                "**This is analysis only** — produce the report artifact. Do NOT edit my `avocado.yaml` or install anything as part of this; that's a separate follow-up once the gaps are understood.",
                "",
                "When done, give me a short summary in chat: the resolved stream, the coverage %, the count of missing packages, and the path to the report file.",
              ]
                .filter((s) => s !== "")
                .join("\n"),
            },
          },
        ],
      };
    },
  );
}
