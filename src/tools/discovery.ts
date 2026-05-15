import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RepoClient } from "../lib/repo-client.js";

export function registerDiscoveryTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.tool(
    "list-targets",
    "List every Avocado OS hardware target currently supported by the package feed. Returns the target string (used in avocado.yaml), and the list of repodata directories backing each target. Always consult this before assuming a target name — the canonical list is fetched live from repo.avocadolinux.org.",
    {},
    async () => {
      const config = await repoClient.getTargetsConfig();
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `# list-targets failed\n\nCould not fetch \`targets.json\` from repo.avocadolinux.org. Check network and try again.`,
            },
          ],
        };
      }

      const entries = Object.entries(config).sort(([a], [b]) =>
        a.localeCompare(b),
      );

      let out = `# list-targets\n\n**Total:** ${entries.length} targets\n\n`;
      out += `| Target | Repodata directories |\n`;
      out += `|--------|----------------------|\n`;
      for (const [target, repos] of entries) {
        out += `| \`${target}\` | ${repos.map((r) => `\`${r}\``).join(", ")} |\n`;
      }
      out += `\n_Use any of these target strings as the value of \`default_target\` or \`supported_targets\` in \`avocado.yaml\`._`;

      return { content: [{ type: "text", text: out }] };
    },
  );
}
