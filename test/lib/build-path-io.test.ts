import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cliVersionWarning,
  createWorkspace,
  findDelta,
  loadPublishedState,
  mirrorDirFrom,
  projectBuildTarget,
  readMirrorMarker,
  readRecipeMap,
  verdictFeeds,
  type GitResult,
  type PublishedClient,
} from "../../src/lib/build-path-io.js";
import { classifyBuildPath } from "../../src/lib/build-path.js";
import type { ResolvedFeed } from "../../src/lib/feed-config.js";
import type { FeedPackage } from "../../src/lib/repo-client.js";

function tmp(): string {
  return realpathSync(mkdtempSync(join(tmpdir(), "bpio-")));
}

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, encoding: "utf8" })
    .toString()
    .trim();
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
}

function commit(dir: string, msg: string): string {
  git(
    dir,
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
  return git(dir, "rev-parse", "HEAD");
}

// ---- target ---------------------------------------------------------------

test("project target: AVOCADO_TARGET wins over default_target", () => {
  const dir = tmp();
  const cfg = join(dir, "avocado.yaml");
  write(cfg, "default_target: qemux86-64\n");
  assert.equal(projectBuildTarget(cfg, { AVOCADO_TARGET: "imx93" }), "imx93");
  assert.equal(projectBuildTarget(cfg, {}), "qemux86-64");
  assert.equal(projectBuildTarget(join(dir, "none.yaml"), {}), undefined);
  rmSync(dir, { recursive: true });
});

// ---- delta ----------------------------------------------------------------

const DELTA = JSON.stringify({
  schema_version: 1,
  base: { release: "2026", channel: "edge", snapshot_id: null },
  built_recipes: ["htop"],
});

test("delta is found two and three levels above a path feed", () => {
  const dir = tmp();
  const root = join(dir, "delta", "2026", "edge");
  write(join(root, "delta.json"), DELTA);
  const two = join(root, "target", "qemux86-64");
  const three = join(two, "core2_64");
  mkdirSync(three, { recursive: true });
  const a = findDelta([two]);
  assert.equal(a.found?.root, root);
  assert.deepEqual(a.found?.manifest.built_recipes, ["htop"]);
  const b = findDelta([three]);
  assert.equal(b.found?.root, root);
  assert.deepEqual(b.found?.feedDirs, [three]);
  rmSync(dir, { recursive: true });
});

test("delta four levels above a path feed is not found", () => {
  const dir = tmp();
  const root = join(dir, "d");
  write(join(root, "delta.json"), DELTA);
  const deep = join(root, "a", "b", "c", "d");
  mkdirSync(deep, { recursive: true });
  assert.equal(findDelta([deep]).found, null);
  rmSync(dir, { recursive: true });
});

test("malformed delta manifest is no delta and carries a warning", () => {
  const dir = tmp();
  const root = join(dir, "d");
  write(join(root, "delta.json"), '{"built_recipes": "htop"}');
  mkdirSync(join(root, "target", "m"), { recursive: true });
  const r = findDelta([join(root, "target", "m")]);
  assert.equal(r.found, null);
  assert.equal(r.warnings.length, 1);
  rmSync(dir, { recursive: true });
});

test("recipe map reads entries and rejects a malformed file", () => {
  const dir = tmp();
  write(
    join(dir, "recipe-map.json"),
    JSON.stringify({
      schema_version: 1,
      entries: [
        {
          recipe: "htop",
          packages: ["htop"],
          layer: "meta-oe",
          epoch: 0,
          pv: "3.5.0",
          pr: "r0.1",
          srcrev: "INVALID",
          layer_commit: "abc1234",
          machine: "qemux86-64",
          release: "2026",
          task_hash: null,
        },
      ],
    }),
  );
  assert.equal(readRecipeMap(dir).map?.entries[0].pr, "r0.1");
  const bad = tmp();
  write(join(bad, "recipe-map.json"), "{not json");
  const r = readRecipeMap(bad);
  assert.equal(r.map, null);
  assert.equal(r.warnings.length, 1);
  assert.equal(readRecipeMap(join(bad, "absent")).warnings.length, 0);
  rmSync(dir, { recursive: true });
  rmSync(bad, { recursive: true });
});

test("recipe map accepts a null layer commit and still rejects a non-string one", () => {
  const entry = (layer_commit: unknown) => ({
    recipe: "htop",
    packages: ["htop"],
    layer: "meta-oe",
    epoch: 0,
    pv: "3.5.0",
    pr: "r0",
    srcrev: "",
    layer_commit,
    machine: "qemux86-64",
    release: "2026",
    task_hash: null,
  });
  const read = (c: unknown) => {
    const dir = tmp();
    write(
      join(dir, "recipe-map.json"),
      JSON.stringify({ schema_version: 1, entries: [entry(c)] }),
    );
    const r = readRecipeMap(dir);
    rmSync(dir, { recursive: true });
    return r;
  };
  const ok = read(null);
  assert.equal(ok.map?.entries[0].layer_commit, null);
  assert.deepEqual(ok.warnings, []);
  assert.equal(read(7).map, null);
});

// ---- workspace ------------------------------------------------------------

function layerWithHtop(ws: string, name: string): string {
  const repo = join(ws, name);
  initRepo(repo);
  write(join(repo, "recipes-support", "htop", "htop_3.5.0.bb"), "# htop\n");
  write(join(repo, "recipes-support", "htop", "files", "p.patch"), "x\n");
  git(repo, "add", "-A");
  commit(repo, "add htop");
  return repo;
}

test("workspace maps a recipe to its last commit and layer repository", () => {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  write(join(repo, "recipes-support", "htop", "files", "p.patch"), "y\n");
  git(repo, "add", "-A");
  const second = commit(repo, "touch files dir");
  const w = createWorkspace(ws);
  const groups = w.workspace.lastCommitFor("htop");
  assert.deepEqual(groups, [{ commit: second, layer: "meta-oe" }]);
  rmSync(ws, { recursive: true });
});

test("workspace gives each append its own group, in every layer", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const other = join(ws, "meta-custom");
  initRepo(other);
  write(join(other, "recipes-support", "htop", "htop_%.bbappend"), "# a\n");
  git(other, "add", "-A");
  const c2 = commit(other, "append");
  const groups = createWorkspace(ws).workspace.lastCommitFor("htop");
  assert.equal(groups.length, 2);
  assert.ok(groups.some((g) => g.layer === "meta-custom" && g.commit === c2));
  assert.ok(groups.some((g) => g.layer === "meta-oe"));
  rmSync(ws, { recursive: true });
});

