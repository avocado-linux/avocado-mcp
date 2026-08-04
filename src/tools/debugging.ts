import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execFile } from "child_process";
import { promisify } from "util";
import {
  detectSerialPorts,
  getDeviceConnectionInfo,
  buildTmuxSnippet,
  emulatorInstallHint,
  SUPPORTED_EMULATORS,
  SAFE_PORT_RE,
  type SerialEmulator,
} from "../lib/device-info.js";

const execFileP = promisify(execFile);

async function whichBinary(name: string): Promise<boolean> {
  try {
    await execFileP("which", [name], { timeout: 2000 });
    return true;
  } catch {
    return false;
  }
}

async function detectInstalledEmulators(): Promise<
  Record<SerialEmulator, boolean>
> {
  const checks = await Promise.all(
    SUPPORTED_EMULATORS.map(async (e) => [e, await whichBinary(e)] as const),
  );
  return Object.fromEntries(checks) as Record<SerialEmulator, boolean>;
}

export function registerDebuggingTools(server: McpServer): void {
  server.registerTool(
    "detect-serial-ports",
    {
      title: "Detect USB-to-UART adapters + emulators",
      description:
        "Scan /dev for USB-to-UART adapter device nodes (tty.usbserial-*, tty.SLAB_*, ttyUSB*, ttyACM*) AND check which serial terminal emulators are installed on the host (`tio`, `picocom`, `minicom`). Driving a UART through tmux requires BOTH a port AND an emulator — `tmux` alone cannot talk to a serial device. Call this before `get-tmux-uart-snippet` so you can confirm both halves are in place.",
      inputSchema: {},
      outputSchema: {
        ports: z.array(
          z.object({
            path: z.string(),
            confidence: z.enum(["likely", "possible"]),
            reason: z.string(),
          }),
        ),
        emulators: z.object({
          tio: z.boolean(),
          picocom: z.boolean(),
          minicom: z.boolean(),
        }),
        anyEmulatorInstalled: z.boolean(),
      },
      annotations: {
        title: "Detect USB-to-UART adapters + emulators",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      const [ports, emulators] = await Promise.all([
        detectSerialPorts(),
        detectInstalledEmulators(),
      ]);
      let out = `# detect-serial-ports\n\n`;
      out += `## Serial terminal emulators (required — tmux alone is not enough)\n\n`;
      out += `| Emulator | Installed | Install command |\n|---------|-----------|------------------|\n`;
      for (const e of SUPPORTED_EMULATORS) {
        out += `| \`${e}\` | ${emulators[e] ? "✅" : "❌"} | ${emulatorInstallHint(e)} |\n`;
      }
      const anyInstalled = SUPPORTED_EMULATORS.some((e) => emulators[e]);
      if (!anyInstalled) {
        out += `\n**No serial emulator is installed.** \`tmux\` alone cannot talk to a UART. Ask the user to install one of the above (\`tio\` is recommended — cleanest output for \`tmux capture-pane\`) before continuing.\n\n`;
      } else {
        const which = SUPPORTED_EMULATORS.filter((e) => emulators[e]);
        out += `\n✅ Installed: ${which.map((e) => `\`${e}\``).join(", ")}. Use the strongest available (preference: \`tio\` > \`picocom\` > \`minicom\`) when calling \`get-tmux-uart-snippet\`.\n\n`;
      }
      out += `## Detected serial ports\n\n`;
      if (ports.length === 0) {
        out += `No USB-serial adapters detected under \`/dev\`.\n\n`;
        out += `Likely causes:\n`;
        out += `- The adapter isn't plugged in to the host.\n`;
        out += `- The adapter driver isn't installed (Silicon Labs CP210x and FTDI sometimes need explicit drivers on macOS).\n`;
        out += `- You're on a host where this server doesn't have permission to read \`/dev\`.\n\n`;
        out += `Plug in the adapter, then re-run this tool.`;
      } else {
        out += `Found **${ports.length}** candidate port(s):\n\n`;
        out += `| Port | Confidence | Reason |\n|------|-----------|--------|\n`;
        for (const p of ports) {
          out += `| \`${p.path}\` | ${p.confidence} | ${p.reason} |\n`;
        }
        const likely = ports.filter((p) => p.confidence === "likely");
        if (likely.length === 1) {
          out += `\n→ The most likely candidate is \`${likely[0].path}\`. Use this with \`get-tmux-uart-snippet\`.`;
        } else if (likely.length > 1) {
          out += `\n→ Multiple likely candidates. If you're not sure which is your target's adapter, unplug it, re-run, see which port disappears, then re-plug.`;
        } else {
          out += `\n→ Only "possible" matches were found (CDC-ACM devices). These can be UART adapters or unrelated USB serial devices — verify before using.`;
        }
      }
      return {
        content: [
          { type: "text", text: out },
          {
            type: "text",
            text: `\n\`\`\`json\n${JSON.stringify(ports, null, 2)}\n\`\`\``,
          },
        ],
        structuredContent: {
          ports,
          emulators,
          anyEmulatorInstalled: SUPPORTED_EMULATORS.some((e) => emulators[e]),
        },
      };
    },
  );

  server.registerTool(
    "get-device-connection-info",
    {
      title: "Get UART parameters + credentials for a target",
      description:
        "Get the serial-console connection parameters (baud, voltage, parity, data bits, stop bits) and default login credentials for a given Avocado target, plus per-target wiring caveats (Jetson pinout, RS-232 vs TTL, etc.). Call this once you know the user's target so you can configure the serial bridge correctly.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target name (e.g. 'raspberrypi5', 'jetson-orin-nano-devkit').",
          ),
      },
      outputSchema: {
        target: z.string(),
        serial: z.object({
          baud: z.number().int(),
          voltage: z.string(),
          parity: z.string(),
          dataBits: z.number().int(),
          stopBits: z.number().int(),
        }),
        defaultUser: z.string(),
        defaultPasswordNote: z.string(),
        caveats: z.array(z.string()),
      },
      annotations: {
        title: "Get UART parameters + credentials for a target",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ target }) => {
      const info = getDeviceConnectionInfo(target);
      let out = `# get-device-connection-info — \`${target}\`\n\n`;
      out += `## Serial parameters\n\n`;
      out += `- **Baud:** ${info.serial.baud}\n`;
      out += `- **Voltage:** ${info.serial.voltage}\n`;
      out += `- **Format:** ${info.serial.dataBits}${info.serial.parity[0].toUpperCase()}${info.serial.stopBits} (${info.serial.dataBits} data bits, ${info.serial.parity} parity, ${info.serial.stopBits} stop bit)\n\n`;
      out += `## Default credentials (dev runtime)\n\n`;
      out += `- **User:** \`${info.defaultUser}\`\n`;
      out += `- **Password:** ${info.defaultPasswordNote}\n\n`;
      if (info.caveats.length > 0) {
        out += `## Wiring caveats\n\n`;
        for (const c of info.caveats) out += `- ${c}\n`;
      } else {
        out += `_No target-specific wiring caveats._\n`;
      }
      return {
        content: [
          { type: "text", text: out },
          {
            type: "text",
            text: `\n\`\`\`json\n${JSON.stringify(info, null, 2)}\n\`\`\``,
          },
        ],
        structuredContent: { ...info },
      };
    },
  );

  server.registerTool(
    "get-tmux-uart-snippet",
    {
      title: "Get tmux+UART bridge commands",
      description:
        "Generate the exact bash commands to bridge a UART serial console to Claude through a detached tmux session. **Requires BOTH `tmux` AND a serial terminal emulator** (`tio`, `picocom`, or `minicom`) — `tmux` alone cannot talk to a serial device. Call `detect-serial-ports` first to confirm which emulators are installed. Returns the `tmux new-session`, `tmux send-keys`, and `tmux capture-pane` snippets pre-filled with the user's port, target's baud rate, and chosen emulator.",
      inputSchema: {
        portPath: z
          .string()
          // Shared with the runtime guard in device-info.ts so the schema and
          // the lib can't drift into accepting/rejecting different values.
          .regex(
            SAFE_PORT_RE,
            "must be a device path (letters, digits, '.', '_', ':', '-', '/'), starting with a letter or '/'",
          )
          .describe(
            "Full path to the serial port (from detect-serial-ports), e.g. '/dev/tty.usbserial-AB0123' or '/dev/ttyUSB0'.",
          ),
        target: z
          .string()
          .describe(
            "Target name. Used to look up the correct baud rate (almost always 115200).",
          ),
        emulator: z
          .enum(["tio", "picocom", "minicom"])
          .optional()
          .describe(
            "Serial terminal emulator to drive. Defaults to 'tio' (recommended — cleanest output for tmux capture-pane). Pick whichever is installed on the host per detect-serial-ports. `screen` is NOT supported — its Ctrl-A binding collides with tmux and its terminal control sequences pollute capture-pane output.",
          ),
        sessionName: z
          .string()
          .optional()
          .describe(
            "Optional tmux session name. Defaults to 'avocado-uart'. Use a different name only if you already have an avocado-uart session for another device. Non-`[A-Za-z0-9_-]` characters are stripped, and an empty/flag-like result falls back to the default — so this is repaired, not rejected (unlike portPath).",
          ),
      },
      annotations: {
        title: "Get tmux+UART bridge commands",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ portPath, target, emulator, sessionName }) => {
      const info = getDeviceConnectionInfo(target);
      const session = sessionName ?? "avocado-uart";
      const chosen: SerialEmulator = emulator ?? "tio";

      // Sanity check: warn if the target is QEMU, which has no physical port.
      if (target.startsWith("qemu")) {
        return {
          content: [
            {
              type: "text",
              text: `# get-tmux-uart-snippet\n\n⚠️  \`${target}\` is a virtual target. There is no physical serial port. Launch the VM with \`avocado sdk run -iE vm dev\` instead, and the console will appear in your terminal directly.`,
            },
          ],
        };
      }

      let snippet: string;
      try {
        snippet = buildTmuxSnippet(portPath, info.serial.baud, chosen, session);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# get-tmux-uart-snippet failed\n\n❌ ${(e as Error).message}`,
            },
          ],
          isError: true,
        };
      }

      let out = `# get-tmux-uart-snippet — \`${target}\` on \`${portPath}\` (via \`${chosen}\`)\n\n`;
      out += `## Prerequisites — BOTH required\n\n`;
      out += `Driving a UART through tmux needs two pieces. \`tmux\` is a session multiplexer; it does NOT speak to serial devices. The emulator (\`${chosen}\` here) is what actually opens the port. Confirm both are installed:\n\n`;
      out += "```bash\n";
      out += `which tmux ${chosen}    # both lines must return a path\n`;
      out += "```\n\n";
      out += `Install commands if either is missing:\n\n`;
      out += "```bash\n";
      out += `# tmux — macOS: brew install tmux  •  Debian/Ubuntu: sudo apt install tmux\n`;
      out += `# ${chosen} — ${emulatorInstallHint(chosen)}\n`;
      out += "```\n\n";
      out += `## Bridge setup + usage\n\n`;
      out += "```bash\n" + snippet + "\n```\n\n";
      out += `## Important rules\n\n`;
      out += `- Always use \`Enter\` as a separate \`send-keys\` argument (not \`'\\n'\` inside the string).\n`;
      out += `- Always use \`--no-pager\` with journalctl over this bridge.\n`;
      out += `- Never run \`journalctl -f\` or interactive editors (\`vi\`, \`htop\`) — they won't return.\n`;
      out += `- Capture more lines than you think you need; async kernel output pollutes the buffer.\n`;
      out += `- Don't substitute \`screen\` for the emulator: Ctrl-A binding collides with tmux and its control sequences break \`capture-pane\` output.\n`;
      out += `- For details and patterns (sentinels for slicing output, etc.), read \`avocado://skills/tmux-uart-bridge\`.\n`;

      return { content: [{ type: "text", text: out }] };
    },
  );
}
