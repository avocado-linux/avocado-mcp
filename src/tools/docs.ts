import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerDocsTools(server: McpServer) {
  server.tool(
    "get-docs-info",
    "Get information about Avocado OS and Peridio documentation",
    {},
    async () => {
      const docsBase = "https://docs.peridio.com";

      const output = `# Avocado OS Documentation

**Primary Source:** ${docsBase}/avocado/
**Peridio Integration:** ${docsBase}/peridio/

## Key Documentation Areas

### Avocado OS
- **Getting Started:** ${docsBase}/avocado/getting-started
- **Configuration Reference:** ${docsBase}/avocado/configuration
- **Target Platforms:** ${docsBase}/avocado/targets
- **Extensions:** ${docsBase}/avocado/extensions

### Peridio Integration
- **Device Management:** ${docsBase}/peridio/device-management
- **OTA Updates:** ${docsBase}/peridio/ota
- **Fleet Management:** ${docsBase}/peridio/fleet-management

## Benefits
- **Official Source:** Authoritative and up-to-date
- **Comprehensive:** Complete coverage of all features
- **Integration Ready:** First-class Peridio support documented`;

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    },
  );
}
