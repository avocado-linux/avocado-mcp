export const URI = "avocado://skills/getting-started";
export const NAME = "getting-started";
export const DESCRIPTION =
  "How to start a new Avocado OS project from scratch — pick hardware, install tooling, init a project, build, provision. Read this BEFORE invoking init-project, list-targets, or environment-check.";

export const CONTENT = `# Getting started with Avocado OS

Avocado OS is a Yocto-based embedded Linux distribution. A working project consists of:

- **A hardware target** (e.g. \`raspberrypi5\`, \`jetson-orin-nano-devkit\`, \`imx8mp-evk\`).
- **An \`avocado.yaml\` config file** declaring runtimes, extensions, and packages.
- **The \`avocado\` CLI on the host machine** for build and provisioning.
- **The Avocado SDK container image** (\`docker.io/avocadolinux/sdk:<release>-<channel>\`), pulled automatically by the CLI.

## Prerequisites the user must have

- **Docker Desktop** (macOS or Linux). The CLI runs all builds inside the SDK container.
- **The avocado CLI** installed (\`curl -fsSL https://connect.peridio.com/install.sh | sh\` on macOS or Linux).
- **~8 GB free disk space** for the SDK container, builds, and image artifacts.
- **A USB-to-UART adapter** wired into the device's debug UART. **HARD REQUIREMENT** for every non-QEMU target — provisioning and debugging both go through the serial console. Without it, the user can't see boot output, can't recover from failures, and can't diagnose anything on the device. The only exception is QEMU targets (\`qemuarm64\`, \`qemux86-64\`) which run in a VM and don't need physical hardware. If the user doesn't have an adapter, recommend starting with QEMU first.
- **A microSD card / USB drive / NVMe** appropriate to the target's provisioning profile (most targets use SD). Not needed for QEMU.

## The happy path

1. **Verify the host.** Run \`environment-check\` first. If the CLI, Docker, or disk space aren't ready, fix that before anything else — every later step assumes the CLI is on PATH.
2. **Pick a target.** Use \`list-targets\` to see what's supported. Each entry has a \`target\` string the user puts in their \`avocado.yaml\`.
3. **Scaffold the project.** Call \`init-project\` with the chosen \`target\` and \`task\` (the user's task in their own words — e.g. "python web app", "mqtt sensor", "qemu trial run"). The tool searches the reference catalog first and prefers a matching reference whenever one fits — references are pre-built, verified, working projects, and they save substantial time vs. building YAML from scratch. The tool returns either:
   - **A reference scaffold command** (\`avocado init --target <target> --reference <slug> <slug> && cd <slug>\`) when a reference matches. Read the reference with \`get-reference\` to understand what it sets up before suggesting edits.
   - **A from-scratch starter YAML** when no reference fits (or when called with \`forceFromScratch: true\`). Use \`add-extension\` / \`add-package-to-extension\` to extend it. Schema-first, package-verified.
4. **Install packages.** The user runs \`avocado install\` (or \`avocado install -f\` on a fresh scaffold) to resolve and stage all packages declared in \`avocado.yaml\` into the SDK. This is a separate step from build.
5. **Build.** The user runs \`avocado build\` locally. The CLI pulls the SDK container, compiles, and produces a system image from the already-staged packages.
6. **Provision (first time only).** The user runs \`avocado provision -r dev\` (with the right \`--profile\` for the target — usually \`sd\` for an SD card). This flashes the image to media. **If YOU (the LLM) are running this via Bash**, wrap with \`script -q /dev/null avocado provision ... --no-tui\` — the command shells out to \`docker run -it\` internally and fails under a non-TTY harness with \`the input device is not a TTY\`. \`--no-tui\` alone does not fix this. See \`avocado://skills/iterative-deployment\` for the full rule.
7. **Boot the device** with the provisioned media. Default root password is empty in the \`dev\` runtime.
8. **Iterate with \`avocado deploy\`.** After the device is up and on the network, subsequent edits don't need a reflash. Run \`avocado build && avocado deploy -r dev -d <device-ip>\` to OTA changes in seconds. **\`deploy\` is sideloading — it requires the device to have been provisioned at least once.** See \`avocado://skills/iterative-deployment\` for the full flow.

## Provision vs deploy — when to use which

These are NOT interchangeable. Get this wrong and the user wastes 5+ minutes flashing media when they could've pushed in seconds, or worse, tries to deploy to a device that has no OS yet.

| Situation | Command | Prompt |
|---|---|---|
| Device has never been flashed with Avocado OS | \`avocado provision -r dev\` (with profile per target) | \`/provision-device\` |
| Device has Avocado OS, is on the network, you have its IP | \`avocado deploy -r dev -d <ip>\` | \`/build-and-deploy\` |

**Always ask the user up front when they want to push work to a device:** _"Has this device been provisioned with Avocado before, or is this the first time?"_ Route to \`/provision-device\` or \`/build-and-deploy\` based on the answer. Don't assume.

## \`avocado install\` vs \`avocado build\` — when to re-run what

\`avocado install\` resolves \`avocado.yaml\` against the package feed and stages packages into the SDK. \`avocado build\` compiles the system image from whatever is already staged. They are **separate steps**, and \`avocado build\` does **not** re-resolve packages.

**Re-run \`avocado install\` whenever you:**

- add or remove an extension (\`add-extension\` / hand edits)
- add or remove a package from an extension's \`packages\` map (\`add-package-to-extension\` / hand edits)
- add or remove a runtime (\`add-runtime\`)
- bump a package version pin in \`avocado.yaml\`
- change \`distro.release\` or \`distro.channel\`

If you skip this, \`avocado build\` will produce an image with stale package contents and no error message saying so. After any YAML mutation tool the canonical next command is: \`avocado install && avocado build\`.

## Where things live

- **The schema** for \`avocado.yaml\`: \`github.com/avocado-linux/avocado-config\`. Fetch it with \`get-config-schema\` before authoring YAML — this is mandatory, the LLM should never guess YAML structure.
- **The package feed**: \`repo.avocadolinux.org\`. RPM-format, queried via \`search-packages\` / \`describe-package\`.
- **Reference projects**: see \`references-catalog\`. Copyable examples that already build and provision.
- **CLI docs**: \`docs.peridio.com/developer-reference/avocado-cli\`.
- **Per-target getting started**: see \`get-provisioning-steps\` for the exact \`avocado provision\` invocation a target needs.

## Building features — start with \`app-development\`

When the user moves past scaffolding into actual feature work (adding libraries, services, configs, app code), read \`avocado://skills/app-development\`. That skill covers:

- **Where every kind of asset lives** in the project layout (source, configs, systemd units, overlays, var seeds).
- **The feed-first rule for libraries**: \`search-packages\` BEFORE proposing \`pip install\` / \`npm install\` / \`cargo add\` / etc. Feed packages are versioned, security-updatable, and don't bloat the extension. Vendoring is a fallback, not the default.
- **Language-specific patterns** for Python, Node, Rust, C/C++.

## Common pitfalls

- **Target name mismatch.** Target strings are case-sensitive and must exactly match an entry in \`targets.json\`. Use \`list-targets\` to verify.
- **Unverified package names.** The schema doesn't validate package names — only structure. Always run \`search-packages\` or \`describe-package\` before adding a package to an extension.
- **Linux auto-mount.** Some Linux hosts auto-mount SD cards during provisioning, which corrupts the flash. The relevant target's provisioning steps will flag \`linuxAutoMount\` if it applies.
- **Wrong provisioning profile.** Each target has a profile (\`sd\`, \`usb\`, \`tegraflash\`, etc.). Don't guess — use \`get-provisioning-steps\`.
`;
