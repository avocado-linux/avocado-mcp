# Avocado OS MCP Server

MCP server that turns an AI assistant into a working Avocado OS co-pilot. It helps a user:

- Pick the right hardware target
- Initialize a working `avocado.yaml` from a clean slate
- Search and describe packages in the live RPM feed
- Author and validate YAML safely (schema-checked, package-verified)
- Browse, read, and copy from reference projects (full source — `avocado.yaml`, app code, overlays, build hooks)
- Diagnose `avocado build` / `avocado provision` failures
- Look up per-target provisioning steps
- Debug a running device over UART/USB via a long-lived tmux session

Stdio-only over npm. No hosted endpoint, no API key. All data sources are public:
`repo.avocadolinux.org`, `github.com/avocado-linux/avocado-config`,
`github.com/avocado-linux/references`, `docs.peridio.com`.

## Installation

Add to your MCP client config (Claude Desktop, Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "avocado-os": {
      "command": "npx",
      "args": ["-y", "avocado-os-mcp-server"]
    }
  }
}
```

Requires Node ≥18. `npx` will fetch the package on first use and cache it.

## What it exposes

### Tools

| Tool                         | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `environment-check`          | Verify host has `avocado` CLI, Docker daemon, and ≥8 GB free disk space              |
| `list-targets`               | Every Avocado target currently supported by the package feed                         |
| `search-packages`            | Substring search across the live RPM feed (optionally scoped to release/channel)     |
| `describe-package`           | Detail view for one package: version, arch, summary, description                     |
| `list-references`            | Catalog of starter reference projects (Python, Rust, C, Node, Elixir, etc.)          |
| `search-references`          | Free-text search across the reference catalog                                        |
| `get-reference`              | Full project bundle: file tree, `avocado.yaml`, README, overlay layout, build hooks  |
| `get-reference-file`         | Read a single file from a reference (app source, overlay configs, build scripts)     |
| `get-config-schema`          | Fetch the JSON Schema for `avocado.yaml`                                             |
| `init-project`               | Generate a starter `avocado.yaml` for a target (validated against schema)            |
| `validate-yaml`              | Validate an `avocado.yaml` against the current schema                                |
| `add-extension`              | Add a new extension definition to existing YAML                                      |
| `add-runtime`                | Add a new runtime (named composition of extensions) to existing YAML                 |
| `add-package-to-extension`   | Add a verified package to an extension's packages map                                |
| `list-yaml-extensions`       | List extensions defined in a YAML (introspection helper)                             |
| `diagnose-provision-log`     | Analyze `avocado provision` output for known failure patterns                        |
| `explain-build-error`        | Analyze `avocado build` output for known failure patterns                            |
| `get-provisioning-steps`     | Per-target provisioning steps (profile, media, commands, caveats)                    |
| `search-docs`                | Full-text BM25 search across the Peridio + Avocado docs at `docs.peridio.com`        |
| `get-doc`                    | Fetch a full documentation page by slug, URL, or repo path                           |
| `list-docs`                  | Catalog of every docs page (titles + URLs), optionally filtered by section           |
| `detect-serial-ports`        | List USB serial adapters on the host (macOS / Linux) for UART debugging              |
| `get-device-connection-info` | Show recommended baud/parity for a target plus the tmux session name to use          |
| `get-tmux-uart-snippet`      | Emit copy-paste tmux commands for attaching to a UART and streaming/capturing output |

### Skills (resources)

Background knowledge the LLM reads to ground itself before invoking tools:

- `avocado://skills/getting-started`
- `avocado://skills/hardware-catalog`
- `avocado://skills/references-catalog`
- `avocado://skills/config-yaml-guide`
- `avocado://skills/extensions-and-runtimes`
- `avocado://skills/filesystem-model`
- `avocado://skills/avocado-runtime-details`
- `avocado://skills/device-debugging`
- `avocado://skills/tmux-uart-bridge`
- `avocado://skills/extension-build-debugging`
- `avocado://skills/iterative-deployment`
- `avocado://skills/app-development`

### Prompts

Pre-built workflows the user can invoke by name:

