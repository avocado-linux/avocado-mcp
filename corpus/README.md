# Bringup corpus

This directory is the first human-sourced bringup corpus: a growing set of
build/feed error->fix cases captured while bringing real packages through the
avocado package-feed pipeline (produce -> stage -> consume).

## Purpose

The corpus exists to seed and de-risk the future Plan 2 `yocto-engineer`
agentic-recipe skill. That skill will author and repair recipes autonomously;
to do so well it needs a body of verified-green examples of what actually breaks
during a Yocto build or feed-staging run and how each break was fixed. Every
case here is verified-green by construction: it records a failure that was hit
for real and a fix that was confirmed to resolve it.

`yocto-engineer` inherits this corpus as its initial training/reference data and
evolves it over time. The schema and on-disk location defined here are the v0
contract the skill builds on, so they must stay stable.

## Location: workspace root, NOT a meta layer

The corpus lives at the **workspace root**, as a sibling of `plans/`:

```text
peridio/
  plans/
  corpus/        <- here
    README.md
    cases/
```

It MUST NOT live inside any `meta-*` layer (e.g. `meta-avocado/corpus/`). Meta
layers are managed by the kas manifest; a `kas` re-sync would check out the
upstream layer tree and clobber any corpus copy placed inside it. The
workspace-root location is repo-agnostic, survives layer re-syncs, mirrors the
existing `plans/` convention, and gives Plan 2 a stable inherited path.

## Case schema (v0)

Each case is a YAML file under `corpus/cases/`. Every case carries these seven
required fields:

- `normalized_signature` - the error signature stripped of run-specific paths
  and hashes, so cases dedupe across runs.
- `failed_task` - the bitbake task or pipeline step that failed (e.g.
  `do_compile`, `do_package_qa`, `repo-stage-rpms`).
- `build_system` - the build system involved (e.g. `cmake`, `autotools`,
  `meson`, `kas`, `feed-pipeline`).
- `root_cause` - the underlying cause, one or two sentences.
- `fix_diff` - the diff or concrete change that resolved it.
- `doc_link` - a link to the relevant doc, issue, or commit, or `""` if none.
- `falsifier` - what observation would prove the fix wrong.

## Worked example

```yaml
normalized_signature: "QA Issue: zeromq: non -dev/-dbg package contains symlink .so: libzmq.so"
failed_task: do_package_qa
build_system: cmake
root_cause: >
  The recipe shipped the development symlink libzmq.so in the main runtime
  package. The dev-so QA check fails because a versionless .so symlink belongs
  in the -dev package, not the runtime package.
fix_diff: |
  --- a/recipes-connectivity/zeromq/zeromq_4.3.5.bb
  +++ b/recipes-connectivity/zeromq/zeromq_4.3.5.bb
  @@
  +FILES:${PN}-dev += "${libdir}/libzmq.so"
  +FILES:${PN} = "${libdir}/libzmq.so.*"
doc_link: "https://docs.yoctoproject.org/ref-manual/qa-checks.html#dev-so"
falsifier: >
  After the fix, do_package_qa still reports the dev-so warning for libzmq.so,
  or libzmq.so (the versionless symlink) appears in the runtime zeromq package
  instead of zeromq-dev.
```

See `corpus/cases/` for the concrete case files, including the example template.
