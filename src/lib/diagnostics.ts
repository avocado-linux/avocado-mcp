/**
 * Heuristic log analyzers for avocado build / avocado provision output.
 *
 * Each pattern returns a structured diagnosis: a short label, the matched
 * snippet, the likely cause, and a suggested action. The patterns are
 * intentionally conservative — false negatives are preferred to false
 * positives, and the LLM can extrapolate further from the raw log.
 */

export interface Diagnosis {
  label: string;
  excerpt: string;
  cause: string;
  suggestion: string;
}

interface Pattern {
  label: string;
  match: RegExp;
  cause: string;
  suggestion: string;
}

const PROVISION_PATTERNS: Pattern[] = [
  {
    label: "Non-TTY harness — needs `script` wrapper",
    match:
      /the input device is not a TTY|stdin is not a (?:terminal|tty)|inappropriate ioctl for device|cannot enable tty/i,
    cause:
      "`avocado provision` shells out to `docker run -it` internally, which requires a TTY allocated for the container. When you (the LLM) run it via a non-interactive Bash tool, that TTY doesn't exist and the command exits immediately. `--no-tui` does NOT fix this — it only controls Avocado's own output rendering, not Docker's `-it` requirement.",
    suggestion:
      "Wrap the command with `script -q /dev/null` to provide a pseudo-TTY: `script -q /dev/null avocado provision -r <runtime> [--profile <prof>] --no-tui > /tmp/avocado-provision.log 2>&1`. This is the standard workaround when running interactive-Docker-shelling CLIs from a non-interactive harness. Re-run with the wrapper and the TTY error should disappear.",
  },
  {
    label: "QEMU binary missing",
    match:
      /qemu-system-[a-z0-9_]+ ?: ?(?:command not found|not found|no such file)|cannot find qemu|qemu binary missing/i,
    cause:
      "The QEMU emulator binary (`qemu-system-<arch>`) is not installed. Required for QEMU-target workflows; not needed for physical-hardware builds.",
    suggestion:
      "Install QEMU: macOS → `brew install qemu`; Debian/Ubuntu → `sudo apt install qemu-system`; Fedora → `sudo dnf install qemu-system-x86 qemu-system-arm`. Then retry. `environment-check` can verify the install.",
  },
  {
    label: "Device auto-mounted by host OS",
    // "automount" in any tense is itself the signal. The tool *names*, however,
    // are not: merely naming one ("udisks2 is installed") is not a failure, so
    // those require an actual mount action alongside them.
    match:
      /auto-?mount(?:ed|ing|s)?\b|(?:udisks|gvfs)[^\n]*\bmount|\bmount(?:ed|ing)?\b[^\n]*(?:udisks|gvfs)/i,
    cause:
      "Your Linux host auto-mounted the target storage during provisioning. This can corrupt the image flash.",
    suggestion:
      "On Ubuntu/GNOME: `gsettings set org.gnome.desktop.media-handling automount false` (and `automount-open false`). Retry the provision afterward.",
  },
  {
    label: "Insufficient disk space",
    match: /no space left on device|ENOSPC|disk full/i,
    cause: "The host or target ran out of disk space during provisioning.",
    suggestion:
      "Check `df -h` on the host. Free up space, then re-run. If the target is the SD card, use a larger one.",
  },
  {
    label: "Target storage not detected",
    // Require an open failure *and* a device path — a bare "No such file or
    // directory" (e.g. an optional hook that isn't present) is the most common
    // string in any log and must not be read as a missing storage device.
    // Phrasing varies by tool: dd/bmaptool say "failed to open", others
    // "cannot open" / "could not open".
    match:
      /no such device\b|device not found|(?:cannot|could not|couldn't|failed to|unable to) open [^\n]*\/dev\/[^\n]*no such/i,
    cause:
      "The provisioner could not find the target storage device (SD card, USB drive, NVMe).",
    suggestion:
      "Verify the device is plugged in and visible (`lsblk` on Linux, `diskutil list` on macOS). For Jetson tegraflash, check the USB-C cable and recovery-mode jumper.",
  },
  {
    label: "USB / tegraflash failure",
    match: /tegraflash|USB.*not found|fastboot/i,
    cause:
      "Tegraflash provisioning hit a USB issue. Common causes: device not in recovery mode, wrong cable, host kernel module missing.",
    suggestion:
      "Confirm the device is in recovery mode (FC REC pin shorted to GND, USB-C connected). Run `lsusb` and look for `NVIDIA Corp. APX`. Try unplug-replug.",
  },
  {
    label: "Permission denied on /dev",
    match: /permission denied.*\/dev\//i,
    cause:
      "The provisioner needs raw access to a device node and your user doesn't have permission.",
    suggestion:
      "On Linux: add your user to the `disk` group (`sudo usermod -aG disk $USER`) and re-login, or rerun with `sudo`.",
  },
  {
    label: "Container can't reach the device",
    match: /(docker|container).*permission denied|cgroup.*denied/i,
    cause:
      "The SDK container could not access the target device. Likely missing `--privileged` or a `/dev` bind mount.",
    suggestion:
      "Verify your `avocado.yaml` has `sdk.container_args` including `--privileged`, `-v /dev:/dev`, and `-v /sys:/sys`.",
  },
];

const BUILD_PATTERNS: Pattern[] = [
  {
    label: "Hook script: command not found",
    match:
      /app-(clean|compile|install)\.sh[^\n]*: line \d+:[^\n]+: (command not found|not found)/i,
    cause:
      "A tool referenced in your build hook script isn't on PATH inside the SDK container. The hook is user-authored — this isn't an Avocado bug.",
    suggestion:
      "Two options: (a) add the missing tool to `sdk.packages` in `avocado.yaml` (NOT your extension's packages — SDK packages live in the build container, extension packages live on the device). Verify the package name first with `search-packages`. (b) Drop the dependency from your hook if it isn't essential. Read the hook script directly (path is in the error) and the comparable hook in a working reference via `get-reference-file`.",
  },
  {
    label: "Hook script: permission denied",
    match: /app-(install|compile)\.sh[^\n]*: [^\n]*Permission denied/i,
    cause:
      "An install/compile hook tried to write outside its staging area. The SDK runs hooks unprivileged inside the build container; only `$AVOCADO_BUILD_EXT_SYSROOT` is writable.",
    suggestion:
      'Prefix EVERY install path with `$AVOCADO_BUILD_EXT_SYSROOT`. `install -d "$AVOCADO_BUILD_EXT_SYSROOT/etc/myapp"`, not `install -d /etc/myapp`. The path you intend for the device (e.g. `/usr/bin/foo`) becomes `$AVOCADO_BUILD_EXT_SYSROOT/usr/bin/foo` during the build. Do NOT use `$DESTDIR` — it\'s not set in the Avocado hook environment. See `avocado://skills/extension-build-debugging` for the full lifecycle.',
  },
  {
    label: "Hook script: shell error",
    match:
      /app-(clean|compile|install)\.sh[^\n]*: line \d+:(?![^\n]*(command not found|Permission denied))/i,
    cause:
      "A user-authored build hook hit a shell error (syntax, redirection, undefined variable, etc.). The failure is in your hook script, not in Avocado.",
    suggestion:
      "Read the hook file at the path shown in the error and check the indicated line number. Compare against a working reference's same hook via `get-reference-file` (e.g. `python-flask/app-install.sh`). Read `avocado://skills/extension-build-debugging` for the triage guide.",
  },
  {
    label: "Package not found",
    match: /no package matching|package not found|nothing provides/i,
    cause:
      "A package referenced in your avocado.yaml is not in the repo for this target.",
    suggestion:
      "Use `search-packages` or `describe-package` to find the right name. Many packages are target-specific (e.g. BSP packages have target suffixes).",
  },
  {
    label: "Unresolved dependency",
    match:
      /unresolved deps|conflicting requests|cannot install|nothing provides/i,
    cause:
      "DNF couldn't satisfy a dependency. Either a versioned constraint is too tight, or two extensions want conflicting versions.",
    suggestion:
      'Loosen version constraints (e.g. use `"*"`). If you specified an exact version, check `describe-package` for available versions for the target.',
  },
  {
    label: "Schema validation error",
    match: /schema validation|invalid YAML|JSON schema/i,
    cause: "Your avocado.yaml does not validate against the current schema.",
    suggestion:
      "Run `validate-yaml` to get the exact error path. Then fix the YAML — usually a wrong type or a missing required field.",
  },
  {
    label: "Docker daemon not reachable",
    match:
      /Cannot connect to the Docker daemon|Is the docker daemon running|error during connect|docker socket forward .* is missing/i,
    cause:
      "The CLI could not connect to a Docker daemon. On macOS, the daemon runs in the avocado-vm, not Docker Desktop. This usually means the VM is not running or not installed. On Linux, it means the Docker Engine on the host is stopped.",
    suggestion:
      "On macOS, run `avocado vm status`. If the VM is stopped, run `avocado vm start`. For first-time setup, run `avocado vm update -y` to install it, then `avocado vm start`. If the VM runs but the Docker socket forward is missing, run `avocado vm stop && avocado vm start`. Do not run `sudo systemctl start docker`, because there is no host daemon on a Mac. On Linux, run `sudo systemctl start docker`. For more information, see `avocado://skills/container-backend`.",
  },
  {
    label: "SDK image pull failed",
    match: /pull access denied|manifest unknown|image not found|TLS handshake/i,
    cause:
      "Docker could not pull the SDK container image. You are offline, the image tag is wrong, or the engine cannot connect to the registry.",
    suggestion:
      "Examine the network. On macOS, the pull runs inside the avocado-vm. To isolate the problem, run `avocado vm shell`, then `docker pull <tag>`. The VM caches images across restarts, so a retry is cheap. Make sure that the tag in `sdk.image` matches a published tag, for example `docker.io/avocadolinux/sdk:2024-edge`.",
  },
  {
    label: "Out of memory",
    match: /killed by signal|OOM|Cannot allocate memory/i,
    cause: "The OS stopped the build because it used too much memory.",
    suggestion:
      "On macOS, the build runs inside the avocado-vm. Give the VM more memory: run `avocado vm stop`, then `avocado vm start --memory-mib <MiB>` (a running VM rejects the flag, so you must stop it first). The value persists for later starts. Do not change Docker Desktop Resources. On Linux, free host RAM or lower the build parallelism. The minimum is 8 GB.",
  },
  {
    label: "Compile error in overlay",
    match: /error: .*\.(c|cc|cpp|rs|go|py):\d+/i,
    cause:
      "A source file in an overlay failed to compile. The error path shows which file.",
    suggestion:
      "This is your application code, not Avocado. Fix the source error and re-run `avocado build`.",
  },
  {
    label: "Disk full during build",
    match: /no space left on device|disk quota exceeded/i,
    cause: "The host filesystem ran out of room while building.",
    suggestion:
      "Free space on the volume backing your project directory and Docker's data volume.",
  },
];

export function diagnoseProvisionLog(log: string): Diagnosis[] {
  return runPatterns(PROVISION_PATTERNS, log);
}

export function diagnoseBuildLog(log: string): Diagnosis[] {
  return runPatterns(BUILD_PATTERNS, log);
}

/**
 * Generic, domain-agnostic shape extraction for any failure log.
 *
 * Pulls structured signals that may be useful even when no `Pattern` in our
 * curated lists matched. The LLM uses whichever fields are relevant — nothing
 * here prescribes a fix or claims to understand the failure.
 */
export interface LogShape {
  hasErrors: boolean;
  exitCode: number | null;
  errorLines: string[];
  filePaths: string[];
  commands: string[];
}

const ERROR_LINE_RE =
  /^(?:.{0,200})(?:\bERROR\b|\berror:|\bFailed\b|\bfatal:|\bFatal:|\bpanic:?|\bTraceback\b|\bAssertion|\bsegfault\b|\bsegmentation fault\b)/i;
// The trailing lookahead is what keeps this from matching counters like
// "returned 0 warnings" / "exited with 2 errors" — those are tallies, not exit
// codes, and treating them as one lets a benign number mask a real failure.
const EXIT_CODE_RE =
  /\b(?:exit(?: code|ed with)?|returned)\s*[:=]?\s*(\d+)\b(?!\s*(?:warning|error|result|package|match|file|byte|line|test|item|second)s?\b)/i;
const FILE_PATH_RE =
  /(?:^|[\s'"`(])((?:\/[A-Za-z0-9._+\-/]+|[A-Za-z]:\\[A-Za-z0-9._+\-\\]+))(?=[\s'"`):,;]|$)/g;
const COMMAND_RE = /^\s*\$\s+(.+?)$|^\+ (.+?)$|^Running:\s+(.+?)$/m;

/** Conservative file-path filter — drop obviously-not-useful paths. */
function isInterestingPath(p: string): boolean {
  if (p.length < 4 || p.length > 256) return false;
  // Drop pure /dev/null, /tmp/random scratch, /proc/, very common log dirs
  if (/^\/dev\/null$/.test(p)) return false;
  if (/^\/proc\//.test(p)) return false;
  // Anchor to anything that looks like a project/source/SDK path
  return /\/(?:src|app|opt|usr|etc|var|home|workspace|build|sysroots?|extensions?|runtimes?|target|sdk)\//i.test(
    p,
  );
}

/**
 * Extract generic signals from a log. Safe to call on any string; returns
 * empty arrays when nothing applies. Bounds output sizes so a giant log
 * doesn't blow up downstream context.
 */
export function extractLogShape(log: string): LogShape {
  const errorLines: string[] = [];
  const filePathsSeen = new Set<string>();
  const commands: string[] = [];
  let exitCode: number | null = null;

  // Scan once, line by line.
  const lines = log.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.length > 400 ? raw.slice(0, 400) + " …(truncated)" : raw;
    if (ERROR_LINE_RE.test(line) && errorLines.length < 20) {
      errorLines.push(line.trim());
    }
    const cmdMatch = line.match(COMMAND_RE);
    if (cmdMatch && commands.length < 5) {
      const cmd = (cmdMatch[1] || cmdMatch[2] || cmdMatch[3] || "").trim();
      if (cmd.length > 0 && cmd.length < 300) commands.push(cmd);
    }
  }

  // Exit code: last occurrence wins — a log's final exit report is the
  // process's real one, and intermediate codes (a retried step, an earlier
  // sub-command) are not. Tallies are excluded by EXIT_CODE_RE itself, so a
  // trailing "returned 0 warnings" cannot mask a failure here.
  const exitMatches = Array.from(log.matchAll(new RegExp(EXIT_CODE_RE, "gi")));
  if (exitMatches.length > 0) {
    const n = Number(exitMatches[exitMatches.length - 1]![1]);
    if (Number.isFinite(n)) exitCode = n;
  }

  // File paths: scan whole log, dedupe, filter.
  for (const m of log.matchAll(FILE_PATH_RE)) {
    const p = m[1];
    if (!p) continue;
    if (filePathsSeen.size >= 15) break;
    if (isInterestingPath(p)) filePathsSeen.add(p);
  }

  return {
    hasErrors: errorLines.length > 0,
    exitCode,
    errorLines,
    filePaths: Array.from(filePathsSeen),
    commands,
  };
}

/**
 * Render a fallback diagnosis when no curated pattern matched but the log
 * clearly contains error signals. Tells the LLM honestly that we don't
 * recognize this failure class, then routes it to productive next steps.
 */
export function renderFallbackDiagnosis(
  kind: "build" | "provision",
  shape: LogShape,
): string {
  let out = `## ⚠️ No known failure pattern matched\n\n`;
  out += `The log contains error signals that don't match any fingerprint the MCP currently recognizes for ${kind} failures. The MCP is honest about this rather than silently returning an empty diagnosis. Below is what the log *does* contain — use it to drive the next step yourself.\n\n`;

  if (shape.exitCode !== null) {
    out += `**Exit code:** \`${shape.exitCode}\`\n\n`;
  }

  if (shape.commands.length > 0) {
    out += `**Failing command (heuristic):**\n\n\`\`\`\n${shape.commands.slice(-1)[0]}\n\`\`\`\n\n`;
  }

  if (shape.errorLines.length > 0) {
    const shown = shape.errorLines.slice(0, 10);
    out += `**Error lines extracted from the log** (first ${shown.length}):\n\n\`\`\`\n${shown.join("\n")}\n\`\`\`\n\n`;
  }

  if (shape.filePaths.length > 0) {
    out += `**File paths mentioned in the log** (the LLM can \`Read\` these if relevant):\n\n`;
    for (const p of shape.filePaths.slice(0, 10)) out += `- \`${p}\`\n`;
    out += `\n`;
  }

  out += `**Suggested next steps** (in order, stop when you find a useful lead):\n\n`;
  out += `1. **\`search-docs\`** with a short, distinctive substring of the error line — usually the verbatim message text without paths or numbers. The Avocado docs site indexes failure modes and CLI behaviour.\n`;
  out += `2. **\`search-packages\` / \`describe-package\`** if any error line names what looks like a package, library, or binary.\n`;
  out += `3. **\`get-reference-file\`** to compare the failing component against a working reference's analogous file (e.g. \`avocado.yaml\`, a hook script, an overlay file).\n`;
  out += `4. **\`Read\` the file paths** listed above if they look like project / extension / SDK files (NOT host-only paths).\n`;
  out += `5. **Report the error** to the user with the extracted lines verbatim — don't fabricate a cause from training-data priors. Ask the user if they recognize the failure class.\n`;
  out += `\n**Do not interpret an empty pattern list as "the build is fine."** The log has errors; we just don't have a curated diagnosis for this one yet. If this failure class is one you see often, file it at \`src/lib/diagnostics.ts\` so future runs get a curated fingerprint.\n`;
  return out;
}

/**
 * Pull package names that the log accuses of being missing / unsatisfiable.
 * Conservative: only the well-known fingerprints from DNF / Avocado install.
 * Captured strings may be full NVRA (name-version-release.arch); we strip
 * the tail to recover the base package name.
 */
export function extractFailingPackages(log: string): string[] {
  const NAME_RE = "[A-Za-z0-9][A-Za-z0-9._+-]*";
  const patterns: RegExp[] = [
    new RegExp(`nothing provides [^\\n]+? needed by (${NAME_RE})`, "gi"),
    new RegExp(`no package matching ['"\`]?(${NAME_RE})`, "gi"),
    new RegExp(`package (${NAME_RE}) not found`, "gi"),
    new RegExp(`unable to find a match: (${NAME_RE})`, "gi"),
    new RegExp(`broken packages?:\\s*(${NAME_RE}(?:[, ]+${NAME_RE})*)`, "gi"),
  ];
  const found = new Set<string>();
  for (const re of patterns) {
    for (const m of log.matchAll(re)) {
      const captured = m[1];
      if (!captured) continue;
      for (const part of captured.split(/[, ]+/)) {
        const name = normalizePackageName(part);
        if (name.length > 0 && name.length < 128) found.add(name);
      }
    }
  }
  return Array.from(found).slice(0, 5);
}

/**
 * Strip RPM version-release.arch tail from a captured name.
 * `nativesdk-boardctl-1.0-r0.aarch64` → `nativesdk-boardctl`
 * `avocado-bsp-jetson-orin-nano-devkit` → unchanged (no digit-led segment).
 */
function normalizePackageName(raw: string): string {
  // Drop trailing .<arch>
  let s = raw.replace(/\.(aarch64|x86_64|noarch|armv7hl|armv7l|i686)$/i, "");
  // Trim at the first `-<digit>` (version starts with a digit per RPM convention)
  const m = s.match(/^(.*?)-\d/);
  if (m && m[1] && m[1].length > 0) s = m[1];
  return s;
}

/**
 * Feed streams the build-error investigator AUTO-probes for a failing
 * package. Six streams exist — channels `next` / `edge` / `stable` (`apollo`
 * is retired) across releases `2024` and `2026` — and all are queryable via
 * explicit `release`/`channel` args on `search-packages` etc. But in practice
 * ~all users run `edge` on the release that matches their hardware (2024 or
 * 2026) and don't switch channels, so the automatic probe covers just those
 * two edge streams to keep the diagnosis fast. Extend this list only if the
 * common-case stream set changes.
 */
const INVESTIGATION_STREAMS: { release: string; channel: string }[] = [
  { release: "2026", channel: "edge" },
  { release: "2024", channel: "edge" },
];

export interface StreamPresence {
  release: string;
  channel: string;
  hits: { repo: string; version: string }[];
  /** Set when the feed for this stream couldn't be reached (e.g. not live). */
  error?: string;
}

export interface PackageInvestigation {
  name: string;
  streams: StreamPresence[];
}

export interface RepoLookup {
  searchPackages(
    targets: string[],
    query: string,
    limit: number,
    release?: string,
    channel?: string,
  ): Promise<{
    results: { name: string; repo: string; version: string }[];
  }>;
}

function dedupHits(
  hits: { repo: string; version: string }[],
): { repo: string; version: string }[] {
  const seen = new Set<string>();
  const out: { repo: string; version: string }[] = [];
  for (const h of hits) {
    const k = `${h.repo}@${h.version}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(h);
  }
  return out;
}

export async function investigatePackages(
  repo: RepoLookup,
  names: string[],
  targets: string[],
): Promise<PackageInvestigation[]> {
  const tasks = names.map(async (name): Promise<PackageInvestigation> => {
    const streams = await Promise.all(
      INVESTIGATION_STREAMS.map(async ({ release, channel }) => {
        try {
          const r = await repo.searchPackages(
            targets,
            name,
            20,
            release,
            channel,
          );
          return {
            release,
            channel,
            hits: dedupHits(r.results.filter((x) => x.name === name)),
          };
        } catch (e) {
          return {
            release,
            channel,
            hits: [],
            error: (e as Error).message,
          };
        }
      }),
    );
    return { name, streams };
  });
  return Promise.all(tasks);
}

const ARCH_MISMATCH_FINGERPRINT =
  /\bGLIBC[_\d.]+|\blibc\.so\.\d+\(GLIBC|SONAME|\bILP32\b/;

const ARCH_MISMATCH_WORKAROUND = [
  `**Vetted workarounds (in order of reliability):**`,
  ``,
  `1. **Switch to an x86_64 Linux host** to run \`avocado install\` / \`avocado build\`. This is the single most reliable fix when the SDK feed's aarch64 metadata is broken. Native Linux x86_64 or an Intel-CPU Mac both work; Apple Silicon + Rosetta 2 does NOT work.`,
  `2. **Try a different channel** — set \`distro.channel\` to another live channel (\`next\`, \`edge\`, or \`stable\`) in your \`avocado.yaml\` and re-run \`avocado install\`. A package's build/layout can differ between channels; the investigation table above shows where it's actually present.`,
  `3. **Try the other release** — if you're on \`2024\`, try \`distro.release: 2026\` (or vice-versa). Newer hardware and rebuilt packages often land on a different release. Switch releases deliberately — it's a larger change than a channel bump.`,
  ``,
  `**Do NOT** suggest \`--sdk-arch\`, \`--platform\`, or any other \`avocado install\` flag for arch override — no such flag exists. Verify any flag with \`avocado install --help\` before recommending.`,
].join("\n");

function renderInvestigation(
  inv: PackageInvestigation,
  archMismatchSuspected: boolean,
): string {
  const present = inv.streams.filter((s) => s.hits.length > 0);
  let out = `### \`${inv.name}\`\n\n`;

  if (present.length === 0) {
    const errored = inv.streams.filter((s) => s.error);
    if (errored.length === inv.streams.length) {
      out += `Could not reach the package feed for any stream (network / feed availability?). Retry, or check manually with \`search-packages\`.\n\n`;
      return out;
    }
    const checked = inv.streams
      .filter((s) => !s.error)
      .map((s) => `${s.release}/${s.channel}`)
      .join(", ");
    out += `Not found on the stream(s) checked (${checked}).`;
    if (errored.length > 0) {
      // Don't conflate "couldn't query" with "absent".
      out += ` (Couldn't query ${errored
        .map((s) => `${s.release}/${s.channel}`)
        .join(", ")} — those may or may not carry it; retry to be sure.)`;
    }
    out += ` Either the name is wrong (try \`search-packages\` with a partial name) or the package is target-specific (BSP packages typically carry a target suffix).\n\n`;
    return out;
  }

  for (const s of present) {
    out += `- **${s.release}/${s.channel}:** present (${s.hits
      .map((h) => `\`${h.repo}\` v${h.version}`)
      .join(", ")})\n`;
  }
  out += `\n`;

  const streamsList = present
    .map((s) => `\`${s.release}/${s.channel}\``)
    .join(", ");
  out += `The package exists in the feed (present on ${streamsList}). If your \`avocado.yaml\`'s \`distro.release\` doesn't match one of these, switch it and re-run \`avocado install\` — most commonly the package is on the release that matches your hardware (\`2026\` for newer boards, \`2024\` otherwise). If you're already on a matching stream, a "not found" build error usually means a broken transitive dependency or arch-specific metadata, not a missing top-level package.\n`;

  if (archMismatchSuspected) {
    out += `\nThe log fingerprints as an **arch / SDK metadata mismatch** (mentions \`libc\` / \`GLIBC\` / SONAMEs). ${ARCH_MISMATCH_WORKAROUND}\n`;
  } else {
    out += `\nIf install still fails though the package exists, check host arch (\`uname -m\`); \`libc\` / \`GLIBC\` / SONAME errors usually point to an upstream metadata bug for this arch.\n`;
  }
  out += `\n`;
  return out;
}

