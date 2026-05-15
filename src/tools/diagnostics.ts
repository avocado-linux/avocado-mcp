import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  diagnoseProvisionLog,
  diagnoseBuildLog,
  extractFailingPackages,
  investigatePackages,
  renderDiagnoses,
} from "../lib/diagnostics.js";
import { RepoClient } from "../lib/repo-client.js";

export function registerDiagnosticsTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.tool(
    "diagnose-provision-log",
    "Analyze the output of `avocado provision` for known failure patterns (auto-mount, missing device, USB issues, permission errors, etc.) and return a structured diagnosis. Use this when a provision failed and the user has pasted the log.",
    {
      log: z
        .string()
        .min(1)
        .describe(
          "Full or partial provision log output. Paste verbatim — heuristics scan for known error fingerprints.",
        ),
    },
    async ({ log }) => {
      const diagnoses = diagnoseProvisionLog(log);
      return {
        content: [
          { type: "text", text: renderDiagnoses("provision", diagnoses) },
        ],
      };
    },
  );

  server.tool(
    "explain-build-error",
    "Analyze the output of `avocado build` or `avocado install` for known failure patterns AND actively probe the package feed. When you pass `targets`, the tool extracts any failing package names from the log and looks them up across both the `edge` and `apollo` channels — turning generic 'package not found' advice into a concrete answer (e.g. 'present on apollo only, switch distro.channel'). Always pass `targets` if you know them; without it the tool falls back to pattern matching only.",
    {
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
          "Target(s) the user was building for (e.g. ['jetson-orin-nano-devkit']). Strongly recommended — enables cross-channel package lookup that often surfaces the actual cause when patterns alone are inconclusive.",
        ),
    },
    async ({ log, targets }) => {
      const diagnoses = diagnoseBuildLog(log);
      if (!targets || targets.length === 0) {
        return {
          content: [
            { type: "text", text: renderDiagnoses("build", diagnoses) },
          ],
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
            }),
          },
        ],
      };
    },
  );

  server.tool(
    "get-provisioning-steps",
    "Return the per-target provisioning steps for a given target (which profile to use, which media to flash, the exact `avocado provision` command, and per-target caveats like linuxAutoMount or tegraflash recovery mode). Look this up before telling a user how to provision.",
    {
      target: z
        .string()
        .describe(
          "Target name (must match an entry from list-targets, e.g. 'raspberrypi5').",
        ),
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
      let out = `# Provisioning \`${target}\`\n\n`;
      out += `**Profile:** \`${profile.profile}\`\n`;
      out += `**Media:** ${profile.media}\n`;
      out += `**Host OS supported:** ${profile.hostOs.join(", ")}\n`;
      if (profile.warnings.length > 0) {
        out += `**Warnings:** ${profile.warnings.join(", ")}\n`;
      }
      out += `\n## Steps\n\n`;
      out += "```bash\n";
      out += `avocado build\n`;
      out += `avocado provision -r dev${profile.profile !== "default" ? ` --profile ${profile.profile}` : ""}\n`;
      out += "```\n\n";
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