test("a recipe found in two layers is unknown", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-a");
  layerWithHtop(ws, "meta-b");
  assert.deepEqual(createWorkspace(ws).workspace.lastCommitFor("htop"), []);
  assert.deepEqual(createWorkspace(ws).workspace.lastCommitFor("absent"), []);
  rmSync(ws, { recursive: true });
});

test("a recipe found in two layers is unknown and the warning names both layers", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-a");
  layerWithHtop(ws, "meta-b");
  const h = createWorkspace(ws);
  assert.deepEqual(h.workspace.lastCommitFor("htop"), []);
  h.workspace.lastCommitFor("htop");
  const w = h.failures.filter((f) => f.includes("htop"));
  assert.equal(w.length, 1, "one warning however often it is asked");
  assert.match(w[0], /meta-a/);
  assert.match(w[0], /meta-b/);
  rmSync(ws, { recursive: true });
});

test("an uncommitted recipe file has no commit: one group with an empty commit and a warning naming the file", () => {
  const ws = tmp();
  const repo = join(ws, "meta-a");
  initRepo(repo);
  write(join(repo, "README"), "x\n");
  git(repo, "add", "-A");
  commit(repo, "init");
  write(join(repo, "recipes-x", "foo", "foo_1.0.bb"), "# foo\n");
  const h = createWorkspace(ws);
  assert.deepEqual(h.workspace.lastCommitFor("foo"), [
    { commit: "", layer: "meta-a" },
  ]);
  assert.ok(
    h.failures.some((f) => f.includes("foo_1.0.bb") && /commit/.test(f)),
    h.failures.join("\n"),
  );
  rmSync(ws, { recursive: true });
});

test("a delta recipe whose file is uncommitted is no-cache-key, never stale-delta", () => {
  const ws = tmp();
  const repo = join(ws, "meta-a");
  initRepo(repo);
  write(join(repo, "README"), "x\n");
  git(repo, "add", "-A");
  commit(repo, "init");
  write(join(repo, "recipes-x", "foo", "foo_1.0.bb"), "# foo\n");
  const entry = {
    recipe: "foo",
    packages: ["foo"],
    layer: "meta-a",
    epoch: 0,
    pv: "1.0",
    pr: "r0",
    srcrev: "",
    layer_commit: "abcd",
    machine: "q",
    release: "2026",
    task_hash: null,
  };
  const r = classifyBuildPath({
    target: "q",
    release: "2026",
    channel: "edge",
    change: { recipes: ["foo"] },
    recipeMap: { schema_version: 1, entries: [entry] },
    delta: {
      manifest: {
        schema_version: 1,
        base: { release: "2026", channel: "edge", snapshot_id: null },
        built_recipes: ["foo"],
      },
      packages: [
        {
          name: "foo",
          epoch: 0,
          version: "1.0",
          release: "r0",
          sourcerpm: "foo-1.0-r0.src.rpm",
        },
      ],
    },
    workspace: createWorkspace(ws).workspace,
    published: {
      reachable: false,
      snapshotId: null,
      packages: [],
      buildManifest: null,
    },
    now: "x",
  });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.verdict.verdict, "package_miss");
  assert.ok(r.verdict.missing.every((m) => m.reason === "no-cache-key"));
  rmSync(ws, { recursive: true });
});

