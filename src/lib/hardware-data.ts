/**
 * Board data from the docs.
 *
 * The docs site renders its hardware pages from three files in `peridio/docs`
 * (`src/src/data/hardware/`):
 *
 *   - `targets.json`: per-target provisioning profiles, recovery mode, serial
 *     console and the board page path.
 *   - `supported.json` + `virtual-environment.json`: the boards for each
 *     target and the stream status per LTS release.
 *
 * The MCP reads the same files, so its per-board facts match the docs. Fetch
 * and cache follow `hardware-support.ts`: a 30 min cache, no cache on failure,
 * and `null` when the data cannot be fetched. Callers then say "board data
 * unavailable" and link the docs. They never guess.
 *
 * The commands in the data still use the deprecated `-r` runtime flag, so the
 * renderers here build each command from the profile.
 */
import {
  CACHE_TTL_MS,
  fetchHardwareFile,
  sameTarget,
} from "./hardware-support.js";

export const DOCS_SITE = "https://docs.peridio.com";
export const HARDWARE_DOCS_URL = `${DOCS_SITE}/hardware/support-matrix`;
const AVOCADO_DESKTOP_URL = `${DOCS_SITE}/avocado-desktop/overview`;
const AUTO_MOUNT_URL = `${DOCS_SITE}/developer-reference/linux-auto-mounting`;
export const QEMU_GUIDE_URL = `${DOCS_SITE}/developer-reference/getting-started/qemu`;

/** Free disk space the docs ask for when a target gives no larger number. */
export const DEFAULT_MIN_DISK_GB = 8;

export type RecoveryStep = string | { text: string };

export interface ProvisionOption {
  id: string;
  label?: string;
  profile?: string | null;
  media?: string | null;
  autoMount?: boolean;
  prerequisites?: string[];
  description?: string;
  /** Text and sample output shown after the command on the board page. */
  steps?: { type: string; content: string }[];
  recoveryMode?: {
    steps?: RecoveryStep[];
    verifyCommand?: string;
    verifyExpect?: string;
    reference?: { url: string; label?: string };
  };
  bootInstructions?: string;
  bootSteps?: string[];
  bootNote?: string;
}

export interface SerialConsole {
  onboard?: boolean;
  baud?: number;
  voltage?: string;
  description?: string;
  gpio?: { pin: string; to: string; note?: string }[];
}

export interface TargetEntry {
  name: string;
  target: string;
  board?: string;
  category?: string;
  description?: string;
  configuration?: { description?: string; yaml?: string } | null;
  provisioning?: {
    hostOs?: string[];
    prerequisites?: string[];
    options?: ProvisionOption[];
  };
  serial?: SerialConsole | null;
  hardwareUrl?: string | null;
}

export interface SupportedDevice {
  name: string;
  target: string;
  board?: string;
  url?: string | null;
  lts?: Record<string, string>;
}

export interface HardwareData {
  /** `targets.json`, keyed by entry id (not always the target slug). */
  targets: Record<string, TargetEntry>;
  /** Rows of `supported.json` and `virtual-environment.json`. */
  devices: SupportedDevice[];
}

let cache: { data: HardwareData; expiresAt: number } | null = null;

function devicesOf(json: unknown): SupportedDevice[] {
  const devices =
    json && typeof json === "object" && "devices" in json
      ? (json as { devices: unknown }).devices
      : null;
  return Array.isArray(devices) ? (devices as SupportedDevice[]) : [];
}

/**
 * The docs board data. Cached for 30 min. Returns `null` when it cannot be
 * fetched, so callers can say the data is unavailable.
 */
export async function getHardwareData(): Promise<HardwareData | null> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return cache.data;
  try {
    const [targets, supported, virtual] = await Promise.all(
      ["targets.json", "supported.json", "virtual-environment.json"].map(
        fetchHardwareFile,
      ),
    );
    if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
      throw new Error("targets.json is not an object");
    }
    const data: HardwareData = {
      targets: targets as Record<string, TargetEntry>,
      devices: [...devicesOf(supported), ...devicesOf(virtual)],
    };
    if (Object.keys(data.targets).length === 0 || data.devices.length === 0) {
      throw new Error("board data parsed empty");
    }
    cache = { data, expiresAt: now + CACHE_TTL_MS };
    return data;
  } catch (error) {
    // Don't cache the failure. Retry on the next call.
    console.error("[hardware-data] could not fetch board data:", error);
    return null;
  }
}

