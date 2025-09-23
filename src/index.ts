#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerSchemaTools } from "./tools/schema.js";
import { registerDocsTools } from "./tools/docs.js";
import { registerRepositoryTools } from "./tools/repository.js";
import { registerConfigTools } from "./tools/config.js";
import { registerDatabaseTools } from "./tools/database.js";

// Create server
const server = new McpServer({
  name: "avocado-os",
  version: "2.0.0",
});

// Register all core resource tools
registerSchemaTools(server);
registerDocsTools(server);
registerRepositoryTools(server);
registerConfigTools(server);
registerDatabaseTools(server);

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.log("Avocado MCP Server v2.0 running");
  console.log(
    "Tools: schema validation, config reasoning, repository querying, efficient database management, extension patterns",
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error("Server failed:", error);
    process.exit(1);
  });
}

export { main };
