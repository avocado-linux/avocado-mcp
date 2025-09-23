#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerConsolidatedTools } from "./tools/consolidated.js";
// Create server
const server = new McpServer({
    name: "avocado-os",
    version: "3.0.0",
});
// Register consolidated tools
registerConsolidatedTools(server);
// Start server
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