/** Test seam: reset the in-memory cache. */
export function clearHardwareDataCache(): void {
  cache = null;
}

/** The docs data for one target, narrowed to a board when one is given. */
export interface TargetInfo {
  /** The target slug as the docs write it. */
  target: string;
  board?: string;
  /** `targets.json` entries for the target (only the board's, if given). */
  entries: TargetEntry[];
  /** `supported.json` rows for the target, one per board. */
  devices: SupportedDevice[];
}

/**
 * True when an entry's steps apply to a board: the entry is for that board, or
 * its avocado.yaml settings name it (RB3 Gen 2 covers its kits this way).
 */
function covers(entry: TargetEntry, board: string): boolean {
  return (
    entry.board === board || (entry.configuration?.yaml ?? "").includes(board)
  );
}

/**
 * Find a target in the docs data. Accepts the docs slug or a feed slug (the
 * 2026 feed drops the `-devkit` suffix). Returns `null` for an unknown target.
 */
export function lookupTarget(
  data: HardwareData,
  target: string,
  board?: string,
): TargetInfo | null {
  const entries = Object.values(data.targets).filter(
    (e) => e?.target && sameTarget(target, e.target),
  );
  const devices = data.devices.filter(
    (d) => d?.target && sameTarget(target, d.target),
  );
  if (entries.length === 0 && devices.length === 0) return null;
  const b = board?.trim() || undefined;
  return {
    target: (entries[0] ?? devices[0]).target,
    board: b,
    // A board-specific setup (MIC-733 on the AGX Orin target) must not get
    // the dev kit's steps, so a board narrows to the entries for that board.
    entries: b ? entries.filter((e) => covers(e, b)) : entries,
    devices,
  };
}

/**
 * Free disk space in GB for a target. The docs give a larger number than the
 * default for some targets (Jetson: 16 GB) as a prerequisite line.
 */
export function minDiskGB(info: TargetInfo | null): number {
  let gb = DEFAULT_MIN_DISK_GB;
  for (const e of info?.entries ?? []) {
    for (const p of e.provisioning?.prerequisites ?? []) {
      const m = /(\d+)\s*GB available disk space/i.exec(p);
      if (m) gb = Math.max(gb, Number(m[1]));
    }
  }
  return gb;
}

export function isVirtual(info: TargetInfo): boolean {
  return info.entries.some((e) => e.category === "virtual");
}

function docsUrl(path: string | null | undefined): string | undefined {
  return path ? `${DOCS_SITE}${path.replace(/\/+$/, "")}` : undefined;
}

/** The board page for a target (or for its board), with no trailing slash. */
export function boardDocsUrl(info: TargetInfo): string | undefined {
  const device = info.board
    ? info.devices.find((d) => d.board === info.board)
    : undefined;
  return (
    docsUrl(device?.url) ??
    docsUrl(info.entries.find((e) => e.hardwareUrl)?.hardwareUrl) ??
    docsUrl(info.devices.find((d) => d.url)?.url)
  );
}

export function provisionCommand(
  runtime: string,
  profile?: string | null,
): string {
  return `avocado provision ${runtime}${profile ? ` --profile ${profile}` : ""}`;
}

const ONBOARD_PORT_HINT =
  "On Linux, an onboard USB console shows up as `/dev/ttyUSB*` or `/dev/ttyACM*`. Use the stable name from `ls /dev/serial/by-id/`. On macOS, look for `/dev/tty.usbserial-*` or `/dev/tty.usbmodem*`.";

export const SERIAL_OPTIONAL =
  "A serial console is recommended, not required. It shows boot output and helps you recover a device that is not on the network. Without one, use SSH after the device boots and joins the network.";

