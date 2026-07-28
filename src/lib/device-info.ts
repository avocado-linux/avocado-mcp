/**
 * Serial-port detection + per-target device debugging info.
 *
 * The MCP server can't open serial ports — it doesn't need to. Its job is to
 * tell Claude *which* port to use and *how* to wire the tmux bridge. Claude
 * runs the actual `tmux new-session` / `send-keys` / `capture-pane` via its
 * own Bash tool.
 */

import { readdir } from "fs/promises";
import * as path from "path";

export interface SerialPortCandidate {
  /** Full path, e.g. /dev/tty.usbserial-AB0123 */
  path: string;
  /** Heuristic likelihood: "likely" for usbserial-prefixed devices, "possible" otherwise */
  confidence: "likely" | "possible";
  /** Why this entry was matched */
  reason: string;
}

/**
 * Probe /dev for typical USB-to-UART adapter device nodes.
 *
 * macOS uses /dev/tty.usbserial-*, /dev/tty.SLAB_USBtoUART, /dev/tty.usbmodem*
 * Linux uses /dev/ttyUSB*, /dev/ttyACM*
 * We ignore /dev/cu.* on macOS (the call-out variant) because `tio` and most
 * console tools default to the tty.* side.
 */
export async function detectSerialPorts(): Promise<SerialPortCandidate[]> {
  let entries: string[] = [];
  try {
    entries = await readdir("/dev");
  } catch {
    return [];
  }

  const out: SerialPortCandidate[] = [];

  for (const name of entries) {
    const full = path.join("/dev", name);

    // macOS — tty side only
    if (name.startsWith("tty.usbserial")) {
      out.push({
        path: full,
        confidence: "likely",
        reason: "USB-serial adapter (macOS)",
      });
    } else if (name.startsWith("tty.SLAB_USBtoUART")) {
      out.push({
        path: full,
        confidence: "likely",
        reason: "Silicon Labs CP210x adapter (macOS)",
      });
    } else if (name.startsWith("tty.usbmodem")) {
      out.push({
        path: full,
        confidence: "possible",
        reason:
          "USB CDC-ACM device (macOS) — could be a UART adapter or another USB serial device",
      });
    }

    // Linux
    else if (/^ttyUSB\d+$/.test(name)) {
      out.push({
        path: full,
        confidence: "likely",
        reason: "USB-serial adapter (Linux)",
      });
    } else if (/^ttyACM\d+$/.test(name)) {
      out.push({
        path: full,
        confidence: "possible",
        reason:
          "USB CDC-ACM device (Linux) — could be a UART adapter or another USB serial device",
      });
    }
  }

  // Stable order: likely first, then alphabetical.
  out.sort((a, b) => {
    if (a.confidence !== b.confidence) {
      return a.confidence === "likely" ? -1 : 1;
    }
    return a.path.localeCompare(b.path);
  });

  return out;
}

export interface DeviceConnectionInfo {
  target: string;
  serial: {
    baud: number;
    voltage: string;
    parity: string;
    dataBits: number;
    stopBits: number;
  };
  defaultUser: string;
  defaultPasswordNote: string;
  caveats: string[];
}

/**
 * Per-target connection info. Most targets are 115200/8N1/3.3V — this table
 * captures the exceptions (Jetson pinout, x86 boards without onboard TTL).
 */
export function getDeviceConnectionInfo(target: string): DeviceConnectionInfo {
  // The standard everywhere unless noted.
  const base: DeviceConnectionInfo = {
    target,
    serial: {
      baud: 115200,
      voltage: "3.3V",
      parity: "none",
      dataBits: 8,
      stopBits: 1,
    },
    defaultUser: "root",
    defaultPasswordNote:
      "Passwordless in the `dev` runtime (set by the `config` extension in the starter YAML). NOT FOR PRODUCTION.",
    caveats: [],
  };

  if (target.startsWith("jetson")) {
    return {
      ...base,
      caveats: [
        "Jetson serial console needs three jumper wires to the 40-pin header: GND (pin 6), UART TXD (pin 8) → adapter RX, UART RXD (pin 10) → adapter TX.",
        "Do NOT connect VCC — the adapter's 3.3V from USB and the Jetson's regulators don't coexist.",
        "For provisioning recovery mode, also short FC REC to GND (a fourth jumper).",
      ],
    };
  }

  if (target.startsWith("intel-x86-64") || target === "fr201") {
    return {
      ...base,
      caveats: [
        "x86 platforms typically expose the serial console over the board's DB9 / RJ45 console port (NOT a 3.3V TTL header). Use a proper RS-232 serial cable / USB-to-RS-232 adapter, not a 3.3V TTL adapter.",
        "Voltage may be RS-232 levels (±12V), not 3.3V. Check the board manual before connecting a TTL adapter.",
      ],
    };
  }

  if (target.startsWith("qemu")) {
    return {
      ...base,
      caveats: [
        "QEMU targets have no physical serial port — the VM's serial output goes to stdout / a pty. `tio` and a USB adapter are not used; instead use `avocado sdk run` to launch the VM with the console in your terminal.",
      ],
    };
  }

  if (target.startsWith("raspberrypi")) {
    return {
      ...base,
      caveats: [
        "Wire the adapter to the 40-pin header: GND (pin 6 or any GND), UART TXD (pin 8, GPIO 14) → adapter RX, UART RXD (pin 10, GPIO 15) → adapter TX.",
        "Do NOT connect VCC.",
      ],
    };
  }

  if (target.startsWith("imx") || target.startsWith("stm32")) {
    return {
      ...base,
      caveats: [
        "Refer to the board's debug header in the vendor docs for the exact UART pinout. Most NXP and STM32 EVKs expose a labeled 3-pin header (RX/TX/GND).",
      ],
    };
  }

  if (target === "grinn-astra-1680-sbc" || target === "rzv2n-sr-som") {
    return {
      ...base,
      caveats: [
        "Refer to the carrier board's labeled debug UART header. Connect GND, RX, TX (cross over: adapter TX → target RX, adapter RX → target TX).",
      ],
    };
  }

  return base;
}

