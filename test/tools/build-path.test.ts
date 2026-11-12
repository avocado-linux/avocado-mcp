import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";

import { RepoClient } from "../../src/lib/repo-client.js";
import {
  checkBuildPath,
  renderVerdictText,
} from "../../src/tools/build-path.js";

class UnreachableRepo extends RepoClient {
  override async getTargetManifest() {
    return null;
  }
  override async fetchSnapshotPointer() {
    return null;
  }
}

class ThrowingRepo extends UnreachableRepo {
  override async getTargetManifest(): Promise<never> {
    throw new Error("connection reset");
  }
}

function project(yaml: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "build-path-tool-"));
  writeFileSync(join(dir, "avocado.yaml"), yaml);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

// A binary that does not exist: the version query fails quietly, never runs the real CLI.
const NO_ENV = { AVOCADO_BINARY: "/nonexistent/avocado-for-tests" };

test("unreachable remote returns verdict", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new UnreachableRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.equal(r.verdict.target, "qemux86-64");
    assert.ok(r.verdict.missing.length > 0);
    assert.ok(
      r.verdict.missing.every((m) => m.reason === "feed-unreachable"),
      JSON.stringify(r.verdict.missing),
    );
    assert.ok(
      r.verdict.warnings.some((w) =>
        /published feed could not be read/.test(w),
      ),
      JSON.stringify(r.verdict.warnings),
    );
  } finally {
    p.done();
  }
});

test("a throwing remote returns a verdict, not an exception", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new ThrowingRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.ok(r.verdict.missing.every((m) => m.reason === "feed-unreachable"));
  } finally {
    p.done();
  }
});

class RecordingRepo extends RepoClient {
  calls: string[] = [];
  override async getTargetManifest() {
    this.calls.push("getTargetManifest");
    return null;
  }
  override async fetchSnapshotPointer() {
    this.calls.push("fetchSnapshotPointer");
    return null;
  }
}

