export const URI = "avocado://skills/extensions-and-runtimes";
export const NAME = "extensions-and-runtimes";
export const DESCRIPTION =
  "Conceptual model for sysext / confext / runtimes / overlays — what an extension actually is, how runtimes compose them, and how this maps to systemd-sysext on the device. Read this when the user asks about extensions or runtimes, or before invoking add-extension / add-runtime.";

export const CONTENT = `# Extensions and runtimes

Avocado OS is built around two ideas: **extensions** (modular pieces of functionality) and **runtimes** (named compositions of extensions for a specific use case).

## Extensions

An extension is a sealed, signed image that gets merged into the running filesystem at boot via systemd-sysext / systemd-confext. Two flavors:

- **\`sysext\`** — extends \`/usr/\` and \`/opt/\`. Use for application binaries, libraries, systemd service files, kernel modules.
- **\`confext\`** — extends \`/etc/\`. Use for configuration files, user accounts, network settings, service configs.

An extension can be **both** at once — declare \`types: [sysext, confext]\`. Most application extensions are.

Extensions can be sourced three ways:

1. **From the package repo** — \`source: { type: package, version: "*" }\`. e.g. \`avocado-ext-dev\`, BSP extensions.
2. **From a local definition in this \`avocado.yaml\`** — declared inline with \`types\`, \`packages\`, \`overlay\`. This is how you ship your own app.
3. **From a git repo or local path** — \`source: { type: git, url: ..., ref: ... }\` or \`source: { type: path, path: ... }\`. Useful for sharing extensions across projects.

## Runtimes

A runtime is a named combination of extensions that go on the device together. Most projects have at least these:

- \`dev\` — engineering runtime: includes SSH, debugging tools, your app. \`avocado-ext-dev\` + \`avocado-ext-sshd-dev\` + BSP + app.
- \`prod\` — production: stripped of dev tooling. Just the app, BSP, and required runtime packages.
- \`factory\` (optional) — manufacturing runtime: end-of-line tests, provisioner, then hands off to \`prod\`.

Runtimes are switchable: same hardware, different image. \`avocado provision -r prod\` puts the prod runtime on the device.

## Overlays

An extension's \`overlay:\` field points to a directory of files that get layered into the extension image. Use this for:

- Compiled binaries from your build pipeline
- Static config files
- systemd service unit files
- Anything the package repo doesn't already supply

Overlay paths are relative to the project root.

## How it maps to the device

At boot, systemd-sysext merges every sysext into \`/usr/\` (and confext into \`/etc/\`) via OverlayFS. The base rootfs is read-only and atomic — sysext/confext images are the only writable layer at the filesystem level, and they're signed (and optionally dm-verity'd) for integrity.

This is why packages must be installed *into an extension*, not just into the root image: the root is sealed.

## The most common pattern

You typically have **one app extension** plus pre-built extensions for dev tooling and BSP. Adding new functionality usually means:

1. Add packages to your app extension (\`add-package-to-extension\`).
2. Drop new files into \`overlays/app/\`.
3. \`avocado build\` → \`avocado provision\`.

You rarely need to create a brand-new extension. When you do (e.g. a separate confext for production config), use \`add-extension\`.
`;
