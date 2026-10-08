import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadSchema } from "../lib/schema-client.js";

export function registerConfigTools(server: McpServer): void {
  server.registerTool(
    "get-config-schema",
    {
      title: "Get the avocado.yaml JSON schema",
      description:
        "REQUIRED: Get the JSON schema for avocado.yaml. It is the schema the avocado CLI ships, served at https://docs.peridio.com/schemas/avocado-config.json (cached for an hour, with a bundled copy as the offline fallback). Read it before you generate or edit any avocado.yaml.",
      inputSchema: {},
      annotations: {
        title: "Get the avocado.yaml JSON schema",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const { schema, source } = await loadSchema();
      return {
        content: [
          {
            type: "text",
            text: `# Avocado OS Configuration Schema\n\n**Source:** ${source}\n\nThis is the schema the avocado CLI uses. Use it to write \`avocado.yaml\` and check it with \`validate-yaml\`.\n\n## How the CLI reads it\n\n- **Unknown keys:** the CLI ignores a key the schema does not describe and prints a warning. It does not fail.\n- **\`x-avocado-warning\`:** the key parses but has no effect. The CLI prints this text as a warning.\n- **\`deprecated\`:** an old key. Do not write it in new YAML.\n- **Targets:** \`definitions.target\` lists the targets Avocado OS ships, but any string is accepted. Use \`list-targets\` for the targets in the feed.\n- **Templates:** values such as \`{{ avocado.target.board }}\` and \`{{ config.distro.release }}\` are resolved by the CLI.\n- **Packages:** the schema does not check package names. Verify them with \`search-packages\`.\n\n## Schema Content\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
          },
        ],
      };
    },
  );
}
