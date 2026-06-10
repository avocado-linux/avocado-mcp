import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);

const AVOCADO_TIMEOUT_MS = 30_000;

/**
 * Run an `avocado connect …` subcommand and return parsed JSON stdout.
 * Throws a descriptive Error on non-zero exit, parse failure, or timeout.
 */
async function runConnectCli(args: string[]): Promise<unknown> {
  const binary = process.env.AVOCADO_BINARY ?? "avocado";
  let stdout: string;
  let stderr: string;
  try {
    ({ stdout, stderr } = await execFileP(binary, args, {
      timeout: AVOCADO_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
    }));
  } catch (err) {
    const e = err as { code?: string; stderr?: string; message?: string };
    if (e.code === "ENOENT") {
      throw new Error(
        `avocado binary not found. Ensure avocado is installed and on PATH. ` +
          `Connect tools require the workstation execution channel — they will not work from inside the VM.`,
      );
    }
    // execFileP rejects on non-zero exit; extract stderr for context.
    const detail = (e.stderr ?? "").trim() || (e.message ?? "unknown error");
    throw new Error(`avocado ${args.join(" ")} failed: ${detail}`);
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
    throw new Error(`avocado ${args[0]} returned unparseable output: ${trimmed.slice(0, 200)}`);
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
        user: z
          .object({ email: z.string(), name: z.string() })
          .optional(),
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
        title: "Check Avocado Connect auth status",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const result = (await runConnectCli([
        "connect",
        "auth",
        "status",
        "--output",
        "json",
      ])) as Record<string, unknown>;
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        ...result,
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
          .describe("Organization ID. Required for projects, cohorts, runtimes."),
        project: z
          .string()
          .optional()
          .describe("Project ID. Required for cohorts and runtimes."),
      },
      annotations: {
        title: "List Connect platform resources",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ resource, org, project }) => {
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
            "--org",
            org,
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
            "--org",
            org,
            "--project",
            project,
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
            "--org",
            org,
            "--project",
            project,
            "--output",
            "json",
          ];
          break;
      }
      const result = await runConnectCli(args);
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
        org: z.string().describe("Organization ID from `connect-list-resources { resource: 'orgs' }`."),
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
        title: "Initialize a project for Avocado Connect",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ directory, org, project, cohort, runtime }) => {
      const configPath = `${directory}/avocado.yaml`;
      const runtimeName = (runtime ?? "").trim() || "dev";
      const args: string[] = [
        "connect",
        "init",
        "--org",
        org,
        "--project",
        project,
        "-r",
        runtimeName,
        "-C",
        configPath,
        "--output",
        "json",
      ];
      if (cohort) {
        args.push("--cohort", cohort);
      }

      // Collect NDJSON events for a structured summary.
      const binary = process.env.AVOCADO_BINARY ?? "avocado";
      let stdout: string;
      let stderr: string;
      try {
        ({ stdout, stderr } = await execFileP(binary, args, {
          timeout: AVOCADO_TIMEOUT_MS,
          maxBuffer: 4 * 1024 * 1024,
        }));
      } catch (err) {
        const e = err as { code?: string; stderr?: string; stdout?: string; message?: string };
        if (e.code === "ENOENT") {
          throw new Error(
            `avocado binary not found. Connect tools require the workstation execution channel.`,
          );
        }
        // Extract structured error from NDJSON stream if present.
        const outLines = (e.stdout ?? "").split("\n");
        for (const line of outLines) {
          try {
            const ev = JSON.parse(line.trim()) as Record<string, unknown>;
            if (ev["event"] === "error" && typeof ev["message"] === "string") {
              throw new Error(`connect init failed: ${ev["message"]}`);
            }
          } catch (parseErr) {
            if (
              parseErr instanceof Error &&
              parseErr.message.startsWith("connect init failed:")
            ) {
              throw parseErr;
            }
          }
        }
        const detail = (e.stderr ?? "").trim() || (e.message ?? "unknown");
        throw new Error(`avocado connect init failed: ${detail}`);
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
