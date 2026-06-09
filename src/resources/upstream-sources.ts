export const URI = "avocado://skills/upstream-sources";
export const NAME = "upstream-sources";
export const DESCRIPTION =
  "Catalog of the open-source repos in `github.com/avocado-linux` (and related). The MCP only directly integrates with `references` (via `get-reference` / `search-references`) and the docs site (via `search-docs` / `get-doc`). For everything else — CLI source, the stone image bundler, the Yocto distro layer, per-extension implementations, per-target BSPs — you reach into the repo with your Bash tool (`gh` / `git clone` / `curl raw.githubusercontent.com/...`). **Critical guardrail:** the meta-layer repos (`meta-avocado`, every `bsp-*`, `vendor-openembedded-core`) are the internal Yocto build pipeline — read-only reference, NOT user-consumable layers. Users do NOT fork these; their modification surface is `avocado.yaml` + the project's `app/` + feed packages, never a private Yocto layer. Read this skill whenever you need to verify CLI behavior, look up flag semantics, understand how an extension is actually packaged, find the source of an error message, OR before proposing any kind of fork-and-rebuild move against an avocado-linux repo (the answer is almost always 'don't').";

export const CONTENT = `# Upstream open-source sources

The MCP wraps two repos directly (\`references\` and the docs site). The Avocado ecosystem is much bigger than that — 50+ public repos under \`github.com/avocado-linux\`. When you need ground truth that isn't in the docs or the references, those repos are where you go.

**You access them with your own tools — \`Bash\` with \`gh\`, \`git\`, \`curl\`. The MCP doesn't proxy GitHub for you.** That's intentional: these are read-as-needed, not part of the per-session grounding.

## When to consult this skill

- A CLI invocation behaves differently from what you expect, or you can't remember the exact flag — go to \`avocado-cli\`.
- An error message contains a path or string that doesn't match docs or feed content — \`grep\` for the literal string across the relevant repo.
- A user asks "why does \`avocado <X>\` do Y?" or "what's actually in the \`dev\` extension?" — go to the source.
- A build fails inside a tool the CLI shells out to (\`stone\`, etc.) — that tool has its own repo.
- A BSP-specific question (kernel options, default cmdline, partitioning) — go to the per-target \`bsp-*\` repo.

## ⚠️ Critical guardrail — meta-layer repos are read-only reference, NOT user-consumable Yocto layers

\`meta-avocado\`, every \`bsp-*\` repo, and \`vendor-openembedded-core\` are **the Yocto / OpenEmbedded layers used internally to build the packages that ship in the Avocado package feed**. They exist so the build pipeline can produce \`avocado-bsp-raspberrypi4\`, \`avocado-ext-dev\`, kernel binaries, etc., and publish them to \`repo.avocadolinux.org\`.

**Users do NOT consume these by forking + building themselves.** If you are tempted to recommend any of the following, STOP — these are anti-patterns:

| ❌ Anti-pattern | ✅ What the user should do instead |
|---|---|
| Fork \`bsp-raspberrypi4\` and modify the kernel config | Add the change to their own extension (with a kernel-module recipe), or file an upstream issue if it belongs in the BSP itself |
| Add \`meta-avocado\` to a personal \`bblayers.conf\` and run \`bitbake\` against it | Use the published packages from the feed (\`search-packages\` / \`add-package-to-extension\`) — that's the whole point of the feed |
| Clone \`bsp-jetson-orin-nano-devkit\` to "rebuild" the BSP locally | The BSP packages are already built and in the feed; if a specific package version needs updating, file an upstream issue or pin in \`avocado.yaml\` |
| Vendor \`meta-avocado\` recipes into a project | Project changes belong in \`avocado.yaml\` + the project's \`app/\` overlay tree, NOT in a private Yocto layer |
| "Modify and rebuild the BSP" as a debug step | Almost never the right move at the user level — use the references' patterns and \`avocado deploy\` for iteration |

**The supported user-modification surfaces are:**

1. **\`avocado.yaml\`** — runtimes, extensions, packages, distro release/channel, the SDK image, etc.
2. **The project's \`app/\` directory** — application source, overlays, hook scripts.
3. **The references repo** — fork a reference and modify your fork if you want a starting-point project that's beyond what the catalog covers.

**Treat the meta repos as documentation-grade reference only.** You can read them to *explain* something (what packages a BSP includes, what kernel option enables a driver, what an SDK env var resolves to), but the user's path to a different outcome is always through their own \`avocado.yaml\` + extensions + the feed — never through forking the meta layer. If a meta-layer change is the only fix, that's an upstream issue to file at the appropriate repo, not a user-side patch.

## How to fetch

\`curl\` and \`git\` are required (almost always pre-installed). \`gh\` (the GitHub CLI) is convenient for search but optional — every \`gh\` example below has a \`curl\` fallback.

### Detect what's available first

\`\`\`bash
command -v gh && echo "gh: yes" || echo "gh: no (use curl fallbacks)"
command -v git && echo "git: yes" || echo "git: no"
\`\`\`

### Single file (always use this when you know the path — cheapest option)

\`\`\`bash
# Public file, no auth. Works for everything in avocado-linux/* and peridio/*.
curl -sL https://raw.githubusercontent.com/avocado-linux/<repo>/main/<path> | head -100
\`\`\`

### Directory listing

\`\`\`bash
# With gh:
gh api repos/avocado-linux/<repo>/contents/<path> --jq '.[].name'

# Without gh (curl + GitHub REST API):
curl -sL https://api.github.com/repos/avocado-linux/<repo>/contents/<path> \\
  | python3 -c 'import json,sys; [print(e["name"]) for e in json.load(sys.stdin)]'
\`\`\`

### Code search across a single repo (substring match)

\`\`\`bash
# With gh:
gh api -X GET search/code -f q='<query> repo:avocado-linux/<repo>' --jq '.items[].path' | head

# Without gh — use the GitHub search API directly. URL-encode the query.
QUERY='<query>+repo:avocado-linux/<repo>'
curl -sL "https://api.github.com/search/code?q=$QUERY" \\
  | python3 -c 'import json,sys; [print(i["path"]) for i in json.load(sys.stdin).get("items", [])]' \\
  | head
\`\`\`

### Code search across the entire org

\`\`\`bash
# With gh:
gh api -X GET search/code -f q='<query> org:avocado-linux' \\
  --jq '.items[] | .repository.name + ":" + .path' | head

# Without gh:
QUERY='<query>+org:avocado-linux'
curl -sL "https://api.github.com/search/code?q=$QUERY" \\
  | python3 -c 'import json,sys; [print(i["repository"]["name"]+":"+i["path"]) for i in json.load(sys.stdin).get("items", [])]' \\
  | head
\`\`\`

**Important caveat for both \`gh\` and \`curl\` search:** GitHub's code-search API requires authentication for cross-org queries. The \`gh\` CLI handles this automatically once the user has run \`gh auth login\`. Plain \`curl\` against \`/search/code\` will fail with 401 / 422 / rate-limit errors **without** a token. Two ways to authenticate:

- Pass a personal access token: \`curl -H "Authorization: Bearer $GITHUB_TOKEN" ...\`
- Tell the user to run \`brew install gh && gh auth login\` (macOS) or \`sudo apt install gh && gh auth login\` (Debian/Ubuntu)

If neither is available, **fall back to direct \`curl\` of \`raw.githubusercontent.com\`** with paths you can guess from the repo's README or your training-data priors. Most lookups (specific recipe files, hook scripts, kernel configs) have predictable paths.

### Broader exploration (rare)

\`\`\`bash
# Clone, read, throw away. Use a tmp dir.
git clone --depth 1 https://github.com/avocado-linux/<repo> /tmp/<repo> && cd /tmp/<repo>
\`\`\`

\`git clone\` works without \`gh\` and without auth for public repos. Use this when you need to grep across many files in a single repo and don't have search-API access.

**Rules of thumb:**
- Single file with known path → \`curl raw.githubusercontent.com\` (always works, no auth).
- Listing or search → \`gh\` if available, else authenticated \`curl\` to the REST API, else \`git clone --depth 1 + grep\`.
- Never sit and wait on a hung lookup — if \`gh\` isn't there and \`curl\` rate-limits without a token, switch to \`git clone\` immediately rather than retrying.

## The catalog

### Core tooling

| Repo | What it is | Consult when |
|---|---|---|
| [\`avocado-cli\`](https://github.com/avocado-linux/avocado-cli) | The CLI itself — every \`avocado <subcommand>\` you and the user run | Verifying flag names / semantics, debugging an error message you don't recognize, confirming the actual default for a knob, understanding subcommand exit codes |
| [\`stone\`](https://github.com/avocado-linux/stone) | The image bundler the CLI shells out to during \`avocado build\` (\`stone bundle\` produces \`os-bundle.aos\`) | Build failures with errors mentioning \`stone\`, stone manifests, or paths under \`<output>/stone/\` |
| [\`meta-avocado\`](https://github.com/avocado-linux/meta-avocado) | The Yocto / OpenEmbedded distro layer that **builds** the packages shipped in the feed (recipes, image classes, distro config). **Read-only reference — NOT a layer users fork or add to their own \`bblayers.conf\`** (see guardrail section above). | Understanding what \`sdk.packages\` actually installs, finding a recipe for a feed package, tracing how an SDK env var (\`OECORE_*\`, \`AVOCADO_BUILD_EXT_SYSROOT\`, etc.) is set |
| [\`microclaw\`](https://github.com/avocado-linux/microclaw) | The in-VM agent that drives the avocado-cli on the desktop side. Referenced by \`avocado://skills/avocado-cli-execution\` | Working in the \`host-tool\` execution channel and needing to understand what the host MCP is actually doing |
| [\`prserv\`](https://github.com/avocado-linux/prserv) | Package revision server. Internal — explains version pinning behavior. | Diagnosing surprising package-revision behavior; usually not needed |

### Reference projects (already integrated)

| Repo | What it is | Consult via |
|---|---|---|
| [\`references\`](https://github.com/avocado-linux/references) | The reference catalog. Each top-level dir is a working starter project. | \`search-references\` / \`get-reference\` / \`get-reference-file\` MCP tools — NOT direct fetch |

### Extensions (\`ext-*\`)

These are the \`avocado-ext-<name>\` packages that runtimes pull in. Each repo has an \`avocado.yaml\`-style packaging, an overlay tree, and any hook scripts. **15 repos at writing time, naming pattern \`ext-<name>\`.**

| Repo | Provides |
|---|---|
| [\`ext-dev\`](https://github.com/avocado-linux/ext-dev) | The \`dev\` extension — debug tooling, common diagnostics |
| [\`ext-sshd\`](https://github.com/avocado-linux/ext-sshd) / [\`ext-sshd-dev\`](https://github.com/avocado-linux/ext-sshd-dev) | OpenSSH server. \`-dev\` variant adds passwordless root for development |
| [\`ext-docker\`](https://github.com/avocado-linux/ext-docker) / [\`ext-podman\`](https://github.com/avocado-linux/ext-podman) | Container engines for on-device workloads |
| [\`ext-webkit\`](https://github.com/avocado-linux/ext-webkit) | WPE WebKit + display utilities for kiosk / HMI |
| [\`ext-cockpit\`](https://github.com/avocado-linux/ext-cockpit) | Cockpit web-based system administration UI |
| [\`ext-microclaw\`](https://github.com/avocado-linux/ext-microclaw) | On-device microclaw agent — only relevant in the desktop / VM flow |
| [\`ext-jtop\`](https://github.com/avocado-linux/ext-jtop) | Jetson system monitoring |
| [\`ext-ca-certificates\`](https://github.com/avocado-linux/ext-ca-certificates) | Trusted CA bundle |
| [\`ext-kmod-v4l2loopback\`](https://github.com/avocado-linux/ext-kmod-v4l2loopback) | V4L2 loopback kernel module |

**Consult when** the user asks what an extension actually does, or you suspect a behavior change between extension versions.

Browse the full list:

\`\`\`bash
gh api orgs/avocado-linux/repos --paginate --jq '.[] | select(.name | startswith("ext-")) | .name'
\`\`\`

### Board support packages (\`bsp-*\`)

Per-target BSP repos. Each one is a **meta-layer used internally to build** the kernel binaries, device-tree blobs, bootloader bits, and \`avocado-bsp-<target>\` packages that ship in the feed. **~29 repos, naming pattern \`bsp-<target-slug>\`.**

**Same guardrail as \`meta-avocado\` applies — these are read-only reference, NOT user-consumable Yocto layers.** A user does not fork a BSP repo to build a custom kernel; they consume the already-built BSP package from the feed via \`avocado-bsp-<target>\` in their \`avocado.yaml\`. If a kernel option needs to flip for their use case, that's an upstream issue against the BSP repo, not a private fork.

The slug matches the canonical target slug (e.g. \`bsp-raspberrypi4\` → target \`raspberrypi4\`).

Browse:

\`\`\`bash
gh api orgs/avocado-linux/repos --paginate --jq '.[] | select(.name | startswith("bsp-")) | .name'
\`\`\`

**Consult when** the user needs an *explanation* of target-specific behavior — "why does my rpi4 boot with this kernel cmdline?", "what BSP packages does \`jetson-orin-nano-devkit\` ship?", "what's enabled in the default kernel config?" — NOT when they want to modify the BSP. Modifications happen at the project layer (extensions + overlays), or upstream via an issue / PR if the change belongs in the BSP itself.

### Other

| Repo | What it is |
|---|---|
| [\`avocado-os\`](https://github.com/avocado-linux/avocado-os) | The composed Avocado OS extension repo. Mostly metadata. |
| [\`vendor-openembedded-core\`](https://github.com/avocado-linux/vendor-openembedded-core) | Vendor fork of OpenEmbedded-core, used in the internal build pipeline. **Same read-only guardrail as \`meta-avocado\` and \`bsp-*\` — NOT a layer users fork.** Rare; for tracing upstream Yocto class behavior. |
| [\`avocado-config\`](https://github.com/avocado-linux/avocado-config) | **TOML config schema only — NOT used by this MCP.** The MCP bundles its own YAML schema. Ignore unless you're investigating the TOML config format specifically. |

## Anti-patterns

- **Don't recommend forking \`meta-avocado\` or any \`bsp-*\` for user-side modification.** See the guardrail section above. The user's modification surface is \`avocado.yaml\` + extensions + the feed — never a private Yocto layer.
- **Don't fetch a whole repo to answer a small question.** Use \`curl raw.githubusercontent.com\` or \`gh api search/code\` for the specific file or substring you need.
- **Don't treat any of these as stable public APIs.** Internal interfaces can change between versions. Cite what you read with the commit SHA you read it at if it matters for the user.
- **Don't propose changes to these repos in your own response.** If the user wants to file an issue or PR, they do that themselves; you can suggest where it would go.
- **Don't use the MCP's docs-search for these.** \`search-docs\` only indexes \`peridio/docs\` — it won't find anything in \`avocado-linux/*\` source. Use \`gh api search/code\` instead.

## Why this isn't a tool

The MCP wraps \`references\` and \`peridio/docs\` because each is a curated, schema-coherent surface the LLM uses frequently and where uniform tooling adds value. The repos catalogued here are heterogeneous — different shapes, varying relevance per session. Wrapping all of them would duplicate the \`gh\`/\`curl\` access you already have, with no leverage gain. The right interface is "the LLM knows the catalog exists and how to reach into it directly."
`;