/** Wiring and port notes for a serial console, from the docs data. */
export function serialCaveats(
  serial: SerialConsole | null | undefined,
): string[] {
  if (!serial) {
    return [
      "The docs data does not describe a serial console for this board. See the board page.",
    ];
  }
  const out: string[] = [];
  if (serial.description) out.push(serial.description);
  for (const g of serial.gpio ?? []) {
    out.push(`Wire \`${g.pin}\` to ${g.to}${g.note ? ` (${g.note})` : ""}.`);
  }
  if (serial.onboard) out.push(ONBOARD_PORT_HINT);
  return out;
}

function serialSection(serial: SerialConsole | null | undefined): string {
  let out = `## Serial console\n\n${SERIAL_OPTIONAL}\n\n`;
  if (serial?.onboard) {
    out += `- **Console:** onboard USB. You do not need a USB-to-UART adapter.\n`;
  } else if (serial) {
    out += `- **Console:** a USB-to-UART adapter${serial.voltage ? ` (${serial.voltage} TTL)` : ""} on the debug UART.\n`;
  }
  if (serial?.baud) out += `- **Baud:** ${serial.baud}\n`;
  for (const c of serialCaveats(serial)) out += `- ${c}\n`;
  return out + "\n";
}

function stepText(s: RecoveryStep): string {
  return typeof s === "string" ? s : s.text;
}

function optionSection(o: ProvisionOption, runtime: string): string {
  const profile = o.profile
    ? `\`--profile ${o.profile}\``
    : "the CLI default profile";
  let out = `### ${o.label ?? o.id} (${profile})\n\n`;
  if (o.media) out += `- **Media:** ${o.media}\n`;
  for (const p of o.prerequisites ?? []) out += `- **Needs:** ${p}\n`;
  if (o.autoMount) {
    out += `- **Linux hosts:** turn off desktop auto-mount first. See ${AUTO_MOUNT_URL}.\n`;
  }
  if (o.description) out += `\n${o.description}\n`;
  const rec = o.recoveryMode;
  if (rec?.steps?.length) {
    out += `\n**Recovery mode** (do this before you provision):\n\n`;
    rec.steps.forEach((s, i) => (out += `${i + 1}. ${stepText(s)}\n`));
    if (rec.verifyCommand) {
      out += `\nCheck with \`${rec.verifyCommand}\`. ${rec.verifyExpect ?? ""}\n`;
    }
    if (rec.reference) {
      out += `\nReference: ${rec.reference.label ?? rec.reference.url} (${rec.reference.url})\n`;
    }
  }
  out += `\n\`\`\`bash\n${provisionCommand(runtime, o.profile)}\n\`\`\`\n`;
  for (const st of o.steps ?? []) {
    out +=
      st.type === "code"
        ? `\n\`\`\`text\n${st.content}\n\`\`\`\n`
        : `\n${st.content}\n`;
  }
  if (o.bootSteps?.length) {
    out += `\n**After provisioning:**\n\n`;
    o.bootSteps.forEach((s, i) => (out += `${i + 1}. ${s}\n`));
  } else if (o.bootInstructions) {
    out += `\n**After provisioning:** ${o.bootInstructions}\n`;
  }
  if (o.bootNote) out += `\n${o.bootNote}\n`;
  return out + "\n";
}

// Facts on the board pages that targets.json does not hold yet. Source:
// hardware/qualcomm/rb3-gen-2 and hardware/qualcomm/rubik-pi-3.
const QCS6490_TARGETS = new Set(["rb3gen2", "rubikpi3"]);

function boardPageNotes(info: TargetInfo, runtime: string): string[] {
  const notes: string[] = [];
  if (QCS6490_TARGETS.has(info.target)) {
    notes.push(
      `**Hypervisor (set at provision time):** \`AVOCADO_HYPERVISOR=gunyah\` is the default and keeps the GPU and NPU. \`AVOCADO_HYPERVISOR=kvm\` gives \`/dev/kvm\` for guest VMs, but the GPU and NPU stay offline. To select KVM: \`${provisionCommand(runtime, "ufs")} --env AVOCADO_HYPERVISOR=kvm\`. The choice changes only on a new provision.`,
    );
  }
  if (info.target === "rb3gen2") {
    notes.push(
      "A kit that already runs Avocado OS enters EDL with `reboot edl` on the device. `05c6:900e` is the ramdump mode after a failed boot, not EDL.",
    );
  }
  return notes;
}

