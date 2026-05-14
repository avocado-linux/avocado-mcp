import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { fetchSchema } from "../lib/schema-client.js";

export function registerConfigTools(server: McpServer): void {
  server.tool(
    "get-config-schema",
    "REQUIRED: Acquire the JSON schema for Avocado OS configurations. This schema is essential for validating all Avocado configurations and must be obtained before generating any configuration files.",
    {
      version: z
        .string()
        .optional()
        .describe(
          "Git tag/version to fetch (e.g., 'v1.0.0', 'main'). If not provided, fetches the latest version from main branch",
        ),
    },
    async ({ version }) => {
      try {
        const {
          schema,
          version: schemaVersion,
          source,
        } = await fetchSchema(version);

        return {
          content: [
            {
              type: "text",
              text: `# Avocado OS Configuration Schema\n\n**Version:** ${schemaVersion}\n**Source:** ${source}\n\nThis schema is **REQUIRED** for validating Avocado OS configurations. Use it to ensure your YAML configurations (avocado.yaml) meet all structural and constraint requirements.\n\n## Key Validation Points\n\n- **Required Properties:** Ensure all required top-level properties are present\n- **Target Validation:** Target names must match schema enum values\n- **Extension Types:** Must be "sysext" or "confext"\n- **Dependencies:** Use exact package names verified through query-repos\n- **Data Types:** All values must match schema type definitions\n\n## Schema Content\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# Schema Fetch Error\n\n❌ **Failed to fetch schema:** ${error}\n\n## Troubleshooting\n\n1. **Check version:** Ensure the version/tag exists in the repository\n2. **Try main branch:** Use no version parameter to fetch from main\n3. **Manual download:** Visit https://github.com/avocado-linux/avocado-config to browse available schema files\n\n## Available Actions\n\n- Retry with no version parameter for latest\n- Check GitHub repository for available tags\n- Verify network connectivity`,
            },
          ],
        };
      }
    },
  );
}
