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
import { registerSkillResources } from "./tools/resources.js";
import { registerPrompts } from "./tools/prompts.js";
import { registerRecipeTools } from "./tools/recipe.js";

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
      "run `avocado build`, push to a running device with `avocado deploy -r <runtime>",
      "-d <device-ip>`, and verify on the device over UART or SSH. The user does NOT",
      "need to copy-paste commands one at a time; they can ask 'build and deploy this'",
      "and you handle the full sequence.",
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
      '    and UART verification."',
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
      "**Long-running waits go through `schedule_task`, not in-turn polling.**",
      "`avocado install` / `build` / `deploy` / `provision` routinely run for",
      "minutes-to-half-an-hour. Polling them in-turn exhausts your tool-call budget",
      "long before they finish, which forces you to hand back to the user — the",
      "single thing they are most frustrated by. The right pattern (detailed in",
      "the avocado-cli-execution skill): kick off the run, call the status tool",
      "ONCE to grab `recommendedNextPollSeconds`, then `schedule_task` a one-shot",
      "follow-up after that delay. The follow-up runs in a fresh agent loop, polls",
      "once more, and either re-schedules (if still running) or reports the",
      'outcome (if terminal). Never finish a turn with "ping me when it\'s done"',
      "unless you've scheduled the follow-up first.",
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
      "For fleet OTA management tasks (pushing updates to devices in production,",
      "enrolling devices, managing cohorts, uploading runtimes), use the `connect-*`",
      "tools. Always read `avocado://skills/avocado-connect` first — it explains the",
      "upload → publish → deploy lifecycle and the correct tool sequence. The",
      "`/setup-connect` prompt walks through the full initialization flow.",
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
registerRecipeTools(server, repoClient);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// TEMP instrumentation: confirm how each consumer (Claude Code / ACP /
// microclaw) spawns us. stderr is safe — it does not pollute the JSON-RPC
// stream on stdout. Remove once the root cause is confirmed.
console.error(
  "[avocado-mcp] argv1=%s import.meta.url=%s",
  process.argv[1],
  import.meta.url,
);

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
