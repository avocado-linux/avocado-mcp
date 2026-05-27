export const URI = "avocado://skills/avocado-cli-execution";
export const NAME = "avocado-cli-execution";
export const DESCRIPTION =
  "How to invoke `avocado <subcommand>` correctly in this session, AND how to write files inside a project. There are two channels (host-tool delegation via the desktop's MCP, or local Bash) and choosing the right one matters for matching the user's CLI version, config, and credentials. In host-tool mode this skill also covers `write_project_file` — the canonical path for editing `avocado.yaml` and other project files (the in-VM 9p mount has read-only edge cases that make direct Write/Edit unreliable). Read this before running ANY `avocado` command OR editing any file inside a project. `environment-check` sets the channel; the rules here say how to use it.";

export const CONTENT = `# Avocado-CLI execution channel

There are two ways the LLM in this session can invoke \`avocado <args>\`. Picking the right one matters because they bind to different copies of the CLI, different config, and different credentials.

**Always call \`environment-check\` once at the start of a session before your first \`avocado\` invocation.** Its **Execution channel** section names which path to use. Re-using a stale channel selection across sessions will silently misroute commands.

---

## Channel 1 — \`host-tool\` (desktop MCP delegation)

**When it applies:** \`environment-check\` reports \`Execution channel: host-tool\`. This happens when this MCP is running alongside a co-pilot agent inside the Avocado VM, and the Avocado desktop on the user's Mac exposes its MCP server. The desktop runs \`avocado-cli\` on the Mac with the user's own binary, their \`avocado.yaml\`, their Avocado Connect credentials, and their Docker SDK container.

**How to invoke:** call the host MCP's \`run_avocado_cli\` tool. The host returns a \`run_id\` immediately. **Then wait on it with \`await_avocado_cli\` — that's a host-push, near-zero-latency wake.** Reach for \`avocado_cli_status\` only for one-shot snapshots (e.g. inside a scheduled follow-up, or when you already know the run is terminal and just want a fresh tail).

\`\`\`json
// Start (host MCP tool: run_avocado_cli)
{
  "args": ["build"],          // No leading "avocado". No "--no-tui".
  "project": "myapp"          // Project name from list_projects.
                              // Omit "project" for non-project commands
                              // like ["--version"].
}
// → { "run_id": "...", "status": "running", ... }

// Wait (host MCP tool: await_avocado_cli)
//   Blocks the response until terminal OR max_wait_seconds elapses.
//   The host wakes this within ms of avocado-cli's process exit.
{ "run_id": "...", "max_wait_seconds": 240, "tailLines": 80 }
// → { "status": "succeeded" | "failed" | "running",
//     "exitCode": 0,                  // present once finished
//     "outputTail": ["..."],          // merged stdout+stderr, line-oriented
//     "droppedFromHead": 0,           // non-zero = older lines rolled off
//     "waitedSeconds": 240,           // budget actually used
//     "timedOut": true,               // ONLY present if still running
//     "nextAction": "...",            //   → call await_avocado_cli again
//     "startedAt": "...", "finishedAt": "..." }

// One-shot snapshot (host MCP tool: avocado_cli_status) — rare
{ "run_id": "...", "tailLines": 80 }
\`\`\`

### Rules for the host-tool channel

- **Do NOT pass \`--no-tui\`.** The host already runs the CLI without a TTY, so output is line-oriented by default. Passing \`--no-tui\` is harmless but unnecessary noise.
- **Do NOT also run \`avocado\` via the Bash tool in the same session.** That would invoke a different CLI inside the VM with the wrong config and no credentials — silently divergent results from what the user sees. If you absolutely need to inspect VM state, use Bash for non-\`avocado\` commands only.
- **Do NOT redirect output to \`/tmp/...\` files.** Capture happens on the host; \`outputTail\` already gives you the recent lines. The full output stays in host memory for the duration of the run.
- **Status reporting after each call:** surface a one-line \`✅ <subcommand> succeeded\` / \`❌ <subcommand> failed (exit N)\` once \`status\` flips to terminal, just like the bash channel. The user is watching for these.
- **Wait with \`await_avocado_cli\`, not scheduled polls.** This is the single most important rule in this skill. \`await_avocado_cli\` blocks the host MCP's response until the avocado-cli process actually exits — the host pushes the terminal state into your tool call within milliseconds of it happening. No pacing hints, no fixed cadence, no scheduled follow-up. The pattern:
  1. Kick off the work with \`run_avocado_cli\` and capture the \`run_id\`.
  2. Call \`await_avocado_cli\` with that \`run_id\`. It blocks up to \`max_wait_seconds\` (default 240, hard cap 270).
  3. **If the response has \`status: succeeded\` or \`status: failed\`**, you're done — proceed with the next step (deploy, verify, report, etc.).
  4. **If the response has \`timedOut: true\`** (run still in flight after 240s), call \`await_avocado_cli\` again with the same \`run_id\`. Each round is one tool call covering ~4 minutes of wait — far cheaper than schedule_task latency and burns roughly one tool call every 4 min, well under the per-turn cap even for 20+ minute runs.

  Why this beats every other wait pattern: scheduled polls sit idle for the full \`recommendedNextPollSeconds\` window even when the run finishes seconds after the poll fired, so the user routinely sees minutes of dead time between completion and the next status report. In-turn polling burns the tool-call cap every few seconds. \`await_avocado_cli\` has neither problem — the host wakes the call the moment the process exits.

- **Fall back to \`schedule_task\` only for genuinely long runs (multi-tens of minutes).** Provisioning flashes that write a full image to slow storage can run 20–30 min. Awaiting in-turn for that long is doable (~7 tool calls) but consumes the agent's wall-clock budget. Cut over to \`schedule_task\` only when you've already awaited for ~10 minutes on a single run AND the output makes it clear the work is "still going." When you do schedule:
  1. **Immediately after \`schedule_task\` returns a task id, call \`register_scheduled_followup\` on the host MCP** so the user sees a pill above the chat input with what's queued and a one-click cancel. Pass \`task_id\`, a short \`description\`, the \`fires_at\` ISO8601 if you have it, and \`run_id\` if the follow-up is polling an avocado-cli run (the host auto-clears the pill when that run hits terminal). **Skipping this is the #1 source of user complaints about "agent went dark" — without it the user has no idea you queued anything.**
  2. Inside the scheduled follow-up prompt, use \`avocado_cli_status\` (NOT \`await_avocado_cli\`) for the snapshot — the follow-up runs in a fresh agent loop and the response shape is fully sufficient.
  3. If still running, schedule another follow-up at \`recommendedNextPollSeconds\` and call \`register_scheduled_followup\` again with the new task id (the prior pill auto-clears when its task fires; you're registering the next chain link).
  4. On terminal status, call \`clear_scheduled_followup\` to drop the pill (idempotent if the host already auto-cleared via \`run_id\`), then end the chain with \`notify_chat\` so the user actually sees the outcome — microclaw's scheduler does NOT route scheduled-task output back through the ACP channel (its \`AcpAdapter::send_text\` is a no-op stub), so without \`notify_chat\` the user sees nothing.

  Example scheduled-prompt template (the rare case):

  > "Check \`avocado_cli_status\` for run_id=<id>. If \`status\` is terminal, \`clear_scheduled_followup\` for task_id=<this_task> then \`notify_chat\` with a one-line summary (level: \\"success\\" or \\"error\\"; pass failure output to \`explain-build-error\` first). If \`status\` is \`running\`, call \`schedule_task\` again with this same prompt and a delay of \`recommendedNextPollSeconds\` seconds, then \`register_scheduled_followup\` with the new task id, description=\\"Poll <run-id> for myapp\\", fires_at=<new fire time>, run_id=<id>."

- **Cancel via the user's pill click.** If the user clicks the [x] on a scheduled-followup pill, the chat panel injects a synthetic prompt telling you to drop the task. Handle it by calling your scheduler's delete API (\`CronDelete\` if available, or microclaw's equivalent) on the \`task_id\`, then \`clear_scheduled_followup\` so the pill disappears. If the task has already fired, just confirm.

- **\`avocado_cli_status\` is for snapshots, not waits.** Reach for it when (a) you're inside a scheduled follow-up that just woke up, (b) you already know the run is terminal and want a fresh tail, or (c) \`await_avocado_cli\` is unavailable for some reason. Never spin-poll \`avocado_cli_status\` in-turn — that's the failure mode \`await_avocado_cli\` was built to replace.
- **Never** finish your turn with "still running, ping me when it's done" without either (a) being inside an active \`await_avocado_cli\` call, or (b) having scheduled a follow-up. The user delegated the work to you and expects it to land.
- **Only stop awaiting on:** terminal status, explicit user cancellation, or a hard error in the await tool itself. "I've awaited a lot" is not a reason — loop the await.
- **Failure handling:** when \`status\` is \`failed\`, the \`error\` field carries the spawn / exit message and \`outputTail\` carries the CLI's own output. Pass the \`outputTail\` to \`explain-build-error\` the same way you would a captured log file.
- **\`droppedFromHead > 0\`:** the buffer rolled over — older lines are gone. If the diagnosis isn't in \`outputTail\`, re-run with the \`tailLines\` knob bumped, but accept that very old output is irretrievable.

### Mapping the common workflow

| What you want | Call |
|---|---|
| \`avocado install -f\` for project \`myapp\` | \`run_avocado_cli({ args: ["install", "-f"], project: "myapp" })\` → \`await_avocado_cli({ run_id })\` (loop on \`timedOut\`) |
| \`avocado build\` for project \`myapp\` | \`run_avocado_cli({ args: ["build"], project: "myapp" })\` → \`await_avocado_cli({ run_id })\` |
| \`avocado deploy -r dev -d 192.168.1.42\` | \`run_avocado_cli({ args: ["deploy", "-r", "dev", "-d", "192.168.1.42"], project: "myapp" })\` → \`await_avocado_cli({ run_id })\` |
| \`avocado --version\` | \`run_avocado_cli({ args: ["--version"] })\` → \`await_avocado_cli({ run_id })\` (returns in seconds; no project needed) |
| Multi-tens-of-minutes provision flash | \`run_avocado_cli\` → \`await_avocado_cli\` ×2-3 rounds → if still going, switch to \`schedule_task\` |

### Path / tool conventions in host-tool mode (read this if anything below confuses you)

When the host MCP is delegating, work splits cleanly along this matrix. **Picking the wrong row is the most common cause of "I keep trying to write to disk but nothing happens" loops.**

| What you're doing | Tool to use | Path / argument |
|---|---|---|
| **Reading** a project file (\`avocado.yaml\`, app source, hook script, overlay file) | \`Read\` (your built-in tool) | The project's **\`vmDirectory\`** path (e.g. \`/run/workspace/myapp/avocado.yaml\`). Get it from \`list_projects\`. |
| **Writing or editing** a project file | **\`write_project_file\` (host MCP tool)** | \`{ project: "myapp", path: "avocado.yaml", content: "..." }\`. Relative path only — the host writes it under the project's directory atomically. |
| **Bash commands** inside a project (cd / ls / cat / git) | \`Bash\` (your built-in tool) | Use the **\`vmDirectory\`** path. \`cd /run/workspace/myapp && …\` |
| **Running \`avocado <subcommand>\`** | \`run_avocado_cli\` (host MCP tool) | \`{ project: "myapp", args: ["build"] }\`. No path. |
| **Telling the user where their project lives on disk** | Just include it in your reply text | The project's **\`directory\`** (the host path, e.g. \`/Users/you/.../myapp\`). |

**Why a separate write tool for project edits.** The in-VM 9p mount at \`/run/workspace\` is read-write in principle, but in practice we've seen Write/Edit on \`vmDirectory\` fail with "read-only" errors or silently drop xattrs. \`write_project_file\` writes directly on the Mac host where the avocado-cli will read it, bypassing the 9p path entirely. Atomic via temp-file + rename. Always prefer it for project-rooted edits.

**Quick test before each Read/Bash:** if the file_path or working directory starts with \`/Users/\`, \`/home/\`, or anything that looks like a host filesystem path, you have the wrong one — go look it up under \`vmDirectory\` in \`list_projects\` instead.

**Quick test before each Write/Edit:** if you're using the Write or Edit tool with a path inside a project, **stop** and call \`write_project_file\` instead.

**For files outside any avocado project** (e.g. you're editing something in \`~/Documents/\` or somewhere unrelated to a project), use Write/Edit normally — \`write_project_file\` only handles paths inside a project root.

---

## Channel 2 — \`bash\` (local Bash tool)

**When it applies:** \`environment-check\` reports \`Execution channel: bash\`. This is the normal channel on a developer workstation where this MCP is running standalone (no host MCP reachable at \`http://10.0.2.2:11551\`).

**How to invoke:** run \`avocado <args>\` via your Bash tool, but follow the redirect-to-file + tail + grep pattern below. Don't pull the CLI's full output into context — \`install\` and \`build\` can each emit hundreds of lines.

### Canonical pattern (use this for every install / build / deploy invocation)

\`\`\`bash
# Capture full output to a file, surface only what matters
avocado install -f --no-tui > /tmp/avocado-install.log 2>&1
INSTALL_RC=$?
echo "exit: $INSTALL_RC"
tail -40 /tmp/avocado-install.log
echo '---errors---'
grep -iE 'error|failed|nothing provides|broken' /tmp/avocado-install.log | tail -40 || true
\`\`\`

Read those three slices (exit code, tail, grepped errors) and report a one-line ✅/❌ status. The full log stays on disk and you only need to load more if the diagnosis isn't obvious. If \`explain-build-error\` needs more context, pass it the file contents — don't re-run the build.

### Rules for the bash channel

- **Always pass \`--no-tui\`** to \`avocado install\` / \`avocado build\` / \`avocado deploy\` when running under Bash with captured output. The default TUI renders status spinners, redraws, and ANSI escape sequences that turn a captured log file into garbage. \`--no-tui\` produces line-oriented stdout. Only omit the flag if a human is running the command directly in their own terminal.
- **\`avocado provision\` needs a pseudo-TTY — wrap with \`script\`.** \`avocado provision\` shells out to \`docker run -it\` internally, which requires a TTY. The Bash tool runs without one, so the call fails immediately with \`the input device is not a TTY\`. \`--no-tui\` does NOT fix this — it only affects Avocado's own output, not Docker's \`-it\` requirement. Use \`script -q /dev/null\` to provide a pseudo-TTY: \`script -q /dev/null avocado provision -r dev --no-tui > /tmp/avocado-provision.log 2>&1\`. This wrapper is required for every \`avocado provision\` call via Bash; \`install\` / \`build\` / \`deploy\` do NOT need it.
- **Collect and filter the CLI's own output. Do not inspect its internals.** The \`avocado\` CLI is the orchestrator and the single source of truth: run it, wait for it to exit, and read its exit code + what it printed. Never \`docker logs\` / \`docker ps\` / \`docker exec\` to peek into the SDK container — that's racy, noisy, and will break when the implementation changes.
- **Status reporting after each command:** surface a one-line \`✅ <subcommand> succeeded\` / \`❌ <subcommand> failed (exit N)\`. Silent runs that only summarise at the end are a regression.
- **Re-use captured logs.** If \`/tmp/avocado-install.log\` or \`/tmp/avocado-build.log\` already exists from a recent run, \`tail -200\` it rather than re-running the slow command just to capture output.

### Conventional log paths

| Subcommand | Log file |
|---|---|
| \`avocado install\` | \`/tmp/avocado-install.log\` |
| \`avocado build\` | \`/tmp/avocado-build.log\` |
| \`avocado deploy\` | \`/tmp/avocado-deploy.log\` |

---

## Cross-channel rules (both apply)

- **Don't paper over failures.** Stop at the first failed step. Don't deploy after a broken build; don't claim deploy success after a broken deploy.
- **\`explain-build-error\` takes log text.** Both channels produce text — pass the captured \`outputTail\` (host-tool) or the file contents (bash) to it the same way.
- **Whichever channel is selected for the session, stick with it.** Don't mix host-tool and bash for \`avocado\` calls within a single workflow — that defeats the whole point of routing to the user's CLI.
`;