test("git exit 1 is not an error", () => {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  write(join(repo, "recipes-support", "nano", "nano_8.0.bb"), "# nano\n");
  git(repo, "add", "-A");
  const mid = commit(repo, "add nano");
  write(join(repo, "recipes-support", "htop", "htop_3.5.0.bb"), "# v2\n");
  git(repo, "add", "-A");
  const second = commit(repo, "touch htop");
  const w = createWorkspace(ws);
  assert.equal(w.workspace.lastCommitFor("htop")[0].commit, second);
  assert.equal(w.workspace.lastCommitFor("nano")[0].commit, mid);
  assert.equal(w.workspace.isAncestor(second, mid), false);
  assert.equal(w.workspace.isAncestor(mid, second), true);
  assert.equal(w.workspace.isAncestor(second, second), true);
  assert.deepEqual(w.failures, []);
  rmSync(ws, { recursive: true });
});

test("git exit 1 from the runner is false and records nothing; exit 128 is unproven and recorded", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  let status = 1;
  const run = (_cwd: string, args: string[]): GitResult =>
    args.includes("merge-base")
      ? { status, stdout: "" }
      : args[0] === "status"
        ? { status: 0, stdout: "" }
        : { status: 0, stdout: "a".repeat(40) + "\n" };
  const w = createWorkspace(ws, run);
  w.workspace.lastCommitFor("htop");
  assert.equal(w.workspace.isAncestor("a".repeat(40), "b".repeat(40)), false);
  assert.deepEqual(w.failures, []);
  status = 128;
  assert.equal(w.workspace.isAncestor("a".repeat(40), "c".repeat(40)), null);
  assert.equal(w.failures.length, 1);
  rmSync(ws, { recursive: true });
});

test("isAncestor refuses a commit that is not hexadecimal", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const calls: string[][] = [];
  const run = (_cwd: string, args: string[]): GitResult => {
    calls.push(args);
    if (args[0] === "status") return { status: 0, stdout: "" };
    return { status: 0, stdout: "a".repeat(40) + "\n" };
  };
  const w = createWorkspace(ws, run);
  w.workspace.lastCommitFor("htop");
  const before = calls.length;
  assert.equal(w.workspace.isAncestor("a".repeat(40), "--output=x"), null);
  assert.equal(calls.length, before);
  rmSync(ws, { recursive: true });
});

test("recipesInDir names every recipe whose file sits in the directory", () => {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  write(join(repo, "recipes-core", "glibc", "glibc_2.40.bb"), "# a\n");
  write(join(repo, "recipes-core", "glibc", "glibc-locale_2.40.bb"), "# b\n");
  write(join(repo, "recipes-core", "glibc", "glibc.inc"), "# c\n");
  git(repo, "add", "-A");
  commit(repo, "glibc");
  const w = createWorkspace(ws).workspace;
  assert.deepEqual(w.recipesInDir?.("meta-oe/recipes-core/glibc"), [
    "glibc",
    "glibc-locale",
  ]);
  assert.deepEqual(w.recipesInDir?.("recipes-core/glibc"), [
    "glibc",
    "glibc-locale",
  ]);
  assert.deepEqual(w.recipesInDir?.("meta-oe/recipes-support/htop"), ["htop"]);
  assert.deepEqual(w.recipesInDir?.("meta-oe/recipes-core/absent"), []);
  rmSync(ws, { recursive: true });
});

test("recipesInDir is scoped to the layer of the changed path", () => {
  const ws = tmp();
  const a = join(ws, "meta-a");
  const b = join(ws, "meta-b");
  initRepo(a);
  initRepo(b);
  write(join(a, "recipes-core", "foo", "foo_1.bb"), "# a\n");
  write(join(b, "recipes-core", "foo", "bar_1.bb"), "# b\n");
  for (const r of [a, b]) {
    git(r, "add", "-A");
    commit(r, "x");
  }
  const w = createWorkspace(ws).workspace;
  assert.deepEqual(w.recipesInDir?.("meta-a/recipes-core/foo"), ["foo"]);
  assert.deepEqual(w.recipesInDir?.("meta-b/recipes-core/foo"), ["bar"]);
  rmSync(ws, { recursive: true });
});

