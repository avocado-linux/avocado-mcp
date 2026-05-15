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
    label: "Device auto-mounted by host OS",
    match: /(automount|auto-mounted|gvfs|udisks)/i,
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
    match: /no such (device|file)|device not found|cannot open .* No such/i,
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
      "An install/compile hook tried to write outside its staging area. The SDK runs hooks unprivileged inside the build container; only `$DESTDIR` is writable.",
    suggestion:
      "Prefix EVERY install path with `$DESTDIR`. `install -d $DESTDIR/etc/myapp`, not `install -d /etc/myapp`. The path you intend for the device (e.g. `/usr/bin/foo`) becomes `$DESTDIR/usr/bin/foo` during the build. See `avocado://skills/extension-build-debugging` for the full lifecycle.",
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
    label: "SDK image pull failed",
    match: /pull access denied|manifest unknown|image not found|TLS handshake/i,
    cause:
      "Docker couldn't pull the SDK container image. Either you're offline, the image tag is wrong, or Docker Hub is unreachable.",
    suggestion:
      "Check your network. Verify the image tag in `sdk.image` matches a published tag (e.g. `docker.io/avocadolinux/sdk:2024-edge`). Try `docker pull` manually to isolate.",
  },
  {
    label: "Out of memory",
    match: /killed by signal|OOM|Cannot allocate memory/i,
    cause: "The build was killed by the OS for using too much memory.",
    suggestion:
      "Increase Docker's memory limit (Docker Desktop → Settings → Resources). 8 GB is the recommended minimum.",
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

export interface PackageInvestigation {
  name: string;
  edge: { repo: string; version: string }[];
  apollo: { repo: string; version: string }[];
  edgeError?: string;
  apolloError?: string;
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

export async function investigatePackages(
  repo: RepoLookup,
  names: string[],
  targets: string[],
): Promise<PackageInvestigation[]> {
  const tasks = names.map(async (name): Promise<PackageInvestigation> => {
    const [edgeRes, apolloRes] = await Promise.all([
      repo
        .searchPackages(targets, name, 20, "2024", "edge")
        .then((r) => ({
          ok: true as const,
          hits: r.results.filter((x) => x.name === name),
        }))
        .catch((e: unknown) => ({
          ok: false as const,
          err: (e as Error).message,
        })),
      repo
        .searchPackages(targets, name, 20, "2024", "apollo")
        .then((r) => ({
          ok: true as const,
          hits: r.results.filter((x) => x.name === name),
        }))
        .catch((e: unknown) => ({
          ok: false as const,
          err: (e as Error).message,
        })),
    ]);
    const dedup = (
      hits: { repo: string; version: string }[],
    ): { repo: string; version: string }[] => {
      const seen = new Set<string>();
      const out: { repo: string; version: string }[] = [];
      for (const h of hits) {
        const k = `${h.repo}@${h.version}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
      }
      return out;
    };
    return {
      name,
      edge: edgeRes.ok ? dedup(edgeRes.hits) : [],
      apollo: apolloRes.ok ? dedup(apolloRes.hits) : [],
      edgeError: edgeRes.ok ? undefined : edgeRes.err,
      apolloError: apolloRes.ok ? undefined : apolloRes.err,
    };
  });
  return Promise.all(tasks);
}

function renderInvestigation(inv: PackageInvestigation): string {
  const edgeLine = inv.edgeError
    ? `error — ${inv.edgeError}`
    : inv.edge.length > 0
      ? `present (${inv.edge.map((h) => `\`${h.repo}\` v${h.version}`).join(", ")})`
      : "not found";
  const apolloLine = inv.apolloError
    ? `error — ${inv.apolloError}`
    : inv.apollo.length > 0
      ? `present (${inv.apollo.map((h) => `\`${h.repo}\` v${h.version}`).join(", ")})`
      : "not found";

  let out = `### \`${inv.name}\`\n\n`;
  out += `- **edge / 2024:** ${edgeLine}\n`;
  out += `- **apollo / 2024:** ${apolloLine}\n\n`;

  if (inv.edge.length > 0 && inv.apollo.length > 0) {
    out += `Present on both channels — the error is likely a broken transitive dep or arch-specific metadata, not a missing top-level package. Check host arch (\`uname -m\`); if the error mentions \`libc\`/\`GLIBC\`/SONAMEs, an upstream metadata bug on this arch is the usual culprit. Workarounds: try the other channel anyway (\`distro.channel\`), or use a host whose arch matches the SDK image.\n`;
  } else if (
    inv.edge.length > 0 &&
    inv.apollo.length === 0 &&
    !inv.apolloError
  ) {
    out += `Only on edge. Switching channel is not an option here. If install fails, the package itself exists — the cause is upstream (broken transitive dep, arch mismatch). Check host arch (\`uname -m\`); if the log mentions \`libc\`/\`GLIBC\`/SONAMEs, an upstream metadata bug for this arch is the usual culprit.\n`;
  } else if (inv.apollo.length > 0 && inv.edge.length === 0 && !inv.edgeError) {
    out += `Only on apollo. Set \`distro.channel: apollo\` in your \`avocado.yaml\` and re-run \`avocado install\`.\n`;
  } else if (!inv.edgeError && !inv.apolloError) {
    out += `Not found on either channel for the listed targets. Either the name is wrong (try \`search-packages\` with a partial name) or the package is target-specific (BSP packages typically have a target suffix).\n`;
  }
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
  investigationContext?: { targets: string[] },
): string {
  let out = `# diagnose-${kind}-log\n\n`;

  if (diagnoses.length === 0) {
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
    out += `## Package investigation (across channels)\n\n`;
    out += `_Queried targets: ${investigationContext?.targets.map((t) => `\`${t}\``).join(", ") ?? "(none)"}._\n\n`;
    for (const inv of investigations) {
      out += renderInvestigation(inv);
    }
  } else if (
    kind === "build" &&
    investigations &&
    investigations.length === 0
  ) {
    out += `## Package investigation\n\n_No package names extracted from the log — couldn't run a cross-channel lookup. If you can isolate the failing package, re-run with that name in mind or call \`describe-package\` directly._\n\n`;
  }

  if (kind === "build" && !investigations) {
    out += `\n_Pass \`targets: [...]\` to enable a cross-channel package lookup. The tool will extract the failing package(s) from the log and probe both \`edge\` and \`apollo\` channels for you._\n`;
  }

  return out;
}
