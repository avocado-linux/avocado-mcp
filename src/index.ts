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
import { INSTRUCTIONS } from "./instructions.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

const server = new McpServer(
  {
    name: "avocado-os",
    version: packageJson.version,
  },
  { instructions: INSTRUCTIONS },
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
