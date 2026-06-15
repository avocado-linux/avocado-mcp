---
name: yocto-engineer
description: Onboard a BitBake recipe end-to-end - dossier then decide. Given a package source URL, decide whether a new Yocto recipe is needed and, if so, author it. Entry point is a source URL (GitHub repo preferred, PyPI fallback). Skip when the package already has a scarthgap recipe in the layer-index, or for edits to an existing recipe rather than authoring a new one.
model: opus
allowed-tools: Read, Bash, WebFetch, mcp__devtool-edit__*, mcp__fff__*, mcp__avocado-mcp__*
---

# Yocto Engineer

Drive a structured **dossier-then-decide** workflow for evaluating whether a
package needs a new Yocto recipe, and authoring it when it does. Gather every
fact first; decide from the dossier, never from a guess.

Domain knowledge (tool descriptions, BitBake failure modes, avocado
conventions, the build ladder) lives in the `avocado://recipe-authoring/guide`
MCP resource. Read it before authoring. This SKILL.md is thin orchestration.

## Input

A **package source URL**. GitHub repo URL preferred; PyPI project URL as the
fallback. Detect the package name and likely build system from the URL/repo.

## GitHub-first source rule

Always try the project's GitHub repo as the recipe source before falling back
to PyPI. For `github.com/<org>/<repo>`, build `SRC_URI` as a git fetcher:

```
SRC_URI = "git://github.com/<org>/<repo>;protocol=https;branch=<branch>"
SRCREV = "<sha of the chosen tag>"
```

GitHub gives `recipetool` the real build system, applied patches, and
submodules. PyPI sdists often drop the cmake/meson files a native extension
needs. Only fall back to a PyPI `SRC_URI` (pypi fetcher) when no GitHub repo
URL is available.

**Resolve the branch from the tag - do not assume `main`.** BitBake's git
fetcher rejects a SRCREV that is not reachable from the named branch, and
release tags often live on a release branch, not `main`. Confirm with
`git ls-remote` before pinning:

```bash
git ls-remote --tags --heads https://github.com/<org>/<repo>.git \
  | grep -E '<tag>|refs/heads/(main|release)'
```

Match the tag's SHA to the branch whose tip (or history) contains it and set
`branch=` accordingly (e.g. `branch=release/1.3`). If the tag commit is on no
named branch, use `;nobranch=1` and pin SRCREV alone. Real case: executorch
`v1.3.1` is the tip of `release/1.3`, not `main`; pinning `branch=main` failed
`do_fetch` with "Unable to find revision ... in branch main".

**Submodules: use `gitsm://`, never `git://;submodules=1`.** If the repo has a
`.gitmodules`, switch the fetcher to `gitsm://` - it checks out submodules
recursively. The `git://` fetcher silently ignores `submodules=1` (it is not a
valid option), leaving the submodule directories empty:

```
SRC_URI = "gitsm://github.com/<org>/<repo>.git;protocol=https;branch=<branch>"
```

This matters most for cmake recipes built with `FETCHCONTENT_FULLY_DISCONNECTED`
(the avocado default): a missing submodule fails `do_configure` with
"does not contain a CMakeLists.txt" or "is not an existing non-empty directory"
rather than fetching at build time. Real case: executorch bundles flatbuffers,
gflags, and nlohmann-json as submodules; `git://...;submodules=1` left
`third-party/{flatbuffers,gflags,json}` empty and `do_configure` failed. The
org convention is `gitsm://` (see oe-core and meta-* recipes).

**Checkout dir name: override with `destsuffix` when upstream demands it.** The
git/gitsm fetcher unpacks to `${WORKDIR}/git`, so `S = "${WORKDIR}/git"`. Some
upstreams hard-check their own source-tree name and fail configure on anything
else. Override the unpack dir with `;destsuffix=<name>` and point `S` at it:

```
SRC_URI = "gitsm://github.com/<org>/<repo>.git;protocol=https;branch=<branch>;destsuffix=<repo>"
S = "${WORKDIR}/<repo>"
```

Real case: executorch's `CMakeLists.txt` aborts with "must be cloned into a
directory named exactly `executorch`; found `git`" (upstream issue 6475);
`destsuffix=executorch` plus `S = "${WORKDIR}/executorch"` satisfies it.

