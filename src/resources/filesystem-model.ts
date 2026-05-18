export const URI = "avocado://skills/filesystem-model";
export const NAME = "filesystem-model";
export const DESCRIPTION =
  "The Avocado filesystem model: root is immutable (assembled from sysext/confext extension images), /var is the only writable partition (persistent across OTAs). The single most important architectural fact to know before authoring an extension — anything that needs to be writable at runtime cannot live in the read-only sysext. Also covers seeding /var content at build time (`var_files`, `docker_images`) vs. creating it at first-boot. Read this BEFORE authoring app extensions, before adding any service that writes to disk, and any time the user asks 'where do I put X?'";

export const CONTENT = `# Filesystem model — root-immutable, /var-writable

This is the single most important architectural fact about Avocado OS:

> **The root filesystem is read-only. /var is the only writable partition. Anything that needs to be writable at runtime cannot live in a sysext.**

If you internalize one thing about Avocado before touching an extension, make it this. Most "but it works on my Ubuntu" confusion comes from not understanding the split.

## The partitions

| Mount | Contents | Writable? | Survives OTA? |
|---|---|---|---|
| **\`/\` (rootfs)** | A frozen erofs image flashed by the BSP, plus sysext images merged into \`/usr/\` and \`/opt/\` via OverlayFS | No (immutable) | No — replaced atomically on update |
| **\`/etc/\`** | Base files from rootfs, overlaid with confext images via systemd-confext | No at the filesystem layer (overlaid) | No — extension provides the values |
| **\`/var/\`** | The writable btrfs partition | **Yes** | **Yes** — persists across OS updates |
| **\`/tmp/\`, \`/run/\`** | tmpfs (RAM-backed) | Yes | No — wiped on reboot |

The rootfs image is signed and (optionally) dm-verity'd. You cannot \`echo > /usr/foo\` and have it stick. Trying to do so at runtime fails with \`Read-only filesystem\`.

## What goes where

| Kind of data | Lives in | How it gets there |
|---|---|---|
| Binaries, libraries, systemd unit files, kernel modules | A \`sysext\` extension's \`/usr/\` | Built into the extension's overlay or installed via \`packages:\` |
| Static configuration, user accounts, network settings | A \`confext\` extension's \`/etc/\` | Built into the extension's overlay |
| Application state (databases, caches, logs) | \`/var/\` on the device | Created by the app at runtime, OR seeded at build time via \`var_files\` |
| Container image storage (\`/var/lib/docker\`, podman, etc.) | \`/var/\` | Either pulled lazily at runtime, OR seeded at build time via \`docker_images\` + \`var_files\` exclusion |
| Anything the user-facing app writes at runtime | \`/var/\` | The app's responsibility — it must point its data dir there |

## The implication for extensions

When you author an extension that needs runtime-writable state, **two things must happen**:

1. The runtime-writable path must be on \`/var/\` — typically \`/var/lib/<your-app>/\`.
2. The extension's \`packages:\` install step may stage files there during build; those paths must be **excluded** from the read-only sysext image and routed to the var partition instead.

The \`extensions.<name>.var_files\` field is how you express that exclusion:

\`\`\`yaml
extensions:
  postgres:
    types: [sysext]
    packages:
      postgresql: '*'
    var_files:
      - var/lib/pgsql/**     # exclude from .raw, lives on var partition
\`\`\`

Without that line, \`avocado ext image\` bakes \`/var/lib/pgsql/\` into the read-only erofs image. PostgreSQL starts, tries to write to \`/var/lib/pgsql/\`, hits read-only, refuses to run.

## Seeding /var at build time

Two mechanisms, controlled separately.

### \`runtimes.<name>.var_files\` — copy files from source tree into /var

Use this for static configuration, certificates, default databases, anything that ships as a file in your repo and needs to be writable on the device.

\`\`\`yaml
runtimes:
  dev:
    extensions: [my-app]
    var_files:
      - source: config/app-defaults/        # path relative to project src_dir
        dest: lib/myapp/                    # destination under /var
      - source: certs/device.pem
        dest: lib/myapp/certs/device.pem
\`\`\`

Each entry is \`{source, dest}\`. The \`source\` is project-relative; the \`dest\` is rooted at \`/var/\` on the device (so \`dest: lib/myapp/\` → \`/var/lib/myapp/\`). Directories are copied recursively — convention is to add a trailing slash for clarity.

### \`extensions.<name>.docker_images\` — pre-pull container images at build time

Use this when the device needs to start containers offline on first boot:

\`\`\`yaml
extensions:
  my-app:
    docker_images:
      - image: docker.io/library/redis
        tag: '7-alpine'
      - image: docker.io/library/nginx
        tag: '1.25'
    var_files:
      - var/lib/docker/**                   # exclude from sysext
\`\`\`

During \`avocado build\`, the CLI spins up an ephemeral \`dockerd\` inside the SDK container, pulls each image for the target architecture, and stages the populated \`/var/lib/docker/\` into the var partition image. The result: a device that has the images cached on first boot, no network required.

The \`extensions.my-app.var_files: ["var/lib/docker/**"]\` line is mandatory in this pattern. Without it, the SDK tries to bake the Docker storage into the read-only sysext and fails.

### Two \`var_files\`, two different jobs

This trips people up. Pay attention:

| Location | Shape | Purpose |
|---|---|---|
| \`runtimes.<name>.var_files\` | \`[{source, dest}, ...]\` | **Copy in**: stage files from project tree into the var image |
| \`extensions.<name>.var_files\` | \`[glob, ...]\` | **Exclude**: tell \`avocado ext image\` not to bake these paths into the read-only sysext |

They serve opposite roles. The runtime-level one says "put this on var"; the extension-level one says "don't put this in the sysext."

## When to seed vs. when to create at first boot

| Situation | Seed at build time? | First-boot create? |
|---|---|---|
| Default config a user shouldn't have to think about | Seed | — |
| TLS certificates, device identity | Seed | — |
| Pre-pulled container images for offline boot | Seed (via \`docker_images\`) | — |
| Database files that will be modified | Seed if pre-populated; otherwise let the app create | First-boot if empty |
| Cache directories that fill up over time | — | First-boot (let app create) |
| Anything per-device (UUIDs, MAC-derived state) | — | First-boot |
| Anything that depends on network or hardware probe | — | First-boot |

Rule of thumb: seed what's deterministic and shippable from source control. Let the app create everything that's device-specific or grows at runtime.

## Why this design

The split is intentional and load-bearing:

- **Atomic updates**: the OS image and \`/var\` are independent. An OTA replaces the rootfs and extensions; app state survives.
- **Rollback**: if a new OS extension fails, the bootloader reverts to the previous slot — your app's data is untouched.
- **Reproducibility**: the rootfs is a content-addressable artifact (deterministic for a given input). Two devices flashed from the same image have bit-identical \`/usr\`.
- **Integrity**: the read-only rootfs can be signed and dm-verity'd. Tampering is detectable. The cost is that you can't \`apt install\` at runtime — but you can ship a new extension instead.

This is also what makes \`avocado deploy\` (network push of a single extension) safe — it replaces a signed component without disturbing \`/var\`.

## Common mistakes to avoid

1. **Trying to write to \`/usr/local/...\` at runtime.** Doesn't work — read-only. Use \`/var/lib/<app>/\` and set the app's \`WorkingDirectory\` / config path accordingly.
2. **Forgetting the \`extensions.*.var_files\` exclusion list.** If your extension's package installs files under \`/var\`, you must exclude them or the build fails or the device errors out.
3. **Editing files in \`/etc\` interactively.** They're overlaid via confext. Edits don't persist across reboots unless you ship the change in a confext.
4. **Storing secrets in the sysext.** It's a signed, world-readable image. Put secrets in \`/var/\` (seeded at provision time) or use TPM-sealed storage.
5. **Assuming \`docker pull\` works on first boot without internet.** It doesn't. Use \`docker_images\` to pre-pull at build time.

## Pointer to the canonical guide

For the full reference on var-partition seeding (including the exact build flow and SDK requirements for Docker-in-Docker priming), see \`docs.peridio.com\`'s "Seeding the var partition" guide. The MCP's local mirror lives at \`docs/src/docs-guides/seeding-var.md\` in the Avocado monorepo.
`;
