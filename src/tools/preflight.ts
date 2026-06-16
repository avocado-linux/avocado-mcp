import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { homedir } from "os";
import { join, dirname } from "path";
import { mkdir, readFile, writeFile } from "fs/promises";
import { checkBinary } from "./discovery.js";

// Bump when REQUIRED_TOOLS changes so a sentinel written by an older server
// no longer satisfies the skip check and the preflight re-runs.
const PREFLIGHT_VERSION = 1;

interface RequiredTool {
  cmd: string;
  versionArgs: string[];
  why: string;
  install: string;
}

// Host-side tools the yocto-engineer skill shells out to before it ever
// enters a build env. The build-env tools (bitbake, recipetool, kas/bakar)
// are intentionally absent: they only exist inside `kas shell`, and the
// recipe tools that need them already self-gate on BUILDDIR.
const REQUIRED_TOOLS: RequiredTool[] = [
  {
    cmd: "gh",
    versionArgs: ["--version"],
    why: "build-system detection via `gh api`",
    install:
      "install the GitHub CLI from https://cli.github.com, then `gh auth login`",
  },
  {
    cmd: "curl",
    versionArgs: ["--version"],
    why: "LIC_FILES_CHKSUM md5 fetch",
    install: "install curl from your distro package manager",
  },
  {
    cmd: "git",
    versionArgs: ["--version"],
    why: "ls-remote SRCREV / branch resolution",
    install: "install git from your distro package manager",
  },
  {
    cmd: "uv",
    versionArgs: ["--version"],
    why: "installs oelint-adv",
    install: "curl -LsSf https://astral.sh/uv/install.sh | sh",
  },
  {
    cmd: "oelint-adv",
    versionArgs: ["--version"],
    why: "lint-recipe static analysis",
    install: "uv tool install oelint-adv",
  },
];

interface Sentinel {
  version: number;
  tools: string[];
  verifiedAt: string;
}

function sentinelPath(): string {
  const stateHome =
    process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(stateHome, "avocado-mcp", "yocto-engineer-preflight.json");
}

// A sentinel satisfies the skip only when it was written by the current
// PREFLIGHT_VERSION and covers exactly today's required-tool set. Either
// drifting re-triggers a full probe.
function sentinelSatisfies(s: Sentinel): boolean {
  if (s.version !== PREFLIGHT_VERSION) return false;
  const want = new Set(REQUIRED_TOOLS.map((t) => t.cmd));
  const have = new Set(s.tools);
  if (want.size !== have.size) return false;
  for (const c of want) if (!have.has(c)) return false;
  return true;
}

