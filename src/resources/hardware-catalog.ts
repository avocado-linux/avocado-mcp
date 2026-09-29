export const URI = "avocado://skills/hardware-catalog";
export const NAME = "hardware-catalog";
export const DESCRIPTION =
  "Conceptual map of Avocado OS hardware support: vendors, target naming conventions, provisioning profiles, and how targets relate to package feeds. Read this when the user asks about hardware or when picking a target.";

export const CONTENT = `# Hardware catalog

Avocado OS targets are organized as flat strings (e.g. \`raspberrypi5\`, \`imx8mp-evk\`, \`jetson-orin-nano-devkit\`). The canonical list lives per feed stream at \`{repo_url}/{release}/{channel}/targets.json\`, e.g.:

> https://repo.avocadolinux.org/2024/edge/targets.json

**Targets differ per stream.** Feeds are published across releases (\`2024\`, \`2026\`) and channels (\`next\`, \`edge\`, \`stable\`), and the target set is not identical between them — newer hardware may exist only on a newer release (e.g. NVIDIA Thor on \`2026\`, not \`2024\`). Which feed a project uses is set by its \`distro.release\` / \`distro.channel\` / \`distro.repo.url\` (or the \`AVOCADO_REPO_URL\` / \`AVOCADO_DISTRO_RELEASE\` / \`AVOCADO_DISTRO_CHANNEL\` / \`AVOCADO_RELEASEVER\` env overrides).

This MCP exposes the list via the \`list-targets\` tool — **pass \`projectDir\` when working in a project** so it reads the project's configured feed, or \`release\`/\`channel\` to inspect a specific stream. The docs support matrix at https://docs.peridio.com/hardware/support-matrix#supported documents which release each board is supported on. Always consult one of these before assuming a target exists.

## Vendor families currently supported

- **Raspberry Pi** — \`raspberrypi4\`, \`raspberrypi5\`, \`raspberrypi0-2w\`. Microsd-card provisioning. Cortex-A72/A76/A53.
- **NVIDIA Jetson** — \`jetson-orin-nano-devkit\`, \`jetson-agx-orin-devkit\`. Use the \`tegraflash\` profile, not SD. Linux host only.
- **NXP i.MX** — \`imx8mp-evk\`, \`imx91-frdm\`, \`imx93-evk\`, \`imx93-frdm\`. SD-card provisioning. Industrial features (EdgeLock, TSN).
- **Intel x86-64** — \`intel-x86-64-v2\`, \`intel-x86-64-v3\`. USB-drive provisioning. Requires UEFI boot.
- **Advantech** — \`icam-540\` (Jetson Orin NX inside). Industrial AI camera.
- **OnLogic** — \`fr201\`. Ruggedized x86 industrial.
- **Seeed** — \`reterminal\`, \`reterminal-dm\`. Pi-CM4 / RK3588S-based HMI devices.
- **STMicroelectronics** — \`stm32mp257f-dk\`. SD-card. Cortex-A35 + Cortex-M33 industrial SoC.
- **Grinn** — \`grinn-astra-1680-sbc\`. Synaptics Astra SL1680, Cortex-A73 quad with 7.9 TOPS NPU.
- **SolidRun** — \`rzv2n-sr-som\`. Renesas RZ/V2N HummingBoard, Cortex-A55 + DRP-AI3 NPU.
- **QEMU** — \`qemuarm64\`, \`qemux86-64\`. Virtual targets for development. No physical hardware needed; runs in a VM.

## Provisioning profile cheat sheet

| Profile | What you flash | Targets |
|---|---|---|
| \`sd\` | microSD card | Raspberry Pi, NXP boards, STM32MP, Grinn, SolidRun, Seeed |
| \`usb\` | USB drive | Intel x86-64 |
| \`tegraflash\` | NVMe over USB (recovery mode) | NVIDIA Jetson |
| (none, just power) | internal storage on already-provisioned device | Advantech ICAM-540, OnLogic FR201 |
| (virtual) | no flash — \`avocado sdk run\` boots a VM | QEMU |

Use \`get-provisioning-steps\` for the precise command sequence per target.

## How targets relate to packages

The Avocado package feed has separate repodata directories per target *and* per CPU family. When \`search-packages\` is called for a given target, it queries the union of:

- \`target/<target>/\` — target-specific RPMs (BSP, HITL tooling, board firmware)
- \`target/<cpu_arch>/\` — generic Linux packages for that CPU (e.g. \`cortexa76\` for rpi5)

The CLI handles this transparently via DNF inside the SDK container. The MCP queries the same data over HTTP — from the same feed, provided you pass \`projectDir\` (it mirrors the CLI's feed precedence, including the lock file's \`repo-snapshot\` pin at \`.avocado/lock.json\`, which rewrites the path to \`{release}/{channel}/snapshots/<id>\`). Every feed tool prints the effective feed and where each value came from; if it doesn't match what the user expects, fix the config rather than overriding per call.
`;
