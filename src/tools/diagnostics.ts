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
import { checkQemu, qemuArchAdvisory } from "./discovery.js";
import { platform as osPlatform } from "os";

export function registerDiagnosticsTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  const diagnosisSchema = z.object({
    label: z.string(),
    excerpt: z.string(),
    cause: z.string(),
    suggestion: z.string(),
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
        "Analyze the output of `avocado build`, `avocado install` or `avocado deploy` for known failure patterns (deploy covers refusals such as extension verity, a missing `root.json` and stamp pre-flight errors) AND actively probe the package feed. When you pass `targets`, the tool extracts any failing package names from the log and looks them up first on the project's configured feeds (with `projectDir`, this includes `repos:` feeds enabled in `distro.feeds`), then on every live stream (2026/next, 2026/edge, 2026/stable, 2024/edge, 2024/next) that carries the target, turning generic 'package not found' advice into a concrete answer (e.g. 'present on 2026/edge only, switch distro.release'). Always pass `targets` if you know them. **When no curated pattern matches**, the tool falls back to a generic log-shape extraction: error-line excerpts, exit code, suggested-file-paths, and explicit next-step routing (`search-docs`, `search-packages`, `Read` mentioned files). Never returns an empty response when the log has errors. If `diagnoses` is empty and `shape.hasErrors` is true, the prose response contains the fallback diagnosis.",
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
        "Return the per-target provisioning steps for a given target (which profile to use, which media to flash, the exact `avocado provision` command, and per-target caveats like linuxAutoMount or tegraflash recovery mode). Look this up before telling a user how to provision.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target name (must match an entry from list-targets, e.g. 'raspberrypi5').",
          ),
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
    async ({ target, ...feedArgs }) => {
      const feed = feedContextFrom(feedArgs);
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

      const profile = guessProfile(target);
      const isQemu = target.startsWith("qemu");
      let out = `# Provisioning \`${target}\`\n\n`;

      if (!isQemu) {
        out += `## ⚠️  HARDWARE REQUIRED: USB-to-UART adapter\n\n`;
        out += `Provisioning AND debugging an Avocado OS device requires a **USB-to-UART adapter wired into the device's debug UART**. This is a hard prerequisite — without it the user cannot see boot output, cannot recover from boot failures, and cannot drive the device for diagnostics. **Before recommending any provision command, confirm the user has the adapter connected.**\n\n`;
        out += `If the user doesn't have an adapter, point them at \`avocado://skills/device-debugging\` and \`avocado://skills/tmux-uart-bridge\` for setup, or suggest they start with a QEMU target instead (\`qemuarm64\`, \`qemux86-64\`) which doesn't need physical hardware.\n\n`;
      } else {
        out += `## QEMU target — no UART adapter needed\n\n`;
        out += `\`${target}\` runs in a VM; the serial console comes directly to the launching terminal. See the \`qemu-quickstart\` reference for the full flow.\n\n`;
        const archWarning = qemuArchAdvisory(target);
        if (archWarning) {
          out += `${archWarning}\n\n`;
        }

        // QEMU-only prerequisite: verify `qemu-system-<arch>` is on PATH.
        // Skipped for non-QEMU targets in `environment-check` to avoid noise.
        const qemu = await checkQemu();
        if (!qemu.ok) {
          const platform = osPlatform();
          const installCmd =
            platform === "darwin"
              ? "brew install qemu"
              : platform === "linux"
                ? "sudo apt install qemu-system  # or your distro's equivalent (e.g. `dnf install qemu-system-x86 qemu-system-arm` on Fedora)"
                : "install QEMU for your platform";
          out += `## ⚠️  QEMU prerequisite missing\n\n`;
          out += `\`${target}\` is a QEMU target, but the matching \`qemu-system\` binary isn't on PATH: ${qemu.detail}.\n\n`;
          out += `**Fix:** \`${installCmd}\`. Then retry. \`environment-check\` does not include this check because it's only relevant for QEMU targets.\n\n`;
        }
      }

      out += `**Profile:** \`${profile.profile}\`\n`;
      out += `**Media:** ${profile.media}\n`;
      out += `**Host OS supported:** ${profile.hostOs.join(", ")}\n`;
      if (profile.warnings.length > 0) {
        out += `**Warnings:** ${profile.warnings.join(", ")}\n`;
      }
      const profileArg =
        profile.profile !== "default" ? ` --profile ${profile.profile}` : "";
      const provisionCmd = `avocado provision dev${profileArg}`;

      out += `\n## Steps\n\n`;
      if (isQemu) {
        out += `For QEMU targets, there's no provision-to-media step — launch the VM directly:\n\n`;
        out += "```bash\n";
        out += `avocado build --no-tui\n`;
        out += `avocado sdk run -iE vm dev\n`;
        out += "```\n\n";
      } else {
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
      }
      if (profile.notes.length > 0) {
        out += `## Notes\n\n`;
        for (const n of profile.notes) out += `- ${n}\n`;
      }
      out += `\nFor authoritative per-target documentation, see:\n\n`;
      out += `\`https://docs.peridio.com/hardware/${target}\` (or the parent vendor's section).\n\n`;
      out += feed.describe();

      return { content: [{ type: "text", text: out }] };
    },
  );
}

