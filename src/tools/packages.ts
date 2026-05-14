import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RepoClient, type SearchResult } from "../lib/repo-client.js";

export function registerPackageTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.tool(
    "describe-package",
    "Show detail for a single package by exact name across one or more targets: version, arch, summary, description, and which repo provides it. Use this to confirm a package exists before referencing it in avocado.yaml, OR to answer 'does package X exist for target Y?' as a standalone question — no project required.",
    {
      targets: z
        .array(z.string())
        .min(1)
        .describe("Target names to look up the package in."),
      name: z.string().describe("Exact package name."),
      release: z
        .string()
        .optional()
        .describe(
          "Release year. Defaults to '2024'. Only override if you're targeting an older or experimental stream.",
        ),
      channel: z
        .string()
        .optional()
        .describe(
          "Release channel. Defaults to 'edge'. Other valid values today: 'apollo'.",
        ),
    },
    async ({ targets, name, release, channel }) => {
      try {
        const { results } = await repoClient.searchPackages(
          targets,
          name,
          200,
          release,
          channel,
        );
        const exact = results.filter((r) => r.name === name);
        if (exact.length === 0) {
          const near = results.slice(0, 5);
          return {
            content: [
              {
                type: "text",
                text: `# describe-package\n\nNo exact match for \`${name}\` in ${targets.map((t) => `\`${t}\``).join(", ")}.${
                  near.length
                    ? `\n\nNearest matches: ${near.map((r) => `\`${r.name}\``).join(", ")}.`
                    : ""
                }`,
              },
            ],
          };
        }
        let out = `# describe-package — \`${name}\`\n\n`;
        for (const p of exact) {
          out += `## \`${p.repo}\`\n\n`;
          out += `- **Version:** ${p.version}${p.release ? `-${p.release}` : ""}\n`;
          out += `- **Arch:** \`${p.arch}\`\n`;
          out += `- **Summary:** ${p.summary || "_(none)_"}\n`;
          if (p.description) {
            out += `\n${p.description}\n`;
          }
          out += `\n`;
        }
        return {
          content: [
            { type: "text", text: out },
            {
              type: "text",
              text: `\n\`\`\`json\n${JSON.stringify(exact, null, 2)}\n\`\`\``,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# describe-package failed\n\n❌ ${error}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "search-packages",
    "Search the live Avocado OS package feed for one or more targets. Matches package name and summary (case-insensitive), ranked by where the hit lands — same default behaviour as `avocado sdk dnf search`. **No avocado.yaml or local project required**: pass a target name and a query and you get live results from repo.avocadolinux.org. Use this to verify packages before referencing them in YAML, or as a standalone 'is package X available for target Y?' lookup. Description matching is NOT included — use `describe-package` for full-text details on a specific name.",
    {
      targets: z
        .array(z.string())
        .min(1)
        .describe(
          "Target names (e.g. ['raspberrypi5', 'jetson-orin-nano-devkit']). Must match entries from list-targets. Pass one or more.",
        ),
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text search. Matches packages whose name or summary contains this text (case-insensitive). Examples: 'openssh', 'kernel-module-gpio', 'gstreamer', 'python3'.",
        ),
      limit: z
        .number()
        .int()
        .positive()
        .optional()
        .describe("Maximum results to return. Default 50."),
      release: z
        .string()
        .optional()
        .describe(
          "Release year. Defaults to '2024'. Only override if you're targeting an older or experimental stream.",
        ),
      channel: z
        .string()
        .optional()
        .describe(
          "Release channel. Defaults to 'edge'. Other valid values today: 'apollo'.",
        ),
    },
    async ({ targets, query, limit, release, channel }) => {
      try {
        const { totalMatches, results, errors } =
          await repoClient.searchPackages(
            targets,
            query,
            limit ?? 50,
            release,
            channel,
          );
        return {
          content: [
            {
              type: "text",
              text: renderSummary(
                query,
                targets,
                totalMatches,
                results,
                errors,
                release,
                channel,
              ),
            },
            {
              type: "text",
              text: `\n## Full results (JSON)\n\n\`\`\`json\n${JSON.stringify(results, null, 2)}\n\`\`\``,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# search-packages failed\n\n❌ ${error}\n\n## Troubleshooting\n\n1. **Check the target name.** It must match an entry in https://repo.avocadolinux.org/2024/edge/targets.json.\n2. **Check connectivity.** The server must reach repo.avocadolinux.org.\n3. **Try a simpler query.** The search is a plain substring match against name + summary.`,
            },
          ],
        };
      }
    },
  );
}

function renderSummary(
  query: string,
  targets: string[],
  totalMatches: number,
  results: SearchResult[],
  errors: { target: string; messages: string[] }[],
  release?: string,
  channel?: string,
): string {
  let out = `# search-packages\n\n`;
  out += `**Query:** \`${query}\`\n`;
  out += `**Targets:** ${targets.map((t) => `\`${t}\``).join(", ")}\n`;
  out += `**Stream:** \`${release ?? "2024"}/${channel ?? "edge"}\`\n`;
  out += `**Total matches:** ${totalMatches}${results.length < totalMatches ? ` (showing first ${results.length})` : ""}\n\n`;

  if (errors.length > 0) {
    out += `## Repo errors (non-fatal)\n\n`;
    for (const e of errors) {
      out += `- **${e.target}**: ${e.messages.join("; ")}\n`;
    }
    out += `\n`;
  }

  if (results.length === 0) {
    out += `No packages matched. Confirm the target name exists in targets.json and try a broader query.\n`;
    return out;
  }

  out += `## Results\n\n`;
  out += `| Name | Version | Arch | Repo | Summary |\n`;
  out += `|------|---------|------|------|---------|\n`;
  for (const r of results) {
    const ver = r.release ? `${r.version}-${r.release}` : r.version;
    const summary = r.summary.replace(/\|/g, "\\|").slice(0, 80);
    out += `| \`${r.name}\` | ${ver} | ${r.arch} | \`${r.repo}\` | ${summary} |\n`;
  }
  return out;
}
