import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import * as path from "path";
import { existsSync, readFileSync } from "fs";
import { parse as parseYaml } from "yaml";
import { assertWorkstationChannel } from "../lib/cli-channel.js";
import {
  getHardwareData,
  targetInfoText,
  lookupTarget,
  provisionCommand,
  isSafeProfile,
  skippedProfileText,
  unavailableText,
} from "../lib/hardware-data.js";
import { isSafeSegment } from "../lib/repo-client.js";

const execFileP = promisify(execFile);

// `provision --list` starts a one-shot SDK container to read the manifest, so
// it gets more time than the read-only connect calls.
const LIST_TIMEOUT_MS = 60_000;

export interface ProvisionProfileField {
  name: string;
  type: string;
  label?: string | null;
  description?: string | null;
  required?: boolean;
  default?: unknown;
}

/** The JSON shape of `avocado provision --list --output json` (profiles.rs). */
export interface ProvisionProfileList {
  available: boolean;
  target?: string | null;
  default?: string | null;
  reason?: string;
  profiles?: {
    name: string;
    script?: string | null;
    fields?: ProvisionProfileField[];
  }[];
}

/**
 * Find the `provision --list` result in stdout. The CLI prints one JSON object
 * on one line, but an update banner can come first.
 */
export function parseProvisionList(
  stdout: string,
): ProvisionProfileList | null {
  for (const line of stdout.split("\n").reverse()) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const v = JSON.parse(t) as ProvisionProfileList;
      if (v && typeof v.available === "boolean") return v;
    } catch {
      /* not JSON, ignore */
    }
  }
  return null;
}

export function renderProvisionList(
  list: ProvisionProfileList,
  runtime: string,
  target?: string,
): string {
  let out = `**Target:** \`${list.target ?? "unknown"}\`\n`;
  if (list.default) out += `**Default profile:** \`${list.default}\`\n`;
  const all = list.profiles ?? [];
  // Profile names from the CLI go into the printed shell commands.
  const profiles = all.filter((p) => isSafeProfile(p.name));
  const skipped = all.filter((p) => !isSafeProfile(p.name));
  if (profiles.length === 0 && skipped.length === 0) {
    return out + `\nThe manifest declares no provisioning profiles.\n`;
  }
  if (profiles.length > 0) {
    out += `\n| Profile | Command |\n|---|---|\n`;
  }
  for (const p of profiles) {
    out += `| \`${p.name}\` | \`${provisionCommand(runtime, p.name, target)}\` |\n`;
  }
  for (const p of profiles) {
    if (!p.fields?.length) continue;
    out += `\n**Settings for \`${p.name}\`** (pass each with \`--env NAME=<value>\`):\n\n`;
    for (const f of p.fields) {
      const what = f.label || f.description || "";
      out += `- \`${f.name}\` (${f.type}, ${f.required ? "required" : "optional"})${what ? `: ${what}` : ""}\n`;
    }
  }
  for (const p of skipped) out += `\n${skippedProfileText(p.name)}\n`;
  return out;
}

/**
 * The board the CLI uses for a runtime: `AVOCADO_TARGET_BOARD`, then
 * `runtimes.<name>.target_board`, then `default_target_board` (avocado-cli
 * `interpolation/avocado.rs`). Returns undefined when the YAML has none.
 */
export function projectBoard(
  configPath: string,
  runtime: string,
): string | undefined {
  const env = process.env.AVOCADO_TARGET_BOARD?.trim();
  if (env) return env;
  try {
    const doc = parseYaml(readFileSync(configPath, "utf8")) as {
      runtimes?: Record<string, { target_board?: unknown } | null>;
      default_target_board?: unknown;
    } | null;
    for (const b of [
      doc?.runtimes?.[runtime]?.target_board,
      doc?.default_target_board,
    ]) {
      if (typeof b === "string" && b.trim()) return b.trim();
    }
  } catch {
    /* unreadable YAML: the fallback lists the target's profiles */
  }
  return undefined;
}

