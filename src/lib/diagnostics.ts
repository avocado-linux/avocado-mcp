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
    return out;
  }

  out += `Found **${diagnoses.length}** likely issue(s):\n\n`;
  for (const d of diagnoses) {
    out += `## ${d.label}\n\n`;
    out += `**Excerpt:**\n\n\`\`\`\n${d.excerpt}\n\`\`\`\n\n`;
    out += `**Cause:** ${d.cause}\n\n`;
    out += `**Fix:** ${d.suggestion}\n\n`;
  }
  return out;
}