function runPatterns(patterns: Pattern[], log: string): Diagnosis[] {
  const out: Diagnosis[] = [];
  for (const p of patterns) {
    const m = log.match(p.match);
    if (m) {
      // Capture a small surrounding snippet for context.
      const idx = m.index ?? 0;
      const start = Math.max(0, idx - 80);
      const end = Math.min(log.length, idx + (m[0].length ?? 0) + 80);
      out.push({
        label: p.label,
        excerpt: log.slice(start, end).trim(),
        cause: p.cause,
        suggestion: p.suggestion,
      });
    }
  }
  return out;
}

export function renderDiagnoses(
  kind: "build" | "provision",
  diagnoses: Diagnosis[],
  investigations?: PackageInvestigation[],
  investigationContext?: { targets: string[]; rawLog?: string },
): string {
  const headerName =
    kind === "build" ? "explain-build-error" : "diagnose-provision-log";
  let out = `# ${headerName}\n\n`;

  if (diagnoses.length === 0) {
    // Generic fallback — extract what we can from the log shape itself.
    const shape = investigationContext?.rawLog
      ? extractLogShape(investigationContext.rawLog)
      : null;

    if (shape && shape.hasErrors) {
      // Log has clear error signals but no curated pattern matched.
      out += renderFallbackDiagnosis(kind, shape);
    } else if (shape && !shape.hasErrors) {
      // No patterns AND no error signals — the log might genuinely be fine,
      // or the user pasted something other than a failure log. Say so.
      out += `_No known failure pattern matched, and the log doesn't contain obvious error signals (\`ERROR\`, \`error:\`, \`Failed\`, \`fatal:\`, \`Traceback\`, etc.)._\n\n`;
      out += `Possibilities:\n\n`;
      out += `- The build/provision actually succeeded. Check the exit code on the original command.\n`;
      out += `- Only a partial log was pasted — re-paste the section containing the failure.\n`;
      out += `- The failure is silent (process killed by OOM with no error message; check \`dmesg | grep -i "killed process"\`).\n`;
    } else {
      // No rawLog supplied (older callers / fallback). Generic checks.
      out += `No known failure pattern matched. The log may contain a novel error. Common things to check manually:\n\n`;
      if (kind === "build") {
        out += `- Is every package in your YAML in the repo? Run \`search-packages\`.\n`;
        out += `- Does your YAML validate? Run \`validate-yaml\`.\n`;
        out += `- Is Docker running with enough memory (≥8 GB)?\n`;
      } else {
        out += `- Is the target media plugged in and detected? \`lsblk\` / \`diskutil list\`.\n`;
        out += `- Is auto-mount disabled on your host?\n`;
        out += `- For Jetson: is the device in recovery mode?\n`;
      }
    }
  } else {
    out += `Found **${diagnoses.length}** likely issue(s):\n\n`;
    for (const d of diagnoses) {
      out += `## ${d.label}\n\n`;
      out += `**Excerpt:**\n\n\`\`\`\n${d.excerpt}\n\`\`\`\n\n`;
      out += `**Cause:** ${d.cause}\n\n`;
      out += `**Fix:** ${d.suggestion}\n\n`;
    }
  }

  if (kind === "build" && investigations && investigations.length > 0) {
    const archMismatchSuspected = investigationContext?.rawLog
      ? ARCH_MISMATCH_FINGERPRINT.test(investigationContext.rawLog)
      : false;
    out += `## Package investigation (across channels)\n\n`;
    out += `_Queried targets: ${investigationContext?.targets.map((t) => `\`${t}\``).join(", ") ?? "(none)"}._\n\n`;
    for (const inv of investigations) {
      out += renderInvestigation(inv, archMismatchSuspected);
    }
  } else if (
    kind === "build" &&
    investigations &&
    investigations.length === 0
  ) {
    out += `## Package investigation\n\n_No package names extracted from the log — couldn't run a cross-channel lookup. If you can isolate the failing package, re-run with that name in mind or call \`describe-package\` directly._\n\n`;
  }

  if (kind === "build" && !investigations) {
    out += `\n_Pass \`targets: [...]\` to enable a cross-release package lookup. The tool will extract the failing package(s) from the log and probe the \`edge\` channel on both releases (\`2024\` and \`2026\`) — the streams ~all users are on — for you._\n`;
  }

  return out;
}
