export const URI = "avocado://skills/references-catalog";
export const NAME = "references-catalog";
export const DESCRIPTION =
  "Map of available Avocado OS reference projects (working starter apps in C, Python, Rust, Node, Elixir, AI, etc.). Read this when the user wants an example to copy from. Use `search-references` (omit `query` to browse the full catalog, pass `query` to rank by relevance) and `get-reference` / `get-reference-file` for live data.";

export const CONTENT = `# References catalog

Reference projects are full, working Avocado OS projects (each with an \`avocado.yaml\`, an app extension, and provisioning instructions) that show how to do something useful. They are the fastest way for a user to get a hands-on result.

## Browsing the catalog

The catalog is **not hardcoded** — it is read live from the repo. Call \`search-references\` with no \`query\` to list every reference (slug, language, hardware, one-line summary), or pass a \`query\` (and optional \`target\`) to rank matches. References span language/framework quickstarts, system & kernel demos, hardware-specific camera/vision runtimes, container patterns, and a minimal \`dev\` starter — read the live list rather than relying on a fixed set of names here.

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

1. \`search-references\` — call with no \`query\` to browse the full catalog, or with a \`query\` (and optional \`target\`) to get ranked matches.
2. \`get-reference\` returns the project bundle: file tree, full \`avocado.yaml\`, README, getting-started, build-hook list, and overlay layout summary.
3. \`get-reference-file\` reads any specific file (app source, overlay configs, build scripts) — use this when you need to see the actual code, not just the structure.

## Important caveats

- **Not every reference works on every target.** Most have target-specific code (e.g. GPU/NPU paths). The catalog's \`hardware\` field lists known-good targets; an empty list means "generic, should work anywhere with the right BSP."
- **Source of truth is github.com/avocado-linux/references.** This MCP fetches directly from there via raw.githubusercontent.com.
- **Adapting a reference for a different target is non-trivial.** For Phase 4 we'll have an \`adapt-reference-for-target\` tool; until then, prefer steering the user to a reference whose hardware list already includes their target.
`;