## Build-time code generators must be native

The single most common cross-compile failure class: a project builds a tool
(flatc, protoc, a Python codegen) and **runs it during its own build** to
generate sources. Under OE the tool gets built for the target, so executing it
on the build host fails. Two signatures, same root cause:

- `qemu-<arch>-static: Could not open '/usr/lib/ld-linux-<arch>.so.1'` - a
  compiled target binary (e.g. flatc, protoc) was run on the host.
- `ModuleNotFoundError: No module named '<x>'` inside a build-step Python
  codegen - a host Python tool (e.g. PyTorch's `torchgen`, the project's own
  package) is not on the build `PYTHONPATH`.

Upstream "force host build" tricks (unsetting `CMAKE_TOOLCHAIN_FILE`) are not
enough under OE, where the cross compiler comes from the `CC`/`CXX`
environment. Fixes, cheapest first:

- Add the tool's `-native` recipe to `DEPENDS` and point the build at it
  (`${STAGING_BINDIR_NATIVE}/<tool>`), patching the build if it insists on
  building its own. Prefer a `-native` whose version matches any vendored copy.
- For a host Python codegen, add the providing `-native` recipe (e.g.
  `python3-pytorch-native` ships `torchgen`) and put the package on
  `PYTHONPATH` (a source tree named `<pkg>` is importable with `${WORKDIR}` on
  the path, which `destsuffix=<pkg>` arranges).
- If no `-native` exists, author it first (build leaves first) or pre-generate
  the sources on a dev host and ship them as recipe files.

Real cases: executorch's flatc (fixed with `flatbuffers-native` + a patch
repointing the imported `flatc` target) and its `codegen.tools.gen_oplist` /
`codegen.gen` (needs `torchgen` plus the executorch package on `PYTHONPATH`).
Expect this class to recur in any recipe with codegen.

Four follow-on traps that bit the executorch codegen, in order:

- **The codegen tool's version must match what the project requires, not just
  "some version".** A host Python codegen validates the project's op/schema list
  against the tool's bundled schema; a too-old tool fails with a missing-symbol
  assertion (executorch's `codegen.gen` asserted on `mean.dtype_out` because
  `python3-pytorch-native` is 2.4.1 while executorch 1.3.1 needs torch 2.12.0).
  Read the project's pin (`pyproject.toml`, `install_requirements.py`,
  `.ci/.../pytorch.txt`) and match it.
- **You rarely need the whole framework - just its pure-Python codegen
  package.** Don't build nightly libtorch to get `torchgen`. Author a tiny
  native recipe that fetches the matching CPU **wheel** (a zip;
  `downloadfilename=*.zip` makes BitBake unpack it) and installs only the
  codegen package (`cp -r torchgen ${D}${PYTHON_SITEPACKAGES_DIR}`), with
  `BBCLASSEXTEND = "native"`. Add the codegen's own imports (`python3-pyyaml`,
  `python3-typing-extensions`) as native deps.
- **cmake often resolves `python3` to the build container's interpreter, not
  the OE native one**, so a module staged into the native sysroot is invisible.
  `inherit python3native` (steers cmake to the native python) and put the
  native site-packages on `PYTHONPATH`
  (`${STAGING_LIBDIR_NATIVE}/python${PYTHON_BASEVERSION}/site-packages`).
- **A pinned wheel/tarball can 403 from a CDN inside the build container even
  when it downloads fine from the host** (pytorch's `/whl/test` did). Confirm
  the file with `curl` from the host, then pre-seed `DL_DIR` with it; flag that
  the `SRC_URI` may need a project mirror for CI.

Packaging trap from the same recipe: a cmake `install()` with an absolute
DESTINATION leaks a whole `${D}/work/...` tree, tripping `installed-vs-shipped`.
Relocate the stragglers to `${libdir}` in `do_install:append` and `rm -rf
${D}/work`; route a bundled dep's nonstandard installs (cmake files under
`${datadir}`, a header in `${libdir}`) into `-dev` explicitly.

## Preflight (first run only)

