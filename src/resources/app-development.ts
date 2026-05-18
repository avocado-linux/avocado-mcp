export const URI = "avocado://skills/app-development";
export const NAME = "app-development";
export const DESCRIPTION =
  "How to structure feature/application development on Avocado OS: where to put source code, configs, services, and how to add libraries. **Core rule: when adding any library or dependency, search the package feed FIRST.** Bundled / vendored dependencies are a fallback, not the default. Read this BEFORE proposing `pip install` / `npm install` / `cargo add` / `apt install` / etc. — the right move is almost always to call `search-packages` for the user's target and add the matching feed package to the extension.";

export const CONTENT = `# Application development on Avocado OS

This skill is the guide for the day-to-day work of building features inside an Avocado project: project layout, where each kind of file lives, and — most importantly — how to add libraries the right way.

## The most important rule: feed-first for every library

> **Before suggesting any library / dependency / package to a user, call \`search-packages\` against their target. If it's in the feed, add it to \`extensions.<name>.packages\` (or use \`add-package-to-extension\`). Only vendor / bundle / language-package-manager-install when the feed genuinely lacks it.**

Concrete: if the user says "I want to add MQTT to my Python app", do NOT immediately reach for \`pip install paho-mqtt\`. Call \`search-packages({ targets: [<target>], query: "mqtt" })\`, see what's in the feed (commonly \`paho-mqtt\` is available as a system package), and add it via \`add-package-to-extension\`.

### Why feed-first

| Property | Feed package | Vendored / pip-/npm-installed |
|---|---|---|
| Version-tracked across OTAs | ✅ | ❌ (frozen at build time) |
| Dependency-resolved automatically | ✅ DNF handles it | ❌ you're the resolver |
| Security/CVE updates via channel | ✅ | ❌ manual |
| Image size impact | Minimal (shared, deduplicated) | Bloats every extension that bundles it |
| Reproducible | ✅ pinned via avocado-config | Maybe (lockfile-dependent) |
| Cross-compile complexity | None — pre-built for target | Often non-trivial (manylinux, native modules, etc.) |

The package feed is the canonical distribution surface. It's why Avocado has one. Use it.

### When vendoring is the right call

It's not always wrong — these are the legitimate cases:

- **Feed genuinely doesn't have it.** \`search-packages\` returns no match across the target's repos. Then yes, vendor.
- **You need a specific version newer than what the feed has.** Sometimes worth opening a feed request (the right long-term fix) but vendoring is acceptable as a short-term path.
- **It's pure-Python / pure-Node and trivial.** Tiny pure-Python helpers without C extensions don't gain much from feed packaging.
- **It's app-internal code that will never have a downstream consumer.** Your own \`utils/\` directory isn't a "library" in the package sense.

Even when vendoring, prefer:
1. \`pip install <pkg>\` invoked from a build hook (\`app-install.sh\`) so the install happens in the SDK at build time, not on the device at first boot.
2. Vendor into \`app/overlay/usr/lib/python3.<x>/site-packages/\` (or the equivalent) so it ships in the read-only sysext rather than mutating \`/var\` on first run.

## Project layout — where everything lives

A typical Avocado project looks like this:

\`\`\`
my-project/
├── avocado.yaml              # The config — runtimes, extensions, packages
├── app-clean.sh              # (Optional) clean stale build state
├── app-compile.sh            # (Optional) compile your app code in the SDK
├── app-install.sh            # (Optional) stage compiled artifacts into \$DESTDIR
└── app/                      # Your application
    ├── server.py             # or server.js, main.rs, main.c, ...
    ├── package.json          # or requirements.txt, Cargo.toml, Makefile, ...
    └── overlay/              # ← Files baked INTO the extension image
        ├── etc/
        │   └── myapp/
        │       └── config.toml          # static config (read-only on device)
        └── usr/
            ├── bin/                     # binaries staged here at install time
            ├── lib/
            │   └── myapp/               # libraries / runtime files
            └── lib/
                └── systemd/
                    └── system/
                        └── myapp.service   # systemd unit (root unit dir, NOT /etc)
\`\`\`

Read \`avocado://skills/filesystem-model\` for the deep reason the overlay tree mirrors device paths and which paths are writable vs read-only.

## Where each kind of asset goes

| Asset | Lives in | Mechanism |
|---|---|---|
| **System packages** (libgpiod, openssl, python3, nodejs) | \`extensions.<name>.packages\` map in \`avocado.yaml\` | Pulled from the feed by \`avocado install\` |
| **SDK-only packages** (cmake, nativesdk-rust, build-time tools) | \`sdk.packages\` in \`avocado.yaml\` | Pulled into the build container, NOT installed on device |
| **Your app source** | \`app/\` | Compiled by \`app-compile.sh\`, staged by \`app-install.sh\` |
| **Compiled binaries you ship** | \`app/overlay/usr/bin/\` (after install hook stages them) | Baked into the read-only sysext |
| **Static configuration** | \`app/overlay/etc/myapp/...\` | Baked into a confext extension |
| **systemd unit files** | \`app/overlay/usr/lib/systemd/system/\` | ALWAYS the root unit dir, NEVER \`/etc/systemd/system/\` (overlay paths must mirror device paths exactly) |
| **systemd unit overrides / drop-ins** | \`app/overlay/etc/systemd/system/<unit>.d/<override>.conf\` | confext |
| **Default \`/var\` content (config seeds, certs, default databases)** | Seeded via \`runtimes.<name>.var_files: [{source, dest}, ...]\` | Copied into the var image at build time |
| **Pre-pulled Docker images for offline boot** | \`extensions.<name>.docker_images: [{image, tag}, ...]\` | Pulled at build time into \`/var/lib/docker\` |
| **Anything writable at runtime** | \`/var/\` on the device (not in the sysext) | Created at first boot OR seeded via \`var_files\` |

The two most common mistakes:

1. **Putting writable state in the sysext** — \`app-install.sh\` writes to \`/var/lib/myapp/\` directly. **Wrong** — \`/var\` is excluded from the sysext. Either seed via \`runtimes.<name>.var_files\` or let the app create it on first run. See \`extension-build-debugging\` for the \`var_files\` exclusion pattern.
2. **Putting systemd units in \`app/overlay/etc/systemd/system/\`** — that's the override directory, not the unit definition directory. Default unit files go in \`/usr/lib/systemd/system/\`. Use the override path only for drop-in fragments.

## Adding a library — the canonical workflow

1. **Identify what the user actually needs.** "MQTT support" → look for an MQTT client library. "Send email" → look for an SMTP library or \`msmtp\`.
2. **Search the feed for the user's target.** \`search-packages({ targets: ["<target>"], query: "<name-or-keyword>" })\`. Try a few synonyms — package names vary (\`paho-mqtt\` vs \`python3-paho-mqtt\` vs \`mosquitto-clients\`).
3. **If a feed match exists:** verify the exact name with \`describe-package\` and add it via \`add-package-to-extension\` (or hand-edit and re-run \`avocado install\`). Done.
4. **If no feed match:** tell the user it isn't in the feed and propose the vendoring approach. Two flavours:
   - **Language package manager in build hook.** For Python: \`pip install --target=\$DESTDIR/usr/lib/python3.<x>/site-packages <pkg>\` in \`app-install.sh\`. For Node: \`npm ci --omit=dev\` then copy \`node_modules/\` into overlay. For Rust: \`cargo build --release\` then copy the binary.
   - **Vendor into overlay.** \`git clone\` or download release, build at hook time, install artifacts into \`\$DESTDIR\` under the right overlay paths.
5. **Verify on device after deploy.** \`rpm -q <pkg>\` for feed packages; \`which <bin>\` or runtime smoke for vendored.

The \`add-package-to-extension\` tool enforces step 2 automatically — it rejects packages not in the feed with a "did you mean" suggestion list — so use it whenever possible.

## Language-specific notes

### Python

- Feed convention: many Python packages are exposed as system packages prefixed \`python3-\` (e.g. \`python3-paho-mqtt\`, \`python3-flask\`). Some keep upstream names (\`paho-mqtt\`).
- Always \`search-packages\` with the bare upstream name AND \`python3-\` prefixed.
- If pip-installing in a hook: \`pip install --no-cache-dir --target="$DESTDIR/usr/lib/python3.13/site-packages" <pkg>\` (adjust python3.<x> to match the SDK's Python).
- \`nativesdk-uv\` is in the feed for fast pip installs in hooks.

### Node.js

- Feed convention: \`nodejs-<name>\` for system npm packages, plus standalone packages.
- Vendoring path: \`app-install.sh\` runs \`npm ci --omit=dev --prefix \$DESTDIR/usr/lib/myapp\`, then your service runs \`node /usr/lib/myapp/server.js\`.
- For npm packages with native extensions: requires the SDK's Node + headers (\`nativesdk-nodejs\`, \`nativesdk-nodejs-npm\`).

### Rust

- Feed convention: \`nativesdk-rust\` and \`nativesdk-cargo\` for the build toolchain; \`libstd-rs\` / \`libstd-rs-dev\` for target libstd.
- Build pattern (\`app-compile.sh\`): \`cargo build --release --target=<triple>\` using the SDK's cross-compiler.
- See the \`rust-vitals\` reference for a full working example.

### C / C++

- Feed has the common library set: \`libgpiod\`, \`openssl\`, \`curl\`, \`zlib\`, etc., plus their \`-dev\` counterparts in the SDK.
- Use \`pkg-config\` (already on the SDK PATH) to find headers/libs. The SDK's \`$PKG_CONFIG_PATH\` is pre-set.
- See \`c-gpio\` (meson) and \`cpp-tui-dashboard\` (cmake) for build hook patterns.

## Read the references before writing from scratch

For most app shapes there's already a reference project that demonstrates the right structure. Before authoring a new layout, run \`search-references\` for the language and rough shape ("python web", "node dashboard", "rust telemetry"), then \`get-reference\` on the top hit to see the canonical layout. Even if you scaffold from scratch, mirror the layout of the closest reference rather than inventing one.

## What to discuss with the user up front

When the user is starting feature work, surface these questions early so the project is structured for them, not against them:

- **What language?** Determines which references to crib from, which SDK packages to add.
- **Does it need to write data?** If yes — what path on device? (Will land in \`/var\`.)
- **Does it need network access?** If yes — clients (curl, http libs) or servers (sshd is in dev runtime; for HTTP servers you ship your own).
- **Does it need a systemd unit?** Almost always yes for anything long-running. Plan the overlay path.
- **Are there hardware-specific libraries?** (GPIO, camera, etc.) — these are target-specific feed packages; ensure they're available for the chosen target.
- **Will the app need state seeded at install time?** (TLS certs, default config, container images for offline.) That goes in \`runtimes.<name>.var_files\` or \`extensions.<name>.docker_images\` — see \`avocado://skills/filesystem-model\`.

Get answers to these before scaffolding so the structure fits the feature.
`;