/**
 * The target `provision --list` uses when the caller passes none:
 * `AVOCADO_TARGET`, then `default_target` (avocado-cli `utils/target.rs`,
 * called from `commands/profiles.rs`). Returns undefined when the YAML has
 * none.
 */
export function projectTarget(configPath: string): string | undefined {
  const env = process.env.AVOCADO_TARGET?.trim();
  if (env) return env;
  try {
    const doc = parseYaml(readFileSync(configPath, "utf8")) as {
      default_target?: unknown;
    } | null;
    const t = doc?.default_target;
    if (typeof t === "string" && t.trim()) return t.trim();
  } catch {
    /* unreadable YAML: the fallback asks for a target */
  }
  return undefined;
}

/**
 * The docs profiles for a target. `explicitTarget` is the target the caller
 * gave, which the printed commands then name.
 */
async function docsFallback(
  target: string | undefined,
  runtime: string,
  board: string | undefined,
  explicitTarget: string | undefined,
): Promise<string> {
  if (!target) {
    return `Pass \`target\` to see the docs profiles, or call \`get-target-info\`.\n`;
  }
  const data = await getHardwareData();
  if (!data) return unavailableText(target);
  const info = lookupTarget(data, target, board);
  const all = (info?.entries ?? []).flatMap(
    (e) => e.provisioning?.options ?? [],
  );
  const options = all.filter((o) => isSafeProfile(o.profile));
  const what = board ? `\`${target}\` board \`${board}\`` : `\`${target}\``;
  if (all.length === 0) {
    return `The docs data lists no profiles for ${what}. Call \`get-target-info\` with the board for the board page.\n`;
  }
  let out = `Profiles in the docs data for ${what} (call \`get-target-info\` for the full steps):\n\n`;
  for (const o of options) {
    out += `- ${o.label ?? o.id}: \`${provisionCommand(runtime, o.profile, explicitTarget)}\`\n`;
  }
  for (const o of all) {
    if (!isSafeProfile(o.profile))
      out += `- ${skippedProfileText(o.profile!)}\n`;
  }
  return out;
}

