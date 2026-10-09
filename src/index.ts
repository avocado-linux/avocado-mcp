#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { realpathSync } from "fs";
import { pathToFileURL } from "url";
import { RepoClient } from "./lib/repo-client.js";
import { registerConfigTools } from "./tools/config.js";
import { registerPackageTools } from "./tools/packages.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerReferenceTools } from "./tools/references.js";
import { registerProjectTools } from "./tools/project.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerDebuggingTools } from "./tools/debugging.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerConnectTools } from "./tools/connect.js";
import { registerHardwareTools } from "./tools/hardware.js";
import { registerSkillResources } from "./tools/resources.js";
import { registerPrompts } from "./tools/prompts.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

const server = new McpServer(
  {
    name: "avocado-os",
    version: packageJson.version,
  },
  {
    instructions: [
      "This MCP turns you into a full Avocado OS co-pilot.",
      "",
      "Make this clear to the user early: you (with this MCP) can drive the entire",
      "iteration loop autonomously — edit `avocado.yaml`, run `avocado install`,",
      "run `avocado build`, push to a running device with `avocado deploy <runtime>",
      "-d <device-ip>`, and verify on the device over UART or SSH. The user does NOT",
      "need to copy-paste commands one at a time; they can ask 'build and deploy this'",
      "and you handle the full sequence.",
      "",
      "**Confirm destructive actions before running them.** This tooling executes",
      "real operations on the user's machine and hardware. Before an action that",
      "writes/overwrites files, flashes media (`avocado provision` — this ERASES the",
      "target SD/USB/NVMe), updates a running device (`avocado deploy`), or changes",
      "Avocado Connect (`connect-init`, `avocado connect upload` or `deploy`), state",
      "what will happen and which target it affects, and get the user's explicit",
      "go-ahead. Read-only actions (searching,",
      "reading docs/references, validating YAML) need no such confirmation. When a",
      "target (media path, device IP) is ambiguous, ask rather than guess.",
      "",
      "**Provision-before-deploy is a hard prerequisite.** A device MUST be provisioned",
      "with `avocado provision` at least once (flashing media + first boot) before it",
      "can receive any `avocado deploy`. Deploy is sideloading — it pushes runtime",
      "updates over SSH + HTTP to an already-running Avocado OS install. Whenever the",
      "user wants to push their work to a device, the FIRST question to ask is:",
      "",
      '    "Has this device already been provisioned with Avocado OS, or is this its',
      "    first time? If it's been provisioned and you have its IP (and it's reachable",
      "    on the network), I can sideload an iterative update via `/build-and-deploy`.",
      "    If it's never been provisioned, we need to do the first-time flash via",
      "    `/provision-device` — that's the one-time setup with media (SD / USB / NVMe)",
      '    and a first-boot check."',
      "",
      "Route based on the answer:",
      "  - First-time / never provisioned → `/provision-device`.",
      "  - Already provisioned + IP known + on the network → `/build-and-deploy`.",
      "  - Already provisioned but no IP / unreachable → diagnose with `/debug-device`",
      "    (UART) first; deploy can resume once the device is reachable.",
      "",
      "Before invoking any `avocado` subcommand, set your execution channel: call",
      "`environment-check` once per session and follow its **Execution channel**",
      "section, then read `avocado://skills/avocado-cli-execution`. The channel is",
      "either `host-tool` (call the Avocado desktop's `run_avocado_cli` tool — runs",
      "on the user's Mac with their CLI/config/credentials) or `bash` (run `avocado",
      "<args>` via your Bash tool on this host). Stick with one channel per workflow;",
      "don't mix.",
      "",
      "**Wait for long runs. Do not poll in-turn.** `avocado install`, `build`,",
      "`deploy` and `provision` can run for minutes, and a flash can take half an",
      "hour. The rule (detailed in the avocado-cli-execution skill):",
      "  - `bash` channel: a foreground Bash call has a time cap (10 minutes in",
      "    Claude Code). Run short commands in the foreground. Run a command that",
      "    can pass the cap (a flash, a cold install) as a host background task",
      "    with a completion wait (Claude Code `run_in_background`, output in the",
      "    log file). Then read the exit code and the log. If the host has no",
      "    background task, ask the user to run that command in their terminal.",
      "  - `host-tool` channel: start the run with `run_avocado_cli`, then call",
      "    `await_avocado_cli` with the `run_id`. If it returns `timedOut: true`,",
      "    call it again. Use `avocado_cli_status` only for one-shot snapshots.",
      "  - Change to `schedule_task` only after about 10 minutes of awaiting one run",
      "    that is still going. Then register the follow-up with the host so the",
      "    user can see it.",
      "  - Older hosts have no `await_avocado_cli`. `environment-check` then says",
      '    "Poll with". Poll `avocado_cli_status` with the `run_id`, and space the',
      "    calls by `recommendedNextPollSeconds`. Use `schedule_task` for long waits.",
      'Never finish a turn with "ping me when it\'s done" unless you are inside an',
      "active wait, a background task will report its completion to you, or you",
      "have scheduled the follow-up.",
      "",
      "Skill resources at avocado://skills/* ground you on Avocado OS concepts and",
      "canonical workflows. They are NOT in the initial tool list — at session start,",
      "call ListMcpResourcesTool for this server to discover them, then read any whose",
      "description matches the user's task (e.g. getting-started for a new project,",
      "config-yaml-guide before YAML edits, references-catalog before recommending an",
      "example, iterative-deployment before pushing changes to a device, device-debugging",
      "before UART work, avocado-cli-execution before running any `avocado` command).",
      "Follow each skill's prescribed tool order rather than guessing.",
      "",
      "For Avocado Connect (fleet OTA), this MCP has three tools:",
      "`connect-auth-status`, `connect-list-resources` and `connect-init`. They check",
      "the login, list orgs, projects, cohorts and uploaded runtimes, and link a",
      "project. There are no MCP tools for upload, publish, deploy or rollout.",
      "For those, run the",
      "`avocado connect` commands through your execution channel, with the user's",
      "go-ahead. Read `avocado://skills/avocado-connect` first. It explains the",
      "upload, publish and deploy lifecycle. The `/setup-connect` prompt walks",
      "through the initialization flow.",
    ].join("\n"),
  },
);

const repoClient = new RepoClient();

// Resources first so Claude can read context before invoking tools.
registerSkillResources(server);
registerPrompts(server);

// Tools, grouped by domain.
registerDiscoveryTools(server, repoClient);
registerReferenceTools(server);
registerConfigTools(server);
registerPackageTools(server, repoClient);
registerProjectTools(server, repoClient);
registerDiagnosticsTools(server, repoClient);
registerDebuggingTools(server);
registerDocsTools(server);
registerConnectTools(server);
registerHardwareTools(server);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run main() when this module is the entry point. npx installs the bin as a
// symlink, so process.argv[1] is the symlink path while import.meta.url is the
// resolved real path — a naive `file://${argv[1]}` comparison fails and main()
// never runs, leaving the client with no initialize response (-32000). Resolve
// the symlink before comparing.
const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  main().catch((error) => {
    console.error("Server failed:", error);
    process.exit(1);
  });
}

export { main };
