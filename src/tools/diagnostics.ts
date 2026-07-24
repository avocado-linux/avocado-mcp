import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diagnoseProvisionLog,
  diagnoseBuildLog,
  extractFailingPackages,
  extractLogShape,
  investigatePackages,
  renderDiagnoses,
} from "../lib/diagnostics.js";
import { RepoClient } from "../lib/repo-client.js";
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
      title: "Diagnose an avocado build/install log",
      description:
        "Analyze the output of `avocado build` or `avocado install` for known failure patterns AND actively probe the package feed. When you pass `targets`, the tool extracts any failing package names from the log and looks them up on the `edge` channel of both releases (`2024` and `2026` — the streams ~all users are on), turning generic 'package not found' advice into a concrete answer (e.g. 'present on 2026/edge only, switch distro.release'). Always pass `targets` if you know them. **When no curated pattern matches**, the tool falls back to a generic log-shape extraction: error-line excerpts, exit code, suggested-file-paths, and explicit next-step routing (`search-docs`, `search-packages`, `Read` mentioned files). Never returns an empty response when the log has errors — if `diagnoses` is empty and `shape.hasErrors` is true, the prose response contains the fallback diagnosis.",
      inputSchema: {
        log: z
          .string()
          .min(1)
          .describe(
            "Full or partial build/install log output. Paste verbatim — heuristics scan for known error fingerprints and extract failing package names.",
          ),
        targets: z
          .array(z.string())
          .optional()
          .describe(
            "Target(s) the user was building for (e.g. ['jetson-orin-nano-devkit']). Strongly recommended — enables a cross-release package lookup (probes the `edge` channel on releases 2024 and 2026) that often surfaces the actual cause when patterns alone are inconclusive.",
          ),
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
                  hits: z.array(
                    z.object({ repo: z.string(), version: z.string() }),
                  ),
                  error: z.string().optional(),
                }),
              ),
            }),
          )
          .optional()
          .describe(
            "Per-package cross-release lookup on the `edge` channel of releases 2024 and 2026 (the common-case streams). Only populated when `targets` was supplied.",
          ),
        shape: logShapeSchema,
      },
      annotations: {
        title: "Diagnose an avocado build/install log",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ log, targets }) => {
      const diagnoses = diagnoseBuildLog(log);
      const shape = extractLogShape(log);
      if (!targets || targets.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: renderDiagnoses("build", diagnoses, undefined, {
                targets: [],
                rawLog: log,
              }),
            },
          ],
          structuredContent: { diagnoses, shape },
        };
      }
      const names = extractFailingPackages(log);
      const investigations = await investigatePackages(
        repoClient,
        names,
        targets,
      );
      return {
        content: [
          {
            type: "text",
            text: renderDiagnoses("build", diagnoses, investigations, {
              targets,
              rawLog: log,
            }),
          },
        ],
        structuredContent: { diagnoses, investigations, shape },
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
      },
      annotations: {
        title: "Get per-target provisioning steps",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ target }) => {
      const validTargets = await repoClient.getTargetsConfig();
      if (!validTargets) {
        return {
          content: [
            {
              type: "text",
              text: `# get-provisioning-steps failed\n\nCould not fetch targets.json. Check network.`,
            },
          ],
        };
      }
      if (!validTargets[target]) {
        return {
          content: [
            {
              type: "text",
              text: `# get-provisioning-steps failed\n\nUnknown target \`${target}\`. Use \`list-targets\` to see valid options.`,
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
      const provisionCmd = `avocado provision -r dev${profileArg}`;

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
        out += `**For an LLM running via the Bash tool (NO interactive terminal):** \`avocado provision\` shells out to \`docker run -it\` internally and fails under a non-TTY harness with \`the input device is not a TTY\`. **\`--no-tui\` does NOT fix this** — \`--no-tui\` only controls Avocado's own output rendering, not Docker's TTY requirement. Wrap with \`script -q /dev/null\` to provide a pseudo-TTY:\n\n`;
        out += "```bash\n";
        out += `avocado build --no-tui > /tmp/avocado-build.log 2>&1\n`;
        out += `script -q /dev/null ${provisionCmd} --no-tui > /tmp/avocado-provision.log 2>&1\n`;
        out += "```\n\n";
        out += `**This wrapper is required for every \`avocado provision\` call you make via Bash.** Without it the provision exits immediately with the TTY error; passing \`--no-tui\` alone is not sufficient.\n\n`;
      }
      if (profile.notes.length > 0) {
        out += `## Notes\n\n`;
        for (const n of profile.notes) out += `- ${n}\n`;
      }
      out += `\nFor authoritative per-target documentation, see:\n\n`;
      out += `\`https://docs.peridio.com/hardware/${target}\` (or the parent vendor's section).\n`;

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
        "FR201 ships pre-configured for Avocado. `avocado provision -r dev` over the network.",
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
      "Insert the SD card after `avocado provision -r dev --profile sd` finishes, then apply power to the target.",
    ],
  };
}
