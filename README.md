# Avocado OS MCP Server

MCP server that turns an AI assistant into a working Avocado OS co-pilot. It helps a user:

- Pick the right hardware target
- Scaffold a project — reference-first when one matches the user's task, or a minimal `avocado.yaml` when none does
- Search and describe packages in the live RPM feed; feed-first is the default for adding any library
- Author and validate `avocado.yaml` against a bundled JSON Schema (no schema-version drift)
- Browse, read, and copy from reference projects (full source — `avocado.yaml`, app code, overlays, build hooks)
- First-time provision a device, then push iterative updates via `avocado deploy` — no reflash required
- Diagnose `avocado build` / `avocado provision` failures; honest fallback when no pattern matches (no empty diagnoses)
- Look up per-target provisioning steps, with headless commands for LLM-driven runs
- Debug a running device over UART/USB via a long-lived tmux session (default), or SSH once the device is healthy
- Run closed-loop debugging: read logs, edit code or extensions to add logging, redeploy, re-verify

Stdio-only over npm. No hosted endpoint, no API key. All data sources are public:
`repo.avocadolinux.org`, `github.com/avocado-linux/references`, `docs.peridio.com`. The `avocado.yaml` schema ships bundled with the server.

> **Safety:** this server lets an AI assistant run real operations on your
> behalf — editing project files and running `avocado` commands that can flash
> media and provision/update devices. It is arbitrary code execution: review
> actions before approving them, work in version control, and run with scoped
> credentials. See [SECURITY.md](./SECURITY.md).

## Installation

Add to your MCP client config (Claude Desktop, Claude Code, Cursor, etc.):

```json
{
  "mcpServers": {
    "avocado-os": {
      "command": "npx",
      "args": ["-y", "github:avocado-linux/avocado-mcp"]
    }
  }
}
```