- `start-avocado-project` — walks through target pick → init → next-steps for a fresh project.
- `debug-device` — walks through attaching to a device over UART/tmux and capturing logs.
- `debug-build-failure` — recovery walkthrough for failed `avocado install` / `avocado build`: known-issues triage, cross-channel package lookup, host/arch checks.
- `build-and-deploy` — fully automated `avocado install -f && avocado build && avocado deploy` to a running device, with verification. The canonical iteration loop after first provision.

## Recommended flow

The schema-first, package-verified pattern is non-negotiable. When generating or modifying YAML, the canonical order is:

1. **Read context** — let Claude consult `getting-started` and `config-yaml-guide` skills first.
2. **`get-config-schema`** — pull the schema so structure decisions are grounded.
3. **`list-targets`** to pick a target from user requirements.
4. **`init-project`** to scaffold, or **`add-extension` / `add-runtime` / `add-package-to-extension`** to edit.
5. **`search-packages` / `describe-package`** before every package add — never invent names.
6. **`validate-yaml`** before handing back a final YAML.
7. **`get-provisioning-steps`** when telling the user how to flash.

If a build or provision fails, paste the log into `explain-build-error` or `diagnose-provision-log`.

To debug a running device, plug in a USB-to-UART adapter and run `detect-serial-ports` → `get-device-connection-info` → `get-tmux-uart-snippet`.

## Development

```bash
git clone https://github.com/avocado-linux/avocado-mcp.git
cd avocado-mcp
npm install
npm run build
npm run dev
```

Run against the MCP Inspector (browser UI for poking individual tools):

```bash
npm run test
```

Type-check, format-check, build:

```bash
npm run checks
```

End-to-end checks (mirrors CI):

```bash
./scripts/checks.sh
```

### Test against a real Claude client

Point either Claude Desktop or Claude Code at your local build instead of npm.

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or the equivalent on Windows/Linux:

```json
{
  "mcpServers": {
    "avocado-os-dev": {
      "command": "node",
      "args": ["/absolute/path/to/avocado-mcp/build/index.js"]
    }
  }
}
```

Then quit and reopen Claude Desktop.

**Claude Code** — register the local build under a separate name from the published server so they don't collide:

```bash
claude mcp add avocado-os-dev -- node /absolute/path/to/avocado-mcp/build/index.js
```

In either client you can verify it picked up by asking, e.g., _"Start a new Avocado OS project for a Raspberry Pi 5"_ — Claude should invoke the `start-avocado-project` prompt or call `list-targets` → `init-project` directly.

When you change source files, run `npm run build` again and restart the client (Desktop) or run `claude mcp restart avocado-os-dev` (Code).

## How it talks to the world

The server reads from public HTTPS endpoints only:

- **`repo.avocadolinux.org`** — RPM repodata (targets manifest, `repomd.xml`, `primary.xml.gz`). Used by `list-targets`, `search-packages`, `describe-package`, `add-package-to-extension`. Defaults to release `2024`, channel `edge` (matching the current docs site); both are overridable per-call.
- **`github.com/avocado-linux/avocado-config`** — JSON Schema for `avocado.yaml`. Used by `get-config-schema`, `validate-yaml`, every YAML-mutation tool.
- **`github.com/avocado-linux/references`** — full source of every reference project. Used by `get-reference` and `get-reference-file` (fetched via `raw.githubusercontent.com` + GitHub trees API).
- **`github.com/peridio/docs`** — the Docusaurus source for `docs.peridio.com`. Used by `search-docs`, `get-doc`, and `list-docs`. Trees API for the manifest (cached 1 h), `raw.githubusercontent.com` for content (cached on disk by blob SHA, no TTL — content-addressable).

Caches under `~/.cache/avocado-mcp/` (override with `$AVOCADO_MCP_CACHE_DIR` or `$XDG_CACHE_HOME`). Set `GITHUB_TOKEN` for higher GitHub API rate limits if you'll be using the references / docs tools heavily.

## Documentation

- About Avocado OS: https://docs.peridio.com/about
- Developer getting started: https://docs.peridio.com/developer-reference/getting-started
- Hardware support matrix: https://docs.peridio.com/hardware/support-matrix

## Repository links

- Schema repo: https://github.com/avocado-linux/avocado-config
- References repo: https://github.com/avocado-linux/references
- Package feed: https://repo.avocadolinux.org
- Targets manifest: https://repo.avocadolinux.org/2024/edge/targets.json