test("a repository-relative path matches every layer holding the directory", () => {
  const ws = tmp();
  const a = join(ws, "meta-a");
  const b = join(ws, "meta-b");
  initRepo(a);
  initRepo(b);
  write(join(a, "recipes-core", "foo", "foo_1.bb"), "# a\n");
  write(join(b, "recipes-core", "foo", "bar_1.bb"), "# b\n");
  for (const r of [a, b]) {
    git(r, "add", "-A");
    commit(r, "x");
  }
  const w = createWorkspace(ws).workspace;
  assert.deepEqual([...(w.recipesInDir?.("recipes-core/foo") ?? [])].sort(), [
    "bar",
    "foo",
  ]);
  assert.deepEqual(w.recipesInDir?.("meta-a/recipes-core/foo"), ["foo"]);
  assert.deepEqual(w.recipesInDir?.("meta-b/recipes-core/foo"), ["bar"]);
  rmSync(ws, { recursive: true });
});

test("recipesInDir finds a layer kept in a subdirectory of its repository", () => {
  const ws = tmp();
  const repo = join(ws, "meta-repo");
  initRepo(repo);
  write(join(repo, "meta-sub", "recipes-core", "zlib", "zlib_1.3.bb"), "# z\n");
  git(repo, "add", "-A");
  commit(repo, "z");
  const w = createWorkspace(ws).workspace;
  assert.deepEqual(w.recipesInDir?.("meta-sub/recipes-core/zlib"), ["zlib"]);
  assert.deepEqual(w.recipesInDir?.("meta-repo/meta-sub/recipes-core/zlib"), [
    "zlib",
  ]);
  assert.deepEqual(w.recipesInDir?.("meta-other/recipes-core/zlib"), []);
  rmSync(ws, { recursive: true });
});

test("a sibling recipe's subdirectory counts toward every recipe of the directory", () => {
  const ws = tmp();
  const repo = join(ws, "meta");
  initRepo(repo);
  const dir = join(repo, "recipes-devtools", "gcc");
  write(join(dir, "gcc_14.bb"), "# gcc\n");
  write(join(dir, "gcc-cross_14.bb"), "# cross\n");
  write(join(dir, "gcc", "0001.patch"), "a\n");
  git(repo, "add", "-A");
  commit(repo, "gcc");
  write(join(dir, "gcc", "0002.patch"), "b\n");
  git(repo, "add", "-A");
  const patch = commit(repo, "patch in gcc/");
  const w = createWorkspace(ws).workspace;
  // gcc-cross names no gcc/ directory itself, but searches it.
  assert.deepEqual(w.lastCommitFor("gcc-cross"), [
    { commit: patch, layer: "meta" },
  ]);
  rmSync(ws, { recursive: true });
});

test("a shared .inc beside the recipe counts toward its last commit", () => {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  write(join(repo, "recipes-support", "htop", "htop.inc"), "# a\n");
  git(repo, "add", "-A");
  commit(repo, "add inc");
  write(join(repo, "recipes-support", "htop", "htop.inc"), "# b\n");
  git(repo, "add", "-A");
  const incChange = commit(repo, "change inc");
  const groups = createWorkspace(ws).workspace.lastCommitFor("htop");
  assert.deepEqual(groups, [{ commit: incChange, layer: "meta-oe" }]);
  rmSync(ws, { recursive: true });
});

test("a workspace that is itself a repository still finds nested layer repositories", () => {
  const ws = tmp();
  initRepo(ws);
  write(join(ws, "README"), "x\n");
  git(ws, "add", "-A");
  commit(ws, "root");
  write(join(ws, ".gitignore"), "meta-b/\n");
  const nested = join(ws, "meta-b");
  initRepo(nested);
  write(join(nested, "recipes-x", "foo", "foo_1.0.bb"), "# foo\n");
  git(nested, "add", "-A");
  const c = commit(nested, "add foo");
  const w = createWorkspace(ws);
  assert.deepEqual(w.workspace.lastCommitFor("foo"), [
    { commit: c, layer: "meta-b" },
  ]);
  assert.deepEqual(w.workspace.duplicateLayers?.("foo"), []);
  assert.deepEqual(w.failures, []);
  rmSync(ws, { recursive: true });
});

test("git is asked once per recipe and per commit pair", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  let n = 0;
  const run = (_cwd: string, args: string[]): GitResult => {
    n++;
    return args.includes("merge-base") || args[0] === "status"
      ? { status: 0, stdout: "" }
      : { status: 0, stdout: "a".repeat(40) + "\n" };
  };
  const w = createWorkspace(ws, run).workspace;
  w.lastCommitFor("htop");
  w.lastCommitFor("htop");
  assert.equal(n, 2, "one git log and one git status for the group");
  w.isAncestor("a".repeat(40), "b".repeat(40));
  w.isAncestor("a".repeat(40), "b".repeat(40));
  assert.equal(n, 3);
  rmSync(ws, { recursive: true });
});

// ---- uncommitted changes in a file group -----------------------------------

const GROUP = join("recipes-support", "htop");

