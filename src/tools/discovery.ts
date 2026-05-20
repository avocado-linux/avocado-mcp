import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { statfs } from "fs/promises";
import { homedir } from "os";
import { RepoClient } from "../lib/repo-client.js";
import { resolveTarget } from "../lib/target-resolver.js";

const execFileP = promisify(execFile);

const MIN_FREE_GB = 8;
const INSTALL_HINT = "curl -fsSL https://connect.peridio.com/install.sh | sh";

async function checkBinary(
  cmd: string,
  args: string[],
): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout, stderr } = await execFileP(cmd, args, { timeout: 5000 });
    const first = (stdout || stderr).split("\n")[0]?.trim() ?? "";
    return { ok: true, detail: first || "(no version output)" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string };
    if (err.code === "ENOENT") return { ok: false, detail: "not on PATH" };
    const stderr = (err.stderr ?? "").split("\n")[0]?.trim();
    return { ok: false, detail: stderr || err.message || "failed" };
  }
}

async function checkDiskGB(): Promise<{ ok: boolean; freeGB: number }> {
  try {
    const s = await statfs(homedir());
    const freeBytes = Number(s.bavail) * Number(s.bsize);
    const freeGB = freeBytes / 1024 ** 3;
    return { ok: freeGB >= MIN_FREE_GB, freeGB };
  } catch {
    return { ok: false, freeGB: 0 };
  }
}

