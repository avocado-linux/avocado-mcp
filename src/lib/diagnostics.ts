/**
 * Heuristic log analyzers for avocado build / avocado provision output.
 *
 * Each pattern returns a structured diagnosis: a short label, the matched
 * snippet, the likely cause, and a suggested action. The patterns are
 * intentionally conservative — false negatives are preferred to false
 * positives, and the LLM can extrapolate further from the raw log.
 */

import { NO_TARGET_REPOS, type FeedSelector } from "./repo-client.js";

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

// Build, provision and deploy all check build stamps before they start, so
// these fire on either log. Match text is from avocado-cli
// `src/utils/stamps.rs`.
const STAMP_PATTERNS: Pattern[] = [
  {
    label: "Build step prerequisites not met",
    match: / - dependencies not satisfied/,
    cause:
      "The CLI checks build stamps before each step. A step that this one needs is missing or stale, so the CLI stopped before it did any work.",
    suggestion:
      "The log lists each missing or stale step, then prints the exact commands under `To fix:`. Run those commands in the order shown, then retry. In most cases this is `avocado install`, then the step that failed. Docs: https://docs.peridio.com/developer-reference/lockfiles-and-build-stamps",
  },
  {
    label: "Stamps from an older CLI",
    match: /stamp format changed \(v\d+/,
    cause:
      "The CLI was upgraded and its stamp format changed. Every stamp that the older CLI wrote now reads as stale, although `avocado.yaml` did not change.",
    suggestion:
      "This is expected after `avocado upgrade`. Your config needs no edit. Run the commands that the CLI prints under `To fix:` (usually `avocado install`, then `avocado build`) to write new stamps. Docs: https://docs.peridio.com/developer-reference/lockfiles-and-build-stamps",
  },
];

const PROVISION_PATTERNS: Pattern[] = [
  {
    label: "Non-TTY harness: CLI too old",
    match:
      /the input device is not a TTY|stdin is not a (?:terminal|tty)|inappropriate ioctl for device|cannot enable tty/i,
    cause:
      "Docker refused to give the SDK container a TTY because stdin is not a terminal. Since 1.0.0-rc.2 the `avocado` CLI checks stdin first and starts the container without a PTY when there is no terminal, so this error points at an older CLI.",
    suggestion:
      "Run `avocado --version`. If it is older than 1.0.0-rc.4, run `avocado upgrade`, then retry. No TTY wrapper is needed. For headless runs, set `AVOCADO_NONINTERACTIVE=1`: `mkdir -p .avocado/logs && AVOCADO_NONINTERACTIVE=1 avocado provision <runtime> [--profile <prof>] --no-tui > .avocado/logs/provision.log 2>&1`.",
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
      /no such device\b|(?<!QDL )device not found|(?:cannot|could not|couldn't|failed to|unable to) open [^\n]*\/dev\/[^\n]*no such/i,
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
  ...STAMP_PATTERNS,
  {
    label: "Qualcomm board not in EDL mode",
    // meta-avocado `stone-provision-ufs.sh` waits for `05c6:9008`. A board
    // that shows `05c6:900e` instead is in dload/ramdump mode.
    match: /QDL device not found after \d+ seconds|\b05c6:900e\b/,
    cause:
      "The provisioner waited for a Qualcomm device in EDL mode (USB ID `05c6:9008`) and did not find one. A board that shows `05c6:900e` is in dload/ramdump mode after a failed boot. That mode is not EDL.",
    suggestion:
      "Put the board into EDL mode as its docs page shows, then run `lsusb` and look for `05c6:9008`. If you see `05c6:900e`, power-cycle the board and put it into EDL mode again. Then rerun the same `avocado provision` command. Docs: https://docs.peridio.com/hardware/qualcomm/rb3-gen-2 and https://docs.peridio.com/hardware/qualcomm/rubik-pi-3",
  },
  {
    label: "Jetson not in recovery mode",
    // meta-avocado `stone-provision-tegraflash.sh` and `find-jetson-usb.sh`.
    match:
      /Device did not enter RCM mode \(waited \d+s\)|No Jetson device in recovery mode found/,
    cause:
      "The provisioner waited for a Jetson in Force Recovery (RCM) mode and did not find one on USB.",
    suggestion:
      "Put the board into Force Recovery mode, then rerun the same `avocado provision` command. The steps are different for each board. On AGX Thor, hold the Force Recovery button and the Reset button for 3 seconds. Release Reset only, then release Force Recovery 3 seconds later. For other Jetson boards, follow the recovery steps on the docs page of that board. Docs: https://docs.peridio.com/hardware/nvidia/jetson-agx-thor",
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
    // The lookahead keeps the CLI's `depends_on` closure error out: that one
    // is about extensions, not DNF packages.
    match:
      /unresolved deps|conflicting requests|cannot install(?! with an unresolved dependency closure)|nothing provides/i,
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
  ...STAMP_PATTERNS,
  // Feed auth: avocado-cli `src/utils/feeds.rs`. The 401 hint and the
  // `--connect-sign` session error (runtime/deploy.rs) have the same fix.
  {
    label: "Connect login missing or expired",
    match:
      /is a private feed and you are not logged in|no Connect profile for org '|feed-token request returned 401\b|--connect-sign requires an active Connect session/,
    cause:
      "The project reads a private `org:` feed or signs through Connect, and the CLI has no valid Connect credential for it. Either you never logged in, or Connect rejected the stored credential.",
    suggestion:
      "Run `avocado login`. If your account is in more than one org, run `avocado login --org <org-id>`. For CI, set `AVOCADO_CONNECT_TOKEN` instead. Then rerun the command that failed. Docs: https://docs.peridio.com/developer-reference/avocado-cli/commands#avocado-login",
  },
  {
    label: "Not entitled to a private feed",
    match: /feed-token request returned 403\b/,
    cause:
      "You are logged in, but this account has no access to the private feed of the org that `repos:` names.",
    suggestion:
      "Check the `org:` value of that entry under `repos:` in `avocado.yaml`. Then log in with an account in that org: `avocado login --org <org-id>`. If the org is correct, ask an admin of that org for access. Docs: https://docs.peridio.com/developer-reference/avocado-cli/commands#avocado-login",
  },
  {
    label: "Connect serves no feed tokens",
    match: /feed-token request returned 404\b/,
    cause:
      "The Connect API that the CLI called does not issue feed tokens. This usually means that the login or `AVOCADO_CONNECT_URL` points at the wrong Connect deployment.",
    suggestion:
      "Check `AVOCADO_CONNECT_URL` and the URL of your login. The default is `https://connect.peridio.com`. To log in to a different deployment, run `avocado login --url <url>`. Docs: https://docs.peridio.com/developer-reference/avocado-cli/commands#avocado-login",
  },
  // Signing and verity: avocado-cli `src/commands/runtime/build.rs` (FIT
  // assembly script) and `runtime/deploy.rs`.
  {
    label: "Rootfs verity needs a FIT signing key",
    match: /rootfs\.image\.verity is on, which needs the boot FIT rebuilt/,
    cause:
      "`rootfs.image.verity` puts the rootfs root hash into the boot FIT, so the build must rebuild the FIT. The runtime sets neither `signing.fit_key` nor `signing.fit_unsigned`, so the build cannot make the FIT.",
    suggestion:
      "Set `runtimes.<name>.signing.fit_key` to an RSA key from the signing-key registry. To make one, run `avocado signing-keys create <key-name> --algorithm rsa2048`. Use `signing.fit_unsigned: true` instead only if the U-Boot of this board enforces no key. Do not set both. Then run `avocado build`. Docs: https://docs.peridio.com/developer-reference/security/verity",
  },
  {
    label: "Feed has no bootloader rekey tool",
    match:
      /signing\.fit_key_in_bootloader is on but this feed ships no imx-boot-tools\/rekey-imx-boot\.sh/,
    cause:
      "`signing.fit_key_in_bootloader` puts your FIT key into the bootloader. It is on by default when `signing.fit_key` is set. The feed for this target has no tool to do that.",
    suggestion:
      "Set `runtimes.<name>.signing.fit_key_in_bootloader: false` to keep the distro bootloader, then run `avocado build`. The FIT is still signed, but U-Boot does not enforce your key. Docs: https://docs.peridio.com/developer-reference/security/boot-signing",
  },
  {
    label: "Deploy refuses extension verity",
    match: /extensions with image\.verity: true; deploy does not publish/,
    cause:
      "`avocado deploy` cannot publish the dm-verity hash trees of extensions yet, so the device would refuse them. Rootfs verity is not affected.",
    suggestion:
      "To install this runtime with verity, provision the device: `avocado provision <runtime>`. This erases the target storage, so confirm with the user first. To iterate with deploy, remove `image.verity` from those extensions, run `avocado build`, then `avocado deploy <runtime> -d <device-ip>`. Docs: https://docs.peridio.com/developer-reference/security/verity",
  },
  {
    label: "No root.json in the runtime",
    match: /No root\.json found at /,
    cause:
      "The runtime has no update authority (`root.json`) because no signing key is set for it. Deploy needs one, and `--connect-sign` needs a local signing key for this reason.",
    suggestion:
      "Set `runtimes.<name>.signing.key` for the runtime. For a Connect project, also run `avocado connect trust promote-root --key <key-name>`. Then run `avocado build` and deploy again. Docs: https://docs.peridio.com/developer-reference/avocado-cli/commands#avocado-deploy",
  },
  // Extension dependencies and the lock: avocado-cli `src/commands/install.rs`,
  // `src/utils/ext_deps.rs` and `src/commands/ext/fetch.rs`.
  {
    label: "Unresolved depends_on closure",
    match:
      /unresolved dependency closure|is not defined in `extensions:` and could not be resolved from the target's feed|configuration has not been merged, so its dependencies are unknown/,
    cause:
      "An extension lists another extension in `depends_on` that the CLI cannot find. Either the name is not under `extensions:` and not in the feed of the target, or it is a `git` or `package` source that was not fetched yet.",
    suggestion:
      "The error names the extension, and `Required by:` shows the chain. Check the spelling in `depends_on`. Define the extension under `extensions:`, or make sure that the feed of the target has it. For a `git` or `package` source, run `avocado ext fetch`. Then run `avocado install`. Docs: https://docs.peridio.com/changelog/august-2026/1.0.0-rc.2",
  },
  {
    label: "avocado.lock drift under --locked",
    match:
      /--locked forbids (?:resolving them|updating it)|avocado\.lock pins dependency versions that cannot satisfy/,
    cause:
      "`--locked` does not let the CLI change `avocado.lock`. The config or the feed no longer matches the lock, so the command stopped.",
    suggestion:
      "This is what `--locked` is for in CI. On a development machine, run `avocado ext fetch` without `--locked` (or `avocado install`) to update the lock. Review the `avocado.lock` diff and commit it. Keep `--locked` in CI. Docs: https://docs.peridio.com/developer-reference/avocado-cli/commands#avocado-ext-fetch",
  },
  {
    label: "Lockfile from another distro release",
    match: /Lock file was created with distro\.release '/,
    cause:
      "`avocado.lock` pins packages from a different `distro.release` than `avocado.yaml` names. Locked pins stay in place until you clear them. The same is true for a version change in `avocado.yaml`.",
    suggestion:
      "Run `avocado unlock`, then `avocado install`. To clear only one scope, use `avocado unlock --sdk`, `--rootfs`, `--initramfs`, `--extension <name>` or `--runtime <name>`. Docs: https://docs.peridio.com/developer-reference/lockfiles-and-build-stamps",
  },
  // Config checks: avocado-cli `src/utils/config_lint.rs` (warnings, the
  // build continues), `src/utils/version.rs` and `src/utils/config.rs`.
  {
    label: "avocado.yaml keys ignored",
    match:
      /\.ya?ml: (?:unknown key '[^'\n]+' is ignored|'[^'\n]+' (?:has no effect|is an old (?:name|spelling)|is no longer read|sets no [^\n]*? fields))/,
    cause:
      "The CLI found keys in `avocado.yaml` that it does not read. These are warnings. The command continues, but those settings have no effect.",
    suggestion:
      "Each warning names the key path and, when it can, the key it expected (`did you mean ...`). Rename or remove each key. Run `validate-yaml` to list all of them at once. Docs: https://docs.peridio.com/developer-reference/avocado-cli/configuration",
  },
  {
    label: "CLI version does not meet cli_requirement",
    match: /This project requires avocado CLI version '/,
    cause:
      "`cli_requirement` in `avocado.yaml` names CLI versions that do not include the one you run.",
    suggestion:
      "Run `avocado upgrade`, then retry. Change the requirement to allow an older CLI only if you know that the project works with it. Docs: https://docs.peridio.com/developer-reference/avocado-cli/commands#avocado-upgrade",
  },
  {
    label: "Invalid cli_requirement",
    match: /Invalid cli_requirement '/,
    cause:
      "`cli_requirement` in `avocado.yaml` is not a valid semver requirement. An upgrade does not fix this.",
    suggestion:
      'Correct `cli_requirement` in `avocado.yaml` to a semver requirement such as `">=1.0.0"` or `"^1.0"`, then retry. Docs: https://docs.peridio.com/changelog/march-2026/0.26.0',
  },
  {
    label: "Encrypted /var config error",
    match:
      /var\.hardware: '[^'\n]*' (?:is not one of|needs var\.recovery)|var\.recovery is set but var\.encrypt is not true|(?:sets|opts in to) var\.encrypt (?:but is scoped|for ')|targets is empty - that scopes the runtime to no target/,
    cause:
      "The `var` settings of a runtime do not agree. The CLI checks them at config load and before the build, so that `/var` never comes up plaintext when the config asks for encryption.",
    suggestion:
      "`var.hardware` takes `auto`, `caam`, `tpm2` or `none`. `none` needs `var.recovery`. `var.recovery` needs `var.encrypt: true`. A runtime with `var.encrypt` and a `targets:` list must list the target you build for. Do not set `targets: []`. Omit the key to mean every target. Fix the key that the error names, then rerun. Docs: https://docs.peridio.com/developer-reference/security/encrypted-var",
  },
  {
    label: "Stale build volume",
    // avocado-cli `src/commands/rootfs/image.rs`. Older CLIs failed later with
    // a grep error on the same file, which the docs also describe.
    match:
      /is missing \/etc\/passwd\. The build volume looks half-populated or stale|rootfs-work\/etc\/(?:passwd|shadow|group): No such file/,
    cause:
      "The Docker volume of this project is stale or half-populated. An install was interrupted, or the project directory was deleted without `avocado clean`, and its old volume is still there.",
    suggestion:
      "Reset the build state, then rebuild: `avocado clean`, `avocado prune`, `avocado install`, `avocado build`. `clean` removes the volume of this project. `prune` removes volumes left by deleted projects. Run both. The next install downloads and builds again. Docs: https://docs.peridio.com/developer-reference/getting-started/qemu#troubleshooting-a-stale-build-volume",
  },
];

export function diagnoseProvisionLog(log: string): Diagnosis[] {
  const out = runPatterns(PROVISION_PATTERNS, log);
  // The generic tegraflash advice (short FC REC to GND) is wrong for boards
  // such as AGX Thor. The specific RCM diagnosis has the per-board steps.
  if (out.some((d) => d.label === "Jetson not in recovery mode")) {
    return out.filter((d) => d.label !== "USB / tegraflash failure");
  }
  return out;
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
  /\b(?:exit(?:ed with)?(?:\s+(?:code|status))?|returned (?:non-zero )?exit (?:code|status))\s*[:=]?\s*(\d+)\b(?!\s*(?:warning|error|result|package|match|file|byte|line|test|item|second)s?\b)/i;
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
    // A nonzero exit code is an error even when no line says so (a deploy
    // that prints only progress, then `exit code: 1`).
    hasErrors: errorLines.length > 0 || (exitCode !== null && exitCode !== 0),
    exitCode,
    errorLines,
    filePaths: Array.from(filePathsSeen),
    commands,
  };
}

/** The command whose log a diagnosis reads. */
export type LogKind = "build" | "install" | "deploy" | "provision";

/**
 * Render a fallback diagnosis when no curated pattern matched but the log
 * clearly contains error signals. Tells the LLM honestly that we don't
 * recognize this failure class, then routes it to productive next steps.
 */
export function renderFallbackDiagnosis(
  kind: LogKind,
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
  if (kind === "deploy") {
    out += `1. **Check SSH and the network to the device.** Run \`ping -c 1 <device-ip>\` and \`ssh -o ConnectTimeout=5 -o BatchMode=yes root@<device-ip> true\`. Both return on their own, so they cannot hang an automated run. Deploy pushes the runtime over SSH and HTTP, so the device must be on and reachable from this host.\n`;
    out += `2. **Check \`avocadoctl\` on the device.** Run \`ssh -o ConnectTimeout=5 -o BatchMode=yes root@<device-ip> avocadoctl status\`. A missing or failing \`avocadoctl\` stops the runtime update on the device.\n`;
    out += `3. **Compare against the deploy refusals the MCP knows:** extension \`image.verity: true\` (provision instead), no \`root.json\` in the runtime (set \`runtimes.<name>.signing.key\`), and stale or missing build stamps (run the commands that the CLI lists under \`To fix:\`, in order).\n`;
    out += `4. **Read the device logs.** Run \`ssh -o ConnectTimeout=5 -o BatchMode=yes root@<device-ip> journalctl -b --no-pager | tail -n 100\`.\n`;
    out += `5. **\`search-docs\`** with a short, distinctive substring of the error line. Then report the error to the user with the extracted lines verbatim. Do not make up a cause.\n`;
    out += `\n**Do not interpret an empty pattern list as "the deploy is fine."** The log has errors. If this failure class is one you see often, file it at \`src/lib/diagnostics.ts\` so future runs get a curated fingerprint.\n`;
    return out;
  }
  out += `1. **\`search-docs\`** with a short, distinctive substring of the error line — usually the verbatim message text without paths or numbers. The Avocado docs site indexes failure modes and CLI behaviour.\n`;
  out += `2. **\`search-packages\` / \`describe-package\`** if any error line names what looks like a package, library, or binary.\n`;
  out += `3. **\`get-reference-file\`** to compare the failing component against a working reference's analogous file (e.g. \`avocado.yaml\`, a hook script, an overlay file).\n`;
  out += `4. **\`Read\` the file paths** listed above if they look like project / extension / SDK files (NOT host-only paths).\n`;
  out += `5. **Report the error** to the user with the extracted lines verbatim — don't fabricate a cause from training-data priors. Ask the user if they recognize the failure class.\n`;
  out += `\n**Do not interpret an empty pattern list as "the ${kind} is fine."** The log has errors; we just don't have a curated diagnosis for this one yet. If this failure class is one you see often, file it at \`src/lib/diagnostics.ts\` so future runs get a curated fingerprint.\n`;
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
 * Feed streams the build-error investigator probes for a failing package,
 * after the project's own configured feeds (always probed first). These are
 * the streams live on repo.avocadolinux.org (2026-10): 2024 has `edge` and
 * `next`, and 2026 has `next`, `edge` and `stable`. `next` matters because
 * newer boards ship there first (RB3 Gen 2 is only on 2026/next). A stream
 * whose targets.json lacks the target is dropped from the result, so the
 * extra probes cost one small fetch each.
 */
export const INVESTIGATION_STREAMS: { release: string; channel: string }[] = [
  { release: "2026", channel: "next" },
  { release: "2026", channel: "edge" },
  { release: "2026", channel: "stable" },
  { release: "2024", channel: "edge" },
  { release: "2024", channel: "next" },
];

export interface StreamPresence {
  release: string;
  channel: string;
  /** True for the feed the project is configured for. */
  configured: boolean;
  hits: { repo: string; version: string }[];
  /** Set when the feed for this stream couldn't be reached (e.g. not live). */
  error?: string;
  /** Enabled feeds the lookup could not read, e.g. private `org:` feeds. */
  notChecked?: { feed: string; reason: string }[];
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
    feed?: FeedSelector,
  ): Promise<{
    results: { name: string; repo: string; version: string }[];
    errors?: { target: string; messages: string[] }[];
    notChecked?: { feed: string; reason: string }[];
  }>;
}

/**
 * One stream to probe. The caller resolves `feed` from the project's config,
 * so alternates keep the project's repo URL, TLS settings and snapshot pins.
 */
export interface StreamProbe {
  release: string;
  channel: string;
  configured: boolean;
  feed: FeedSelector;
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
  probes: StreamProbe[],
): Promise<PackageInvestigation[]> {
  const tasks = names.map(async (name): Promise<PackageInvestigation> => {
    const streams = await Promise.all(
      probes.map(
        async ({
          release,
          channel,
          configured,
          feed,
        }): Promise<StreamPresence | undefined> => {
          try {
            const r = await repo.searchPackages(targets, name, 20, feed);
            const hits = dedupHits(r.results.filter((x) => x.name === name));
            // A stream that isn't reachable (e.g. no targets.json) comes back
            // as per-target errors, not a throw. Report it, not "not found".
            const errs = (r.errors ?? []).flatMap((e) => e.messages);
            // An alternate stream that doesn't carry the target says nothing
            // about the package. Drop it instead of reporting an error.
            if (
              !configured &&
              hits.length === 0 &&
              errs.length > 0 &&
              errs.every((e) => e.startsWith(NO_TARGET_REPOS))
            ) {
              return undefined;
            }
            // One entry per feed, not one per target.
            const notChecked = [
              ...new Map(
                (r.notChecked ?? []).map(({ feed, reason }) => [
                  `${feed}\0${reason}`,
                  { feed, reason },
                ]),
              ).values(),
            ];
            return {
              release,
              channel,
              configured,
              hits,
              error:
                hits.length === 0 && errs.length > 0
                  ? errs.join("; ")
                  : undefined,
              ...(notChecked.length > 0 ? { notChecked } : {}),
            };
          } catch (e) {
            return {
              release,
              channel,
              configured,
              hits: [],
              error: (e as Error).message,
            };
          }
        },
      ),
    );
    return {
      name,
      streams: streams.filter((x): x is StreamPresence => x !== undefined),
    };
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
  `4. **Emulate an x86-64 SDK on this host** with the global \`--sdk-arch\` flag: \`avocado --sdk-arch x86-64 install\`. The CLI runs the x86-64 SDK container through Docker buildx and QEMU, so it pulls the x86-64 SDK packages. It is much slower than a native SDK. The SDK install is tracked per architecture, so pass the same flag to every later \`avocado\` command for this project.`,
  ``,
  `**Do NOT** suggest \`--platform\` or other invented flags. \`--sdk-arch\` (values \`aarch64\` or \`x86-64\`) is the only arch override. Verify any flag with \`avocado --help\` before recommending.`,
].join("\n");

/** Feeds the configured stream enables but the lookup could not read. */
function renderStreamNotChecked(inv: PackageInvestigation): string {
  const list = inv.streams.find((s) => s.configured)?.notChecked ?? [];
  if (list.length === 0) return "";
  return `Not checked on your configured feeds: ${list
    .map((n) => `\`${n.feed}\` (${n.reason})`)
    .join("; ")}. The package may come from one of these.\n\n`;
}

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
    out += renderStreamNotChecked(inv);
    return out;
  }

  for (const s of present) {
    out += `- **${s.release}/${s.channel}${s.configured ? " _(configured)_" : ""}:** present (${s.hits
      .map((h) => `\`${h.repo}\` v${h.version}`)
      .join(", ")})\n`;
  }
  out += `\n`;

  const streamsList = present
    .map((s) => `\`${s.release}/${s.channel}\``)
    .join(", ");
  const configured = inv.streams.find((s) => s.configured);
  if (configured && configured.hits.length > 0) {
    out += `The package is on your configured stream \`${configured.release}/${configured.channel}\`, so it is not a missing top-level package — a "not found" build error here usually means a broken transitive dependency or arch-specific metadata.\n`;
  } else if (configured?.notChecked && !configured.error) {
    out += `The checked feeds of your configured stream \`${configured.release}/${configured.channel}\` do not have it. Its availability there is unknown, because the MCP could not read some of your feeds. It is present on ${streamsList}. Check the unread feeds before you change \`distro.release\` / \`distro.channel\`.\n\n`;
    out += renderStreamNotChecked(inv);
  } else if (configured && !configured.error) {
    out += `Not on your configured stream \`${configured.release}/${configured.channel}\`, but present on ${streamsList}. Set \`distro.release\` / \`distro.channel\` in \`avocado.yaml\` to one of those and re-run \`avocado install\` — switch deliberately, since it changes every package, and prefer the release that matches your hardware (\`2026\` for newer boards, \`2024\` otherwise).\n`;
  } else if (configured?.error) {
    out += `Could not query your configured stream \`${configured.release}/${configured.channel}\`, so it is unknown whether the package is there. It is present on ${streamsList}. Retry before you change \`distro.release\` / \`distro.channel\`.\n`;
    const unread = renderStreamNotChecked(inv);
    if (unread) out += `\n${unread}`;
  } else {
    out += `The package exists in the feed (present on ${streamsList}). If your \`avocado.yaml\`'s \`distro.release\` doesn't match one of these, switch it and re-run \`avocado install\` — most commonly the package is on the release that matches your hardware (\`2026\` for newer boards, \`2024\` otherwise). If you're already on a matching stream, a "not found" build error usually means a broken transitive dependency or arch-specific metadata, not a missing top-level package.\n`;
  }

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
  kind: LogKind,
  diagnoses: Diagnosis[],
  investigations?: PackageInvestigation[],
  investigationContext?: {
    targets: string[];
    rawLog?: string;
    feedDescription?: string;
  },
): string {
  const headerName =
    kind === "provision" ? "diagnose-provision-log" : "explain-build-error";
  // The package-feed lookup only applies to build and install logs.
  const feedLookup = kind === "build" || kind === "install";
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
      out += `- The \`avocado ${kind}\` command actually succeeded. Check the exit code on the original command.\n`;
      out += `- Only a partial log was pasted — re-paste the section containing the failure.\n`;
      out += `- The failure is silent (process killed by OOM with no error message; check \`dmesg | grep -i "killed process"\`).\n`;
    } else {
      // No rawLog supplied (older callers / fallback). Generic checks.
      out += `No known failure pattern matched. The log may contain a novel error. Common things to check manually:\n\n`;
      if (kind === "deploy") {
        out += `- Can this host reach the device over SSH? \`ssh -o ConnectTimeout=5 -o BatchMode=yes root@<device-ip> true\`.\n`;
        out += `- Does \`avocadoctl status\` run on the device?\n`;
        out += `- What do the device logs say? \`journalctl -b\` on the device.\n`;
      } else if (feedLookup) {
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

  if (feedLookup && investigations && investigations.length > 0) {
    const archMismatchSuspected = investigationContext?.rawLog
      ? ARCH_MISMATCH_FINGERPRINT.test(investigationContext.rawLog)
      : false;
    out += `## Package investigation (across channels)\n\n`;
    if (investigationContext?.feedDescription) {
      out += investigationContext.feedDescription + `\n`;
    }
    out += `_Queried targets: ${investigationContext?.targets.map((t) => `\`${t}\``).join(", ") ?? "(none)"}._\n\n`;
    for (const inv of investigations) {
      out += renderInvestigation(inv, archMismatchSuspected);
    }
  } else if (feedLookup && investigations && investigations.length === 0) {
    out += `## Package investigation\n\n_No package names extracted from the log — couldn't run a cross-channel lookup. If you can isolate the failing package, re-run with that name in mind or call \`describe-package\` directly._\n\n`;
  }

  if (feedLookup && !investigations) {
    out += `\n_Pass \`targets: [...]\` to enable a cross-release package lookup. The tool will extract the failing package(s) from the log and probe your configured feed (pass \`projectDir\`) plus the \`edge\` channel on both releases (\`2024\` and \`2026\`) — the streams ~all users are on — for you._\n`;
  }

  return out;
}