function dirtyGroup(setup: (repo: string) => void, expectNote: RegExp): void {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  // Tracked siblings so a new file can sit next to one in an existing dir.
  write(join(repo, GROUP, "files", "q.patch"), "q\n");
  write(join(repo, GROUP, "htop.inc"), "# inc\n");
  git(repo, "add", "-A");
  commit(repo, "more htop");
  setup(repo);
  const h = createWorkspace(ws);
  const groups = h.workspace.lastCommitFor("htop");
  assert.deepEqual(groups, [{ commit: "", layer: "meta-oe" }]);
  assert.ok(
    h.failures.some((f) => expectNote.test(f) && /commit them/.test(f)),
    h.failures.join("\n"),
  );
  rmSync(ws, { recursive: true });
}

test("a modified patch in files/ gives no commit and a note naming the file", () => {
  dirtyGroup((repo) => {
    write(join(repo, GROUP, "files", "p.patch"), "changed\n");
  }, /files\/p\.patch/);
});

test("a staged-only change gives no commit", () => {
  dirtyGroup((repo) => {
    write(join(repo, GROUP, "files", "p.patch"), "staged\n");
    git(repo, "add", "-A");
  }, /files\/p\.patch/);
});

test("a deleted tracked file in the group gives no commit", () => {
  dirtyGroup((repo) => {
    rmSync(join(repo, GROUP, "files", "q.patch"));
  }, /files\/q\.patch/);
});

test("a new untracked file beside a tracked one in the group gives no commit", () => {
  dirtyGroup((repo) => {
    write(join(repo, GROUP, "files", "new.patch"), "n\n");
  }, /files\/new\.patch/);
});

test("a dirty .inc gives no commit", () => {
  dirtyGroup((repo) => {
    write(join(repo, GROUP, "htop.inc"), "# edited\n");
  }, /htop\.inc/);
});

test("a dirty .bbappend in a second layer gives that group no commit", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const other = join(ws, "meta-custom");
  initRepo(other);
  write(join(other, GROUP, "htop_%.bbappend"), "# a\n");
  git(other, "add", "-A");
  commit(other, "append");
  write(join(other, GROUP, "htop_%.bbappend"), "# dirty\n");
  const h = createWorkspace(ws);
  const groups = h.workspace.lastCommitFor("htop");
  assert.equal(groups.length, 2);
  assert.match(
    groups.find((g) => g.layer === "meta-oe")?.commit ?? "",
    /^[0-9a-f]{40}$/,
  );
  assert.equal(groups.find((g) => g.layer === "meta-custom")?.commit, "");
  assert.ok(
    h.failures.some(
      (f) => f.startsWith("meta-custom:") && /htop_%\.bbappend/.test(f),
    ),
    h.failures.join("\n"),
  );
  rmSync(ws, { recursive: true });
});

test("dirt only in an unrelated file keeps the real commit and adds no note", () => {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  const head = git(repo, "rev-parse", "HEAD");
  write(join(repo, "README"), "r\n");
  write(join(repo, "recipes-support", "nano", "nano_8.0.bb"), "# nano\n");
  const h = createWorkspace(ws);
  assert.deepEqual(h.workspace.lastCommitFor("htop"), [
    { commit: head, layer: "meta-oe" },
  ]);
  assert.deepEqual(h.failures, []);
  rmSync(ws, { recursive: true });
});

test("a failed git status fails closed and is recorded", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const run = (_cwd: string, args: string[]): GitResult =>
    args[0] === "status"
      ? { status: 128, stdout: "" }
      : { status: 0, stdout: "a".repeat(40) + "\n" };
  const h = createWorkspace(ws, run);
  assert.deepEqual(h.workspace.lastCommitFor("htop"), [
    { commit: "", layer: "meta-oe" },
  ]);
  assert.ok(h.failures.some((f) => /git status/.test(f) && /128/.test(f)));
  rmSync(ws, { recursive: true });
});

test("a timed-out git status (null exit status) fails closed", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const run = (_cwd: string, args: string[]): GitResult =>
    args[0] === "status"
      ? { status: null, stdout: "" }
      : { status: 0, stdout: "a".repeat(40) + "\n" };
  const h = createWorkspace(ws, run);
  assert.equal(h.workspace.lastCommitFor("htop")[0].commit, "");
  assert.ok(
    h.failures.some((f) => /git status/.test(f) && /no exit status/.test(f)),
  );
  rmSync(ws, { recursive: true });
});

test("status output beyond ten paths names ten and counts the rest", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const recs = Array.from({ length: 13 }, (_, i) => ` M f${i}.patch\0`).join(
    "",
  );
  const run = (_cwd: string, args: string[]): GitResult =>
    args[0] === "status"
      ? { status: 0, stdout: recs }
      : { status: 0, stdout: "a".repeat(40) + "\n" };
  const h = createWorkspace(ws, run);
  h.workspace.lastCommitFor("htop");
  const w = h.failures.find((f) => /uncommitted/.test(f)) ?? "";
  assert.match(w, /f9\.patch/);
  assert.doesNotMatch(w, /f10\.patch/);
  assert.match(w, /and 3 more/);
  rmSync(ws, { recursive: true });
});

