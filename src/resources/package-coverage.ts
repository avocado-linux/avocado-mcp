export const URI = "avocado://skills/package-coverage";
export const NAME = "package-coverage";
export const DESCRIPTION =
  "How to produce a **package coverage report** for a user migrating OFF Docker onto Avocado OS. Given a Dockerfile or an SBOM (CycloneDX / SPDX) plus a hardware target, resolve the right feed stream (release + channel), extract the app's runtime dependencies, batch-check them all against the live Avocado package feed in one call with `check-package-coverage`, research anything missing on the open web, and emit a shareable `package-coverage.md` — a per-dependency present/missing table, upstream links for gaps, and a headline coverage %. Covers the multi-release feed world (2024 + 2026 across next/edge/stable) and how to pick the stream when the user has no `avocado.yaml`. Read this BEFORE running the `/package-coverage` prompt or whenever a user asks 'do you support all my dependencies?' / 'can Avocado replace my container?' / 'what would it take to move this image off Docker?'.";

export const CONTENT = `# Package coverage analysis — migrating off Docker onto Avocado OS

This skill drives a specific deliverable: a **package coverage report** (\`package-coverage.md\`) that answers, for one containerized application, *"which of this app's dependencies already exist in the Avocado OS package feed, and which would a feed maintainer need to add?"*

The audience for the report is an **Avocado OS package-feed maintainer**. Write for them: they need exact upstream names, versions, license, source links, and a clear present/missing verdict per package — enough to open feed-request tickets without re-researching each library.

The split of labor: **you** read the input, reason about names, and write the markdown; the **\`check-package-coverage\` tool** does the bulk feed lookup for the whole dependency list in one call; **web search** fills in the gaps. This skill is the method.

---

## Inputs (both required)

1. **A dependency source** — exactly one of:
   - A **Dockerfile** (path or pasted contents).
   - A **CycloneDX SBOM** (JSON; the default from \`syft\`, \`trivy\`, \`docker sbom\`).
   - An **SPDX SBOM** (JSON or tag-value).
2. **A hardware target + feed stream** — a target slug (e.g. \`jetson-orin-nano-devkit\`) AND the release + channel to evaluate against. The feed is per-(target, release, channel), so coverage is meaningless without all three. Resolving the stream is **Step 0** below — do it before anything else.

If the dependency source is missing, stop and ask. Don't analyze against a default target.

---

## Step 0 — Resolve the target + feed stream

Avocado now publishes multiple **releases** (\`2024\`, \`2026\`, …) across three **channels** (\`next\`, \`edge\`, \`stable\`). Targets differ per stream — some hardware ships only on a newer release (e.g. **NVIDIA Thor is on 2026, not 2024**). So "which feed do we check?" has to be answered first.

### If the user has an \`avocado.yaml\` (active project)

Read it. It's the source of truth — pull the target (\`default_target\` / \`supported_targets\`) and the stream from \`distro.release\` / \`distro.channel\` (or the documented defaults if unset). Confirm the resolved \`(target, release, channel)\` back to the user in one line, then proceed. No need to ask about the stream — the project already declares it.

### If the user has NO project / no \`avocado.yaml\`

Walk them through selection:

1. **Hardware → target.** Ask what hardware they want to support if they haven't said. Resolve prose to a canonical slug with \`list-targets({ query: "..." })\` and confirm. Never guess or substitute a "close enough" target.
2. **Which release supports it?** Check the docs support matrix at **https://docs.peridio.com/hardware/support-matrix#supported** (via \`search-docs({ query: "support matrix", section: "hardware" })\` → \`get-doc\`, or \`WebFetch\` the URL) — that table now documents which release each board is supported on. You can corroborate against the feed itself: \`list-targets({ query: "<target>", release: "2026" })\` vs \`release: "2024"\` shows which stream actually carries the target.
   - Supported on **only one** release → use it (tell the user).
   - Supported on **both 2024 and 2026** → ask which they'd prefer, but **default to / recommend the newest** (if 2026 is available, suggest 2026).
3. **Which channel?** **Recommend \`edge\`**, but ask if they'd prefer \`next\`, \`edge\`, or \`stable\`. Explain the tradeoff:
   - **\`next\`** — like a nightly. Actively worked on; **tends to break, packages can go missing.**
   - **\`edge\`** — like a release candidate. **Good for development** (the default recommendation).
   - **\`stable\`** — for pre-production / production. Solid but **normally behind \`edge\`**, so coverage may be lower than edge for the same hardware.
4. **Confirm** the final \`(target, release, channel)\` before running lookups. If the target isn't in the chosen stream, \`check-package-coverage\` will tell you — re-resolve rather than forcing it.

Record the resolved stream — it goes in the report header and into every \`check-package-coverage\` call.

---

## Step 1 — Extract the dependency set

Goal: a **de-duplicated list of runtime libraries/packages** the application needs. Scope is **runtime dependencies only** — the things that must be present on-device for the app to run. **Exclude build-time-only tooling**: compilers (\`gcc\`, \`g++\`, \`rustc\`), build systems (\`make\`, \`cmake\`, \`meson\`, \`ninja\`), \`-dev\`/\`-devel\` header packages, \`build-essential\`, \`pkg-config\`, linters, test frameworks. Those don't ship on an Avocado device (they live in the SDK at build time), so counting them would understate coverage and mislead the maintainer.

> If the user explicitly asks for build-time deps too, include them but put them in a **clearly separate "Build-time (SDK) dependencies" table** so the runtime coverage number stays honest.

### From a Dockerfile

Parse the explicitly-declared dependencies. Do **not** attempt to expand the full transitive OS closure of the base image (that's hundreds of packages and not what the user controls). Sources to read:

- **\`FROM <base>\`** — note the base image and tag (e.g. \`python:3.12-slim\`, \`node:20-alpine\`, \`ubuntu:22.04\`). The base tells you the ecosystem and the language runtime that must be covered (\`python3\`, \`nodejs\`, etc.). A distroless/scratch base means the app is mostly self-contained — focus on what's \`COPY\`d in.
- **System package installs** — \`apt-get install\`, \`apk add\`, \`dnf/yum install\`, \`zypper in\`. Each named package is a candidate. Strip build-only ones per the scope rule above.
- **Language-ecosystem installs** — \`pip install ...\` / \`requirements.txt\`, \`npm install\` / \`package.json\`, \`cargo ...\` / \`Cargo.toml\`, \`gem install\`, \`go get\`. If the referenced manifest file is available, read it for the concrete list; otherwise extract what's inline.
- **\`COPY\` / \`ADD\` of vendored binaries or libs** — note them as app-supplied (usually "N/A — app-bundled", not a feed gap).

Record each dependency with: raw name, ecosystem (\`system-apt\`/\`system-apk\`/\`pip\`/\`npm\`/\`cargo\`/…), and whether you judged it runtime or build-time (drop build-time from the main table).

### From a CycloneDX SBOM

Read the \`components[]\` array. For each component use \`name\`, \`version\`, and \`purl\` (the purl \`type\` — \`deb\`, \`apk\`, \`pypi\`, \`npm\`, \`cargo\`, \`rpm\` — is your ecosystem signal). This is the richest input: prefer it when the user has both a Dockerfile and an SBOM. Apply the same runtime-only filter (SBOMs list everything the image contains, including build residue and \`-dev\` packages — filter those out of the runtime table).

### From an SPDX SBOM

Read \`packages[]\`. Use \`name\`, \`versionInfo\`, \`downloadLocation\`/\`externalRefs\` (purl) and \`licenseConcluded\`. Same filtering.

**Output of Step 1:** a clean list. Tell the user the count and let them sanity-check before you spend tool calls on lookups: _"Extracted N runtime dependencies from your \`<input>\`. Checking each against the \`<target>\` feed now."_

---

## Step 2 — Batch-check the whole list against the feed

Use the **\`check-package-coverage\`** tool — one call for the entire dependency list, not one \`search-packages\` per dependency. It warms the target's feed once and returns a present/missing verdict, a confidence tier, the best feed match, and near-miss alternatives for every dependency, plus an overall coverage summary.

\`\`\`
check-package-coverage({
  target: "<slug>",
  release: "<release>",   // from Step 0
  channel: "<channel>",   // from Step 0
  dependencies: [
    { name: "libssl-dev", ecosystem: "system-apt", queries: ["openssl", "libssl", "ssl"] },
    { name: "paho-mqtt",  ecosystem: "pip",        queries: ["paho-mqtt", "python3-paho-mqtt", "mqtt"] },
    ...
  ]
})
\`\`\`

**Your job is the \`queries\` array** — the name normalization. This is the core problem: Docker images are Debian/Ubuntu (\`apt\`), Alpine (\`apk\`), or language ecosystems; the Avocado feed is **RPM/Yocto-built**, so names rarely match 1:1. For each dependency, put every plausible variant in \`queries\` (the tool tries them all and keeps the best hit):

| Source name pattern | Put in \`queries\` |
|---|---|
| \`libssl-dev\`, \`libfoo-dev\`, \`libfoo1\` | \`openssl\`, \`foo\`, \`libfoo\` (strip \`lib\` prefix and \`-dev\`/version suffix) |
| \`python3-<x>\` / pip \`<x>\` | both \`python3-<x>\` and bare \`<x>\` (feed uses both conventions — see \`avocado://skills/app-development\`) |
| npm \`<x>\` | \`nodejs-<x>\` and bare \`<x>\` |
| \`libjpeg-turbo8\`, \`zlib1g\` | \`libjpeg-turbo\`, \`zlib\` (drop Debian ABI-version suffixes) |
| \`<x>-bin\` / \`<x>-utils\` | \`<x>\` |
| A provider vs the thing (\`default-jre\` → \`openjdk\`) | the concrete implementation name |

Include a keyword form too — the feed search matches summaries, so \`mqtt\` can surface \`paho-mqtt\` even when the source name was \`libmosquitto1\`.

### What the tool returns

Each dependency comes back with:

- \`status\`: \`present\` (any hit) or \`missing\` (no hit across all its queries). Matching is **optimistic** — a summary-only hit still counts as present.
- \`confidence\`: \`exact\` (feed name == query), \`strong\` (name prefix/substring match), or \`fuzzy\` (summary-only hit — optimistically counted, but a maintainer should verify). Carry this straight into the report's Match-confidence column.
- \`match\`: the best feed package (name + version + repo) for PRESENT rows.
- \`alternatives\`: near-miss package names — useful context for the maintainer and for spotting a better match.
- \`summary\`: totals + coverage % + the exact/strong/fuzzy breakdown — this feeds the report's headline.

If \`targetAvailable\` comes back **false**, the target isn't in that stream (the Thor-on-2024 case). Go back to Step 0, pick the release that supports it, and re-run.

### Scale note

This is one tool call regardless of list size, and the feed is cached process-wide after the first call — so a 200-dependency SBOM is cheap. You can also split into a few calls (e.g. per ecosystem) if you want to review results incrementally. Iterate on \`queries\` for anything that came back \`missing\` but you suspect exists under another name, then re-run just those — a false "missing" wastes a maintainer's time.

---

## Step 3 — Research every MISSING dependency on the open web

For each package marked MISSING, do light web research so the maintainer gets a self-contained ticket. Use \`WebSearch\` / \`WebFetch\` (and \`gh\`/\`curl\` per \`avocado://skills/upstream-sources\` if it's already an avocado-linux thing).

> **If web-research tools aren't available in this session** (no \`WebSearch\`/\`WebFetch\`, no network for \`gh\`/\`curl\`), do NOT stall and do NOT invent links. Still produce the report — list each missing package by name, note in its subsection that _"upstream research was not performed (no web access in this session)"_, and add a top-level note in the report so the maintainer knows the gap detail needs a follow-up pass.

Capture, per missing package:

- **What it is** — one-line description of the library and what the app uses it for.
- **Canonical upstream source** — the GitHub/GitLab repo URL (primary link). Add a second link where useful: the project homepage, the PyPI/npm/crates.io page, or the Debian/Fedora package page.
- **License** (SPDX id if determinable) — maintainers need this for feed inclusion.
- **Latest / relevant version.**
- **Packaging signal** — is there an existing OpenEmbedded/Yocto recipe (e.g. in \`openembedded-core\`, \`meta-openembedded\`) or a Fedora/RPM spec? A "recipe already exists upstream" note dramatically lowers the cost of adding it. Note native-extension/build complexity if obvious (pure-Python vs C-extension, etc.).

Prefer 1–3 high-quality links per package over a link dump. If a package is truly obscure and you can't find a canonical source, say so explicitly rather than inventing a link.

---

## Step 4 — Write \`package-coverage.md\`

Write the report to the current working directory (unless the user names another path). Name it \`package-coverage-<target>.md\` when the target slug is known (e.g. \`package-coverage-raspberrypi5.md\`) so running the analysis for a second board doesn't silently overwrite the first report; fall back to \`package-coverage.md\` only if there's no target in the name. It must stand alone — a maintainer reading it cold should understand the app, the target, and exactly what to do. Use this structure:

\`\`\`markdown
# Package Coverage Report

- **Application / image:** <name or Dockerfile path>
- **Input analyzed:** <Dockerfile | CycloneDX SBOM | SPDX SBOM>
- **Avocado target:** \`<target-slug>\`
- **Feed stream:** \`<release>/<channel>\` (e.g. 2024/edge)
- **Base image:** <FROM ... , if from a Dockerfile>
- **Generated:** <date>

## Summary

- **Total runtime dependencies analyzed:** N
- **Present in feed:** X (Y%) — of which E exact, S strong, F fuzzy/unverified
- **Missing from feed:** Z
- **Coverage: Y%** (X/N)  ← headline number

<One short paragraph: overall migration readiness, the biggest gaps, and any
caveats about fuzzy matches the maintainer should verify. If any 'present'
count is fuzzy, say so here in plain terms — e.g. "82% present, but 3 of those
are fuzzy matches a maintainer should confirm before relying on the number.">

## Coverage detail

| # | Dependency | Ecosystem | Status | Feed package | Version | Match confidence | Notes |
|---|---|---|---|---|---|---|---|
| 1 | openssl | system-apt | ✅ Present | openssl | 3.x | exact | |
| 2 | paho-mqtt | pip | ✅ Present | python3-paho-mqtt | ... | strong | pip name → python3- prefix |
| 3 | libfoobar | system-apt | ❌ Missing | — | — | — | see gap #1 |
...

## Missing packages — maintainer detail

For each ❌ row, a subsection the maintainer can turn into a feed request:

### <package name>
- **What it is:** ...
- **Used by the app for:** ...
- **Upstream:** <primary repo URL>
- **Also:** <homepage / PyPI / crates.io / distro package page>
- **License:** <SPDX id>
- **Latest version:** ...
- **Existing recipe?** <yes: link to OE/Yocto/Fedora recipe | no | unknown>
- **Packaging notes:** <native ext? cross-compile complexity? pure-language?>

## Excluded from coverage (build-time only)

<Optional: bulleted list of build-time deps you dropped — gcc, cmake, *-dev,
etc. — so the maintainer sees they were considered, not missed.>
\`\`\`

Compute coverage as \`present / total\` over the **runtime** table, rounded to a whole percent. State the fraction alongside the percent (\`18/22 = 82%\`) so it's auditable.

---

## Guardrails

- **Never fabricate a feed match or an upstream link.** If a lookup is inconclusive, mark it fuzzy (with a note) or missing — don't upgrade a guess to "present" without a plausible hit, and don't invent GitHub URLs. A maintainer acts on this report; a made-up link costs them real time.
- **One target per report.** If the user runs multiple boards, produce one report each (the feed differs per target).
- **Runtime-only by default.** Keep build-time deps out of the coverage denominator unless the user asks; if included, they go in their own table.
- **Optimistic ≠ careless.** Optimistic matching means a plausible hit counts as covered — it does **not** mean skipping the normalization variants. Always try them before declaring missing, and always stamp a confidence so the optimism is auditable.
- **This is analysis, not modification.** The report is a shareable artifact. Don't edit the user's \`avocado.yaml\` or install anything as part of coverage analysis — that's a separate follow-up once the maintainer has closed the gaps. (See \`avocado://skills/app-development\` for the feed-first add-a-library workflow once coverage is understood.)
`;