export function registerHardwareTools(server: McpServer): void {
  server.registerTool(
    "get-target-info",
    {
      title: "Get board facts for a target from the docs",
      description:
        "Return the docs facts for one target: name, board page URL, stream status per LTS release (2024, 2026), the boards that use the target and whether one is required, host OS support, free disk space, serial console (onboard USB or adapter, baud, voltage), and per provisioning profile the media, recovery mode steps, `avocado provision` command and boot steps. QEMU targets get the provision-then-run VM flow. The data comes from the same files the docs hardware pages use. Use this instead of reading the support matrix page, which `get-doc` cannot render.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target slug, e.g. 'rb3gen2', 'jetson-orin-nano-devkit', 'qemux86-64'. 2026 feed names without '-devkit' also work.",
          ),
        board: z
          .string()
          .optional()
          .describe(
            "Board (`default_target_board`), e.g. 'mic-733-ao5a1' or 'rb3gen2-vision'. Narrows the steps to that board.",
          ),
      },
      annotations: {
        title: "Get board facts for a target from the docs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ target, board }) => {
      const data = await getHardwareData();
      return {
        content: [
          { type: "text", text: targetInfoText(data, target.trim(), board) },
        ],
      };
    },
  );

  server.registerTool(
    "list-provision-profiles",
    {
      title: "List the provisioning profiles of an installed project",
      description:
        "Run `avocado provision --list --output json` in a project to list the provisioning profiles the installed SDK has for the target, the default profile, and the `--env` settings each profile takes. The project must be installed (`avocado install`). Before install, or if the CLI fails, the tool returns the profiles from the docs data instead. Runs the CLI locally, so it needs the workstation execution channel.",
      inputSchema: {
        projectDir: z
          .string()
          .describe(
            "Absolute path to the Avocado project directory (must contain avocado.yaml).",
          ),
        target: z
          .string()
          .optional()
          .describe(
            "Target to list profiles for. Defaults to the CLI resolution: AVOCADO_TARGET, then `default_target` in avocado.yaml. When given, the printed commands pass `--target`.",
          ),
        runtime: z
          .string()
          .optional()
          .describe(
            "Runtime used in the printed commands. Defaults to `dev`. The CLI does not take a runtime with `--list`.",
          ),
        board: z
          .string()
          .optional()
          .describe(
            "Board (`default_target_board`), e.g. 'mic-733-ao5a1'. Used only when the tool falls back to the docs data. Defaults to the board in avocado.yaml.",
          ),
      },
      annotations: {
        title: "List the provisioning profiles of an installed project",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ projectDir, target, runtime, board }, extra) => {
      await assertWorkstationChannel({
        operation: "Listing provision profiles",
        command: "avocado provision --list --output json",
      });
      const rt = runtime?.trim() || "dev";
      // The runtime goes into the shell commands this tool prints.
      if (!isSafeSegment(rt)) {
        return {
          content: [
            {
              type: "text",
              text: `# list-provision-profiles failed\n\nInvalid runtime: ${JSON.stringify(rt)}. Use a runtime name from avocado.yaml, such as \`dev\`.`,
            },
          ],
          isError: true,
        };
      }
      // An explicit target goes into the printed commands too, since the CLI
      // otherwise provisions the project's default target.
      const explicitTarget = target?.trim() || undefined;
      if (explicitTarget && !isSafeSegment(explicitTarget)) {
        return {
          content: [
            {
              type: "text",
              text: `# list-provision-profiles failed\n\nInvalid target: ${JSON.stringify(explicitTarget)}. Use a target name such as \`raspberrypi5\`.`,
            },
          ],
          isError: true,
        };
      }
      // Resolve once, so the existence check, the cwd and --config all use
      // the same directory when the caller passes a relative path.
      const dir = path.resolve(projectDir);
      const configPath = path.join(dir, "avocado.yaml");
      if (!existsSync(configPath)) {
        return {
          content: [
            {
              type: "text",
              text: `# list-provision-profiles failed\n\nNo avocado.yaml in \`${dir}\`. Pass the project directory.`,
            },
          ],
          isError: true,
        };
      }
      // `--flag=value` so a value that starts with `-` can't be read as a flag.
      const args = [
        "provision",
        "--list",
        "--output",
        "json",
        `--config=${configPath}`,
      ];
      if (explicitTarget) args.push(`--target=${explicitTarget}`);

      let out = `# list-provision-profiles\n\n`;
      let failure: string;
      try {
        const { stdout } = await execFileP(
          process.env.AVOCADO_BINARY ?? "avocado",
          args,
          {
            cwd: dir,
            timeout: LIST_TIMEOUT_MS,
            maxBuffer: 4 * 1024 * 1024,
            signal: extra.signal,
          },
        );
        const list = parseProvisionList(stdout);
        if (list?.available) {
          return {
            content: [
              {
                type: "text",
                text: out + renderProvisionList(list, rt, explicitTarget),
              },
            ],
          };
        }
        failure = list
          ? (list.reason ?? "the CLI reported no profiles")
          : "the CLI returned no JSON result";
        target = target || list?.target || undefined;
      } catch (err) {
        const e = err as { code?: string; stderr?: string; message?: string };
        failure =
          e.code === "ENOENT"
            ? "the avocado binary is not on PATH"
            : (e.stderr ?? "").trim() || e.message || "unknown error";
      }
      out += `Could not read the profiles from the project: ${failure}\n\n`;
      out += `The profiles come from the installed SDK. Run \`avocado install\` in the project first, then call this tool again.\n\n`;
      out += await docsFallback(
        target?.trim() || projectTarget(configPath),
        rt,
        board?.trim() || projectBoard(configPath, rt),
        explicitTarget,
      );
      return { content: [{ type: "text", text: out }] };
    },
  );
}