Requires Node ≥20. `npx` will clone the repo on first run, install dependencies, and build it (~30s); subsequent runs are instant from cache. To pin to a specific release, suffix with a tag: `github:avocado-linux/avocado-mcp#5.0.0` (see [GitHub Releases](https://github.com/avocado-linux/avocado-mcp/releases)).

## What it exposes

### Tools

| Tool                         | Purpose                                                                              |
| ---------------------------- | ------------------------------------------------------------------------------------ |
| `environment-check`          | Verify host has `avocado` CLI on PATH, a container engine (avocado-vm on macOS, Docker Engine on Linux), and ≥8 GB free disk. Reports host arch + OS |
| `list-targets`               | Every Avocado target currently supported by the package feed                         |
| `search-packages`            | Substring search across the project's configured RPM feed (`projectDir`), or the default feed |
| `describe-package`           | Detail view for one package: version, arch, summary, description                     |
| `check-package-coverage`     | Batch-check a whole dependency list against one target/stream in a single call; per-dep present/missing verdict + confidence + coverage % (engine behind `/package-coverage`) |
| `search-references`          | Browse or search the reference catalog (omit `query` to browse, pass `query` to rank)|
| `get-reference`              | Full project bundle: file tree, `avocado.yaml`, README, overlay layout, build hooks  |
| `get-reference-file`         | Read a single file from a reference (app source, overlay configs, build scripts)     |
| `get-config-schema`          | Fetch the JSON Schema for `avocado.yaml`                                             |
| `init-project`               | Pick a reference, or give the `avocado init` command and the edits for a new project |
| `validate-yaml`              | Validate an `avocado.yaml` against the CLI schema; ignored keys come back as warnings |
| `add-extension`              | Add a new extension definition to existing YAML                                      |
| `add-runtime`                | Add a new runtime (named composition of extensions) to existing YAML                 |
| `add-package-to-extension`   | Add a verified package to an extension's packages map                                |
| `list-yaml-extensions`       | List extensions defined in a YAML (introspection helper)                             |
| `diagnose-provision-log`     | Analyze `avocado provision` output for known failure patterns                        |
| `explain-build-error`        | Analyze `avocado build` output for known failure patterns                            |
| `get-provisioning-steps`     | Per-target provisioning steps (profile, media, commands, caveats)                    |
| `search-docs`                | Browse or BM25-search the Peridio + Avocado docs at `docs.peridio.com` (omit `query` to browse)|
| `get-doc`                    | Fetch a full documentation page by slug, URL, or repo path                           |
| `detect-serial-ports`        | List USB serial adapters on the host (macOS / Linux) for UART debugging              |
| `get-device-connection-info` | Show UART parameters (baud, voltage, parity), default login, and wiring caveats for a target |
| `get-tmux-uart-snippet`      | Emit copy-paste tmux commands for attaching to a UART and streaming/capturing output |
| `connect-auth-status`        | Check if this machine is logged in to Avocado Connect, and list the user and orgs  |
| `connect-list-resources`     | List Connect orgs, projects, cohorts, or runtimes to get IDs for `connect-init`      |
| `connect-init`               | Run `avocado connect init` to link a project to Connect and add OTA config to a runtime |

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
- `avocado://skills/avocado-cli-execution`
- `avocado://skills/avocado-connect`
- `avocado://skills/upstream-sources`
- `avocado://skills/package-coverage`
- `avocado://skills/container-backend`
- `avocado://skills/feeds-and-lockfile`

### Prompts

Pre-built workflows the user can invoke by name:

- `start-avocado-project` — walks through target pick → init → next-steps for a fresh project.
- `debug-device` — walks through attaching to a device over UART/tmux and capturing logs (the default debug channel).
- `debug-device-ssh` — peer to `debug-device` for the case when the device is already known healthy and on the network. Passwordless root in the dev runtime.
- `debug-build-failure`: recovers from a failed `avocado install` or `avocado build`. Covers log-pattern analysis, cross-channel package lookup, hook-script triage, and host/arch checks.
- `provision-device` — fully automated first-time flash: env check → target validation → per-target caveats → build → provision → physical handoff → first-boot UART verification.
- `build-and-deploy` — fully automated `avocado build && avocado deploy` (with conditional `install` on missing-package errors) to a running device, with verification. The canonical iteration loop after first provision.
- `package-coverage` — for users moving off Docker: ingests a Dockerfile or SBOM (CycloneDX / SPDX) plus a target, extracts runtime dependencies, checks each against the live package feed, researches gaps on the web, and writes a shareable `package-coverage.md` (present/missing table + upstream links + headline coverage %) for an Avocado OS feed maintainer.
- `setup-connect`: links a project to Avocado Connect for fleet OTA updates. It checks auth, picks the org, project, and cohort, runs `avocado connect init`, then gives the user the rebuild steps.

## Recommended flow

For most user requests, the canonical entry point is one of the prompts — they orchestrate the right tool sequence and surface the relevant skills along the way.

- **New to Avocado / fresh project** → `/start-avocado-project`
- **First-time flash of a physical device or QEMU VM** → `/provision-device`
- **Iterating after the first provision (edit → push → verify)** → `/build-and-deploy`
- **A build or install failed** → `/debug-build-failure`
- **Debugging a running device** → `/debug-device` (UART, default) or `/debug-device-ssh` (once known healthy)

When invoked directly without a prompt, the underlying conventions are:

1. **`environment-check`** first when the user is new — pre-empts CLI / Docker / disk problems before they show up later.
2. **`list-targets({ query })`** to resolve user-supplied hardware names to canonical slugs.
3. **`init-project`** with `target` + `task` — searches the reference catalog first; falls back to a minimal starter only when no reference fits.
4. **`add-extension` / `add-runtime` / `add-package-to-extension`** for YAML edits; package additions are verified against the live feed.
5. **`search-packages` / `describe-package`** before adding any library — feed packages beat vendoring / `pip install` / `npm install` on every axis (versioning, security updates, image size).
6. **`validate-yaml`** runs against a JSON Schema bundled with the MCP, so there's no schema-version drift.
7. **`get-provisioning-steps`** emits both human and LLM-shaped commands. LLM-driven runs set `AVOCADO_NONINTERACTIVE=1` and need no TTY wrapper.

If `avocado build` / `install` / `provision` fails, paste the log into `explain-build-error` or `diagnose-provision-log` — they return a curated diagnosis when one fits, and otherwise extract the error lines + file paths + next-step routing rather than returning empty.

To debug a running device, plug in a USB-to-UART adapter and run `detect-serial-ports` → `get-device-connection-info` → `get-tmux-uart-snippet`. UART is the default; SSH (`/debug-device-ssh`) is for steady-state work after UART confirms the device is healthy.

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
npm run inspect
```

Unit tests (`test/**/*.test.ts`, run with `node --test`):

```bash
npm test
```

Format check and type check:

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

- **The package feed** — RPM repodata (targets manifest, `repomd.xml`, `primary.xml.gz`). Used by `list-targets`, `search-packages`, `describe-package`, `check-package-coverage`, `add-package-to-extension`, `explain-build-error`, `init-project`, `get-provisioning-steps`, and reported by `environment-check`. Pass `projectDir` and the feed is resolved the same way avocado-cli resolves it (`src/lib/feed-config.ts`):
  - repo URL: `AVOCADO_REPO_URL` > `AVOCADO_SDK_REPO_URL` > `distro.repo.url` > `sdk.repo_url` > `https://repo.avocadolinux.org`
  - releasever: `AVOCADO_RELEASEVER` > `AVOCADO_SDK_REPO_RELEASE` > `distro.repo.releasever` > `sdk.repo_release` > `{release}/{channel}` from `AVOCADO_DISTRO_RELEASE`/`distro.release` and `AVOCADO_DISTRO_CHANNEL`/`distro.channel`, rewritten to `{release}/{channel}/snapshots/<id>` when the lock file (`avocado.lock`, or the legacy `.avocado/lock.json`) pins a matching `repo-snapshot` for the target
  - TLS: `AVOCADO_REPO_CA` > `distro.repo.ca`; `AVOCADO_REPO_INSECURE` > `distro.repo.tls_verify: false`

  Explicit `release` / `channel` / `repoUrl` tool arguments override all of the above. Without a project the default is `https://repo.avocadolinux.org` `2024/edge`. Multiple releases (`2024`, `2026`) and channels (`next`, `edge`, `stable`) are published and the target set differs per stream, so target validation is done against the feed being queried. Every result states the effective feed, whether the repo URL is overridden, and where each value came from. Env vars are read from the MCP server's own process environment.
- **`github.com/avocado-linux/references`** — full source of every reference project. Used by `get-reference` and `get-reference-file` (fetched via `raw.githubusercontent.com` + GitHub trees API).
- **`github.com/peridio/docs`** — the Docusaurus source for `docs.peridio.com`. Used by `search-docs` and `get-doc`. Trees API for the manifest (cached 1 h), `raw.githubusercontent.com` for content (cached on disk by blob SHA, no TTL — content-addressable).

The `avocado.yaml` JSON Schema comes from `https://docs.peridio.com/schemas/avocado-config.json` (cached for 1 h in memory and on disk). If the fetch fails, the server uses its copy of `avocado-cli/schemas/avocado-config.json`. Set `AVOCADO_MCP_SCHEMA_OFFLINE=1` to always use that copy. CI fails when the copy differs from the live docs copy. Run `npm run sync-schema` to refresh it.

Caches under `~/.cache/avocado-mcp/` (override with `$AVOCADO_MCP_CACHE_DIR` or `$XDG_CACHE_HOME`). Set `GITHUB_TOKEN` for higher GitHub API rate limits if you'll be using the references / docs tools heavily.

## Documentation

- About Avocado OS: https://docs.peridio.com/about
- Developer getting started: https://docs.peridio.com/developer-reference/getting-started
- Hardware support matrix: https://docs.peridio.com/hardware/support-matrix

## Repository links

- References repo: https://github.com/avocado-linux/references
- Package feed: https://repo.avocadolinux.org
- Targets manifest: https://repo.avocadolinux.org/2024/edge/targets.json

## Safety & responsibility

This is an AI-agent tool that executes operations on your behalf. Before using
it, read [SECURITY.md](./SECURITY.md) — it covers the security model, the list
of destructive operations (provisioning flashes and erases media; deploy changes
running devices; project tools write files), and the safeguards you are expected
to apply (review-before-approve, version control, backups, least privilege).

You are responsible for the environment the server runs in and for the actions
you approve.

## License

Licensed under the [Apache License, Version 2.0](./LICENSE). The software is
provided on an "AS IS" basis, without warranties or conditions of any kind, and
without liability for damages arising from its use, to the maximum extent
permitted by law. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