Before step 1, call `preflight-recipe-tools`. It verifies the host-side tools
this skill shells out to (`gh`, `curl`, `git`, `uv`, `oelint-adv`) and writes a
version-stamped sentinel under `$XDG_STATE_HOME/avocado-mcp/` so later runs skip
the probe (`skipped: true`, zero tool invocations). If it returns `ok: false`,
stop and surface the `fixes` list - do not author anything until the host has
every tool, since a missing `oelint-adv` or `gh` only fails partway through.
The sentinel re-triggers automatically when the required-tool set changes
(version bump); pass `force: true` after installing a previously-missing tool.

## Workflow

1. **Receive** the package URL; derive the package name.
2. **Search the layer-index.** Call `search-layer-index` with the package
   name. If it returns a scarthgap match, report **"already exists: use the
   existing recipe"** and **stop** - no authoring needed.
3. **Detect the build system** from the repo and find examples. For GitHub
   repos, use the `gh` CLI to list the root tree (always single-quote the URL
   - zsh treats `?` as a glob and silently returns nothing otherwise):
   ```bash
   gh api 'repos/<org>/<repo>/git/trees/HEAD' --jq '[.tree[].path]'
   ```
   If `gh` is unavailable or the URL is not a GitHub repo, fall back to
   `WebFetch` on the repo homepage. Map the result to a build system:
   - `CMakeLists.txt` -> cmake
   - `meson.build` -> meson
   - `setup.py` / `pyproject.toml` -> setuptools3
   - `Cargo.toml` -> cargo
   - `configure.ac` -> autotools

   Then call `find-recipe-examples` with the detected build system.
4. **Read the authoring guide.** Retrieve the `avocado://recipe-authoring/guide`
   resource for the grounded recipe template and conventions.
5. **Explain every variable.** Call `explain-bitbake` for each variable the new
   recipe will set (`SRC_URI`, `SRCREV`, `LIC_FILES_CHKSUM`, `DEPENDS`,
   `RDEPENDS`, `inherit`, ...) so each line is grounded, not cargo-culted.
6. **Emit the dossier.** Output a table:

   | Field | Value |
   |-------|-------|
   | Package name | `<pn>` |
   | Detected build system | cmake / meson / setuptools3 / cargo / autotools |
   | Layer-index status | must-author / exists |
   | Example recipes found | paths from `find-recipe-examples` |
   | Recommended recipe template | the matching template from the guide |

7. **Ask the user: "author the recipe now?"** If yes, scaffold the `.bb` from
   the recommended template and the best-matching example.
8. **Author** (only when the layer-index search found nothing **and** the user
   confirmed): produce a complete `<pn>_<pv>.bb` recipe file using the
   GitHub-first `SRC_URI`/`SRCREV` above.

## Dependency-aware onboarding

When authoring is needed, resolve and onboard the full dependency chain, not
just the leaf. Query `search-layer-index` for every build and runtime
dependency, **and grep the checked-out `meta-*` layers** - the remote index
lags the tree, so a recipe can exist locally while the index returns nothing
(real case: `flatbuffers` is absent from the index but present in
`meta-openembedded/meta-oe`). Deps that already have a recipe are reused.
Onboard **only the `must-author` packages**, building **leaves first** so each
layer is green before its dependent. Emit the dependency plan before authoring.

Run the autonomous build-fix loop (below) **per recipe**, leaf first - a new
dependency recipe is a new build with its own failure surface, so drive it to
green with the same diagnose-fix-rerun discipline before returning to the
dependent. A `-native` dependency pulled in to satisfy a code generator (e.g.
`python3-pytorch-native` for `torchgen`) is itself a recipe to loop on.

## LIC_FILES_CHKSUM md5

Compute the license file hash with `curl`, not `gh api`. The `gh api` path
with a `?ref=<tag>` query string fails silently in zsh because `?` is a glob
character and gets expanded before the shell sees the URL:

```bash
curl -sL 'https://raw.githubusercontent.com/<org>/<repo>/<tag>/LICENSE' \
  | md5sum | cut -d' ' -f1
```

Always single-quote the URL. Substitute `LICENSE` with the actual license
file name if it differs (e.g. `COPYING`, `LICENSE.txt`).

## Autonomous build-fix loop