function qemuSection(info: TargetInfo, runtime: string): string {
  let out = `## QEMU flow\n\n`;
  out += `\`avocado provision ${runtime}\` writes a disk image on this machine. Nothing is flashed. \`avocado sdk run -iE vm ${runtime}\` then boots that image with the QEMU in the SDK container. You do not install QEMU on the host.\n\n`;
  out += "```bash\n";
  out += `avocado build\n`;
  out += `${provisionCommand(runtime)}\n`;
  out += `avocado sdk run -iE vm ${runtime}\n`;
  out += "```\n\n";
  out += `The VM console is the terminal that runs \`avocado sdk run\`, so no serial adapter is used. The command is interactive: ask the user to run it in a terminal, or start it in a detached tmux session. Log in as \`root\` with an empty password. Type \`poweroff\` to stop the VM.\n\n`;
  out += `**SSH (Linux hosts only):** the docs support \`--host-fwd\` on Linux only.\n\n`;
  out += "```bash\n";
  out += `avocado sdk run -iE vm ${runtime} --host-fwd "2222-:22"\n`;
  out += `ssh -o StrictHostKeyChecking=no -p 2222 root@localhost\n`;
  out += "```\n\n";
  out += `If \`avocado build\` fails with a missing \`/etc/passwd\` under \`rootfs-work\`, the build volume is stale. Run \`avocado clean\`, \`avocado prune\`, \`avocado install\` and \`avocado build\`.\n\n`;
  out += `Guide: ${docsUrl(info.devices[0]?.url) ?? QEMU_GUIDE_URL}\n\n`;
  return out;
}

/**
 * How to provision a target, from the docs data: host OS, board settings,
 * serial console, and per profile the media, recovery mode, command and boot
 * steps. For QEMU, the provision-then-run flow.
 */
export function provisioningText(info: TargetInfo, runtime: string): string {
  if (isVirtual(info)) return qemuSection(info, runtime);

  let out = "";
  if (info.entries.length === 0) {
    const page = boardDocsUrl(info);
    out += `## Provisioning\n\n`;
    out += `The docs data has no provisioning details for ${info.board ? `board \`${info.board}\`` : `\`${info.target}\``}. Follow the board page${page ? `: ${page}` : ""}. Without \`--profile\`, the CLI uses the default profile of the target:\n\n`;
    out += `\`\`\`bash\n${provisionCommand(runtime)}\n\`\`\`\n\n`;
    out += `After \`avocado install\`, \`list-provision-profiles\` shows the profiles the target has.\n\n`;
    out += serialSection(undefined);
    return out;
  }

  const otherBoards = info.board
    ? []
    : info.devices.filter(
        (d) => d.board && !info.entries.some((e) => covers(e, d.board!)),
      );
  if (otherBoards.length > 0) {
    out += `The steps below are for ${info.entries.map((e) => e.name).join(" and ")}. For ${otherBoards.map((d) => d.name).join(", ")}, pass \`board\` to get the steps for that board.\n\n`;
  }
  for (const entry of info.entries) {
    if (info.entries.length > 1) out += `## ${entry.name}\n\n`;
    const hostOs = entry.provisioning?.hostOs ?? [];
    if (hostOs.length > 0) out += `**Host OS:** ${hostOs.join(", ")}\n\n`;
    if (hostOs.includes("macOS")) {
      out += `On macOS, the docs recommend Avocado Desktop to provision hardware. It has a build VM with USB passthrough. The CLI on macOS also works, but USB devices are less reliable through the VM. See ${AVOCADO_DESKTOP_URL}.\n\n`;
    }
    for (const p of entry.provisioning?.prerequisites ?? []) {
      out += `- **Needs:** ${p}\n`;
    }
    if (entry.provisioning?.prerequisites?.length) out += "\n";
    if (entry.configuration?.yaml) {
      out += `### Settings in avocado.yaml\n\n`;
      if (entry.configuration.description) {
        out += `${entry.configuration.description}\n\n`;
      }
      out += `\`\`\`yaml\n${entry.configuration.yaml}\n\`\`\`\n\n`;
    } else if (entry.board) {
      out += `### Settings in avocado.yaml\n\n`;
      out += `This target needs a board:\n\n`;
      out += `\`\`\`yaml\ndefault_target: ${entry.target}\ndefault_target_board: ${entry.board}\n\`\`\`\n\n`;
    }
    out += serialSection(entry.serial);
    const options = entry.provisioning?.options ?? [];
    if (options.length > 1) {
      out += `## Provisioning profiles\n\nThis target has ${options.length} options. Ask the user which one fits.\n\n`;
    } else {
      out += `## Provisioning\n\n`;
    }
    for (const o of options) out += optionSection(o, runtime);
  }
  const notes = boardPageNotes(info, runtime);
  if (notes.length > 0) {
    out += `## Notes from the board page\n\n`;
    for (const n of notes) out += `- ${n}\n`;
    out += "\n";
  }
  return out;
}

