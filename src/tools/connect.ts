import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { assertWorkstationChannel } from "../lib/cli-channel.js";

const execFileP = promisify(execFile);

const AVOCADO_TIMEOUT_MS = 30_000;
// `connect init` makes several network round-trips (orgs/projects/cohorts +
// server key + claim token) AND writes files, so it gets a larger budget than
// the read-only list/status calls.
const AVOCADO_INIT_TIMEOUT_MS = 120_000;

interface CliRunOpts {
  /** Abort the child when the MCP client cancels the request. */
  signal?: AbortSignal;
  /** Override the default timeout (e.g. for the slower `connect init`). */
  timeoutMs?: number;
}

/**
 * Scan an NDJSON stream for the first `{ "event": "error", "message": … }`
 * and return its message. Used to surface a structured failure reason from a
 * non-zero `avocado` run instead of a bare exit code.
 */
function firstErrorEventMessage(ndjson: string): string | null {
  for (const line of ndjson.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const ev = JSON.parse(t) as Record<string, unknown>;
      if (ev["event"] === "error" && typeof ev["message"] === "string") {
        return ev["message"];
      }
    } catch {
      /* not a JSON line — ignore */
    }
  }
  return null;
}

/**
 * Turn a rejected `execFile` into a descriptive Error. Centralizes the three
 * cases shared by `runConnectCli` and `connect-init`:
 *   - binary missing (ENOENT),
 *   - an `avocado` too old to know the `connect` subcommand, and
 *   - a generic non-zero exit (preferring a structured NDJSON `error` event,
 *     then stderr, then the raw message).
 */
function mapConnectCliError(args: string[], err: unknown): Error {
  const e = err as {
    code?: string;
    stderr?: string;
    stdout?: string;
    message?: string;
  };
  if (e.code === "ENOENT") {
    return new Error(
      `avocado binary not found. Ensure avocado is installed and on PATH. ` +
        `Connect tools run the CLI locally — they require the workstation execution channel.`,
    );
  }
  const stderr = (e.stderr ?? "").trim();
  // An older CLI without Connect support makes clap reject `connect` as an
  // unrecognized subcommand. Detect that specific shape and point at an upgrade
  // rather than surfacing a bare clap usage error.
  const haystack = `${stderr}\n${e.message ?? ""}`.toLowerCase();
  if (
    /(unrecognized|unknown|invalid|no such) subcommand/.test(haystack) &&
    haystack.includes("connect")
  ) {
    return new Error(
      `Your \`avocado\` CLI does not support the \`connect\` subcommand. ` +
        `Avocado Connect requires a newer avocado CLI — please update avocado and try again.`,
    );
  }
  const detail =
    firstErrorEventMessage(e.stdout ?? "") ||
    stderr ||
    e.message ||
    "unknown error";
  return new Error(`avocado ${args.join(" ")} failed: ${detail}`);
}

/**
 * Run an `avocado connect …` subcommand and return parsed JSON stdout.
 * Throws a descriptive Error on non-zero exit, parse failure, or timeout.
 */
async function runConnectCli(
  args: string[],
  opts: CliRunOpts = {},
): Promise<unknown> {
  // Connect tools exec `avocado` locally; refuse in host-tool sessions where
  // the real CLI/credentials/project live on the Mac and we'd hit the VM's.
  await assertWorkstationChannel();
  const binary = process.env.AVOCADO_BINARY ?? "avocado";
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileP(binary, args, {
      timeout: opts.timeoutMs ?? AVOCADO_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      signal: opts.signal,
    }));
  } catch (err) {
    throw mapConnectCliError(args, err);
  }
  // The CLI may print an [UPDATE] banner before the JSON payload; extract
  // the first complete JSON object or array, same as the Desktop does.
  const trimmed = stdout.trim();
  const jsonStart = trimmed.indexOf("{");
  const arrayStart = trimmed.indexOf("[");
  const start =
    jsonStart === -1
      ? arrayStart
      : arrayStart === -1
        ? jsonStart
        : Math.min(jsonStart, arrayStart);
  if (start === -1) {
    throw new Error(
      `avocado ${args[0]} returned no JSON. stderr: ${stderr.trim()}`,
    );
  }
  try {
    return JSON.parse(trimmed.slice(start));
  } catch {
    throw new Error(
      `avocado ${args[0]} returned unparseable output: ${trimmed.slice(0, 200)}`,
    );
  }
}