Once the recipe is authored, **drive the build to green yourself** - do not hand
the build command to the user and wait for them to paste each error back. First
propose it: "I'll run the build, read each failing log, fix the recipe, and
re-run until it's green or I hit something that needs your decision - go?" On
yes, run the loop; the user watches rather than relays.

Walk the ladder cheapest-signal-first so a problem surfaces before you pay for a
full build:

```
BitBake LSP diagnostics -> lint-recipe -> bitbake -p (parse)
  -> -c fetch -> -c configure -> -c compile -> full bakar bitbake <recipe>
```

`lint-recipe` requires the `oelint-adv` binary on PATH (`uv tool install
oelint-adv`; `python3 -m oelint_adv` fails because uv installs to PATH, not
system Python's site-packages).

Per iteration:

1. **Run** the build step (e.g. `bakar bitbake <recipe> <machine-yaml>`). A full
   build is minutes; individual tasks are faster with the sstate cache. Use a
   long timeout or run it in the background - do not assume a quick return.
2. **Success** -> advance to the next ladder step. Final step green -> leave the
   loop and go to corpus capture below. **Green means zero errors AND no
   warnings the recipe can fix** - a clean recipe builds warning-free. Treat
   every `WARNING:` and `QA Issue` (especially `buildpaths`, `installed-vs-shipped`,
   `host-user-contaminated`, `already-stripped`) as a finding to fix, not noise;
   a non-fatal warning today is a broken downstream consumer or a dirty package
   tomorrow (e.g. a `buildpaths` ref in an exported cmake targets file breaks
   `find_package`). The only acceptable leftover is a warning whose cause is
   demonstrably outside the recipe's control - an upstream toolchain or
   bbclass-level warning you cannot influence from the recipe. When you leave
   one, say so explicitly and name why it is out of scope; never silently accept
   a warning you could have fixed.
3. **Failure** -> read the real error from the failing task's log. The stable
   symlink `tmp/work/<arch>/<pn>/<pv>/temp/log.do_<task>` always points at the
   latest run - read its tail; do not depend on the `.<pid>` suffix. The BitBake
   console output names the task and log path but not the underlying error.
4. **Diagnose** - call `diagnose-build-failure` with the error lines.
   - confidence > 0 (corpus hit) -> apply the recorded fix.
   - confidence 0 (novel) -> find the root cause from the log plus the upstream
     source (`get-doc`, `explain-bitbake`, and reading the failing
     `CMakeLists.txt`/`meson.build`). Name the cause before editing; never
     guess-patch.
   - **Consult an existing recipe or a distro package** before hand-rolling a
     fix. First check whether a sibling Yocto layer already builds this package
     or a close cousin (`search-layer-index`, then grep the checked-out
     `meta-*` layers - the index lags the tree, so grep locally too). If none,
     read how a binary distro packages it: Arch `PKGBUILD` (and AUR), Debian
     `debian/rules` + `debian/control`, Fedora `.spec`, Alpine `APKBUILD`. They
     encode the real configure flags, the host-vs-target tool split, and the
     dependency list - the same knowledge a recipe needs. A cross-compiling
     distro (Debian multiarch, or Arch's `-static`/cross AURs) is the most
     directly transferable. Fetch them with `gh`/WebFetch or Repomix on the
     packaging repo.
5. **Fix** the recipe with the smallest change that addresses that root cause.
6. **Re-run** (step 1).

Stop the loop and ask the user when:

- the **same error recurs** after a fix (no forward progress on the ladder),
- the fix needs a real decision (drop a feature, choose between approaches),
- the failure is **infra, not the recipe** (network down, mirror unreachable,
  disk full) - surface it, do not patch around it.

Bound it: if the ladder has not advanced after ~6 iterations, stop and summarize
what you tried and what is blocking.

## Learn on the way (corpus capture)

Every novel failure (`diagnose-build-failure` returned confidence 0) you
resolved is a corpus gap. After the build goes **green**, call
`record-recipe-fix` once per novel failure - pass the error signature and the
fix that worked - so the next recipe that hits it gets a confidence-1 hit
instead of re-deriving the fix. Verified-only: record a fix **only** after the
green build that proves it; never record a hypothesis.

## Wire into a packagegroup

Authoring the `.bb` is not enough - a recipe that no image or packagegroup
pulls in is never built. Add the package to
`meta-avocado/recipes-avocado/packagegroups/packagegroup-avocado-extra.bb`,
in the alphabetically-sorted `RDEPENDS:${PN}` list, before the build will
include it and before the SDK tier of feed validation can assert it.

Add the package variant that produces the artifact you need. A recipe that
builds only static libraries and headers (no shared `.so`, no runtime binary)
ships its content in `<pn>-staticdev`, so add `<pn>-staticdev`, not `<pn>`.
Check the recipe's `FILES`/`ALLOW_EMPTY` to know which variant is non-empty.

Precedent: zeromq was wired in this way; executorch was added as
`executorch-staticdev` during the ENG-1969 dogfood because its recipe disables
all shared-library backends and emits static libs only.

## E2E gate

Add a one-line case to meta-avocado's `scripts/feed-validation-cases`
(`name | packages | expected-libs | boot`) and run the suite with
`scripts/run-feed-validation.sh` (all cases) or `scripts/validate-feed-local.sh
-m <machine> -l <libs> <pkgs>` (one package). Validate on qemuarm64 by default -
most avocado boards are arm64.

Pick the tiers by what the package actually ships:

- **Runtime package (shared `.so`)**: both tiers. SDK tier asserts the lib lands
  in the extension sysroot; boot tier asserts the symbol/import on a booted
  qemuarm64 over the QEMU guest agent. `boot=yes` (e.g. zeromq -> libzmq.so.5).
- **Static/SDK package (`-staticdev`, only `.a` + headers)**: SDK tier only.
  Assert the static lib lands in the ext sysroot (the harness's lib check is a
  plain `ls` in `/usr/lib*`, so a `.a` works) and set `boot=no` - there is no
  runtime object to load on a device. Forcing a boot tier on a static package
  tests nothing. Real case: `executorch | executorch-staticdev | libexecutorch.a
  | no`.

Build the deployment arch the case targets: a `-staticdev` lib is target-arch,
so the feed build still compiles the recipe for that machine even though no
device boot happens.

### The feed build builds the whole distro - fix what blocks it

The feed-validation stages a real feed, so it builds the entire avocado-distro
image, not just your recipe. That surfaces failures in unrelated packages, and
a green E2E needs the whole build green. Triage each by cause, not by ownership:

- **Deterministic failure that would also fail CI** (stale upstream checksum,
  a recipe that breaks under ccache, a real compile error) - **fix it**, even
  though it is not your recipe. "It is not mine" is not a pass; the automated
  pipeline fails the same way on Justin's farm. Two recurring classes:
  - *Stale source checksum / re-published artifact* (e.g. `nativesdk-publishtool`
    jar) - the base branch usually already has the bump; rebase your chain onto
    current `origin/scarthgap` rather than editing the checksum by hand.
  - *Recipe fails `do_compile` under ccache* - some compile paths exec the
    compiler as the bare `ccache` argv[0] and die with "command '.../ccache'
    failed with exit code 1". gobject-introspection's g-ir-scanner is the
    classic offender (real case: pango). Fix with a distro bbappend setting
    `CCACHE_DISABLE = "1"` - confirmed honored by ccache.bbclass. Suspect this
    for any GI-heavy recipe (pango, gtk, gdk-pixbuf, librsvg).
- **Transient or host-only failure** (OOM, a parallel-make race, a flaky mirror
  reachable from your host but not the container) - surface it and retry; do
  not bake a workaround into a recipe.

The test: is the failure reproducible and rooted in the recipe/metadata
(fix it) or in the machine/network/load (surface it)? Capture each real fix as
a corpus case so the next full-build run hits it pre-solved.

## PR delivery

Open one PR per recipe as a **git-machete** campaign, **bottom-up** (dependency
leaves first). Use `devtool_push` + `gh pr create`. Show the user each PR title
and description and get **explicit confirmation before any push**. Never use
ghstack or spr.

## Dogfood target

Section 8 dogfood target: executorch from https://github.com/pytorch/executorch
(Linear ENG-1969).
