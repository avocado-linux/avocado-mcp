export const URI = "avocado://skills/stone";
export const NAME = "stone";
export const DESCRIPTION =
  "Read this when the user wants to change partitions or partition sizes, make the rootfs or the image bigger, add a data partition, flash to eMMC, NVMe or USB in place of SD, edit boot files (config.txt, U-Boot env, GRUB config), put device certs or IDs on the device at flash time, set up factory provisioning, or asks what gets written to the media. Also read it for a stone error in a build or provision log. Avocado uses stone (a JSON manifest per target) for the disk layout, the boot files, the flash methods (provision profiles) and the OTA bundle. The skill has recipes to replace boot files, fork the manifest, add a profile and change the layout. Kernel arguments, device-tree overlays, rootfs files and more /var space are not stone changes. The skill gives the avocado.yaml key for each.";

export const CONTENT = `# stone: manifests, profiles and disk layout

stone turns a JSON manifest into disk images, the \`.aos\` OS bundle for OTA,
and a provisioned device. The CLI never runs stone on the host. stone runs in
the SDK container, through hook scripts that the BSP installs.

## What do you want to do?

| The user wants to | stone? | Do this |
|---|---|---|
| Make the rootfs bigger, add a data partition, change partition sizes | Yes | Fork the manifest (recipe D), then provision. A deploy cannot do it. |
| Edit \`config.txt\`, turn on the UART in the firmware, change the U-Boot env or GRUB config, add boot firmware files | Yes | \`stone_include_paths\` (recipe A) |
| Flash to eMMC, NVMe or USB in place of SD, or flash over USB | Usually not | Use a profile the target has: \`avocado provision --list\`, then \`--profile <profile>\`. Only a new flashing method needs a custom profile (recipe C). |
| Put a device cert or ID on the device at flash time, factory provisioning, flash many devices | Yes | \`--env\` values for the profile fields, or a custom profile (recipe C) |
| Know what gets written to the media, or why the image has this size | Yes | Read the manifest ("Read a manifest by hand") |
| Turn off A/B updates or change the rollback | Yes, advanced | The \`update\` section of a forked manifest. This is advanced. Tell the user to contact Peridio first. |
| Add kernel arguments | No | \`kernel.cmdline_extra\` in avocado.yaml |
| Add a device-tree overlay | No | \`device_tree_overlays\` on an extension |
| Get more space in /var | No | \`var\` is the last partition. The \`avocado-ext-dev\` extension grows it to fill the disk at boot. |
| Add files to the root filesystem | No | An extension \`overlay\` |

## The manifest

| Section | What it holds |
|---|---|
| \`runtime\` | \`platform\`, \`architecture\`, \`provision_default\` (the default profile) and \`update_strategy\` (the A/B slot scheme). |
| \`storage_devices\` | Per device: the images (plain files, or FAT and fwup images that stone builds) and the ordered partition list. |
| \`provision\` | \`profiles\` (each has a \`script\`, \`envs\` and an optional \`requires\`), named \`envs\` blocks, helper \`files\`, and \`fields\` (input hints for tools). |
| \`update\` | How the OS artifacts map to A/B slots. stone copies it into the bundle. |

For every field, read the docs:
https://docs.peridio.com/developer-reference/stone/overview,
https://docs.peridio.com/developer-reference/stone/usage,
https://docs.peridio.com/developer-reference/stone/commands and
https://docs.peridio.com/developer-reference/stone/provision-fields.

## What the CLI runs

\`avocado build\` (in the SDK container):

1. The build deletes \`/opt/_avocado/<target>/output/runtimes/<runtime>/stone/\`.
2. The BSP hook \`avocado-build-<target> <runtime>\` runs \`stone validate\` and
   \`stone create\`. \`create\` writes \`manifest.json\`, the profile scripts and
   all inputs into that \`stone/\` directory. This is the staged manifest.
3. The CLI runs \`stone bundle\` and writes
   \`/opt/_avocado/<target>/output/runtimes/<runtime>/os-bundle.aos\`.

\`avocado provision <runtime>\`:

1. The CLI copies the real var image into the staged \`stone/\` directory.
2. The BSP hook \`avocado-provision-<target> <runtime>\` runs \`stone provision\`.
   stone uses the first \`manifest.json\` in its input directories: your
   \`stone_include_paths\` first, then the staged \`stone/\` directory.
3. stone runs the script of the selected profile. The script writes the media
   or the image file.

Provision does not run \`stone validate\` or \`stone create\`. It uses what the
last build staged.

## Where the manifest comes from

Each target has one default manifest from its BSP (meta-avocado). In the SDK
container it is \`$AVOCADO_SDK_PREFIX/stone/stone-<target>.json\`. On the
project volume that is \`/opt/_avocado/<target>/sdk/<sdk-arch>/stone/\`.

A board (\`default_target_board\`, \`target_board\`, \`--target-board\`) never
selects a manifest. The board only sets \`{{ avocado.target.board }}\` in
avocado.yaml. All boards of one target use the same manifest.

\`runtimes.<runtime>.stone_manifest\` replaces the BSP manifest for one runtime
(recipe B).

## Read a manifest by hand

No MCP tool reads a manifest. Run stone in the SDK container. The single quotes
keep \`$AVOCADO_SDK_PREFIX\` for the container shell. Add \`--target <target>\`
after \`run\` when the target is not the project default.

\`\`\`bash
# The BSP default manifest
avocado sdk run -E bash -c 'stone describe-manifest -m "$AVOCADO_SDK_PREFIX/stone/stone-<target>.json"'
# The staged manifest that the next provision uses (run avocado build first)
avocado sdk run -E bash -c 'stone describe-manifest -m /opt/_avocado/<target>/output/runtimes/<runtime>/stone/manifest.json'
# The raw JSON
avocado sdk run -E bash -c 'cat "$AVOCADO_SDK_PREFIX/stone/stone-<target>.json"'
\`\`\`

\`describe-manifest\` prints the devices, images and partition sizes. It does
not print the provision profiles. It fails on a unit it does not know, for
example \`sectors\` in the orangepi-5-plus manifest. Read the raw JSON for that
board.

To read the profiles and the default profile, use \`jq\` in the SDK container.
The SDK installs \`jq\` with the BSP hooks.

\`\`\`bash
# The staged manifest (run avocado build first)
avocado sdk run -E bash -c 'jq "{provision_default: .runtime.provision_default, profiles: .provision.profiles}" /opt/_avocado/<target>/output/runtimes/<runtime>/stone/manifest.json'
# A forked manifest (the project directory, or src_dir, is /opt/src)
avocado sdk run -E bash -c 'jq "{provision_default: .runtime.provision_default, profiles: .provision.profiles}" /opt/src/<stone_manifest>'
\`\`\`

## Profiles and inputs

- \`avocado provision <runtime> --profile <profile>\` selects a profile. Without
  \`--profile\`, stone uses \`runtime.provision_default\` of the manifest.
- \`--env VAR=value\` (repeat it) puts \`VAR\` in the provision environment.
  stone expands \`\${VAR}\` in \`provision.envs\`, and the script also sees it.
- A variable that is referenced but not set becomes empty. stone prints a
  warning and goes on. \`provision.fields.<var>.required\` is not enforced.
- \`avocado provision --list\` (after \`avocado install\`) prints the profiles,
  the default profile and the \`--env\` fields. It reads only the BSP manifest.
  It ignores \`stone_manifest\`. The \`list-provision-profiles\` tool wraps it.
- The CLI reads \`provision.fields\` with \`required: false\` as the default. The
  docs say \`true\`. \`--list\` shows only fields from named \`envs\` blocks.
- \`requires: ["usb"]\` is not enforced at provision. Each script checks
  \`AVOCADO_USB_PASSTHROUGH\` itself. The CLI sets it to \`0\` on macOS and
  Windows hosts.

\`provision_profiles.<profile>\` in avocado.yaml takes only \`container_args\`
and \`state_file\`. The key must equal the stone profile key, for example
\`provision_profiles.sd\` for \`--profile sd\`. The CLI applies the block only
when you pass \`--profile\`. It does not apply it to the default profile.

\`\`\`yaml
provision_profiles:
  sd:
    container_args: ["--device", "/dev/sdb"]
\`\`\`

## Recipes

Every path in these keys is relative to the project root (\`src_dir\`, if
set). \`stone_include_paths\` and \`stone_manifest\` also take a target
override, for example \`runtimes.dev.raspberrypi5.stone_manifest\`.

### A. Replace or add a boot file, script or fwup template

\`stone_include_paths\` adds input directories. stone takes the first match
across all input directories, and your paths come first. A file with the same
relative path as a BSP input replaces that input. The BSP manifest stays.

\`\`\`yaml
runtimes:
  dev:
    stone_include_paths:
      - stone/{{ avocado.target }}
\`\`\`

Put the file at \`stone/<target>/<path the manifest uses>\`, for example
\`stone/raspberrypi5/bootfiles/config.txt\`. The \`rubicon\` reference does
exactly this. Read its \`avocado.yaml\` with \`get-reference-file\`. An extension can
also set \`stone_include_paths\`. Runtime paths come first, then extensions in
the order of the runtime \`extensions:\` list.

Do not put a file called \`manifest.json\` in an include path. Provision would
use it in place of the staged manifest. Do not use a space or a colon in a path.

Then run \`avocado build\` and \`avocado provision <runtime>\`. A file in an A/B
slot image (\`update.os_artifacts\`, for example \`boot\` on Raspberry Pi and
i.MX) is also in the OS bundle, so \`avocado deploy\` ships it after the build.
A file in another image, such as the U-Boot env, needs a provision.

### B. Fork the manifest

Copy the BSP manifest into the project (see "Read a manifest by hand") and set:

\`\`\`yaml
runtimes:
  dev:
    stone_manifest: stone-rzv2n-sr-som.json
\`\`\`

Use a relative path. The CLI always adds \`/opt/src/\` in front, so an absolute
path breaks. The \`rzv2n-drpai-yolo\` reference forks its manifest like this.
A fork does not get BSP updates. Compare it with the BSP manifest after each
SDK update. Then run \`avocado build\` and \`avocado provision <runtime>\`.

### C. Add a custom provision profile

Fork the manifest (B), then add the profile:

\`\`\`json
"provision": {
  "profiles": {
    "factory": {
      "script": "stone-provision-factory.sh",
      "envs": ["device_info"]
    }
  },
  "files": ["factory-lib.sh"]
}
\`\`\`

Put \`stone-provision-factory.sh\` and \`factory-lib.sh\` in an include path
(A). \`stone create\` copies the script and \`provision.files\` into the staged
directory. The script runs there and gets \`AVOCADO_STONE_MANIFEST\`,
\`AVOCADO_STONE_BUILD_DIR\`, \`AVOCADO_STONE_DATA_DIR\` and the profile envs.
Start from a BSP script of the same board. Then:

\`\`\`bash
avocado build
avocado provision dev --profile factory --env AVOCADO_DEVICE_ID=unit-42
\`\`\`

\`avocado provision --list\` does not show this profile, because it reads the
BSP manifest. For \`container_args\`, add \`provision_profiles.factory\`.

### D. Resize or add a partition

Fork the manifest (B) and edit \`storage_devices.<device>.partitions\`.

- Keep \`var\` as the last partition, with \`expand: "true"\` and no size. Only
  the last partition may omit its size. The hooks pass
  \`--partition-size var=<bytes>\` themselves, and there is no avocado.yaml key
  for other partitions. A new partition needs \`size\` and \`size_unit\`.
- fwup boards (i.MX, Raspberry Pi, reTerminal, fr202, QEMU, Grinn Astra):
  the device fwup template (\`rootdisk.conf\`) gets
  \`AVOCADO_PARTITION_<NAME>_OFFSET\` and \`_BLOCKS\` for each partition (\`rootfs-a\`
  becomes \`ROOTFS_A\`). A resize needs no template change. A new partition
  needs a template that writes it: put your copy of \`rootdisk.conf\` in an
  include path (A).
- Boards without a device fwup template (Alif, Renesas, Rockchip, STM32,
  Intel x86-64): a BSP script (for example \`build-disk-image.sh\`) reads the
  partitions from the manifest. Read it before you add a partition.
- Jetson and Rubik Pi 3 layouts are not in stone. tegraflash and the UFS
  flasher own them. You cannot change them with a manifest.

A layout change takes effect only when you provision. \`avocado deploy\` and an
OTA update never repartition. Run \`avocado build\`, then
\`avocado provision <runtime>\`. This erases the media, so confirm first.

## Rules

- After any change to a manifest or an include path, run \`avocado build\`, then
  \`avocado provision\`. Provision reuses the staged manifest. Stone inputs are
  not in the build stamp, so the CLI does not see the old build as stale. A
  file in an A/B slot image can also go out with \`avocado deploy\` (recipe A).
- A partition layout change needs a new provision.
- \`fields.required\` and \`requires: usb\` are not enforced.
- stone rejects an unknown key inside \`build_args\`. It ignores other unknown
  keys.

## Targets (snapshot of meta-avocado \`scarthgap\`)

This table can be old. \`avocado provision --list\` is the live answer for the
profiles. \`(u)\` marks a profile with \`requires: ["usb"]\`.

| Target | update_strategy | Default | Profiles | Layout in stone |
|---|---|---|---|---|
| alif-e8-devkit | gpt-ab | sd | img, sd(u), serial(u) | yes |
| jetson-orin-nano, jetson-orin-nx, jetson-agx-orin | tegra-ab | tegraflash | tegraflash, tegraflash-{nvme,mmc,emmc,sd,usb}, noop | no |
| recomputer-j301x, recomputer-j401x | none | tegraflash | as Jetson | no |
| icam-540 | tegra-ab | tegraflash | tegraflash, tegraflash-nvme, noop | no |
| imx8mp-evk, imx8mp-var-dart, imx91-frdm, imx93-frdm, imx95-frdm, ucm-imx8m-plus | uboot-ab | img | img, sd(u), uuu-emmc(u) | yes, fwup |
| imx93-evk | uboot-ab | img | img, sd(u) | yes, fwup |
| raspberrypi4, raspberrypi5 | mbr-ab | img | img, sd(u), usb(u) | yes, fwup |
| raspberrypi0-2w | mbr-ab | img | img, sd(u) | yes, fwup |
| fr202 | none | img | img, sd(u) | yes, fwup |
| reterminal, reterminal-dm | none | img | img, usb(u) | yes, fwup |
| qemux86-64, qemuarm64 | uboot-ab | img | img, direct | yes, fwup |
| rubikpi3 | none | ufs | ufs, noop | no |
| rzv2n-sr-som | gpt-ab | sd | serial(u), emmc(u), sd(u) | yes |
| orangepi-5-plus | gpt-ab | img | img, sd(u), emmc(u) | yes |
| stm32mp25-dk | gpt-ab | sd | sd(u), emmc(u), serial(u) | yes |
| grinn-astra-1680-sbc | none | none | img, synaimg, usb-emmc | yes, fwup |
| intel-x86-64-v2, -v3, -v4 | sdboot-ab | img | img, usb | yes |

grinn-astra-1680-sbc has no default profile, so always pass \`--profile\`.

For stone errors in a build or provision log, call \`explain-build-error\` or
\`diagnose-provision-log\`.
`;