export function registerConnectTools(server: McpServer): void {
  // ─── connect-auth-status ─────────────────────────────────────────────

  server.registerTool(
    "connect-auth-status",
    {
      title: "Check Avocado Connect auth status",
      description:
        "Check whether the current machine is authenticated with Avocado Connect (the OTA fleet management platform). Returns logged-in state, user info, and org memberships when authenticated. Read `avocado://skills/avocado-connect` before using Connect tools.",
      inputSchema: {},
      outputSchema: {
        logged_in: z.boolean().describe("Whether credentials exist on disk."),
        token_valid: z
          .boolean()
          .nullable()
          .optional()
          .describe(
            "Whether the API token is still accepted by the server. null means the check was not performed.",
          ),
        profile_name: z.string().optional(),
        user: z.object({ email: z.string(), name: z.string() }).optional(),
        organization_id: z
          .string()
          .nullable()
          .optional()
          .describe("The org this token is scoped to, or null for unscoped."),
        organizations: z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              role: z.string(),
            }),
          )
          .optional()
          .describe("Organizations the authenticated user belongs to."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (_args, extra) => {
      const result = (await runConnectCli(
        ["connect", "auth", "status", "--output", "json"],
        { signal: extra.signal },
      )) as Record<string, unknown>;
      // The SDK requires `structuredContent` (not arbitrary top-level keys)
      // when an outputSchema is declared — otherwise it throws InvalidParams.
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );

  // ─── connect-list-resources ───────────────────────────────────────────

  server.registerTool(
    "connect-list-resources",
    {
      title: "List Connect platform resources",
      description:
        "List organizations, projects, cohorts, or uploaded runtimes on the Avocado Connect platform. Use this to discover IDs for `connect-init` and for building the org → project → cohort selection cascade. Requires authentication (`connect-auth-status` should return `logged_in: true`).",
      inputSchema: {
        resource: z
          .enum(["orgs", "projects", "cohorts", "runtimes"])
          .describe(
            "Which resource type to list. Use `orgs` first, then `projects` (requires org), then `cohorts` or `runtimes` (require org + project).",
          ),
        org: z
          .string()
          .optional()
          .describe(
            "Organization ID. Required for projects, cohorts, runtimes.",
          ),
        project: z
          .string()
          .optional()
          .describe("Project ID. Required for cohorts and runtimes."),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ resource, org, project }, extra) => {
      // Use `--flag=value` (not `--flag value`) so an id beginning with `-`
      // can't be misparsed by clap as another option (argv option-smuggling).
      let args: string[];
      switch (resource) {
        case "orgs":
          args = ["connect", "orgs", "list", "--output", "json"];
          break;
        case "projects":
          if (!org) {
            throw new Error("`org` is required when listing projects.");
          }
          args = [
            "connect",
            "projects",
            "list",
            `--org=${org}`,
            "--output",
            "json",
          ];
          break;
        case "cohorts":
          if (!org) throw new Error("`org` is required when listing cohorts.");
          if (!project)
            throw new Error("`project` is required when listing cohorts.");
          args = [
            "connect",
            "cohorts",
            "list",
            `--org=${org}`,
            `--project=${project}`,
            "--output",
            "json",
          ];
          break;
        case "runtimes":
          if (!org) throw new Error("`org` is required when listing runtimes.");
          if (!project)
            throw new Error("`project` is required when listing runtimes.");
          args = [
            "connect",
            "runtimes",
            "list",
            `--org=${org}`,
            `--project=${project}`,
            "--output",
            "json",
          ];
          break;
      }
      const result = await runConnectCli(args, { signal: extra.signal });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
      };
    },
  );

  // ─── connect-init ──────────────────────────────────────────────────────

  server.registerTool(
    "connect-init",
    {
      title: "Initialize a project for Avocado Connect",
      description:
        "Run `avocado connect init` to link a local project to an Avocado Connect project and add OTA plumbing (connect-config extension + device config overlay) to the specified runtime in `avocado.yaml`. Non-destructive if already initialized — re-running updates the config. **Always run `connect-auth-status` and `connect-list-resources` first to confirm authentication and obtain the correct IDs.** After init, the project must be rebuilt (`avocado build`) to include the new Connect extension.",
      inputSchema: {
        directory: z
          .string()
          .describe(
            "Absolute path to the Avocado project directory (must contain avocado.yaml).",
          ),
        org: z
          .string()
          .describe(
            "Organization ID from `connect-list-resources { resource: 'orgs' }`.",
          ),
        project: z
          .string()
          .describe(
            "Project ID from `connect-list-resources { resource: 'projects', org }`. Must exist on the platform.",
          ),
        cohort: z
          .string()
          .optional()
          .describe(
            "Cohort ID to use for device enrollment. Required when the project has more than one cohort — if omitted and multiple exist, the CLI will error.",
          ),
        runtime: z
          .string()
          .optional()
          .describe(
            "Runtime name in avocado.yaml to wire the Connect extensions into. Defaults to `dev`.",
          ),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ directory, org, project, cohort, runtime }, extra) => {
      // Same local-exec constraint as runConnectCli — bail early in host-tool.
      await assertWorkstationChannel();
      const configPath = `${directory.replace(/\/+$/, "")}/avocado.yaml`;
      const runtimeName = (runtime ?? "").trim() || "dev";
      // `--flag=value` form so an id/path beginning with `-` can't be misparsed
      // by clap as another option (argv option-smuggling).
      const args: string[] = [
        "connect",
        "init",
        `--org=${org}`,
        `--project=${project}`,
        `--runtime=${runtimeName}`,
        `--config=${configPath}`,
        "--output",
        "json",
      ];
      if (cohort) {
        args.push(`--cohort=${cohort}`);
      }

      // Collect NDJSON events for a structured summary. Init does network +
      // file writes, so it gets the longer timeout and honors client cancel.
      const binary = process.env.AVOCADO_BINARY ?? "avocado";
      let stdout: string;
      let stderr: string;
      try {
        ({ stdout, stderr } = await execFileP(binary, args, {
          timeout: AVOCADO_INIT_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
          signal: extra.signal,
        }));
      } catch (err) {
        throw mapConnectCliError(args, err);
      }

      // Parse the final complete event from NDJSON output.
      let completeEvent: Record<string, unknown> | null = null;
      for (const line of stdout.split("\n")) {
        try {
          const ev = JSON.parse(line.trim()) as Record<string, unknown>;
          if (ev["event"] === "complete") {
            completeEvent = ev;
          }
        } catch {
          // non-JSON lines are progress prose — ignore
        }
      }

      const summary = completeEvent
        ? `Connect initialized successfully.\nOrg: ${String(completeEvent["org"] ?? org)}\nProject: ${String(completeEvent["project"] ?? project)}\n\nNext step: run \`avocado build\` to include the new Connect extension in your runtime.`
        : `connect init completed (exit 0). Run \`avocado build\` to include the new Connect extension.`;

      if (stderr.trim()) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${summary}\n\n(stderr: ${stderr.trim()})`,
            },
          ],
        };
      }
      return { content: [{ type: "text" as const, text: summary }] };
    },
  );
}
