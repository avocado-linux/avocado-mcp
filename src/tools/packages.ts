import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RepoClient } from "../lib/repo-client.js";
import { resolveTarget } from "../lib/target-resolver.js";

async function validateTargets(
  repoClient: RepoClient,
  targets: string[],
): Promise<{ ok: true } | { ok: false; message: string }> {
  const config = await repoClient.getTargetsConfig();
  if (!config) {
    return {
      ok: false,
      message: `Could not fetch targets.json from repo.avocadolinux.org to validate target names. Check network and try again.`,
    };
  }
  const all = Object.keys(config);
  const unknown = targets.filter((t) => !config[t]);
  if (unknown.length === 0) return { ok: true };
  const lines: string[] = [];
  for (const u of unknown) {
    const fuzzy = resolveTarget(u, all).slice(0, 3);
    if (fuzzy.length > 0) {
      lines.push(
        `- \`${u}\` is not a supported target. Did you mean: ${fuzzy.map((t) => `\`${t}\``).join(", ")}?`,
      );
    } else {
      lines.push(`- \`${u}\` is not a supported target.`);
    }
  }
  return {
    ok: false,
    message: [
      `❌ Unsupported target(s):`,
      ``,
      ...lines,
      ``,
      `**Supported targets (${all.length}):** ${all
        .sort()
        .map((t) => `\`${t}\``)
        .join(", ")}`,
      ``,
      `Only these targets are valid. Use \`list-targets({ query: "..." })\` to search.`,
    ].join("\n"),
  };
}

export function registerPackageTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.registerTool(
    "describe-package",
    {
      title: "Describe one Avocado package",
      description:
        "Show detail for a single package by exact name across one or more targets: version, arch, summary, description, and which repo provides it. Use this to confirm a package exists before referencing it in avocado.yaml, OR to answer 'does package X exist for target Y?' as a standalone question — no project required.",
      inputSchema: {
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
      outputSchema: {
        name: z.string(),
        found: z.boolean(),
        results: z.array(
          z.object({
            repo: z.string(),
            version: z.string(),
            release: z.string().optional(),
            arch: z.string(),
            summary: z.string(),
            description: z.string().optional(),
          }),
        ),
        nearest: z
          .array(z.string())
          .optional()
          .describe("If no exact match, top-N near package names."),
      },
      annotations: {
        title: "Describe one Avocado package",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ targets, name, release, channel }) => {
      const targetCheck = await validateTargets(repoClient, targets);
      if (!targetCheck.ok) {
        return {
          content: [
            {
              type: "text",
              text: `# describe-package failed\n\n${targetCheck.message}`,
            },
          ],
          structuredContent: { name, found: false, results: [] },
          isError: true,
        };
      }
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
            structuredContent: {
              name,
              found: false,
              results: [],
              nearest: near.map((r) => r.name),
            },
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
          content: [{ type: "text", text: out }],
          structuredContent: {
            name,
            found: true,
            results: exact.map((p) => ({
              repo: p.repo,
              version: p.version,
              release: p.release,
              arch: p.arch,
              summary: p.summary,
              description: p.description,
            })),
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# describe-package failed\n\n❌ ${error}`,
            },
          ],
          structuredContent: { name, found: false, results: [] },
          isError: true,
        };
      }
    },
  );

  const packageResultSchema = z.object({
    name: z.string(),
    version: z.string(),
    release: z.string(),
    arch: z.string(),
    repo: z.string(),
    summary: z.string(),
  });

  server.registerTool(
    "search-packages",
    {
      title: "Search Avocado package feed",
      description:
        "Search the live Avocado OS package feed for one or more targets. **This is the first move when the user wants to add ANY library / dependency / system package.** Always check the feed before suggesting `pip install`, `npm install`, `cargo add`, `apt install`, or vendoring — feed packages are version-tracked, dependency-resolved, security-updatable via OTA, and don't bloat the extension image. Matches package name and summary (case-insensitive), ranked by where the hit lands — same default behaviour as `avocado sdk dnf search`. **No avocado.yaml or local project required**: pass a target name and a query and you get live results from repo.avocadolinux.org. Description matching is NOT included — use `describe-package` for full-text details on a specific name. See `avocado://skills/app-development` for the feed-first workflow.",
      inputSchema: {
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
      outputSchema: {
        query: z.string(),
        targets: z.array(z.string()),
        release: z.string(),
        channel: z.string(),
        totalMatches: z.number().int(),
        shown: z.number().int(),
        results: z.array(packageResultSchema),
        errors: z.array(
          z.object({
            target: z.string(),
            messages: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        title: "Search Avocado package feed",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ targets, query, limit, release, channel }) => {
      const targetCheck = await validateTargets(repoClient, targets);
      if (!targetCheck.ok) {
        return {
          content: [
            {
              type: "text",
              text: `# search-packages failed\n\n${targetCheck.message}`,
            },
          ],
          structuredContent: {
            query,
            targets,
            release: release ?? "2024",
            channel: channel ?? "edge",
            totalMatches: 0,
            shown: 0,
            results: [],
            errors: [],
          },
          isError: true,
        };
      }
      try {
        const { totalMatches, results, errors } =
          await repoClient.searchPackages(
            targets,
            query,
            limit ?? 50,
            release,
            channel,
          );
        const trimmed = results.map((r) => ({
          name: r.name,
          version: r.version,
          release: r.release,
          arch: r.arch,
          repo: r.repo,
          summary: r.summary,
        }));
        return {
          content: [
            {
              type: "text",
              text: renderHeader(
                query,
                targets,
                totalMatches,
                results.length,
                errors,
                release,
                channel,
              ),
            },
            {
              type: "text",
              text: `\n\`\`\`json\n${JSON.stringify(trimmed, null, 2)}\n\`\`\`\n\n_Per-result \`description\` is omitted to save context. Use \`describe-package\` for full details on a specific name._`,
            },
          ],
          structuredContent: {
            query,
            targets,
            release: release ?? "2024",
            channel: channel ?? "edge",
            totalMatches,
            shown: results.length,
            results: trimmed,
            errors,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# search-packages failed\n\n❌ ${error}\n\n## Troubleshooting\n\n1. **Check the target name.** It must match an entry in https://repo.avocadolinux.org/2024/edge/targets.json.\n2. **Check connectivity.** The server must reach repo.avocadolinux.org.\n3. **Try a simpler query.** The search is a plain substring match against name + summary.`,
            },
          ],
          structuredContent: {
            query,
            targets,
            release: release ?? "2024",
            channel: channel ?? "edge",
            totalMatches: 0,
            shown: 0,
            results: [],
            errors: [],
          },
          isError: true,
        };
      }
    },
  );
}

function renderHeader(
  query: string,
  targets: string[],
  totalMatches: number,
  shown: number,
  errors: { target: string; messages: string[] }[],
  release?: string,
  channel?: string,
): string {
  let out = `# search-packages\n\n`;
  out += `**Query:** \`${query}\`\n`;
  out += `**Targets:** ${targets.map((t) => `\`${t}\``).join(", ")}\n`;
  out += `**Stream:** \`${release ?? "2024"}/${channel ?? "edge"}\`\n`;
  out += `**Total matches:** ${totalMatches}${shown < totalMatches ? ` (showing first ${shown})` : ""}\n`;

  if (errors.length > 0) {
    out += `\n## Repo errors (non-fatal)\n\n`;
    for (const e of errors) {
      out += `- **${e.target}**: ${e.messages.join("; ")}\n`;
    }
  }

  if (shown === 0) {
    out += `\nNo packages matched. Confirm the target name exists in targets.json and try a broader query.\n`;
  }
  return out;
}
