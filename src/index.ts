#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createRequire } from "module";
import { RepoClient } from "./lib/repo-client.js";
import { registerConfigTools } from "./tools/config.js";
import { registerPackageTools } from "./tools/packages.js";
import { registerDiscoveryTools } from "./tools/discovery.js";
import { registerReferenceTools } from "./tools/references.js";
import { registerProjectTools } from "./tools/project.js";
import { registerDiagnosticsTools } from "./tools/diagnostics.js";
import { registerDebuggingTools } from "./tools/debugging.js";
import { registerSkillResources } from "./tools/resources.js";
import { registerPrompts } from "./tools/prompts.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json");

const server = new McpServer({
  name: "avocado-os",
  version: packageJson.version,
});

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

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Server failed:", error);
    process.exit(1);
  });
}

export { main };
