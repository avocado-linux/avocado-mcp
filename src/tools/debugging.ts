import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  detectSerialPorts,
  getDeviceConnectionInfo,
  buildTmuxSnippet,
} from "../lib/device-info.js";

export function registerDebuggingTools(server: McpServer): void {
  server.tool(
    "detect-serial-ports",
    "Scan /dev for USB-to-UART adapter device nodes (tty.usbserial-*, tty.SLAB_*, ttyUSB*, ttyACM*). Returns candidate port paths the user might want to attach `tio` to. Call this before `get-tmux-uart-snippet` so you can fill in the right port path.",
    {},
    async () => {
      const ports = await detectSerialPorts();
      let out = `# detect-serial-ports\n\n`;
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
      };
    },
  );

  server.tool(
    "get-device-connection-info",
    "Get the serial-console connection parameters (baud, voltage, parity, data bits, stop bits) and default login credentials for a given Avocado target, plus per-target wiring caveats (Jetson pinout, RS-232 vs TTL, etc.). Call this once you know the user's target so you can configure the serial bridge correctly.",
    {
      target: z
        .string()
        .describe(
          "Target name (e.g. 'raspberrypi5', 'jetson-orin-nano-devkit').",
        ),
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
      };
    },
  );

  server.tool(
    "get-tmux-uart-snippet",
    "Generate the exact bash commands to bridge a UART serial console to Claude through a detached tmux session. Returns the `tmux new-session`, `tmux send-keys`, and `tmux capture-pane` snippets pre-filled with the user's port and target's baud rate. Run this after `detect-serial-ports` and `get-device-connection-info`.",
    {
      portPath: z
        .string()
        .describe(
          "Full path to the serial port (from detect-serial-ports), e.g. '/dev/tty.usbserial-AB0123' or '/dev/ttyUSB0'.",
        ),
      target: z
        .string()
        .describe(
          "Target name. Used to look up the correct baud rate (almost always 115200).",
        ),
      sessionName: z
        .string()
        .optional()
        .describe(
          "Optional tmux session name. Defaults to 'avocado-uart'. Use a different name only if you already have an avocado-uart session for another device.",
        ),
    },
    async ({ portPath, target, sessionName }) => {
      const info = getDeviceConnectionInfo(target);
      const session = sessionName ?? "avocado-uart";

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

      const snippet = buildTmuxSnippet(portPath, info.serial.baud, session);

      let out = `# get-tmux-uart-snippet — \`${target}\` on \`${portPath}\`\n\n`;
      out += `## Prerequisites\n\nMake sure \`tmux\` and \`tio\` are installed on the host:\n\n`;
      out += "```bash\n";
      out += `# macOS\nbrew install tmux tio\n\n# Debian/Ubuntu\nsudo apt install tmux tio\n`;
      out += "```\n\n";
      out += `## Bridge setup + usage\n\n`;
      out += "```bash\n" + snippet + "\n```\n\n";
      out += `## Important rules\n\n`;
      out += `- Always use \`Enter\` as a separate \`send-keys\` argument (not \`'\\n'\` inside the string).\n`;
      out += `- Always use \`--no-pager\` with journalctl over this bridge.\n`;
      out += `- Never run \`journalctl -f\` or interactive editors (\`vi\`, \`htop\`) — they won't return.\n`;
      out += `- Capture more lines than you think you need; async kernel output pollutes the buffer.\n`;
      out += `- For details and patterns (sentinels for slicing output, etc.), read \`avocado://skills/tmux-uart-bridge\`.\n`;

      return { content: [{ type: "text", text: out }] };
    },
  );
}
