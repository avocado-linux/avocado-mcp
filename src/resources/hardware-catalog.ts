export const URI = "avocado://skills/hardware-catalog";
export const NAME = "hardware-catalog";
export const DESCRIPTION =
  "How Avocado OS targets relate to package feeds, and which tools give the board facts (get-target-info, get-provisioning-steps, list-provision-profiles). Read this when the user asks about hardware or when picking a target.";

export const CONTENT = `# Hardware catalog

Avocado OS targets are organized as flat strings (e.g. \`raspberrypi5\`, \`imx8mp-evk\`, \`jetson-orin-nano-devkit\`). The canonical list lives per feed stream at \`{repo_url}/{release}/{channel}/targets.json\`, e.g.:

> https://repo.avocadolinux.org/2024/edge/targets.json

**Targets differ per stream.** Feeds are published across releases (\`2024\`, \`2026\`) and channels (\`next\`, \`edge\`, \`stable\`), and the target set is not identical between them — newer hardware may exist only on a newer release (e.g. NVIDIA Thor on \`2026\`, not \`2024\`). Which feed a project uses is set by its \`distro.release\` / \`distro.channel\` / \`distro.repo.url\` (or the \`AVOCADO_REPO_URL\` / \`AVOCADO_DISTRO_RELEASE\` / \`AVOCADO_DISTRO_CHANNEL\` / \`AVOCADO_RELEASEVER\` env overrides).

This MCP exposes the list via the \`list-targets\` tool. **Pass \`projectDir\` when working in a project** so it reads the project's configured feed, or \`release\`/\`channel\` to inspect a specific stream. Always check one of these before assuming a target exists.

## Board facts

Do not rely on a fixed list of vendors, boards or profiles. Call \`get-target-info\` for a target. It reads the same data files as the docs hardware pages and returns:

- the board page URL and the stream status per LTS release,
- the boards that use the target, and whether \`default_target_board\` is required,
- host OS support and the free disk space the target needs,
- the serial console: an onboard USB console or an adapter, with baud and voltage,
- per provisioning profile: the media, recovery mode steps, the \`avocado provision\` command and the boot steps.

\`get-provisioning-steps\` gives the same steps with the commands to run. After \`avocado install\`, \`list-provision-profiles\` lists the profiles the installed SDK has for the target.

## How targets relate to packages

The Avocado package feed has separate repodata directories per target *and* per CPU family. When \`search-packages\` is called for a given target, it queries the union of:

- \`target/<target>/\` — target-specific RPMs (BSP, HITL tooling, board firmware)
- \`target/<cpu_arch>/\` — generic Linux packages for that CPU (e.g. \`cortexa76\` for rpi5)

The CLI handles this transparently via DNF inside the SDK container. The MCP queries the same data over HTTP — from the same feed, provided you pass \`projectDir\` (it mirrors the CLI's feed precedence, including the lock file's \`repo-snapshot\` pin in the lock file (\`avocado.lock\`, or the legacy \`.avocado/lock.json\`), which rewrites the path to \`{release}/{channel}/snapshots/<id>\`). Every feed tool prints the effective feed and where each value came from; if it doesn't match what the user expects, fix the config rather than overriding per call.
`;
