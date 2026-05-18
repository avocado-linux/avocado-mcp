export const URI = "avocado://skills/references-catalog";
export const NAME = "references-catalog";
export const DESCRIPTION =
  "Map of available Avocado OS reference projects (working starter apps in C, Python, Rust, Node, Elixir, AI, etc.). Read this when the user wants an example to copy from. Use list-references / search-references / get-reference for live data.";

export const CONTENT = `# References catalog

Reference projects are full, working Avocado OS projects (each with an \`avocado.yaml\`, an app extension, and provisioning instructions) that show how to do something useful. They are the fastest way for a user to get a hands-on result.

## What kinds of references exist

- **Tooling / language quickstarts**: \`python-flask\`, \`python-mqtt\`, \`python-gstreamer-yolo\`, \`python-whisper\`, \`nodejs-dashboard\`, \`react-dashboard\`, \`java-hello\`, \`elixir-phoenix\`, \`rust-vitals\`, \`shell-heartbeat\`, \`webkit-ui\`, \`cpp-tui-dashboard\`.
- **System / kernel demos**: \`linux-custom-kernel\`, \`c-gpio\`, \`rubicon\`.
- **Hardware-specific**: \`icam-540\` (Advantech AI camera), \`qemu-quickstart\` (no hardware).
- **Meta**: \`dev\` (development-runtime walkthrough).

## Layout of every reference

Each reference is a top-level directory in \`github.com/avocado-linux/references\` with the same shape:

\`\`\`
<slug>/
  README.md
  getting_started.md
  avocado.yaml          ← the project config; this is what \`init-project\` would produce
  app/
    <source code>       ← e.g. server.js, server.py, Cargo.toml
    overlay/            ← files layered into the extension; mirrors / on the target
      etc/...
      usr/...
  app-clean.sh          ← build hooks the SDK runs at named stages
  app-compile.sh
  app-install.sh
\`\`\`

The \`overlay/\` tree is the most important thing to understand: anything under \`app/overlay/\` ends up at the corresponding path on the running device (so \`app/overlay/usr/lib/systemd/system/app.service\` becomes \`/usr/lib/systemd/system/app.service\` after boot).

## How to surface a reference to the user

1. \`list-references\` (no args) shows the full catalog with one-liner descriptions.
2. \`search-references\` narrows by free-text or target.
3. \`get-reference\` returns the project bundle: file tree, full \`avocado.yaml\`, README, getting-started, build-hook list, and overlay layout summary.
4. \`get-reference-file\` reads any specific file (app source, overlay configs, build scripts) — use this when you need to see the actual code, not just the structure.

## Important caveats

- **Not every reference works on every target.** Most have target-specific code (e.g. GPU/NPU paths). The catalog's \`hardware\` field lists known-good targets; an empty list means "generic, should work anywhere with the right BSP."
- **Source of truth is github.com/avocado-linux/references.** This MCP fetches directly from there via raw.githubusercontent.com.
- **Adapting a reference for a different target is non-trivial.** For Phase 4 we'll have an \`adapt-reference-for-target\` tool; until then, prefer steering the user to a reference whose hardware list already includes their target.
`;
