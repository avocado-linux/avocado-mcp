import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { statfs } from "fs/promises";
import { arch as osArch, platform as osPlatform, homedir } from "os";
import { RepoClient } from "../lib/repo-client.js";
import { resolveTarget } from "../lib/target-resolver.js";

/**
 * Normalize Node's `os.arch()` to the same vocabulary the rest of the MCP
 * uses for target arch (e.g. `qemux86-64` → `x86-64`, `qemuarm64` → `arm64`).
 */
export function normalizedHostArch(): "arm64" | "x86-64" | "other" {
  const a = osArch();
  if (a === "arm64" || a === "aarch64") return "arm64";
  if (a === "x64" || a === "x86_64") return "x86-64";
  return "other";
}

/**
 * Best-effort: given a target slug, return its arch family for cross-arch
 * comparison with the host. Only QEMU targets carry an obvious arch hint in
 * the slug. Returns `null` when we can't tell (most physical targets — the
 * BSP packaging knows the arch, the slug alone doesn't).
 */
export function targetArchHint(target: string): "arm64" | "x86-64" | null {
  if (target === "qemuarm64") return "arm64";
  if (target === "qemux86-64") return "x86-64";
  if (target.startsWith("intel-x86-64")) return "x86-64";
  return null;
}

/**
 * If the target is a QEMU target whose arch doesn't match the host, return
 * a markdown advisory the LLM should surface to the user. Returns `null`
 * when no warning is warranted (same arch, non-QEMU target, or unknown
 * host arch). Performance-only — does NOT block; the user may have
 * legitimate cross-arch reasons.
 */
export function qemuArchAdvisory(target: string): string | null {
  if (!target.startsWith("qemu")) return null;
  const host = normalizedHostArch();
  const tgt = targetArchHint(target);
  if (host === "other" || tgt === null) return null;
  if (host === tgt) return null;

  const recommendedTarget = host === "arm64" ? "qemuarm64" : "qemux86-64";
  return [
    `> ⚠️  **Cross-arch QEMU — performance advisory.** Host is \`${host}\`; you're targeting \`${target}\` (\`${tgt}\`).`,
    `>`,
    `> A QEMU VM whose arch doesn't match the host boots under software emulation — typically **10–20× slower** than a matched-arch VM with hardware acceleration (HVF on macOS, KVM on Linux). For iteration loops (build → boot → debug → rebuild) that's the difference between seconds and minutes per cycle.`,
    `>`,
    `> **Faster path:** use \`--target ${recommendedTarget}\` for native-speed iteration.`,
    `>`,
    `> **Keep \`${target}\` if** you specifically need to test x86/arm-shape behaviour — cross-arch QEMU testing before real hardware is available, or to validate target-specific binaries. The choice is yours; this is performance guidance only, not a blocker.`,
  ].join("\n");
}

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
        "Verify the host has the prerequisites to build and provision an Avocado OS project: `avocado` CLI on PATH, Docker daemon reachable, and ≥8 GB free disk space in $HOME. Also reports host CPU arch + OS so downstream tools (e.g. `init-project`) can warn about cross-arch QEMU performance gotchas. Call this BEFORE init-project / list-targets when the user is starting from scratch — it pre-empts the common `bash: avocado: command not found` and `Cannot connect to the Docker daemon` failures. Read-only: runs `avocado --version`, `docker info`, and statfs($HOME). No project required.",
      inputSchema: {},
      outputSchema: {
        ok: z.boolean().describe("True iff all three checks pass."),
        host: z.object({
          arch: z
            .enum(["arm64", "x86-64", "other"])
            .describe(
              "Normalized host CPU architecture. `arm64` includes Apple Silicon. `other` covers anything unexpected (32-bit ARM, RISC-V, etc.).",
            ),
          platform: z
            .string()
            .describe(
              "Node-reported OS family (`darwin`, `linux`, `win32`, etc.).",
            ),
        }),
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

      const host = { arch: normalizedHostArch(), platform: osPlatform() };
      const allOk = cli.ok && docker.ok && disk.ok;
      let out = `# environment-check\n\n`;
      out += `**Status:** ${allOk ? "✅ ready" : "❌ missing prerequisites"}\n`;
      out += `**Host:** \`${host.platform}\` / \`${host.arch}\`\n\n`;
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
          host,
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