export type SerialEmulator = "tio" | "picocom" | "minicom";

export const SUPPORTED_EMULATORS: SerialEmulator[] = [
  "tio",
  "picocom",
  "minicom",
];

/**
 * Serial device paths and tmux session names come from device discovery, but
 * they get pasted verbatim into shell commands. A crafted value containing a
 * quote or `;` could otherwise break out of the surrounding quoting and inject
 * a command. Restrict them to the charset real device paths / session names
 * actually use (letters, digits, `._-/`); anything else is dropped. Real ports
 * (`/dev/ttyUSB0`, `/dev/cu.usbserial-1420`, `COM3`) and session names pass
 * through unchanged.
 */
function sanitizeShellToken(s: string): string {
  return s.replace(/[^A-Za-z0-9._/-]/g, "");
}

export function emulatorInvocation(
  emulator: SerialEmulator,
  portPath: string,
  baud: number,
): string {
  const port = sanitizeShellToken(portPath);
  switch (emulator) {
    case "tio":
      return `tio -b ${baud} ${port}`;
    case "picocom":
      return `picocom -b ${baud} ${port}`;
    case "minicom":
      // -o skips the modem init string; without it minicom sends AT
      // commands to the target on startup and the session can fail.
      return `minicom -b ${baud} -D ${port} -o`;
  }
}

export function emulatorInstallHint(emulator: SerialEmulator): string {
  switch (emulator) {
    case "tio":
      return "macOS: `brew install tio`  •  Debian/Ubuntu: `sudo apt install tio`";
    case "picocom":
      return "macOS: `brew install picocom`  •  Debian/Ubuntu: `sudo apt install picocom`";
    case "minicom":
      return "macOS: `brew install minicom`  •  Debian/Ubuntu: `sudo apt install minicom`";
  }
}

export function buildTmuxSnippet(
  portPath: string,
  baud: number,
  emulator: SerialEmulator = "tio",
  sessionName = "avocado-uart",
): string {
  // Both flow into copy-paste shell commands. A session name is cosmetic, so
  // sanitizing it in place is fine. A port path is not: silently stripping
  // characters would hand back a command targeting a *different* device than
  // the caller named, so reject anything that isn't already safe rather than
  // rewriting it. Also reject a leading `-`, which a terminal emulator reads
  // as a flag rather than a device path (option injection with no metachars).
  sessionName = sanitizeShellToken(sessionName) || "avocado-uart";
  if (
    !portPath ||
    sanitizeShellToken(portPath) !== portPath ||
    portPath.startsWith("-")
  ) {
    throw new Error(
      `Serial port path ${JSON.stringify(portPath)} is not a usable device path — expected only letters, digits, '.', '_', '-' and '/', and not to start with '-' (a terminal emulator would read that as a flag). Pass a real device path like /dev/ttyUSB0.`,
    );
  }
  return [
    `# 1. Start a detached tmux session with the serial console`,
    `tmux new-session -d -s ${sessionName} '${emulatorInvocation(emulator, portPath, baud)}'`,
    ``,
    `# 2. (optional) attach yourself in another terminal to watch:`,
    `#    tmux attach -t ${sessionName}`,
    ``,
    `# 3. Send a command — note: Enter is a separate arg, not '\\n'`,
    `tmux send-keys -t ${sessionName} 'journalctl -xeu my-app.service --no-pager' Enter`,
    ``,
    `# 4. Wait a beat and capture the response`,
    `sleep 1`,
    `tmux capture-pane -t ${sessionName} -p -S -200`,
    ``,
    `# When you're done:`,
    `# tmux kill-session -t ${sessionName}`,
  ].join("\n");
}
