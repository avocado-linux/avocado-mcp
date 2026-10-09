export const URI = "avocado://skills/upstream-sources";
export const NAME = "upstream-sources";
export const DESCRIPTION =
  "Catalog of the open-source repos in `github.com/avocado-linux` (and related). The MCP only directly integrates with `references` (via `get-reference` / `search-references`) and the docs site (via `search-docs` / `get-doc`). For everything else (CLI source, the stone image bundler, the Yocto distro layer, per-extension implementations, per-target BSPs), you reach into the repo with your Bash tool (`gh` / `git clone` / `curl raw.githubusercontent.com/...`). **Yocto guidance:** most changes never need Yocto. The CLI covers packages, rootfs and initramfs package lists, version pins, and the kernel command line (`kernel.cmdline`, `kernel.cmdline_extra`). Yocto (`bitbake` against a `meta-avocado` checkout) is needed only to change the source of a packaged component, a recipe, or the kernel configuration. Read this skill whenever you need to verify CLI behavior, look up flag semantics, understand how an extension is actually packaged, find the source of an error message, OR before you propose a Yocto rebuild (check the 'What to rebuild' table first).";

export const CONTENT = `# Upstream open-source sources

The MCP wraps two repos directly (\`references\` and the docs site). The Avocado ecosystem is much bigger than that — 50+ public repos under \`github.com/avocado-linux\`. When you need ground truth that isn't in the docs or the references, those repos are where you go.

**You access them with your own tools — \`Bash\` with \`gh\`, \`git\`, \`curl\`. The MCP doesn't proxy GitHub for you.** That's intentional: these are read-as-needed, not part of the per-session grounding.

## When to consult this skill

- A CLI invocation behaves differently from what you expect, or you can't remember the exact flag — go to \`avocado-cli\`.
- An error message contains a path or string that doesn't match docs or feed content — \`grep\` for the literal string across the relevant repo.
- A user asks "why does \`avocado <X>\` do Y?" or "what's actually in the \`dev\` extension?" — go to the source.
- A build fails inside a tool the CLI shells out to (\`stone\`, etc.) — that tool has its own repo.
- A BSP-specific question (kernel options, default cmdline, partitioning) — go to the per-target \`bsp-*\` repo.

## What to rebuild: the CLI or Yocto

\`meta-avocado\`, the \`bsp-*\` repos and \`vendor-openembedded-core\` are the Yocto / OpenEmbedded layers that build the packages in the Avocado feed. The CLI consumes RPMs from the feed. It does not produce them. Most work never touches Yocto. Before you propose a Yocto rebuild, find the change in this table (from the docs guide "Modifying OS components"):

| The user changed | Yocto needed | How |
|---|---|---|
| An extension's declared packages | No | \`extensions.<name>.packages\`, then \`avocado install\` and \`avocado build\` |
| Their own application source | No | Cross-compile in the SDK (build hooks in the project) |
| The rootfs or initramfs package list | No | \`rootfs\` / \`initramfs\` in \`avocado.yaml\` (see the "Customizing the rootfs and initramfs" guide) |
| A published package, to a different published version | No | Pin the version in \`avocado.yaml\`, run \`avocado unlock\` for the scope that holds it, then \`avocado install\` |
| The kernel command line (\`isolcpus\`, \`earlycon\`, and so on) | No | \`kernel.cmdline\` replaces the board command line. \`kernel.cmdline_extra\` appends to it. Use one of the two, not both. A runtime value wins over the top-level value. Then \`avocado build\`. |
| The **source** of a packaged component | **Yes** | \`bitbake <recipe>\` in a \`meta-avocado\` checkout |
| A recipe, bbappend, packagegroup, or machine config | **Yes** | \`bitbake\` |
| Kernel configuration or an in-tree driver | **Yes** | The "Custom kernel" guide |

The rows marked "No" are the common case. The CLI covers them. Do not send the user to Yocto for these.

When Yocto is necessary:

- Rebuild the single recipe, not a full image. \`bitbake <recipe>\` produces the new RPM in \`tmp/deploy/rpm/<arch>/\` of the build.
- Some components (\`avocadoctl\` is one) ship in both the rootfs and the initramfs. A change to runtime behavior needs only the rootfs copy. A change to early boot needs a new initramfs. That is an OS change: \`avocado deploy\` writes it to the inactive A/B slot with the OS bundle, and the device reboots into it. See \`avocado://skills/iterative-deployment\`.
- If only the user's own code must run on the device, cross-compiling in the SDK is faster and needs no Yocto.

Read the full guide with \`get-doc\`: https://docs.peridio.com/developer-reference/modifying-os-components. If a change belongs in a BSP or in \`meta-avocado\` for everyone, suggest an upstream issue or PR at the repo.

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
# Clone into a workspace directory that the user can find later, not /tmp.
# <workspace> is a directory next to the project, not inside it. Ask the user
# if the workspace has no obvious place for it.
git clone --depth 1 https://github.com/avocado-linux/<repo> <workspace>/upstream/<repo>
\`\`\`

\`git clone\` works without \`gh\` and without auth for public repos. Use this when you need to grep across many files in a single repo and don't have search-API access. Keep the clone for later lookups. Tell the user where it is.

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
| [\`meta-avocado\`](https://github.com/avocado-linux/meta-avocado) | The Yocto / OpenEmbedded distro layer that **builds** the packages shipped in the feed (recipes, image classes, distro config). Read it to explain behavior. Build from it only for the "Yocto needed" rows in "What to rebuild" above. | Understanding what \`sdk.packages\` actually installs, finding a recipe for a feed package, tracing how an SDK env var (\`OECORE_*\`, \`AVOCADO_BUILD_EXT_SYSROOT\`, etc.) is set |
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

Users consume the already-built BSP package from the feed through \`avocado-bsp-<target>\` in their \`avocado.yaml\`. A kernel command line change needs only \`kernel.cmdline\` or \`kernel.cmdline_extra\`. A kernel configuration change needs Yocto: see the "Custom kernel" guide and the "What to rebuild" table above.

The slug matches the canonical target slug (e.g. \`bsp-raspberrypi4\` → target \`raspberrypi4\`).

Browse:

\`\`\`bash
gh api orgs/avocado-linux/repos --paginate --jq '.[] | select(.name | startswith("bsp-")) | .name'
\`\`\`

**Consult when** the user needs an *explanation* of target-specific behavior, for example "why does my rpi4 boot with this kernel cmdline?", "what BSP packages does \`jetson-orin-nano-devkit\` ship?", or "what's enabled in the default kernel config?". For a change, use the "What to rebuild" table above first.

### Other

| Repo | What it is |
|---|---|
| [\`avocado-os\`](https://github.com/avocado-linux/avocado-os) | The composed Avocado OS extension repo. Mostly metadata. |
| [\`vendor-openembedded-core\`](https://github.com/avocado-linux/vendor-openembedded-core) | Vendor fork of OpenEmbedded-core, used in the internal build pipeline. **Same read-only guardrail as \`meta-avocado\` and \`bsp-*\` — NOT a layer users fork.** Rare; for tracing upstream Yocto class behavior. |
| [\`avocado-config\`](https://github.com/avocado-linux/avocado-config) | **Old TOML config schema. NOT used by this MCP.** The \`avocado.yaml\` schema now ships with avocado-cli (\`schemas/avocado-config.json\`). Ignore this repo. |

## Anti-patterns

- **Don't send the user to Yocto for a change the CLI covers.** Packages, rootfs and initramfs package lists, version pins and the kernel command line are all \`avocado.yaml\` changes. See "What to rebuild" above.
- **Don't fetch a whole repo to answer a small question.** Use \`curl raw.githubusercontent.com\` or \`gh api search/code\` for the specific file or substring you need.
- **Don't treat any of these as stable public APIs.** Internal interfaces can change between versions. Cite what you read with the commit SHA you read it at if it matters for the user.
- **Don't propose changes to these repos in your own response.** If the user wants to file an issue or PR, they do that themselves; you can suggest where it would go.
- **Don't use the MCP's docs-search for these.** \`search-docs\` only indexes \`peridio/docs\` — it won't find anything in \`avocado-linux/*\` source. Use \`gh api search/code\` instead.

## Why this isn't a tool

The MCP wraps \`references\` and \`peridio/docs\` because each is a curated, schema-coherent surface the LLM uses frequently and where uniform tooling adds value. The repos catalogued here are heterogeneous — different shapes, varying relevance per session. Wrapping all of them would duplicate the \`gh\`/\`curl\` access you already have, with no leverage gain. The right interface is "the LLM knows the catalog exists and how to reach into it directly."
`;
