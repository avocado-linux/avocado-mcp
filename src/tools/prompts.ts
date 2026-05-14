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
              "2. Run `list-targets` and pick the target that matches my hardware (or, if I haven't named hardware, summarise the options and ask).",
              "3. Call `init-project` with the chosen target to generate a starter `avocado.yaml`.",
              "4. Call `get-provisioning-steps` so I know exactly which `avocado provision` invocation to run for my target.",
              "",
              "Finish by giving me the exact two commands I should run next (`avocado build` and the provisioning command), plus what to expect.",
            ].join("\n"),
          },
        },
      ],
    }),
  );
}
