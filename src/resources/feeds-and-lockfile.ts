export const URI = "avocado://skills/feeds-and-lockfile";
export const NAME = "feeds-and-lockfile";
export const DESCRIPTION =
  "How an Avocado project picks its package feeds (`repos:`, `distro.feeds`, `stages:`, private `org:` feeds and `avocado login`) and how avocado.lock pins what was resolved (`avocado update`, `avocado unlock`, `ext fetch --locked`, `clean --stamps --unlock`). Read this when a user adds a feed, gets a private-feed or auth error, asks why a package version does not change, or sets up CI.";

export const CONTENT = `# Package feeds and the lock file

## Feeds

Every project has one **distro feed**. It comes from \`distro.release\`,
\`distro.channel\` and \`distro.repo\`, and defaults to
\`https://repo.avocadolinux.org/<release>/<channel>\`.

You can add more feeds:

- \`repos:\` **defines** feeds by name. A definition alone enables nothing.
- \`distro.feeds:\` **enables and orders** them. The order is the dnf
  priority: the first feed that has a package wins. The distro feed is first
  unless you put its name (\`avocado\`) somewhere in the list.
- \`distro.repo\` can be an inline block (\`url\`, \`releasever\`, \`ca\`,
  \`tls_verify\`) or the name of a \`repos:\` entry to use as the distro feed.

Each \`repos:\` entry has exactly one locator:

| Locator | Meaning |
|---|---|
| \`url:\` | A remote dnf repo. The CLI expands \`$releasever\` and \`$target\`. |
| \`path:\` | A local directory of RPMs with \`repodata/\` (run \`createrepo_c\` on it). |
| \`org:\` | A private feed hosted by Peridio Connect. |

Other keys: \`targets:\` (only these targets), \`stages:\` (only these
install stages), \`username\`/\`password\`, \`ca\`, \`tls_verify\`,
\`gpgkey\`/\`gpgcheck\`, and \`release\`/\`channel\`/\`releasever\` for
\`$releasever\`. If you set \`release\` or \`channel\`, the \`url\` must contain
\`$releasever\`.

\`stages:\` values are \`sdk\`, \`rootfs\`, \`runtime\`, \`ext\` and
\`initramfs\`. Omit \`stages:\` to use the feed everywhere. Extension packages
install in the \`ext\` stage and runtime packages in the \`runtime\` stage.

Put credentials in \`username\`/\`password\` with \`{{ env.X }}\` references.
The CLI refuses credentials inside a URL.

\`\`\`yaml
distro:
  release: 2026
  channel: edge
  feeds: [acme, local, vendor]    # distro feed first, then these in order

repos:
  acme:
    org: acme                     # private Connect feed
  local:
    path: rpms                    # ./rpms/repodata/repomd.xml must exist
    stages: [ext, runtime]
  vendor:
    url: https://rpm.vendor.example/$releasever/target/$target
    username: "{{ env.VENDOR_USER }}"
    password: "{{ env.VENDOR_TOKEN }}"
    targets: [raspberrypi5]
\`\`\`

### Private \`org:\` feeds

The CLI trades your Connect login for a short-lived feed token on each run.
Run \`avocado login\` once on a workstation. In CI, set
\`AVOCADO_CONNECT_TOKEN\`. A 403 means the account has no access to that
organization's feed.

The MCP does not use Connect credentials. \`search-packages\`,
\`describe-package\`, \`check-package-coverage\` and
\`add-package-to-extension\` list an \`org:\` feed under **not checked**. A
package that is not found may still be in that feed. Confirm with
\`avocado install\`.

## The lock file

\`avocado.lock\` sits at the top of \`src_dir\` (or next to avocado.yaml).
Commit it. Older CLIs wrote \`.avocado/lock.json\`. The current CLI reads that
file and moves it to \`avocado.lock\` on the next write.

Per target, the lock pins:

- the exact version of every package in each sysroot (SDK, rootfs,
  initramfs, extensions, runtimes) and the kernel version,
- \`repo-snapshot\`: the feed snapshot the target resolved against, so a
  later install reads \`<release>/<channel>/snapshots/<id>\`,
- \`feeds\`: the feed set and order the target used.

A locked pin does not change when you edit a version in avocado.yaml.
Unlock that scope, then install:

\`\`\`bash
avocado unlock --extension my-app     # or --runtime dev, --sdk, --rootfs, --initramfs
avocado install
\`\`\`

\`avocado unlock\` with no scope flag clears every pin for the target,
including the snapshot.

To move a target forward to the newest snapshot and the newest packages:

\`\`\`bash
avocado update        # advance the snapshot pin and clear package pins
avocado install       # resolve and lock the new versions
\`\`\`

If you change \`distro.release\` or \`distro.channel\`, the old snapshot pin no
longer applies. The CLI tracks the live channel and warns until you run
\`avocado update\`.

### CI

\`avocado ext fetch --locked\` fails instead of writing the lock when an
extension has no lock entry or its pinned version moved. Use it in CI so a
build never resolves something new by accident.

### Resetting state

\`avocado clean\` removes the project's container volumes by default. To clear
only the build stamps and lock entries for a target, keep the volume:

\`\`\`bash
avocado clean --skip-volumes --stamps --unlock -C avocado.yaml --target <target>
\`\`\`

Then run \`avocado install\` and \`avocado build\`.
`;