export function registerDiscoveryTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.registerTool(
    "environment-check",
    {
      title: "Check host prerequisites",
      description:
        "Verify the host has the prerequisites to build and provision an Avocado OS project: `avocado` CLI on PATH, Docker daemon reachable, and ≥8 GB free disk space in $HOME. Call this BEFORE init-project / list-targets when the user is starting from scratch — it pre-empts the common `bash: avocado: command not found` and `Cannot connect to the Docker daemon` failures. Read-only: runs `avocado --version`, `docker info`, and statfs($HOME). No project required.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean().describe("True iff all three checks pass."),
        cli: z.object({
          ok: z.boolean(),
          detail: z
            .string()
            .describe("Version output if present, or failure message."),
        }),
        docker: z.object({
          ok: z.boolean(),
          detail: z.string(),
        }),
        disk: z.object({
          ok: z.boolean(),
          freeGB: z.number().describe("Free GB in $HOME"),
          minGB: z.number().describe("Minimum required free GB"),
        }),
        fixes: z
          .array(z.string())
          .describe("Markdown-formatted remediation lines, empty when ok."),
      },
      annotations: {
        title: "Check host prerequisites",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const [cli, docker, disk] = await Promise.all([
        checkBinary("avocado", ["--version"]),
        checkBinary("docker", ["info", "--format", "{{.ServerVersion}}"]),
        checkDiskGB(),
      ]);

      const allOk = cli.ok && docker.ok && disk.ok;
      let out = `# environment-check\n\n`;
      out += `**Status:** ${allOk ? "✅ ready" : "❌ missing prerequisites"}\n\n`;
      out += `| Check | Status | Detail |\n`;
      out += `|-------|--------|--------|\n`;
      out += `| \`avocado\` CLI | ${cli.ok ? "✅" : "❌"} | ${cli.detail} |\n`;
      out += `| Docker daemon | ${docker.ok ? "✅" : "❌"} | ${docker.detail} |\n`;
      out += `| Free disk (\`$HOME\`) | ${disk.ok ? "✅" : "❌"} | ${disk.freeGB.toFixed(1)} GB free (need ≥${MIN_FREE_GB}) |\n`;

      const fixes: string[] = [];
      if (!cli.ok) {
        fixes.push(
          `- **Install the avocado CLI:** \`${INSTALL_HINT}\` (macOS / Linux).`,
        );
      }
      if (!docker.ok) {
        fixes.push(
          `- **Start Docker:** install Docker Desktop (macOS) or the \`docker\` engine (Linux), then ensure the daemon is running (\`docker info\` should succeed).`,
        );
      }
      if (!disk.ok) {
        fixes.push(
          `- **Free disk space:** the SDK container + builds need ≥${MIN_FREE_GB} GB. Clear caches or move builds to a larger volume.`,
        );
      }
      if (fixes.length > 0) {
        out += `\n## Fix\n\n${fixes.join("\n")}\n`;
      } else {
        out += `\nAll prerequisites satisfied. Safe to proceed with \`list-targets\` → \`init-project\`.\n`;
      }

      return {
        content: [{ type: "text", text: out }],
        structuredContent: {
          ok: allOk,
          cli,
          docker,
          disk: { ok: disk.ok, freeGB: disk.freeGB, minGB: MIN_FREE_GB },
          fixes,
        },
      };
    },
  );

  server.registerTool(
    "list-targets",
    {
      title: "List Avocado OS targets",
      description:
        "List Avocado OS hardware targets from the live package feed. Pass `query` to narrow down — strongly recommended when the user has named hardware in their own words (e.g. 'rpi4', 'pi 5', 'jetson orin', 'intel x86'). The query does fuzzy-matching against the canonical slug; an exact match shortcuts to a single row. Without `query`, returns the full list.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text hardware identifier in the user's words. Examples: 'raspberry pi 4', 'rpi4', 'jetson orin nano', 'imx8mp'. Token-based fuzzy match against the canonical slug. Returns top matches; exact match returns just that row.",
          ),
      },
      outputSchema: {
        total: z
          .number()
          .int()
          .describe(
            "Total targets in the feed (independent of any `query` filter).",
          ),
        query: z
          .string()
          .optional()
          .describe("The query filter that was applied, if any."),
        matched: z
          .number()
          .int()
          .describe(
            "Number of targets returned. Equals `total` when no `query` is supplied.",
          ),
        targets: z
          .array(
            z.object({
              slug: z
                .string()
                .describe(
                  "Canonical target slug — use this as `default_target` / `supported_targets` in avocado.yaml.",
                ),
              repos: z
                .array(z.string())
                .describe("Repodata directories backing this target."),
            }),
          )
          .describe("Matching targets, sorted by slug."),
      },
      annotations: {
        title: "List Avocado OS targets",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query }) => {
      const config = await repoClient.getTargetsConfig();
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `# list-targets failed\n\nCould not fetch \`targets.json\` from repo.avocadolinux.org. Check network and try again.`,
            },
          ],
          structuredContent: { total: 0, query, matched: 0, targets: [] },
          isError: true,
        };
      }

      const allTargets = Object.keys(config);
      const entries = (
        query
          ? resolveTarget(query, allTargets).map(
              (t) => [t, config[t]] as [string, string[]],
            )
          : Object.entries(config)
      ).sort(([a], [b]) => a.localeCompare(b));

      const structuredContent = {
        total: allTargets.length,
        query,
        matched: entries.length,
        targets: entries.map(([slug, repos]) => ({ slug, repos })),
      };

      let out = `# list-targets\n\n`;
      if (query) {
        out += `**Query:** \`${query}\`  •  **Matches:** ${entries.length} of ${allTargets.length}\n\n`;
        if (entries.length === 0) {
          out += `_No targets matched._ Drop the \`query\` arg to see the full list.`;
          return {
            content: [{ type: "text", text: out }],
            structuredContent,
          };
        }
      } else {
        out += `**Total:** ${entries.length} targets\n\n`;
      }
      out += `| Target | Repodata directories |\n`;
      out += `|--------|----------------------|\n`;
      for (const [target, repos] of entries) {
        out += `| \`${target}\` | ${repos.map((r) => `\`${r}\``).join(", ")} |\n`;
      }
      out += `\n_Use any of these target strings as the value of \`default_target\` or \`supported_targets\` in \`avocado.yaml\`._`;

      return {
        content: [{ type: "text", text: out }],
        structuredContent,
      };
    },
  );
}