// Best-effort target → provisioning profile mapping. Falls back to 'sd' for
// unrecognised targets since that's the most common.
function guessProfile(target: string): {
  profile: string;
  media: string;
  hostOs: string[];
  warnings: string[];
  notes: string[];
} {
  if (target.startsWith("qemu")) {
    return {
      profile: "default",
      media: "no media — runs in a VM",
      hostOs: ["macOS", "Linux"],
      warnings: [],
      notes: [
        "QEMU targets don't flash anything. Launch with `avocado sdk run -iE vm dev`.",
        "Useful for trying Avocado OS without hardware.",
      ],
    };
  }
  if (target.startsWith("jetson")) {
    return {
      profile: "tegraflash",
      media: "NVMe SSD over USB (recovery mode)",
      hostOs: ["Linux"],
      warnings: ["linuxHostOnly"],
      notes: [
        "Tegraflash provisioning requires a Linux host. macOS is NOT supported for this target.",
        "Put the device in recovery mode (short FC REC to GND) and connect USB-C before running provision.",
        "You'll be prompted to disconnect/reconnect USB partway through — follow the on-screen instructions.",
      ],
    };
  }
  if (target.startsWith("intel-x86-64")) {
    return {
      profile: "usb",
      media: "USB drive",
      hostOs: ["macOS", "Linux"],
      warnings: [],
      notes: [
        "Target must support UEFI boot (Legacy BIOS is not supported).",
        "Insert the USB drive into the target and boot from USB via the BIOS boot menu.",
      ],
    };
  }
  if (target === "fr201") {
    return {
      profile: "default",
      media: "internal eMMC (already-provisioned device)",
      hostOs: ["macOS", "Linux"],
      warnings: [],
      notes: [
        "FR201 ships pre-configured for Avocado. `avocado provision dev` over the network.",
      ],
    };
  }
  if (target === "icam-540") {
    return {
      profile: "default",
      media: "internal eMMC",
      hostOs: ["macOS", "Linux"],
      warnings: [],
      notes: [
        "ICAM-540 ships pre-configured. Apply power; provisioning happens over network/serial.",
      ],
    };
  }
  // Default to SD card for everything else (Raspberry Pi, NXP, STM, Grinn, SolidRun, Seeed, etc.)
  return {
    profile: "sd",
    media: "microSD card (8 GB+)",
    hostOs: ["macOS", "Linux"],
    warnings: ["linuxAutoMount"],
    notes: [
      "On Linux hosts (especially Ubuntu/GNOME), disable auto-mount before provisioning to avoid corrupting the flash: `gsettings set org.gnome.desktop.media-handling automount false`.",
      "Insert the SD card after `avocado provision dev --profile sd` finishes, then apply power to the target.",
    ],
  };
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