async function readSentinel(): Promise<Sentinel | null> {
  try {
    const raw = await readFile(sentinelPath(), "utf8");
    const parsed = JSON.parse(raw) as Sentinel;
    if (
      typeof parsed.version === "number" &&
      Array.isArray(parsed.tools) &&
      typeof parsed.verifiedAt === "string"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

async function writeSentinel(): Promise<void> {
  const path = sentinelPath();
  await mkdir(dirname(path), { recursive: true });
  const s: Sentinel = {
    version: PREFLIGHT_VERSION,
    tools: REQUIRED_TOOLS.map((t) => t.cmd),
    verifiedAt: new Date().toISOString(),
  };
  await writeFile(path, JSON.stringify(s, null, 2) + "\n", "utf8");
}

export function registerPreflightTools(server: McpServer): void {
  server.registerTool(
    "preflight-recipe-tools",
    {
      title: "Verify recipe-authoring toolchain (first-run gate)",
      description:
        "First-run gate for the yocto-engineer skill: verify the host-side tools the skill shells out to (`gh`, `curl`, `git`, `uv`, `oelint-adv`) are on PATH, then write a version-stamped sentinel so later runs skip the probe. Call this as the skill's Step 0. When a satisfying sentinel already exists the tool returns immediately with `skipped: true` and runs no probes. When any tool is missing it returns `ok: false` with a `fixes` list and does NOT write a sentinel, so the gate stays closed until the host is fixed. Pass `force: true` to re-probe and rewrite the sentinel even when one exists (use after installing a missing tool). Build-env tools (bitbake, recipetool, kas/bakar) are out of scope here — they live inside `kas shell` and the recipe tools that need them self-gate on BUILDDIR. Read-only except for the sentinel file under `$XDG_STATE_HOME/avocado-mcp/`.",
      inputSchema: {
        force: z
          .boolean()
          .optional()
          .describe(
            "Re-probe every tool and rewrite the sentinel even if a satisfying one already exists. Use after installing a previously-missing tool.",
          ),
      },
      outputSchema: {
        ok: z
          .boolean()
          .describe(
            "True iff every required tool is on PATH (or a satisfying sentinel let the probe be skipped).",
          ),
        skipped: z
          .boolean()
          .describe(
            "True when a satisfying sentinel short-circuited the probe; no tools were run.",
          ),
        sentinelWritten: z
          .boolean()
          .describe("True when this call wrote or refreshed the sentinel."),
        results: z
          .array(
            z.object({
              cmd: z.string(),
              ok: z.boolean(),
              detail: z.string(),
            }),
          )
          .describe("Per-tool probe results; empty when skipped."),
        missing: z
          .array(z.string())
          .describe("Names of tools not found on PATH; empty when ok."),
        fixes: z
          .array(z.string())
          .describe("Markdown install hints for the missing tools."),
      },
      annotations: {
        title: "Verify recipe-authoring toolchain",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ force }) => {
      if (!force) {
        const existing = await readSentinel();
        if (existing && sentinelSatisfies(existing)) {
          const out =
            `# preflight-recipe-tools\n\n` +
            `**Status:** ✅ skipped — toolchain verified ${existing.verifiedAt}.\n\n` +
            `All required tools were confirmed on a prior run (sentinel v${existing.version}). ` +
            `Pass \`force: true\` to re-probe.\n`;
          return {
            content: [{ type: "text", text: out }],
            structuredContent: {
              ok: true,
              skipped: true,
              sentinelWritten: false,
              results: [],
              missing: [],
              fixes: [],
            },
          };
        }
      }

      const results = await Promise.all(
        REQUIRED_TOOLS.map(async (t) => {
          const r = await checkBinary(t.cmd, t.versionArgs);
          return { cmd: t.cmd, ok: r.ok, detail: r.detail };
        }),
      );

      const missingTools = REQUIRED_TOOLS.filter(
        (t) => !results.find((r) => r.cmd === t.cmd)?.ok,
      );
      const missing = missingTools.map((t) => t.cmd);
      const fixes = missingTools.map(
        (t) => `- **\`${t.cmd}\`** (${t.why}): ${t.install}`,
      );
      const ok = missing.length === 0;

      let sentinelWritten = false;
      if (ok) {
        await writeSentinel();
        sentinelWritten = true;
      }

      let out = `# preflight-recipe-tools\n\n`;
      out += `**Status:** ${ok ? "✅ ready" : "❌ missing tools"}\n\n`;
      out += `| Tool | Status | Detail |\n`;
      out += `|------|--------|--------|\n`;
      for (const r of results) {
        out += `| \`${r.cmd}\` | ${r.ok ? "✅" : "❌"} | ${r.detail} |\n`;
      }
      if (ok) {
        out += `\nAll recipe-authoring tools present. Sentinel written — later runs skip this gate.\n`;
      } else {
        out += `\n## Fix\n\n${fixes.join("\n")}\n\n`;
        out += `Install the tools above, then re-run \`preflight-recipe-tools\` (or call with \`force: true\`). No sentinel was written, so the gate stays closed until they're present.\n`;
      }

      return {
        content: [{ type: "text", text: out }],
        structuredContent: {
          ok,
          skipped: false,
          sentinelWritten,
          results,
          missing,
          fixes,
        },
      };
    },
  );
}