test("status is not run for a group whose log result was empty", () => {
  const ws = tmp();
  layerWithHtop(ws, "meta-oe");
  const calls: string[] = [];
  const run = (_cwd: string, args: string[]): GitResult => {
    calls.push(args[0]);
    return { status: 0, stdout: "" };
  };
  const h = createWorkspace(ws, run);
  h.workspace.lastCommitFor("htop");
  assert.deepEqual(calls, ["log"]);
  assert.equal(h.failures.length, 1);
  rmSync(ws, { recursive: true });
});

test("a dirty group is package_miss with no-cache-key on both rules, never a hit or stale-delta", () => {
  const ws = tmp();
  const repo = layerWithHtop(ws, "meta-oe");
  const head = git(repo, "rev-parse", "HEAD");
  write(join(repo, GROUP, "files", "p.patch"), "dirty\n");
  const entry = {
    recipe: "htop",
    packages: ["htop"],
    layer: "meta-oe",
    epoch: 0,
    pv: "3.5.0",
    pr: "r0",
    srcrev: "",
    layer_commit: head,
    machine: "q",
    release: "2026",
    task_hash: null,
  };
  const pkg = {
    name: "htop",
    epoch: 0,
    version: "3.5.0",
    release: "r0",
    sourcerpm: "htop-3.5.0-r0.src.rpm",
  };
  const base = {
    target: "q",
    release: "2026",
    channel: "edge",
    change: { recipes: ["htop"] },
    recipeMap: { schema_version: 1 as const, entries: [entry] },
    workspace: createWorkspace(ws).workspace,
    now: "x",
  };
  const local = classifyBuildPath({
    ...base,
    delta: {
      manifest: {
        schema_version: 1,
        base: { release: "2026", channel: "edge", snapshot_id: null },
        built_recipes: ["htop"],
      },
      packages: [pkg],
    },
    published: null,
  });
  const published = classifyBuildPath({
    ...base,
    delta: null,
    published: {
      reachable: true,
      snapshotId: "s1",
      packages: [pkg],
      buildManifest: { layers: { "meta-oe": head } },
    },
  });
  for (const r of [local, published]) {
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.ok(r.verdict.missing.length > 0);
    assert.ok(r.verdict.missing.every((m) => m.reason === "no-cache-key"));
  }
  rmSync(ws, { recursive: true });
});

// ---- mirror ---------------------------------------------------------------

test("mirror directory: tool input wins over the environment", () => {
  const env = { AVOCADO_FEED_MIRROR_DIR: "/env/dir" };
  assert.equal(mirrorDirFrom("/input/dir", env), "/input/dir");
  assert.equal(mirrorDirFrom(undefined, env), "/env/dir");
  assert.equal(mirrorDirFrom("  ", env), "/env/dir");
  assert.equal(mirrorDirFrom(undefined, {}), undefined);
});

test("mirror marker is read from release/channel/repo", () => {
  const dir = tmp();
  write(
    join(dir, "2026", "edge", "target", "m", "noarch", ".bakar-mirror.json"),
    JSON.stringify({ repomd_sha256: "ab".repeat(32), mode: "metadata-only" }),
  );
  assert.equal(
    readMirrorMarker(dir, "2026", "edge", "target/m/noarch"),
    "ab".repeat(32),
  );
  assert.equal(readMirrorMarker(dir, "2026", "edge", "target/m/none"), null);
  assert.equal(readMirrorMarker(dir, "2026", "edge", "../etc"), null);
  rmSync(dir, { recursive: true });
});

// ---- published state ------------------------------------------------------

const REPO = "target/qemux86-64/noarch";
const HEX40 = "c".repeat(40);

function feed(over: Partial<ResolvedFeed> = {}): ResolvedFeed {
  return {
    baseUrl: "https://repo.example",
    releasever: "2026/edge",
    manifestPath: "2026/edge",
    release: "2026",
    channel: "edge",
    sources: { repoUrl: "default", releasever: "default" },
    notes: [],
    ...over,
  } as ResolvedFeed;
}

const fpkg = (name: string): FeedPackage =>
  ({
    name,
    summary: "",
    description: "",
    version: "1",
    release: "r0",
    arch: "noarch",
    repo: REPO,
    href: "",
    epoch: 0,
    sourcerpm: `${name}-1-r0.src.rpm`,
  }) as FeedPackage;

interface Calls {
  digest: number;
  remotePackages: number;
  /** releasever of each remote package read. */
  remoteReleasevers: string[];
  mirrorPaths: string[];
}

