export const URI = "avocado://skills/avocado-runtime-details";
export const NAME = "avocado-runtime-details";
export const DESCRIPTION =
  "What's actually on a running Avocado OS device: BusyBox vs GNU tools, what shell is available, systemd availability, where logs live, where extensions are mounted. Read this BEFORE driving any device-side commands so you don't waste round-trips on tools that aren't there.";

export const CONTENT = `# Avocado OS runtime details

Things that bite an LLM if it assumes a generic Ubuntu/Fedora environment.

## Shell

- **Default shell is BusyBox \`ash\`**, not bash. \`bash\` MAY be present depending on the runtime — test \`command -v bash\` before relying on it.
- ash supports POSIX: \`if [ ... ]; then ... fi\`, \`for x in ...\`, basic redirections, pipelines.
- ash does NOT support: \`[[ ]]\`, arrays (\`foo=(a b c)\`), \`<<<\` here-strings, \`{1..10}\` brace expansion, \`local -A\` associative arrays, process substitution (\`<(cmd)\`).
- Stick to POSIX when scripting on-device.

## Core utilities — BusyBox flavour

A handful of common commands behave differently from their GNU equivalents:

| GNU | Avocado (BusyBox) | Notes |
|---|---|---|
| \`ifconfig\` | **not installed** — use \`ip a\` / \`ip r\` | iproute2 is the way |
| \`netstat\` | **not installed** — use \`ss\` | \`ss -tlnp\`, \`ss -lnp\` |
| \`ps aux\` | BusyBox \`ps\` — \`ps -ef\` works; no long GNU options | \`ps -ef\` is the safe form |
| \`grep -P\` | not supported | use \`grep -E\` or basic regex |
| \`sed -i\` | available | works |
| \`awk\` | BusyBox awk | a strict subset of GNU awk — stick to portable awk |
| \`find\` | available | no \`-printf\` |
| \`du -h\` | available | works |
| \`stat\` | available, BusyBox flavour | \`-c\` works, \`--printf\` doesn't |

## systemd (full, not BusyBox init)

Avocado uses **systemd**, not BusyBox init. So this is your friend:

- \`systemctl status <unit>\`
- \`systemctl start|stop|restart|reload <unit>\`
- \`systemctl is-active <unit>\`, \`systemctl is-enabled <unit>\`
- \`systemctl cat <unit>\` — show the full merged unit file
- \`systemctl --failed\` — every unit currently in a failed state
- \`systemctl list-units --type=service --state=running\`

## journalctl (full, not k8s minimal)

- \`journalctl -xeu <unit>\` — most recent logs for a unit, with explanations
- \`journalctl -b\` — current boot only; \`-b -1\` previous boot
- \`journalctl -p err\` — priority filter (err, warning, info, debug)
- \`journalctl --since "5 minutes ago"\` / \`--since today\`
- \`journalctl -f\` — follow (won't work over Claude's one-shot Bash; use SSH session or UART)
- \`journalctl --no-pager\` — IMPORTANT for non-interactive use, else output pages and Claude reads "press space to continue"

## Logs

- **\`/var/log/\` is mostly empty** on a stock Avocado image — journald replaces it. Always reach for \`journalctl\` first.
- Kernel ring buffer: \`dmesg --color=never | tail -<N>\`. Or \`journalctl -k\`.

## Filesystem layout: extensions and runtimes

\`avocadoctl\` manages extensions and runtimes on the device. It keeps its state in \`/var/lib/avocado/\`:

\`\`\`
/var/lib/avocado/
├── active              # symlink to runtimes/<active runtime id>
├── runtimes/<id>/manifest.json
├── images/<image_id>.raw   # extension images and OS bundles, shared by all runtimes
├── os-releases/<version_id>/<ext_name>   # symlinks to the enabled extensions
└── metadata/root.json  # TUF trust anchor
\`\`\`

- **After merging** (what running processes see): files appear under normal paths, such as \`/usr/bin/\` and \`/etc/...\`.
- \`avocadoctl status\`: the active runtime (name, version, short ID, rootfs and initramfs build IDs) and the merged extensions. Run this first after a deploy.
- \`avocadoctl ext list\`: every extension image, with its name, version, path and type (sysext or confext).
- \`avocadoctl runtime list\` and \`avocadoctl runtime inspect\`: the staged runtimes and the manifest of the active one.
- \`avocadoctl refresh\`: unmerge and merge the extensions again.
- \`systemd-sysext status\` / \`systemd-confext status\`: the low-level view of what systemd merged.

For every command, see https://docs.peridio.com/developer-reference/avocadoctl/commands.

## Network and discovery

- Dev runtime usually has DHCP and Avahi/mDNS.
- The default hostname is \`avocado-<target>\`, for example \`avocado-raspberrypi5\`. Try both forms from the host before you search for the IP: \`ping avocado-raspberrypi5.local\` (mDNS) and \`ping avocado-raspberrypi5\` (a router or \`/etc/hosts\` entry). If neither resolves, use the IP address.

## Users and auth

- Dev runtime: passwordless \`root\`. The \`avocado init\` template sets it in the top-level \`permissions.dev\` profile (\`users.root.password: \"\"\`), which \`rootfs\` and \`initramfs\` use. SSH login as \`root\` works with no password.
- This is **not for production**. Give production runtimes their own \`permissions\` profile with a hashed password.

## What is NOT on the device

- No package manager. The device's filesystem is read-only and atomic. **Don't try \`apt\` / \`dnf\` / \`apk\` on the device** — they're not there, and even if they were, the rootfs is sealed. Package management happens at *build time* on the host, against the SDK container.
- No compiler toolchain by default. Cross-compile on the host, ship binaries in an extension overlay.
- No container engine by default. Containers run on the device when the runtime includes \`avocado-ext-docker\` or \`avocado-ext-podman\`. Extensions are still the main model. For the container inner loop, see the container dev mode guide: https://docs.peridio.com/developer-reference/container-dev-mode.

## Quick on-device diagnostics catalog

\`\`\`bash
# What's running and what failed
systemctl --failed
systemctl list-units --state=running --type=service

# Errors in this boot
journalctl -p err -b --no-pager

# Boot timeline
systemd-analyze
systemd-analyze blame | head -20

# Networking
ip a; ip r
ss -tlnp

# Storage
df -h
du -sh /var/* 2>/dev/null | sort -h

# Runtime and extensions
avocadoctl status
avocadoctl ext list

# Kernel
uname -a
dmesg --color=never | tail -30
\`\`\`
`;
