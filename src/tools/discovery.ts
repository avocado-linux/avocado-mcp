import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { statfs } from "fs/promises";
import { arch as osArch, platform as osPlatform, homedir } from "os";
import { RepoClient, normalizeStream } from "../lib/repo-client.js";
import { resolveTarget } from "../lib/target-resolver.js";
import {
  getSelectableSlugs,
  filterSelectable,
} from "../lib/hardware-support.js";
import { probeHostMcp, HOST_MCP_URL } from "../lib/cli-channel.js";

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

/**
 * Probe the container engine the CLI will actually use, per platform.
 *
 * On macOS the avocado-vm supplies dockerd and the CLI routes to it
 * transparently (it forwards the VM's socket and sets DOCKER_HOST *inside its
 * own process only*). So a bare `docker info` from HERE is meaningless — it
 * won't see the VM's daemon. We check the VM instead, and Docker Desktop is
 * NOT required. On Linux the CLI uses the host's native Docker Engine directly,
 * so a plain `docker info` is the right probe.
 *
 * See `avocado://skills/container-backend` for the full model.
 */
async function checkContainerEngine(
  platform: string,
): Promise<{ ok: boolean; detail: string }> {
  const dockerInfo = () =>
    checkBinary("docker", ["info", "--format", "{{.ServerVersion}}"]);

  if (platform === "darwin") {
    // `avocado vm status` exits 0 whether the VM is running or not, so parse
    // stdout rather than the exit code.
    try {
      const { stdout } = await execFileP("avocado", ["vm", "status"], {
        timeout: 5000,
      });
      if (/running \(pid/i.test(stdout)) {
        return {
          ok: true,
          detail:
            "avocado-vm running — it supplies Docker (Docker Desktop not necessary)",
        };
      }
      // VM tooling present but not running. Not a blocker: the CLI starts it
      // on the first build (or `avocado vm start`). If it was never installed,
      // that first start prints an `avocado vm update` hint.
      return {
        ok: true,
        detail:
          "avocado-vm not running — it starts on the first build, or run `avocado vm start` (first time: `avocado vm update`)",
      };
    } catch (e) {
      // `avocado vm status` failed (old CLI without the subcommand, or avocado
      // not on PATH). Fall back to a locally-installed Docker daemon if any.
      const d = await dockerInfo();
      if (d.ok)
        return {
          ok: true,
          detail: `local Docker daemon reachable (${d.detail})`,
        };
      const err = e as NodeJS.ErrnoException;
      const why =
        err.code === "ENOENT"
          ? "avocado CLI not on PATH"
          : "`avocado vm status` failed";
      return {
        ok: false,
        detail: `no avocado-vm (${why}) and no local Docker daemon`,
      };
    }
  }

  // Linux (and anything else): native Docker Engine.
  const d = await dockerInfo();
  return {
    ok: d.ok,
    detail: d.ok ? `native Docker Engine (${d.detail})` : d.detail,
  };
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

/**
 * `qemu-system-<arch>` presence. We probe the binary that matches the host
 * arch since that's the one a same-arch QEMU target needs (HVF / KVM). Note:
 * QEMU is ONLY required for QEMU-target workflows — `environment-check` does
 * not include this. It's exposed for `get-provisioning-steps` to call when
 * the resolved target is a QEMU one.
 */
export async function checkQemu(): Promise<{ ok: boolean; detail: string }> {
  const host = normalizedHostArch();
  // Same-arch QEMU is the common path; check it. Users doing cross-arch QEMU
  // need the other one too, but we already advise against that.
  const binary =
    host === "arm64"
      ? "qemu-system-aarch64"
      : host === "x86-64"
        ? "qemu-system-x86_64"
        : null;
  if (!binary) {
    return { ok: false, detail: `host arch '${host}' — unknown QEMU binary` };
  }
  return checkBinary(binary, ["--version"]);
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
        "Verify the host has the prerequisites to build and provision an Avocado OS project: `avocado` CLI on PATH, a working container engine, and ≥8 GB free disk space in $HOME. On macOS the container engine is the avocado-vm, which supplies Docker, so Docker Desktop is not required. On Linux it is the native Docker Engine. Also (a) reports host CPU arch + OS so downstream tools (e.g. `init-project`) can warn about cross-arch QEMU performance gotchas, and (b) detects the avocado-cli execution channel for this session — when reachable, the Avocado desktop's host MCP runs CLI commands on the user's Mac (their CLI, their config, their keys) so the LLM doesn't have to invoke the CLI directly. Call this BEFORE init-project / list-targets / build-and-deploy so subsequent steps follow the right invocation pattern. **QEMU-target prerequisites** (qemu-system-*) are NOT checked here — `get-provisioning-steps` validates those when the resolved target is a QEMU one. Read-only.",
      inputSchema: {},
      outputSchema: {
        ok: z
          .boolean()
          .describe(
            "True iff the session is ready to invoke avocado-cli — either all local checks pass, or the host MCP is delegating CLI calls.",
          ),
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
        executionChannel: z.object({
          mode: z
            .enum(["host-tool", "bash"])
            .describe(
              "`host-tool` when the Avocado desktop's MCP is reachable and will run avocado-cli on the user's Mac. `bash` for a normal developer workstation — the LLM invokes `avocado` via its Bash tool.",
            ),
          runToolName: z.string().optional(),
          statusToolName: z.string().optional(),
          awaitToolName: z.string().optional(),
          detail: z.string(),
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
      const host = { arch: normalizedHostArch(), platform: osPlatform() };
      const [cli, docker, disk, delegation] = await Promise.all([
        checkBinary("avocado", ["--version"]),
        checkContainerEngine(host.platform),
        checkDiskGB(),
        probeHostMcp(),
      ]);
      const isMac = host.platform === "darwin";

      // When the host MCP is delegating CLI calls, the LOCAL avocado /
      // Docker / disk checks describe an environment we don't actually
      // use — the binary, SDK container, and disk that matter are on
      // the Mac, behind the host tool. So we gate readiness on
      // whichever environment will run avocado-cli for this session.
      const localOk = cli.ok && docker.ok && disk.ok;
      const ready = delegation.available || localOk;

      let out = `# environment-check\n\n`;
      out += `**Status:** ${ready ? "✅ ready" : "❌ missing prerequisites"}\n`;
      out += `**Host:** \`${host.platform}\` / \`${host.arch}\`\n`;
      if (delegation.available) {
        out += `**Execution channel:** \`host-tool\` (avocado-cli runs on the Mac via the Avocado desktop's host MCP).\n\n`;
        out += `_Local checks below are informational — this session delegates CLI calls to the host, so these don't gate readiness:_\n\n`;
      } else {
        out += `**Execution channel:** \`bash\` (avocado-cli runs locally via your Bash tool).\n\n`;
      }
      out += `| Check | Status | Detail |\n`;
      out += `|-------|--------|--------|\n`;
      out += `| \`avocado\` CLI on PATH | ${cli.ok ? "✅" : "❌"} | ${cli.detail} |\n`;
      out += `| Container engine | ${docker.ok ? "✅" : "❌"} | ${docker.detail} |\n`;
      out += `| Free disk (\`$HOME\`) | ${disk.ok ? "✅" : "❌"} | ${disk.freeGB.toFixed(1)} GB free (need ≥${MIN_FREE_GB}) |\n`;

      out += `\n## Avocado-CLI execution channel\n\n`;
      if (delegation.available) {
        out += `- **Channel:** \`host-tool\`.\n`;
        out += `- **Start a run with:** \`${delegation.runToolName}\` (returns a \`run_id\` immediately). Pass \`{ "args": ["build"], "project": "<name>" }\` or similar — do NOT pass \`--no-tui\`, the host already runs the CLI non-interactively.\n`;
        if (delegation.awaitToolName) {
          out += `- **Wait with:** \`${delegation.awaitToolName}\` — blocks the response until the run hits terminal state and the host wakes the call within milliseconds of process exit. Default \`max_wait_seconds\` 240; loop the call if the response carries \`timedOut: true\`. This is the canonical wait pattern (replaces the older scheduled-poll loop).\n`;
          out += `- **Snapshot with:** \`${delegation.statusToolName}\` — one-shot status only (use inside scheduled follow-ups, or after you already know a run is terminal). Don't spin-poll it in-turn.\n`;
        } else {
          out += `- **Poll with:** \`${delegation.statusToolName}\` using the returned \`run_id\` until \`status\` is no longer \`running\`. Output (merged stdout+stderr, line-preserved) comes back in \`outputTail\`. (Note: this host MCP doesn't advertise \`await_avocado_cli\` — if it did, prefer that; it's a host-push wake with no scheduled-poll latency.)\n`;
        }
        out += `- **Do NOT also run \`avocado\` via your Bash tool** in this session — it would run inside the VM with a different CLI, config, and credential set than the user's host install. Read \`avocado://skills/avocado-cli-execution\` for the full contract.\n`;
      } else {
        out += `- **Channel:** \`bash\`.\n`;
        out += `- **Probe of \`${HOST_MCP_URL}\`:** ${delegation.detail}. This is the normal channel on a developer workstation.\n`;
        out += `- **Use the redirect-to-file + tail + grep pattern** in \`avocado://skills/avocado-cli-execution\` so long CLI output doesn't flood context.\n`;
      }

      const fixes: string[] = [];
      // Local-CLI fixes only surface when we'll actually use the local
      // CLI. If the host MCP is delegating, missing local avocado /
      // docker / disk isn't a blocker for this session.
      if (!delegation.available) {
        if (!cli.ok) {
          fixes.push(
            `- **Install the avocado CLI and put it on PATH:** \`${INSTALL_HINT}\` (macOS / Linux). If you have a local build of the CLI but it's not on PATH, symlink it: \`mkdir -p ~/.local/bin && ln -s /path/to/avocado ~/.local/bin/avocado\` (then ensure \`~/.local/bin\` is on PATH).`,
          );
        }
        if (!docker.ok) {
          fixes.push(
            isMac
              ? `- **Set up the container engine (avocado-vm):** on macOS the avocado-vm supplies Docker. Docker Desktop is not necessary. Install or update it with \`avocado vm update\`. Then run \`avocado vm start\`. The VM also starts on your first \`avocado build\`. For more information, see \`avocado://skills/container-backend\`.`
              : `- **Start Docker Engine:** install the native Docker Engine (Docker Desktop is not necessary). Start the daemon with \`sudo systemctl start docker\`. The command \`docker info\` must succeed. For more information, see \`avocado://skills/container-backend\`.`,
          );
        }
        if (!disk.ok) {
          fixes.push(
            `- **Free disk space:** the SDK container + builds need ≥${MIN_FREE_GB} GB. Clear caches or move builds to a larger volume.`,
          );
        }
      }
      if (fixes.length > 0) {
        out += `\n## Fix\n\n${fixes.join("\n")}\n`;
      } else if (ready) {
        out += `\nAll prerequisites satisfied. Safe to proceed with \`list-targets\` → \`init-project\`.\n`;
        out += `\n_QEMU prerequisites (\`qemu-system-*\`) are validated by \`get-provisioning-steps\` when the resolved target is a QEMU one — no need to check them here._\n`;
      }

      const executionChannel = delegation.available
        ? {
            mode: "host-tool" as const,
            runToolName: delegation.runToolName,
            statusToolName: delegation.statusToolName,
            awaitToolName: delegation.awaitToolName,
            detail: delegation.detail,
          }
        : { mode: "bash" as const, detail: delegation.detail };

      return {
        content: [{ type: "text", text: out }],
        structuredContent: {
          ok: ready,
          host,
          executionChannel,
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
        "List Avocado OS hardware targets from the live package feed. Pass `query` to narrow down — strongly recommended when the user has named hardware in their own words (e.g. 'rpi4', 'pi 5', 'jetson orin', 'intel x86'). The query does fuzzy-matching against the canonical slug; an exact match shortcuts to a single row. Without `query`, returns the full list. **Targets differ per release/channel** — newer hardware may exist only on a newer release (e.g. NVIDIA Thor on 2026, not 2024). Pass `release`/`channel` to list a specific stream; call it for each stream to discover which release supports a given board (or consult the docs support matrix at https://docs.peridio.com/hardware/support-matrix#supported).",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text hardware identifier in the user's words. Examples: 'raspberry pi 4', 'rpi4', 'jetson orin nano', 'imx8mp'. Token-based fuzzy match against the canonical slug. Returns top matches; exact match returns just that row.",
          ),
        release: z
          .string()
          .optional()
          .describe(
            "Release year to list targets for. Defaults to '2024'. Pass '2026' to see targets on the newer release.",
          ),
        channel: z
          .string()
          .optional()
          .describe(
            "Release channel. Defaults to 'edge'. Valid: 'next', 'edge', 'stable'.",
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
    async ({ query, release, channel }) => {
      const { rel, chan } = normalizeStream(release, channel);
      const config = await repoClient.getTargetsConfig(rel, chan);
      if (!config) {
        return {
          content: [
            {
              type: "text",
              text: `# list-targets failed\n\nCould not fetch \`targets.json\` for \`${rel}/${chan}\` from repo.avocadolinux.org. Check the release/channel and network, then try again.`,
            },
          ],
          structuredContent: { total: 0, query, matched: 0, targets: [] },
          isError: true,
        };
      }

      // The feed's targets.json carries arch/tune pseudo-targets alongside real
      // boards; the support matrix is the authoritative selectable set. Narrow
      // to it, but fall back to the full feed if the matrix can't be fetched so
      // a docs outage never hides targets.
      const feedTargets = Object.keys(config);
      const selectable = await getSelectableSlugs();
      const allTargets = selectable
        ? filterSelectable(feedTargets, selectable)
        : feedTargets;
      const entries = (
        query
          ? resolveTarget(query, allTargets).map(
              (t) => [t, config[t]] as [string, string[]],
            )
          : allTargets.map((t) => [t, config[t]] as [string, string[]])
      ).sort(([a], [b]) => a.localeCompare(b));

      const structuredContent = {
        total: allTargets.length,
        query,
        matched: entries.length,
        targets: entries.map(([slug, repos]) => ({ slug, repos })),
      };

      let out = `# list-targets\n\n**Stream:** \`${rel}/${chan}\`\n\n`;
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
      out += selectable
        ? `\n_These are the user-selectable targets from the [support matrix](https://docs.peridio.com/hardware/support-matrix); use any as \`default_target\` / \`supported_targets\` in \`avocado.yaml\`. (Arch/tune pseudo-targets in the raw feed are filtered out.)_`
        : `\n_⚠️ Support matrix unavailable — showing the raw \`${rel}/${chan}\` feed, which may include arch/tune pseudo-targets that aren't user-selectable. Use any board string as \`default_target\` / \`supported_targets\` in \`avocado.yaml\`._`;

      return {
        content: [{ type: "text", text: out }],
        structuredContent,
      };
    },
  );
}
