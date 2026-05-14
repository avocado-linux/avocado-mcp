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
- **A microSD card / USB drive / NVMe** appropriate to the target's provisioning profile (most targets use SD).

## The happy path

1. **Pick a target.** Use \`list-targets\` to see what's supported. Each entry has a \`target\` string the user puts in their \`avocado.yaml\`.
2. **Init a project.** Use \`init-project\` to generate a starter \`avocado.yaml\` for that target. It declares one runtime (\`dev\`) with sane defaults: the dev extension (for SSH + debugging), the BSP for the target, and a placeholder \`app\` extension.
3. **Build.** The user runs \`avocado build\` locally. The CLI pulls the SDK container, resolves packages from \`repo.avocadolinux.org\`, compiles, and produces a system image.
4. **Provision.** The user runs \`avocado provision -r dev\` (with the right \`--profile\` for the target — usually \`sd\` for an SD card). This flashes the image to media.
5. **Boot the device** with the provisioned media. Default root password is empty in the \`dev\` runtime.

## Where things live

- **The schema** for \`avocado.yaml\`: \`github.com/avocado-linux/avocado-config\`. Fetch it with \`get-config-schema\` before authoring YAML — this is mandatory, the LLM should never guess YAML structure.
- **The package feed**: \`repo.avocadolinux.org\`. RPM-format, queried via \`search-packages\` / \`describe-package\`.
- **Reference projects**: see \`references-catalog\`. Copyable examples that already build and provision.
- **CLI docs**: \`docs.peridio.com/developer-reference/avocado-cli\`.
- **Per-target getting started**: see \`get-provisioning-steps\` for the exact \`avocado provision\` invocation a target needs.

## Common pitfalls

- **Target name mismatch.** Target strings are case-sensitive and must exactly match an entry in \`targets.json\`. Use \`list-targets\` to verify.
- **Unverified package names.** The schema doesn't validate package names — only structure. Always run \`search-packages\` or \`describe-package\` before adding a package to an extension.
- **Linux auto-mount.** Some Linux hosts auto-mount SD cards during provisioning, which corrupts the flash. The relevant target's provisioning steps will flag \`linuxAutoMount\` if it applies.
- **Wrong provisioning profile.** Each target has a profile (\`sd\`, \`usb\`, \`tegraflash\`, etc.). Don't guess — use \`get-provisioning-steps\`.
`;