function fakeAvocado(dir: string, version: string): string {
  const bin = join(dir, "fake-avocado");
  writeFileSync(bin, `#!/bin/sh\necho 'avocado ${version}'\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("an image-level path is an image_miss without reading the remote", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const repo = new RecordingRepo();
    const r = await checkBuildPath(
      repo,
      {
        project_dir: p.dir,
        change: { paths: ["meta-avocado/conf/machine/qemux86-64.conf"] },
      },
      { AVOCADO_BINARY: fakeAvocado(p.dir, "0.9.0") },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "image_miss");
    assert.match(r.verdict.reasons[0], /machine configuration/);
    assert.deepEqual(repo.calls, []);
    assert.deepEqual(r.verdict.warnings, []);
  } finally {
    p.done();
  }
});

test("the avocado version query uses the injected environment", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new UnreachableRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      { AVOCADO_BINARY: fakeAvocado(p.dir, "0.9.0") },
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(
      r.verdict.warnings.some((w) => /0\.9\.0.*older than/.test(w)),
      JSON.stringify(r.verdict.warnings),
    );
  } finally {
    p.done();
  }
});

test("an uncommitted recipe file explains itself in the verdict warnings", async () => {
  const p = project("default_target: qemux86-64\n");
  const ws = mkdtempSync(join(tmpdir(), "build-path-ws-"));
  try {
    const layer = join(ws, "meta-a");
    mkdirSync(join(layer, "recipes-x", "foo"), { recursive: true });
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: layer,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      });
    git("init", "-q");
    writeFileSync(join(layer, "README"), "x\n");
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "init",
    );
    writeFileSync(join(layer, "recipes-x", "foo", "foo_1.0.bb"), "# foo\n");
    const r = await checkBuildPath(
      new UnreachableRepo(),
      {
        project_dir: p.dir,
        workspace_dir: ws,
        change: { recipes: ["foo"] },
      },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(
      r.verdict.warnings.some((w) => /has no commit/.test(w)),
      JSON.stringify(r.verdict.warnings),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    p.done();
  }
});

class DeltaRepo extends UnreachableRepo {
  override async fetchExtraFeed() {
    return [
      {
        name: "foo",
        summary: "",
        description: "",
        version: "1.0",
        release: "r0",
        arch: "core2_64",
        repo: "delta",
        href: "foo-1.0-r0.core2_64.rpm",
        epoch: 0,
        sourcerpm: "foo-1.0-r0.src.rpm",
      },
    ];
  }
}

test("a modified patch in a committed recipe group is a no-cache-key miss that says to commit", async () => {
  const p = project(
    "default_target: qemux86-64\ndistro:\n  release: 2026\n  channel: edge\n  feeds: [local]\nrepos:\n  local:\n    path: delta/target/qemux86-64\n",
  );
  const ws = mkdtempSync(join(tmpdir(), "build-path-ws-"));
  try {
    const droot = join(p.dir, "delta");
    mkdirSync(join(droot, "target", "qemux86-64"), { recursive: true });
    writeFileSync(
      join(droot, "delta.json"),
      JSON.stringify({
        schema_version: 1,
        base: { release: "2026", channel: "edge", snapshot_id: null },
        built_recipes: ["foo"],
      }),
    );
    const layer = join(ws, "meta-a");
    mkdirSync(join(layer, "recipes-x", "foo", "files"), { recursive: true });
    const git = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: layer,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
        },
      })
        .toString()
        .trim();
    git("init", "-q");
    writeFileSync(join(layer, "recipes-x", "foo", "foo_1.0.bb"), "# foo\n");
    const patch = join(layer, "recipes-x", "foo", "files", "fix.patch");
    writeFileSync(patch, "a\n");
    git("add", "-A");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "init",
    );
    writeFileSync(
      join(droot, "recipe-map.json"),
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            recipe: "foo",
            packages: ["foo"],
            layer: "meta-a",
            epoch: 0,
            pv: "1.0",
            pr: "r0",
            srcrev: "",
            layer_commit: git("rev-parse", "HEAD"),
            machine: "qemux86-64",
            release: "2026",
            task_hash: null,
          },
        ],
      }),
    );
    const run = () =>
      checkBuildPath(
        new DeltaRepo(),
        {
          project_dir: p.dir,
          workspace_dir: ws,
          change: { recipes: ["foo"] },
        },
        NO_ENV,
      );

    // Control: the clean tree is served by the delta, so the miss below
    // comes from the edit and not from the fixture.
    const clean = await run();
    assert.equal(clean.ok, true);
    if (!clean.ok) return;
    assert.equal(clean.verdict.verdict, "feed_hit");

    writeFileSync(patch, "b\n");
    const r = await run();
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.deepEqual(
      r.verdict.missing.map((m) => [m.recipe, m.reason]),
      [["foo", "no-cache-key"]],
    );
    assert.ok(
      r.verdict.warnings.some((w) => /fix\.patch/.test(w) && /commit/.test(w)),
      JSON.stringify(r.verdict.warnings),
    );
  } finally {
    rmSync(ws, { recursive: true, force: true });
    p.done();
  }
});

const GIT_TEST_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function gitIn(cwd: string, ...a: string[]): string {
  return execFileSync("git", a, { cwd, env: GIT_TEST_ENV }).toString().trim();
}

function commitIn(cwd: string, msg: string): void {
  gitIn(
    cwd,
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "-m",
    msg,
  );
}

// A recipe served by the delta, in a real git repository. Unless `pv` makes
// the version differ, a clean control is asserted to be a feed_hit first, so
// a miss after `edit` comes from the edit and not from the fixture.
async function deltaScenario(
  edit: (ctx: { ws: string; layer: string }) => void,
  opts: { pv?: string } = {},
) {
  const p = project(
    "default_target: qemux86-64\ndistro:\n  release: 2026\n  channel: edge\n  feeds: [local]\nrepos:\n  local:\n    path: delta/target/qemux86-64\n",
  );
  const ws = mkdtempSync(join(tmpdir(), "build-path-ws-"));
  try {
    const droot = join(p.dir, "delta");
    mkdirSync(join(droot, "target", "qemux86-64"), { recursive: true });
    writeFileSync(
      join(droot, "delta.json"),
      JSON.stringify({
        schema_version: 1,
        base: { release: "2026", channel: "edge", snapshot_id: null },
        built_recipes: ["foo"],
      }),
    );
    const layer = join(ws, "meta-a");
    const dir = join(layer, "recipes-x", "foo");
    mkdirSync(join(dir, "files"), { recursive: true });
    gitIn(layer, "init", "-q");
    writeFileSync(join(dir, "foo_1.0.bb"), "# foo\n");
    writeFileSync(join(dir, "foo.inc"), "# inc\n");
    writeFileSync(join(dir, "files", "fix.patch"), "a\n");
    gitIn(layer, "add", "-A");
    commitIn(layer, "init");
    writeFileSync(
      join(droot, "recipe-map.json"),
      JSON.stringify({
        schema_version: 1,
        entries: [
          {
            recipe: "foo",
            packages: ["foo"],
            layer: "meta-a",
            epoch: 0,
            pv: opts.pv ?? "1.0",
            pr: "r0",
            srcrev: "",
            layer_commit: gitIn(layer, "rev-parse", "HEAD"),
            machine: "qemux86-64",
            release: "2026",
            task_hash: null,
          },
        ],
      }),
    );
    const run = async () => {
      const r = await checkBuildPath(
        new DeltaRepo(),
        {
          project_dir: p.dir,
          workspace_dir: ws,
          change: { recipes: ["foo"] },
        },
        NO_ENV,
      );
      assert.equal(r.ok, true);
      if (!r.ok) throw new Error("checkBuildPath failed");
      return r.verdict;
    };
    if (!opts.pv) assert.equal((await run()).verdict, "feed_hit");
    edit({ ws, layer });
    return await run();
  } finally {
    rmSync(ws, { recursive: true, force: true });
    p.done();
  }
}

const reasons = (v: {
  missing: Array<{ recipe: string | null; reason: string }>;
}) => v.missing.map((m) => [m.recipe, m.reason]);

test("an uncommitted delete of a tracked .inc is a no-cache-key miss that says to commit", async () => {
  const v = await deltaScenario(({ layer }) =>
    rmSync(join(layer, "recipes-x", "foo", "foo.inc")),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(reasons(v), [["foo", "no-cache-key"]]);
  assert.ok(
    v.warnings.some((w) => /foo\.inc/.test(w) && /commit/.test(w)),
    JSON.stringify(v.warnings),
  );
});

test("git rm of a subdirectory so the directory disappears is a no-cache-key miss", async () => {
  const v = await deltaScenario(({ layer }) =>
    gitIn(layer, "rm", "-q", "-r", "recipes-x/foo/files"),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(reasons(v), [["foo", "no-cache-key"]]);
  assert.ok(
    v.warnings.some((w) => /files\/fix\.patch/.test(w)),
    JSON.stringify(v.warnings),
  );
});

test("deleting files/ from disk entirely is a no-cache-key miss", async () => {
  const v = await deltaScenario(({ layer }) =>
    rmSync(join(layer, "recipes-x", "foo", "files"), { recursive: true }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(reasons(v), [["foo", "no-cache-key"]]);
});

test("a committed deletion of a .inc after the build is stale-delta", async () => {
  const v = await deltaScenario(({ layer }) => {
    gitIn(layer, "rm", "-q", "recipes-x/foo/foo.inc");
    commitIn(layer, "drop inc");
  });
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(reasons(v), [["foo", "stale-delta"]]);
});

test("a version difference beside a dirty patch still carries the commit-first warning", async () => {
  const v = await deltaScenario(
    ({ layer }) =>
      writeFileSync(
        join(layer, "recipes-x", "foo", "files", "fix.patch"),
        "b\n",
      ),
    { pv: "2.0" },
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(reasons(v), [["foo", "version-differs"]]);
  assert.ok(
    v.warnings.some((w) => /fix\.patch/.test(w) && /commit/.test(w)),
    JSON.stringify(v.warnings),
  );
});

test("an unmapped path reaches the structured result and the rendered text", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new UnreachableRepo(),
      {
        project_dir: p.dir,
        change: { paths: ["meta-oe/classes/cmake.bbclass"] },
      },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.deepEqual(r.verdict.missing, []);
    assert.deepEqual(r.verdict.unmapped, ["meta-oe/classes/cmake.bbclass"]);
    const text = renderVerdictText(r.verdict);
    assert.match(text, /## Unmapped paths/);
    assert.match(text, /`meta-oe\/classes\/cmake\.bbclass`/);
    assert.doesNotMatch(text, /## Missing/);
  } finally {
    p.done();
  }
});

test("a project without a target is an error", async () => {
  const p = project("distro:\n  release: '2026'\n");
  try {
    const r = await checkBuildPath(
      new UnreachableRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      NO_ENV,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no build target/);
  } finally {
    p.done();
  }
});

test("a missing project directory is an error", async () => {
  const r = await checkBuildPath(
    new UnreachableRepo(),
    { project_dir: join(tmpdir(), "no-such-avocado-project-dir") },
    NO_ENV,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /no avocado\.yaml/);
});
