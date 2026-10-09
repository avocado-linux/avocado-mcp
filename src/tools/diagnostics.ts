import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diagnoseProvisionLog,
  diagnoseBuildLog,
  extractFailingPackages,
  extractLogShape,
  investigatePackages,
  renderDiagnoses,
  INVESTIGATION_STREAMS,
  type StreamProbe,
} from "../lib/diagnostics.js";
import { RepoClient } from "../lib/repo-client.js";
import type { FeedContext } from "../lib/feed-config.js";
import {
  feedArgsShape,
  feedContextFrom,
  feedSummarySchema,
} from "./feed-args.js";
import { qemuArchAdvisory } from "./discovery.js";
import {
  getHardwareData,
  lookupTarget,
  boardDocsUrl,
  isVirtual,
  provisioningText,
  provisionCommand,
  unavailableText,
  unknownTargetText,
} from "../lib/hardware-data.js";

export function registerDiagnosticsTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  const diagnosisSchema = z.object({
    label: z.string(),
    excerpt: z.string(),
    cause: z.string(),
    suggestion: z.string(),
    warningOnly: z
      .boolean()
      .optional()
      .describe(
        "True for a CLI warning that does not stop the command. It does not explain a failed run.",
      ),
  });

  const logShapeSchema = z.object({
    hasErrors: z
      .boolean()
      .describe(
        "True when the log contains generic error signals (ERROR, error:, Failed, fatal:, Traceback, etc.). Even when no curated pattern matched, `hasErrors=true` means the log is a failure, not a success.",
      ),
    exitCode: z.number().int().nullable(),
    errorLines: z
      .array(z.string())
      .describe(
        "Up to 20 lines containing error signals, in source order. Useful as a fallback excerpt when no curated pattern matched.",
      ),
    filePaths: z
      .array(z.string())
      .describe(
        "Project / extension / SDK file paths mentioned in the log. Candidate targets for `Read` to investigate further.",
      ),
    commands: z
      .array(z.string())
      .describe(
        "Heuristically-detected commands the log records (e.g. `+ avocado build`).",
      ),
  });

  server.registerTool(
    "diagnose-provision-log",
    {
      title: "Diagnose an avocado provision log",
      description:
        "Analyze the output of `avocado provision` for known failure patterns (auto-mount, missing device, USB issues, permission errors, TTY harness, etc.) and return a structured diagnosis. When no curated pattern matches, the tool falls back to a generic log-shape extraction: error-line excerpts, exit code, suggested-file-paths, and explicit next-step routing — never returns an empty response when the log has errors. Use this whenever a provision failed and the user has pasted the log.",
      inputSchema: {
        log: z
          .string()
          .min(1)
          .describe(
            "Full or partial provision log output. Paste verbatim — heuristics scan for known error fingerprints.",
          ),
      },
      outputSchema: {
        diagnoses: z.array(diagnosisSchema),
        shape: logShapeSchema,
      },
      annotations: {
        title: "Diagnose an avocado provision log",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ log }) => {
      const diagnoses = diagnoseProvisionLog(log);
      const shape = extractLogShape(log);
      return {
        content: [
          {
            type: "text",
            text: renderDiagnoses("provision", diagnoses, undefined, {
              targets: [],
              rawLog: log,
            }),
          },
        ],
        structuredContent: { diagnoses, shape },
      };
    },
  );

  server.registerTool(
    "explain-build-error",
    {
      title: "Diagnose an avocado build, install or deploy log",
      description:
        "Analyze the output of `avocado build`, `avocado install` or `avocado deploy` for known failure patterns (deploy covers refusals such as extension verity, a missing `root.json` and stamp pre-flight errors) AND, for build and install logs, actively probe the package feed. A deploy log skips the feed lookup and gets deploy next steps instead (SSH to the device, `avocadoctl`, device logs). Pass `command: \"deploy\"` for a deploy log. For a build or install log, when you pass `targets`, the tool extracts any failing package names from the log and looks them up first on the project's configured feeds (with `projectDir`, this includes `repos:` feeds enabled in `distro.feeds`), then on every live stream (2026/next, 2026/edge, 2026/stable, 2024/edge, 2024/next) that carries the target, turning generic 'package not found' advice into a concrete answer (e.g. 'present on 2026/edge only, switch distro.release'). Always pass `targets` if you know them. **When no curated pattern matches**, the tool falls back to a generic log-shape extraction: error-line excerpts, exit code, suggested-file-paths, and explicit next-step routing (`search-docs`, `search-packages`, `Read` mentioned files). Never returns an empty response when the log has errors. If `diagnoses` is empty or has only `warningOnly` entries, and `shape.hasErrors` is true, the prose response contains the fallback diagnosis.",
      inputSchema: {
        log: z
          .string()
          .min(1)
          .describe(
            "Full or partial build, install or deploy log output. Paste verbatim — heuristics scan for known error fingerprints and extract failing package names.",
          ),
        command: z
          .enum(["build", "install", "deploy"])
          .default("build")
          .describe(
            "The command that wrote the log. Pass `deploy` for an `avocado deploy` log, so that a log no pattern matches gets deploy next steps (SSH, `avocadoctl`, device logs) and not build ones.",
          ),
        targets: z
          .array(z.string())
          .optional()
          .describe(
            "Target(s) the user was building for (e.g. ['jetson-orin-nano-devkit']). Strongly recommended. Enables a package lookup on the project's configured feeds plus every live stream that carries the target, which often surfaces the actual cause when patterns alone are inconclusive.",
          ),
        ...feedArgsShape,
      },
      outputSchema: {
        diagnoses: z.array(diagnosisSchema),
        investigations: z
          .array(
            z.object({
              name: z.string(),
              streams: z.array(
                z.object({
                  release: z.string(),
                  channel: z.string(),
                  configured: z
                    .boolean()
                    .describe("True for the project's configured feed."),
                  hits: z.array(
                    z.object({ repo: z.string(), version: z.string() }),
                  ),
                  error: z.string().optional(),
                  notChecked: z
                    .array(z.object({ feed: z.string(), reason: z.string() }))
                    .optional()
                    .describe(
                      "Enabled feeds the lookup could not read, e.g. private `org:` feeds.",
                    ),
                }),
              ),
            }),
          )
          .optional()
          .describe(
            "Per-package lookup on the project's configured feeds, then on each live stream that carries the target. Only populated when `targets` was supplied.",
          ),
        shape: logShapeSchema,
        feed: feedSummarySchema.optional(),
      },
      annotations: {
        title: "Diagnose an avocado build, install or deploy log",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ log, command, targets, ...feedArgs }) => {
      const diagnoses = diagnoseBuildLog(log);
      const shape = extractLogShape(log);
      // A deploy log has no failing packages to look up on the feeds.
      if (!targets || targets.length === 0 || command === "deploy") {
        return {
          content: [
            {
              type: "text",
              text: renderDiagnoses(command, diagnoses, undefined, {
                targets: [],
                rawLog: log,
              }),
            },
          ],
          structuredContent: { diagnoses, shape },
        };
      }
      const names = extractFailingPackages(log);
      const feed = feedContextFrom(feedArgs);
      const investigations = await investigatePackages(
        repoClient,
        names,
        targets,
        investigationProbes(feed),
      );
      return {
        content: [
          {
            type: "text",
            text: renderDiagnoses(command, diagnoses, investigations, {
              targets,
              rawLog: log,
              feedDescription: feed.describe(targets),
            }),
          },
        ],
        structuredContent: {
          diagnoses,
          investigations,
          shape,
          feed: feed.structured(targets),
        },
      };
    },
  );

  server.registerTool(
    "get-provisioning-steps",
    {
      title: "Get per-target provisioning steps",
      description:
        "Return the provisioning steps for a target from the docs board data: the profile, the media, host OS support, recovery mode steps, the exact `avocado provision` command, boot steps, and how to run it from Bash. QEMU targets get the provision-then-run VM flow. Look this up before telling a user how to provision.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target name (must match an entry from list-targets, e.g. 'raspberrypi5').",
          ),
        board: z
          .string()
          .optional()
          .describe(
            "Board (`default_target_board`) when the target has several, e.g. 'mic-733-ao5a1'.",
          ),
        runtime: z
          .string()
          .optional()
          .describe("Runtime to provision. Defaults to `dev`."),
        ...feedArgsShape,
      },
      annotations: {
        title: "Get per-target provisioning steps",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ target, board, runtime, ...feedArgs }) => {
      const feed = feedContextFrom(feedArgs);
      const rt = runtime?.trim() || "dev";
      const validTargets = await repoClient.getTargetsConfig(feed.base);
      if (!validTargets) {
        return {
          content: [
            {
              type: "text",
              text: `# get-provisioning-steps failed\n\nCould not fetch targets.json. Check network and the configured feed.\n\n${feed.describe()}`,
            },
          ],
        };
      }
      if (!validTargets[target]) {
        return {
          content: [
            {
              type: "text",
              text: `# get-provisioning-steps failed\n\nUnknown target \`${target}\` in this feed. Use \`list-targets\` (same \`projectDir\`) to see valid options.\n\n${feed.describe()}`,
            },
          ],
        };
      }

      let out = `# Provisioning \`${target}\`${board ? ` (board \`${board}\`)` : ""}\n\n`;
      const data = await getHardwareData();
      const info = data ? lookupTarget(data, target, board) : null;
      if (!info) {
        out += data ? unknownTargetText(target) : unavailableText(target);
        out += `\n${genericSteps(rt)}`;
      } else {
        const page = boardDocsUrl(info);
        if (page) out += `**Docs:** ${page}\n\n`;
        if (isVirtual(info)) {
          const archWarning = qemuArchAdvisory(target);
          if (archWarning) out += `${archWarning}\n\n`;
          out += provisioningText(info, rt);
        } else {
          out += provisioningText(info, rt);
          const profiles = info.entries.flatMap((e) =>
            (e.provisioning?.options ?? []).map((o) => o.profile),
          );
          out += runSection(
            profiles.length === 1
              ? provisionCommand(rt, profiles[0])
              : `${provisionCommand(rt)} --profile <profile>`,
          );
        }
      }
      out += feed.describe();
      return { content: [{ type: "text", text: out }] };
    },
  );
}

/** The flow for a target with no docs data. States only what holds for all. */
function genericSteps(runtime: string): string {
  let out = `## Generic flow\n\n`;
  out += `Without \`--profile\`, the CLI uses the default profile of the target. After \`avocado install\`, \`list-provision-profiles\` lists the profiles the target has. Check the board page before you flash media.\n\n`;
  return out + runSection(provisionCommand(runtime));
}

