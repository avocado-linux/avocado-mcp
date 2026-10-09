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
import {
  unknownTargetText,
  boardDocsUrl,
  isVirtual,
  lookupTarget,
  serialCaveats,
  SERIAL_OPTIONAL,
  HARDWARE_DOCS_URL,
  type HardwareData,
} from "./hardware-data.js";

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
  /** True when the board has an onboard USB console (no adapter needed). */
  onboardConsole: boolean;
  /**
   * `onboard`: onboard USB console. `adapter`: needs a USB-to-UART adapter.
   * `none`: a virtual target with no physical port. `unknown`: the docs data
   * does not describe a serial console for this board.
   */
  consoleType: ConsoleType;
  defaultUser: string;
  defaultPasswordNote: string;
  caveats: string[];
  /** Board page, when the docs data has one. */
  docsUrl?: string;
}

export type ConsoleType = "onboard" | "adapter" | "none" | "unknown";

/** The "Console" line of `get-device-connection-info` for each type. */
export const CONSOLE_TEXT: Record<ConsoleType, string> = {
  onboard: "onboard USB (no adapter needed)",
  adapter: "USB-to-UART adapter",
  none: "none (virtual target, the VM console is the terminal that runs the VM)",
  unknown:
    "unknown (the docs data does not describe a serial console for this board, check the board page)",
};

const COMMON_BAUD = 115200;

/**
 * Serial console facts for a target from the docs board data. Every Avocado
 * console runs 8N1. The baud, voltage, onboard console and wiring come from
 * the data. When the data is missing, the result says so and falls back to
 * the common 115200 baud.
 */
export function getDeviceConnectionInfo(
  target: string,
  data: HardwareData | null,
  board?: string,
): DeviceConnectionInfo {
  // A board narrows the lookup, so a MIC-733 does not get the wiring of the
  // dev kit that shares its target.
  const info = data ? lookupTarget(data, target, board) : null;
  const serial = info?.entries.find((e) => e.serial)?.serial;
  const virtual = info ? isVirtual(info) : /^qemu/i.test(target.trim());
  const consoleType: ConsoleType = virtual
    ? "none"
    : serial?.onboard
      ? "onboard"
      : serial
        ? "adapter"
        : "unknown";
  const base: DeviceConnectionInfo = {
    target: info?.target ?? target,
    serial: {
      baud: serial?.baud ?? COMMON_BAUD,
      voltage:
        serial?.voltage ??
        (serial?.onboard
          ? "n/a (onboard USB console)"
          : "not in the docs data (check the board page)"),
      parity: "none",
      dataBits: 8,
      stopBits: 1,
    },
    onboardConsole: serial?.onboard === true,
    consoleType,
    defaultUser: "root",
    defaultPasswordNote:
      "Empty root password, set by the `dev` profile in the top-level `permissions` section of the starter `avocado.yaml` (`rootfs` and `initramfs` use it). NOT FOR PRODUCTION.",
    caveats: info?.requested
      ? [
          `Resolved \`${info.requested}\` to target \`${info.target}\`.`,
          SERIAL_OPTIONAL,
        ]
      : [SERIAL_OPTIONAL],
    docsUrl: info ? boardDocsUrl(info) : undefined,
  };

  if (virtual) {
    base.caveats = [
      "QEMU targets have no physical serial port. The VM console is the terminal that runs `avocado sdk run -iE vm dev` (after `avocado provision dev`). No USB adapter or `tio` is used.",
    ];
    return base;
  }
  if (!data) {
    base.caveats.push(
      `Board data unavailable. These are the common defaults, not facts for \`${target}\`. Check ${HARDWARE_DOCS_URL}.`,
    );
    return base;
  }
  if (!info) {
    base.caveats.push(
      `${unknownTargetText(target, data).trim()} These are the common defaults.`,
    );
    return base;
  }
  if (serial && !serial.baud) {
    base.caveats.push(
      `The docs data gives no baud rate for this board. ${COMMON_BAUD} is the common default.`,
    );
  }
  base.caveats.push(...serialCaveats(serial));
  return base;
}

export type SerialEmulator = "tio" | "picocom" | "minicom";

export const SUPPORTED_EMULATORS: SerialEmulator[] = [
  "tio",
  "picocom",
  "minicom",
];

/**
 * The charset a real serial device path uses: letters, digits, and `._:/-`.
 * `:` is required — the canonical stable path is
 * `/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0`. The path must start
 * with a letter or `/` (so `COM3` and `/dev/...` pass) and NOT with `-`, which a
 * terminal emulator would read as an option rather than a device (arg injection
 * with no shell metacharacters). None of these need shell escaping inside the
 * single quotes they land in.
 */
export const SAFE_PORT_RE = /^[A-Za-z/][A-Za-z0-9._:/-]*$/;

/**
 * Reject a serial port path that isn't already safe. These flow verbatim into
 * copy-paste shell commands, so we reject rather than rewrite — a stripped path
 * would silently target a *different* device than the caller named.
 */
function assertSafePortPath(portPath: string): void {
  if (!SAFE_PORT_RE.test(portPath)) {
    throw new Error(
      `Serial port path ${JSON.stringify(portPath)} is not a usable device path — expected only letters, digits, '.', '_', ':', '-' and '/', starting with a letter or '/' (not '-', which a terminal emulator would read as a flag). Pass a real device path like /dev/ttyUSB0.`,
    );
  }
}

/**
 * A tmux session name is cosmetic, so sanitizing it in place is fine (unlike a
 * port path). Strip to a shell-safe token; fall back to the default if that
 * leaves it empty or leading-`-` (which tmux/`-s` would misparse). Both `:` and
 * `.` are excluded — together they are tmux's `session:window.pane` addressing
 * grammar, so a name like `uart.2` in `-t uart.2` would resolve as window+pane
 * against the current session instead of the session we created.
 */
function sanitizeSessionName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9_-]/g, "");
  return !cleaned || cleaned.startsWith("-") ? "avocado-uart" : cleaned;
}

export function emulatorInvocation(
  emulator: SerialEmulator,
  portPath: string,
  baud: number,
): string {
  // Reject (don't rewrite) — this is the point where the port becomes a command
  // argument, so a bad value must fail loudly rather than silently retarget.
  assertSafePortPath(portPath);
  switch (emulator) {
    case "tio":
      return `tio -b ${baud} ${portPath}`;
    case "picocom":
      return `picocom -b ${baud} ${portPath}`;
    case "minicom":
      // -o skips the modem init string; without it minicom sends AT
      // commands to the target on startup and the session can fail.
      return `minicom -b ${baud} -D ${portPath} -o`;
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
  // Reject an unsafe port up front (don't rewrite), and sanitize the cosmetic
  // session name. emulatorInvocation below asserts the port again, but keeping
  // it here makes the rejection an explicit precondition of this public entry
  // point rather than an accident of the array being evaluated eagerly.
  assertSafePortPath(portPath);
  sessionName = sanitizeSessionName(sessionName);
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