function stub(
  opts: {
    down?: boolean;
    /** targets.json fails while the snapshot pointer answers. */
    manifestDown?: boolean;
    digest?: string;
    /** Digest of a snapshot's repomd when it differs from the head's. */
    snapshotDigest?: string;
    build?: "ok" | "none";
  } = {},
): { client: PublishedClient; calls: Calls } {
  const calls: Calls = {
    digest: 0,
    remotePackages: 0,
    remoteReleasevers: [],
    mirrorPaths: [],
  };
  const client = {
    getTargetManifest: async () =>
      opts.down || opts.manifestDown ? null : { "qemux86-64": [REPO] },
    fetchSnapshotPointer: async () => (opts.down ? null : "snap-latest"),
    fetchBuildManifest: async (_f: unknown, id: string) =>
      opts.down
        ? { kind: "unreachable" as const, reason: "down" }
        : opts.build === "none"
          ? { kind: "no-cache-key" as const, reason: "absent" }
          : {
              kind: "manifest" as const,
              commit: HEX40,
              layers: { "meta-oe": id.padEnd(40, "0") },
            },
    fetchRepoPackageInfos: async (f: { releasever: string }) => {
      calls.remotePackages++;
      calls.remoteReleasevers.push(f.releasever);
      return [
        {
          name: "remote",
          epoch: 0,
          version: "1",
          release: "r0",
          sourcerpm: "",
        },
      ];
    },
    fetchRepomdDigest: async (f: { releasever: string }) => {
      calls.digest++;
      if (opts.down) throw new Error("down");
      if (f.releasever.includes("/snapshots/") && opts.snapshotDigest)
        return opts.snapshotDigest;
      return opts.digest ?? "ab".repeat(32);
    },
    fetchExtraFeed: async (x: { path?: string }) => {
      calls.mirrorPaths.push(x.path ?? "");
      return [fpkg("mirrored")];
    },
  } as unknown as PublishedClient;
  return { client, calls };
}

function mirrorWith(digest: string): string {
  const dir = tmp();
  write(
    join(dir, "2026", "edge", REPO, ".bakar-mirror.json"),
    JSON.stringify({ repomd_sha256: digest }),
  );
  return dir;
}

test("fresh mirror serves package metadata after only a digest check", async () => {
  const mirror = mirrorWith("ab".repeat(32));
  const { client, calls } = stub();
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(calls.remotePackages, 0);
  // The head's and the pointed snapshot's metadata index, one request each.
  assert.equal(calls.digest, 2);
  assert.deepEqual(calls.mirrorPaths, [join(mirror, "2026", "edge", REPO)]);
  assert.equal(r.published.packages[0].name, "mirrored");
  assert.equal(r.published.reachable, true);
  assert.equal(r.published.snapshotId, "snap-latest");
  assert.equal(r.mirrorConfigured, true);
  assert.deepEqual(r.warnings, []);
  rmSync(mirror, { recursive: true });
});

test("a matching pin skips the mirror and reads the remote", async () => {
  const mirror = mirrorWith("ab".repeat(32));
  const { client, calls } = stub();
  const r = await loadPublishedState({
    client,
    feed: feed({
      snapshot: "snap-pinned",
      releasever: "2026/edge/snapshots/snap-pinned",
    }),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(calls.digest, 0);
  assert.equal(calls.mirrorPaths.length, 0);
  assert.equal(calls.remotePackages, 1);
  assert.equal(r.published.snapshotId, "snap-pinned");
  assert.deepEqual(r.warnings, []);
  rmSync(mirror, { recursive: true });
});

test("a stale mirror reads the remote and warns", async () => {
  const mirror = mirrorWith("00".repeat(32));
  const { client, calls } = stub({ digest: "ab".repeat(32) });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(calls.remotePackages, 1);
  assert.equal(calls.mirrorPaths.length, 0);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /stale/);
  rmSync(mirror, { recursive: true });
});

test("a mirror matching the head but not the pointed snapshot is not used", async () => {
  const mirror = mirrorWith("ab".repeat(32));
  const { client, calls } = stub({ snapshotDigest: "cd".repeat(32) });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(calls.mirrorPaths.length, 0);
  assert.equal(calls.remotePackages, 1);
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /snapshot/);
  rmSync(mirror, { recursive: true });
});

test("remote down with a mirror reads the mirror and warns freshness was not verified", async () => {
  const mirror = mirrorWith("ab".repeat(32));
  const { client } = stub({ down: true });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(r.published.reachable, false);
  assert.equal(r.published.packages[0].name, "mirrored");
  assert.equal(r.published.buildManifest, null);
  assert.equal(r.mirrorConfigured, true);
  assert.match(r.warnings.join("\n"), /not verified/);
  rmSync(mirror, { recursive: true });
});