/** How a human and an LLM run build + provision. */
function runSection(provisionCmd: string): string {
  let out = `## Run it\n\n`;
  out += `**For a HUMAN running these in their own terminal:**\n\n`;
  out += "```bash\n";
  out += `avocado build --no-tui\n`;
  out += `${provisionCmd} --no-tui\n`;
  out += "```\n\n";
  out += `**For an LLM running via the Bash tool (NO interactive terminal):** no TTY wrapper is needed. The CLI detects a non-TTY stdin and starts the SDK container without a PTY. Set \`AVOCADO_NONINTERACTIVE=1\` so it never waits for an answer, and write logs to \`.avocado/logs/\` in the project:\n\n`;
  out += "```bash\n";
  out += `mkdir -p .avocado/logs\n`;
  out += `avocado build --no-tui > .avocado/logs/build.log 2>&1\n`;
  out += `AVOCADO_NONINTERACTIVE=1 ${provisionCmd} --no-tui > .avocado/logs/provision.log 2>&1\n`;
  out += "```\n\n";
  out += `If the provision fails with \`the input device is not a TTY\`, the CLI is older than 1.0.0-rc.2. Run \`avocado upgrade\`. On macOS, a host-side SD card write asks for confirmation and cancels with no terminal (\`Operation cancelled.\`). Ask the user to run that provision in their own terminal.\n\n`;
  return out;
}

/**
 * Streams the build-error investigator probes: the project's configured feeds
 * first (with per-target snapshot pins and `repos:` feeds), then the live
 * streams in INVESTIGATION_STREAMS. Alternates are resolved from the same project config, so they
 * keep its repo URL and TLS settings; one identical to the configured stream
 * is skipped.
 */
function investigationProbes(feed: FeedContext): StreamProbe[] {
  const base = feed.base;
  const [rvRelease, rvChannel] = base.releasever.split("/");
  const release = base.release ?? rvRelease ?? "";
  const channel = base.channel ?? rvChannel ?? "";
  const probes: StreamProbe[] = [
    {
      release,
      channel,
      configured: true,
      feed: (t: string) => feed.forTarget(t),
    },
  ];
  for (const s of INVESTIGATION_STREAMS) {
    if (s.release === release && s.channel === channel) continue;
    const alt = feed.withStream(s.release, s.channel);
    probes.push({
      release: s.release,
      channel: s.channel,
      configured: false,
      feed: (t: string) => alt.forTarget(t),
    });
  }
  return probes;
}
