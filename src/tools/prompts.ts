import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Pre-built workflows the user can invoke by name from their MCP client.
 * Each prompt returns a message sequence that orients Claude to use the
 * MCP's tools in the right order — these are essentially "macros" for the
 * common flows.
 */
export function registerPrompts(server: McpServer): void {
  server.prompt(
    "debug-device",
    "Debug a running Avocado OS device. Defaults to a UART-over-tmux session (matches the getting-started flow's required USB-to-UART adapter), falls back to SSH for steady-state work.",
    {
      target: z
        .string()
        .optional()
        .describe(
          "Target name the user is debugging (e.g. 'raspberrypi5'). If unknown, ask the user before running.",
        ),
      symptom: z
        .string()
        .optional()
        .describe(
          "What's broken or unexpected, in the user's own words. Helps Claude prioritise which diagnostic commands to run first.",
        ),
    },
    ({ target, symptom }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Help me debug my Avocado OS device.${target ? ` Target: \`${target}\`.` : ""}${symptom ? ` Symptom: ${symptom}.` : ""}`,
              "",
              "Please follow this flow:",
              "",
              "1. Read the `avocado://skills/device-debugging` resource to understand the two channels (UART default, SSH alternative).",
              "2. Read `avocado://skills/avocado-runtime-details` so you know what tools the device actually has (BusyBox vs GNU, systemd is full, etc.).",
              "3. Default to UART. Read `avocado://skills/tmux-uart-bridge` for the exact pattern.",
              "4. Call `detect-serial-ports` to find the user's USB-to-UART adapter.",
              "5. Call `get-device-connection-info` for the target's baud / pinout / credentials.",
              "6. Call `get-tmux-uart-snippet` and run the `tmux new-session` command in Bash to bridge the console.",
              "7. Send the standard diagnostic battery into the session and capture results: `systemctl --failed`, `journalctl -p err -b --no-pager | tail -50`, `dmesg --color=never | tail -30`, and anything tailored to the symptom.",
              "8. If the user later wants more comfortable interactive work and confirms the device has an IP, switch to SSH (`ssh root@<host> '<command>'` via Bash directly — no MCP tool needed).",
              "",
              "Summarise findings clearly, with next-step suggestions, after running the diagnostics.",
            ].join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "debug-build-failure",
    "Recover from a failed `avocado install` or `avocado build`. Walks you through log-pattern analysis, cross-channel package lookup, hook-script triage, and host/arch checks.",
    {
      target: z
        .string()
        .optional()
        .describe(
          "Target the user was building for (e.g. 'jetson-orin-nano-devkit'). Strongly recommended — unlocks cross-channel package lookup.",
        ),
      log: z
        .string()
        .optional()
        .describe(
          "Full build/install log output, verbatim if available. If absent, the LLM should ask the user to paste it.",
        ),
    },
    ({ target, log }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `My \`avocado install\` / \`avocado build\` failed.${target ? ` Target: \`${target}\`.` : ""}${log ? "" : " I'll paste the log when you ask."}`,
              "",
              "Please walk me through recovery:",
              "",
              "1. If I haven't pasted the log yet, ask for it now.",
              "2. Call `explain-build-error` with the log AND `targets` set to mine. The tool will: (a) match against pattern fingerprints, (b) extract failing package names and look them up across both `edge` and `apollo` channels.",
              "3. **If the result includes any `Hook script:` pattern, branch HERE — this is a user-code failure, not an Avocado bug.** Read `avocado://skills/extension-build-debugging`. Then: (a) Read the failing hook file (path is in the error) at the indicated line. (b) Call `get-reference-file` on a closely related reference's same hook (e.g. `python-flask/app-install.sh`) to compare patterns. (c) Apply the fix from the skill's failure-mode table. Do NOT continue with SDK / cross-channel investigation — those don't apply to hook failures.",
              "4. If the package investigation says 'present on both channels' or 'only on edge' AND the log mentions `libc` / `GLIBC` / SONAMEs, this points at host-arch / arch-metadata. Run `uname -m` and `sw_vers` (or `lsb_release -a`) via Bash to capture my host details, then advise on host swap (e.g. x86_64 Linux for aarch64-broken paths).",
              "5. If the investigation says 'only on apollo', tell me to set `distro.channel: apollo` in `avocado.yaml` and re-run `avocado install`.",
              "6. If everything is inconclusive, summarise what you ruled out, what you'd need next (e.g. the full log, the failing extension's source), and suggest filing a bug.",
              "",
              log ? `\nHere is the log:\n\n\`\`\`\n${log}\n\`\`\`` : "",
            ]
              .filter((s) => s !== "")
              .join("\n"),
          },
        },
      ],
    }),
  );

  server.prompt(
    "start-avocado-project",
    "Set up a brand new Avocado OS project from scratch — verifies the host environment, picks a target, generates avocado.yaml, and explains the next steps.",
    {
      hardware: z
        .string()
        .optional()
        .describe(
          "Hardware the user has on hand, in their own words (e.g. 'a Raspberry Pi 5', 'NVIDIA Jetson Orin Nano dev kit'). Leave blank to start by listing supported targets.",
        ),
    },
    ({ hardware }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `I want to start a new Avocado OS project. ${hardware ? `My hardware: ${hardware}.` : "I haven't picked hardware yet."}`,
              "",
              "Please walk me through the setup. Specifically:",
              "",
              "1. Read the `avocado://skills/getting-started` resource to ground yourself in the workflow.",
              "2. Call `environment-check` to confirm I have the `avocado` CLI, Docker, and ≥8 GB free disk. If anything is missing, surface the fix it returns and stop — don't proceed until the user confirms it's resolved.",
              "3. Run `list-targets` and pick the target that matches my hardware (or, if I haven't named hardware, summarise the options and ask).",
              "4. Call `init-project` with the chosen `target` AND `task` (my task in my own words). The tool will search the reference catalog first and prefer a matching reference — that's almost always faster than from-scratch. If it returns a reference scaffold command, also call `get-reference` for that slug so you understand what it sets up before suggesting edits.",
              "5. Call `get-provisioning-steps` so I know exactly which `avocado provision` invocation to run for my target.",
              "",
              "Finish by giving me the exact commands I should run next: `avocado install` (resolves packages, required before build), then `avocado build`, then the provisioning command. Explain what each does and what to expect.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