function streamsSection(info: TargetInfo): string {
  if (info.devices.length === 0) return "";
  let out = `## Stream status per LTS release\n\n`;
  for (const d of info.devices) {
    const lts = Object.entries(d.lts ?? {})
      .map(([release, status]) => `${release}: ${status}`)
      .join(", ");
    out += `- ${d.name}${d.board ? ` (board \`${d.board}\`)` : ""}: ${lts || "not listed"}\n`;
  }
  return out + "\n";
}

function boardsSection(info: TargetInfo): string {
  const withBoard = info.devices.filter((d) => d.board);
  if (withBoard.length === 0) return "";
  const required = info.devices.every((d) => d.board);
  let out = `## Boards\n\n`;
  out += required
    ? `This target needs a board. Set \`default_target_board\` in avocado.yaml.\n\n`
    : `Set \`default_target_board\` in avocado.yaml for these devices. Omit it for the others.\n\n`;
  for (const d of withBoard) {
    out += `- \`${d.board}\`: ${d.name}${d.url ? ` (${docsUrl(d.url)})` : ""}\n`;
  }
  return out + "\n";
}

export function unavailableText(target: string): string {
  return `Board data unavailable: the docs hardware data for \`${target}\` could not be fetched. Do not guess board facts. Read the board page from ${HARDWARE_DOCS_URL}, or try again later.\n`;
}

export function unknownTargetText(target: string): string {
  return `The docs hardware data has no entry for \`${target}\`. Use \`list-targets\` to check the slug. The supported boards are at ${HARDWARE_DOCS_URL}.\n`;
}

/** The full `get-target-info` report. Pure, so tests need no network. */
export function targetInfoText(
  data: HardwareData | null,
  target: string,
  board: string | undefined,
  runtime = "dev",
): string {
  let out = `# get-target-info: \`${target}\`${board ? ` (board \`${board}\`)` : ""}\n\n`;
  if (!data) return out + unavailableText(target);
  const info = lookupTarget(data, target, board);
  if (!info) return out + unknownTargetText(target);

  const entry = info.entries[0];
  const device = info.board
    ? info.devices.find((d) => d.board === info.board)
    : undefined;
  if (info.board && !device && info.entries.length === 0) {
    out += `Board \`${info.board}\` is not in the docs data for \`${info.target}\`.\n\n`;
  }
  out += `**Name:** ${device?.name ?? entry?.name ?? info.devices[0].name}\n`;
  if (info.target !== target)
    out += `**Docs target slug:** \`${info.target}\`\n`;
  const page = boardDocsUrl(info);
  if (page) out += `**Docs:** ${page}\n`;
  if (!isVirtual(info)) {
    out += `**Free disk space:** ${minDiskGB(info)} GB\n`;
  }
  if (entry?.description) out += `\n${entry.description}\n`;
  out += "\n";
  out += streamsSection(info);
  out += boardsSection(info);
  out += provisioningText(info, runtime);
  return out;
}