test("remote down without a mirror is unreachable with a warning", async () => {
  const { client } = stub({ down: true });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
  });
  assert.equal(r.published.reachable, false);
  assert.deepEqual(r.published.packages, []);
  assert.equal(r.mirrorConfigured, false);
  assert.match(r.warnings.join("\n"), /could not be read/);
});

test("targets.json down with the pointer answering is an unreachable remote, with a warning", async () => {
  const { client, calls } = stub({ manifestDown: true });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
  });
  assert.equal(r.published.reachable, false);
  assert.deepEqual(r.published.packages, []);
  assert.equal(calls.remotePackages, 0);
  assert.match(r.warnings.join("\n"), /could not be read/);
});

test("targets.json down with a mirror lacking the target says the remote was unreadable", async () => {
  const mirror = tmp();
  const { client } = stub({ manifestDown: true });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(r.published.reachable, false);
  const w = r.warnings.join("\n");
  assert.match(w, /remote feed could not be read/);
  assert.match(w, /no repository for qemux86-64/);
  rmSync(mirror, { recursive: true });
});

test("a live head read asks the snapshot the pointer names, so the packages match the manifest", async () => {
  const { client, calls } = stub();
  await loadPublishedState({ client, feed: feed(), target: "qemux86-64" });
  assert.deepEqual(calls.remoteReleasevers, [
    "2026/edge/snapshots/snap-latest",
  ]);
});

test("a pin recorded against another feed URL is not used", async () => {
  const mirror = mirrorWith("ab".repeat(32));
  const { client, calls } = stub();
  const r = await loadPublishedState({
    client,
    feed: feed({
      snapshot: "snap-pinned",
      snapshotRepoUrl: "https://elsewhere.example/",
      releasever: "2026/edge/snapshots/snap-pinned",
    }),
    target: "qemux86-64",
    mirrorDir: mirror,
  });
  assert.equal(r.published.snapshotId, "snap-latest");
  assert.equal(calls.digest, 2);
  assert.equal(calls.mirrorPaths.length, 1);
  rmSync(mirror, { recursive: true });
});

test("a pin recorded against the feed URL in use, trailing slash aside, is used", async () => {
  const { client, calls } = stub();
  const r = await loadPublishedState({
    client,
    feed: feed({
      snapshot: "snap-pinned",
      snapshotRepoUrl: "https://repo.example/",
      releasever: "2026/edge/snapshots/snap-pinned",
    }),
    target: "qemux86-64",
  });
  assert.equal(r.published.snapshotId, "snap-pinned");
  assert.deepEqual(calls.remoteReleasevers, [
    "2026/edge/snapshots/snap-pinned",
  ]);
});

test("missing build manifest leaves the manifest null and the remote reachable", async () => {
  const { client } = stub({ build: "none" });
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
  });
  assert.equal(r.published.reachable, true);
  assert.equal(r.published.buildManifest, null);
});

test("build manifest layers reach the published state", async () => {
  const { client } = stub();
  const r = await loadPublishedState({
    client,
    feed: feed(),
    target: "qemux86-64",
  });
  assert.equal(r.commit, HEX40);
  assert.equal(
    r.published.buildManifest?.layers["meta-oe"],
    "snap-latest".padEnd(40, "0"),
  );
});

test("the fallback feed entry masks secrets in its url", () => {
  const f = feed({
    baseUrl: "https://repo.example/tok-secret-9",
    masks: ["tok-secret-9"],
    feeds: [],
  });
  const out = verdictFeeds(f, "s1", null);
  assert.equal(out.length, 1);
  assert.doesNotMatch(out[0].url_or_path, /tok-secret-9/);
});

// ---- CLI version ----------------------------------------------------------

test("the version query runs the binary named by the injected environment", async () => {
  const dir = tmp();
  const bin = join(dir, "fake-avocado");
  write(bin, "#!/bin/sh\necho 'avocado 0.9.0'\n");
  chmodSync(bin, 0o755);
  assert.match(
    (await cliVersionWarning(undefined, { AVOCADO_BINARY: bin })) ?? "",
    /0\.9\.0/,
  );
  rmSync(dir, { recursive: true });
});

test("an avocado CLI older than 1.0.0 warns; a current or absent one does not", async () => {
  assert.match(
    (await cliVersionWarning(async () => "avocado 0.41.0\n")) ?? "",
    /1\.0\.0/,
  );
  assert.match(
    (await cliVersionWarning(async () => "avocado 1.0.0-rc.5")) ?? "",
    /older than 1\.0\.0/,
  );
  assert.equal(await cliVersionWarning(async () => "avocado 1.0.0"), null);
  assert.equal(await cliVersionWarning(async () => "avocado 1.2.0"), null);
  assert.equal(
    await cliVersionWarning(async () => {
      throw new Error("not found");
    }),
    null,
  );
});
