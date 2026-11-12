import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyBuildPath,
  imageClassOf,
  recipeDirOfPath,
  recipeOfPath,
  selectSnapshot,
  type ClassifyInput,
  type PackageInfo,
  type RecipeMapEntry,
  type Verdict,
  type Workspace,
} from "../../src/lib/build-path.js";

const pkg = (
  name: string,
  version = "3.3.0",
  release = "r0",
  epoch = 0,
  recipe = name,
): PackageInfo => ({
  name,
  epoch,
  version,
  release,
  sourcerpm: `${recipe}-${version}-${release}.src.rpm`,
});

const entry = (over: Partial<RecipeMapEntry> = {}): RecipeMapEntry => ({
  recipe: "htop",
  packages: ["htop"],
  layer: "meta-oe",
  epoch: 0,
  pv: "3.3.0",
  pr: "r0",
  srcrev: "INVALID",
  layer_commit: "abc1234",
  machine: "qemux86-64",
  release: "2026",
  task_hash: "th-htop",
  ...over,
});

/** Commit history as a linear list; a is an ancestor of b when it is not later. */
function workspace(
  groups: Record<string, Array<{ commit: string; layer: string }>>,
  history: string[],
  dirs: Record<string, string[]> = {},
): Workspace {
  return {
    lastCommitFor: (r) => groups[r] ?? [],
    recipesInDir: (d) => dirs[d] ?? [],
    isAncestor: (a, b) => {
      const i = history.findIndex((h) => h.startsWith(a) || a.startsWith(h));
      const j = history.findIndex((h) => h.startsWith(b) || b.startsWith(h));
      return i >= 0 && j >= 0 && i <= j;
    },
  };
}

const base = (over: Partial<ClassifyInput> = {}): ClassifyInput => ({
  target: "qemux86-64",
  release: "2026",
  channel: "edge",
  change: { recipes: ["htop"] },
  recipeMap: { schema_version: 1, entries: [entry()] },
  delta: {
    manifest: {
      schema_version: 1,
      base: { release: "2026", channel: "edge", snapshot_id: null },
      built_recipes: ["htop"],
    },
    packages: [pkg("htop")],
  },
  workspace: workspace({ htop: [{ commit: "abc1234", layer: "meta-oe" }] }, [
    "abc1234",
    "def5678",
  ]),
  published: {
    reachable: true,
    snapshotId: "s1",
    packages: [],
    buildManifest: null,
  },
  now: "2026-11-11T00:00:00.000Z",
  ...over,
});

function verdictOf(input: ClassifyInput): Verdict {
  const r = classifyBuildPath(input);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) throw new Error("unreachable");
  return r.verdict;
}

// ---- image-level path classes: one test each ----

const imageClasses: Array<[string, string]> = [
  ["machine configuration", "meta-avocado/conf/machine/qemux86-64.conf"],
  ["kas machine file", "kas/machine/qemux86-64.yml"],
  ["kernel recipe", "meta-avocado/recipes-kernel/linux/linux-yocto_6.12.bb"],
  ["kernel fragment", "meta-avocado/recipes-foo/linux-yocto/files/debug.cfg"],
  ["board-support layer path", "meta-avocado-nxp/recipes-bsp/u-boot/u-boot.bb"],
  ["layer.conf", "meta-avocado/conf/layer.conf"],
  ["distro configuration", "meta-avocado/conf/distro/avocado.conf"],
  [
    "package group",
    "meta-avocado/recipes-core/packagegroups/packagegroup-x.bb",
  ],
  ["image recipe", "meta-avocado/recipes-core/images/avocado-image.bb"],
];

for (const [label, path] of imageClasses) {
  test(`${label} path is image miss`, () => {
    assert.notEqual(imageClassOf(path), null);
    const v = verdictOf(base({ change: { paths: [path] } }));
    assert.equal(v.verdict, "image_miss");
    assert.equal(v.reasons.length, 1);
    assert.match(v.reasons[0], new RegExp(path.replace(/[.]/g, "\\.")));
    assert.deepEqual(v.missing, []);
  });
}

test("package hit with layer change is image miss", () => {
  const v = verdictOf(
    base({
      change: {
        recipes: ["htop"],
        paths: ["meta-avocado/conf/layer.conf"],
      },
    }),
  );
  assert.equal(v.verdict, "image_miss");
});

test("ordinary recipe path is not image level", () => {
  assert.equal(
    imageClassOf("meta-oe/recipes-support/htop/htop_3.3.0.bb"),
    null,
  );
  assert.equal(imageClassOf("meta-oe/recipes-kernelish/foo.bb"), null);
});

// ---- path to recipe mapping ----

test("recipe name is the file name before the first underscore", () => {
  assert.equal(recipeOfPath("a/b/htop_3.3.0.bb"), "htop");
  assert.equal(recipeOfPath("a/b/htop_%.bbappend"), "htop");
  assert.equal(recipeOfPath("a/b/htop.bb"), "htop");
  assert.equal(recipeOfPath("a/b/README.md"), null);
  assert.equal(recipeOfPath("a/b/files/htop.patch"), null);
});

test("changed recipe path counts as naming that recipe", () => {
  const v = verdictOf(
    base({ change: { paths: ["meta-oe/recipes-support/htop/htop_3.3.0.bb"] } }),
  );
  assert.equal(v.verdict, "feed_hit");
  assert.equal(v.cache_keys.local.htop, "th-htop");
});

test("only ignored paths classify the recipes of the map", () => {
  const v = verdictOf(base({ change: { paths: ["README.md"] } }));
  assert.equal(v.verdict, "feed_hit");
  assert.equal(v.cache_keys.local.htop, "th-htop");
});

test("only ignored paths with no recipe map is an error", () => {
  const r = classifyBuildPath(
    base({ change: { paths: ["README.md"] }, recipeMap: null }),
  );
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nothing to classify/);
});

test("no recipe, no path and no recipe map is an error with no verdict", () => {
  const r = classifyBuildPath(base({ change: {}, recipeMap: null }));
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /nothing to classify/);
});

test("no recipe named classifies the recipes of the map", () => {
  const v = verdictOf(base({ change: {} }));
  assert.equal(v.verdict, "feed_hit");
});

// ---- rule (a) ----

test("recipe built into the delta at the recorded commit is feed hit", () => {
  const v = verdictOf(base());
  assert.equal(v.verdict, "feed_hit");
  assert.deepEqual(v.missing, []);
  assert.deepEqual(v.cache_keys.local, { htop: "th-htop" });
  assert.equal(v.target, "qemux86-64");
  assert.equal(v.generated_at, "2026-11-11T00:00:00.000Z");
  assert.equal(v.schema_version, 1);
});

test("null task hash reports the five-field key and never null", () => {
  const v = verdictOf(
    base({
      recipeMap: {
        schema_version: 1,
        entries: [entry({ task_hash: null, srcrev: "deadbeef" })],
      },
    }),
  );
  assert.equal(v.cache_keys.local.htop, "0|3.3.0|r0|deadbeef|abc1234");
});

test("patch after delta build is package miss", () => {
  const v = verdictOf(
    base({
      workspace: workspace(
        { htop: [{ commit: "def5678", layer: "meta-oe" }] },
        ["abc1234", "def5678"],
      ),
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(v.missing, [
    { recipe: "htop", package: "htop", reason: "stale-delta" },
  ]);
});

test("append file newer than the delta build is stale", () => {
  const v = verdictOf(
    base({
      workspace: workspace(
        {
          htop: [
            { commit: "abc1234", layer: "meta-oe" },
            { commit: "def5678", layer: "meta-oe" },
          ],
        },
        ["abc1234", "def5678"],
      ),
    }),
  );
  assert.equal(v.missing[0].reason, "stale-delta");
});

test("append in another layer is not compared against the recipe layer commit", () => {
  // The append group lives in meta-avocado; entry.layer_commit is meta-oe's,
  // so the ancestor test across repositories proves nothing.
  const v = verdictOf(
    base({
      workspace: workspace(
        {
          htop: [
            { commit: "abc1234", layer: "meta-oe" },
            { commit: "def5678", layer: "meta-avocado" },
          ],
        },
        ["abc1234", "def5678"],
      ),
    }),
  );
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("linuxptp config and kas recipe directory are not image level", () => {
  assert.equal(
    imageClassOf("meta-oe/recipes-connectivity/linuxptp/files/ptp4l.cfg"),
    null,
  );
  assert.equal(imageClassOf("meta-oe/recipes-devtools/kas/kas_4.7.bb"), null);
});

test("package at another version is version-differs", () => {
  const v = verdictOf(
    base({
      delta: {
        manifest: {
          schema_version: 1,
          base: { release: "2026", channel: "edge", snapshot_id: null },
          built_recipes: ["htop"],
        },
        packages: [pkg("htop", "3.2.0")],
      },
    }),
  );
  assert.equal(v.missing[0].reason, "version-differs");
});

test("every package of the entry must be present", () => {
  const v = verdictOf(
    base({
      recipeMap: {
        schema_version: 1,
        entries: [entry({ packages: ["htop", "htop-doc"] })],
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(
    v.missing.map((m) => m.package),
    ["htop", "htop-doc"],
  );
});

test("different epoch is a miss", () => {
  const v = verdictOf(
    base({
      delta: {
        manifest: {
          schema_version: 1,
          base: { release: "2026", channel: "edge", snapshot_id: null },
          built_recipes: ["htop"],
        },
        packages: [pkg("htop", "3.3.0", "r0", 1)],
      },
    }),
  );
  assert.equal(v.missing[0].reason, "version-differs");
});

test("without a workspace the local rule cannot be checked", () => {
  const v = verdictOf(base({ workspace: null }));
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("recipe not in built_recipes does not use the local rule", () => {
  const v = verdictOf(
    base({
      delta: {
        manifest: {
          schema_version: 1,
          base: { release: "2026", channel: "edge", snapshot_id: null },
          built_recipes: [],
        },
        packages: [pkg("htop")],
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
});

test("recipe map for another machine skips rule (a) with a warning", () => {
  const v = verdictOf(
    base({
      recipeMap: {
        schema_version: 1,
        entries: [entry({ machine: "raspberrypi5" })],
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.ok(v.warnings.some((w) => /another machine or release/.test(w)));
});

test("recipe map for another release stream skips rule (a) with a warning", () => {
  const v = verdictOf(
    base({
      recipeMap: { schema_version: 1, entries: [entry({ release: "2024" })] },
    }),
  );
  assert.ok(v.warnings.some((w) => /another machine or release/.test(w)));
  assert.equal(v.verdict, "package_miss");
});

test("missing recipe map warns and leaves recipes to the published lookup", () => {
  const v = verdictOf(base({ recipeMap: null }));
  assert.ok(v.warnings.some((w) => /recipe map is missing/.test(w)));
  assert.equal(v.verdict, "package_miss");
});

test("caller-named recipes beat the recipe map", () => {
  const v = verdictOf(
    base({
      change: { recipes: ["nano"] },
      recipeMap: {
        schema_version: 1,
        entries: [entry(), entry({ recipe: "nano", packages: ["nano"] })],
      },
      delta: {
        manifest: {
          schema_version: 1,
          base: { release: "2026", channel: "edge", snapshot_id: null },
          built_recipes: ["htop", "nano"],
        },
        packages: [pkg("htop"), pkg("nano")],
      },
      workspace: workspace(
        { nano: [{ commit: "abc1234", layer: "meta-oe" }] },
        ["abc1234"],
      ),
    }),
  );
  assert.equal(v.verdict, "feed_hit");
  assert.deepEqual(Object.keys(v.cache_keys.local), ["nano"]);
});

test("abbreviated recipe-map layer commit is accepted by the ancestor test", () => {
  const v = verdictOf(
    base({
      recipeMap: {
        schema_version: 1,
        entries: [entry({ layer_commit: "abc12" })],
      },
      workspace: workspace(
        { htop: [{ commit: "abc1234567890", layer: "meta-oe" }] },
        ["abc1234567890", "def5678"],
      ),
    }),
  );
  assert.equal(v.verdict, "feed_hit");
});

// ---- rule (b) ----

const publishedHit = (over = {}) => ({
  reachable: true,
  snapshotId: "s1",
  packages: [pkg("htop")],
  buildManifest: { layers: { "meta-oe": "def5678" } },
  ...over,
});

const noDelta = { recipeMap: null, delta: null };

test("published package at a layer commit containing the recipe is feed hit", () => {
  const v = verdictOf(base({ ...noDelta, published: publishedHit() }));
  assert.equal(v.verdict, "feed_hit");
  assert.equal(v.cache_keys.published.htop, "meta-oe@def5678");
});

test("published cache key records every group layer", () => {
  const v = verdictOf(
    base({
      ...noDelta,
      published: publishedHit({
        buildManifest: {
          layers: { "meta-oe": "def5678", "meta-avocado": "def5678" },
        },
      }),
      workspace: workspace(
        {
          htop: [
            { commit: "abc1234", layer: "meta-oe" },
            { commit: "abc1234", layer: "meta-avocado" },
          ],
        },
        ["abc1234", "def5678"],
      ),
    }),
  );
  assert.equal(v.verdict, "feed_hit");
  assert.equal(
    v.cache_keys.published.htop,
    "meta-avocado@def5678,meta-oe@def5678",
  );
});

test("published layer commit older than the recipe commit is a miss", () => {
  const v = verdictOf(
    base({
      ...noDelta,
      published: publishedHit({
        buildManifest: { layers: { "meta-oe": "abc1234" } },
      }),
      workspace: workspace(
        { htop: [{ commit: "def5678", layer: "meta-oe" }] },
        ["abc1234", "def5678"],
      ),
    }),
  );
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("published package at another version is version-differs", () => {
  const v = verdictOf(
    base({
      recipeMap: { schema_version: 1, entries: [entry()] },
      delta: null,
      published: publishedHit({ packages: [pkg("htop", "3.2.0")] }),
    }),
  );
  assert.equal(v.missing[0].reason, "version-differs");
});

test("missing build manifest is no-cache-key", () => {
  const v = verdictOf(
    base({ ...noDelta, published: publishedHit({ buildManifest: null }) }),
  );
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("published rule without a workspace is no-cache-key", () => {
  const v = verdictOf(
    base({ ...noDelta, workspace: null, published: publishedHit() }),
  );
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("unreachable remote is feed-unreachable", () => {
  const v = verdictOf(
    base({
      ...noDelta,
      published: {
        reachable: false,
        snapshotId: null,
        packages: [],
        buildManifest: null,
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "feed-unreachable");
});

test("unreachable remote with a mirror configured is no-cache-key", () => {
  const v = verdictOf(
    base({
      ...noDelta,
      mirrorConfigured: true,
      published: {
        reachable: false,
        snapshotId: null,
        packages: [],
        buildManifest: null,
      },
    }),
  );
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("unreachable remote leaves rule (a) hits as hits", () => {
  const v = verdictOf(
    base({
      published: {
        reachable: false,
        snapshotId: null,
        packages: [],
        buildManifest: null,
      },
    }),
  );
  assert.equal(v.verdict, "feed_hit");
});

test("failed local rule falls through to a published hit", () => {
  const v = verdictOf(
    base({
      workspace: workspace(
        { htop: [{ commit: "def5678", layer: "meta-oe" }] },
        ["abc1234", "def5678"],
      ),
      published: publishedHit(),
    }),
  );
  assert.equal(v.verdict, "feed_hit");
  assert.equal(v.cache_keys.published.htop, "meta-oe@def5678");
});

test("both rules failing reports the local reason and the published outcome", () => {
  const v = verdictOf(
    base({
      workspace: workspace(
        { htop: [{ commit: "def5678", layer: "meta-oe" }] },
        ["abc1234", "def5678"],
      ),
      published: {
        reachable: false,
        snapshotId: null,
        packages: [],
        buildManifest: null,
      },
    }),
  );
  assert.equal(v.missing[0].reason, "stale-delta");
  assert.ok(
    v.reasons.some((r) => /published lookup: feed-unreachable/.test(r)),
  );
});

test("unmapped recipe is unknown-recipe with a null recipe and a warning", () => {
  const v = verdictOf(
    base({
      change: { recipes: ["ghost"] },
      ...noDelta,
      workspace: workspace({}, []),
    }),
  );
  assert.deepEqual(v.missing, [
    { recipe: null, package: "ghost", reason: "unknown-recipe" },
  ]);
  assert.ok(v.warnings.some((w) => /ghost/.test(w)));
});

test("missing list names only the missing recipes", () => {
  const v = verdictOf(
    base({
      change: { recipes: ["htop", "nano"] },
      recipeMap: {
        schema_version: 1,
        entries: [entry(), entry({ recipe: "nano", packages: ["nano"] })],
      },
      workspace: workspace(
        {
          htop: [{ commit: "abc1234", layer: "meta-oe" }],
          nano: [{ commit: "def5678", layer: "meta-oe" }],
        },
        ["abc1234", "def5678"],
      ),
      delta: {
        manifest: {
          schema_version: 1,
          base: { release: "2026", channel: "edge", snapshot_id: null },
          built_recipes: ["htop", "nano"],
        },
        packages: [pkg("htop"), pkg("nano")],
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(
    v.missing.map((m) => m.package),
    ["nano"],
  );
});

// ---- warnings ----

test("delta base snapshot differing from the current one warns", () => {
  const v = verdictOf(
    base({
      delta: {
        manifest: {
          schema_version: 1,
          base: { release: "2026", channel: "edge", snapshot_id: "old" },
          built_recipes: ["htop"],
        },
        packages: [pkg("htop")],
      },
    }),
  );
  assert.ok(v.warnings.some((w) => /old/.test(w) && /s1/.test(w)));
  assert.equal(v.verdict, "feed_hit");
});

test("newer published version warns without changing the verdict", () => {
  const v = verdictOf(
    base({
      published: {
        reachable: true,
        snapshotId: "s1",
        packages: [pkg("htop", "3.4.0")],
        buildManifest: null,
      },
    }),
  );
  assert.ok(v.warnings.some((w) => /newer/.test(w)));
  assert.equal(v.verdict, "feed_hit");
});

// ---- snapshot selection ----

test("pin matching the feed url selects the pinned snapshot", () => {
  assert.equal(
    selectSnapshot({ snapshot_id: "p1", url: "http://f/" }, "http://f", "s9"),
    "p1",
  );
});

test("pin with no recorded url matches", () => {
  assert.equal(selectSnapshot({ snapshot_id: "p1" }, "http://f", "s9"), "p1");
});

test("pin for another url falls back to the latest snapshot", () => {
  assert.equal(
    selectSnapshot({ snapshot_id: "p1", url: "http://x" }, "http://f", "s9"),
    "s9",
  );
});

test("no pin selects the latest snapshot", () => {
  assert.equal(selectSnapshot(null, "http://f", "s9"), "s9");
});

// ---- review fixes ----

test("published hit needs every package of the entry at the entry version", () => {
  const v = verdictOf(
    base({
      ...noDelta,
      recipeMap: {
        schema_version: 1,
        entries: [entry({ packages: ["htop", "htop-doc"] })],
      },
      published: publishedHit({
        packages: [pkg("htop"), pkg("htop-doc", "3.2.0", "r0", 0, "htop")],
      }),
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "version-differs");
});

test("published hit with an entry package absent from the snapshot is a miss", () => {
  const v = verdictOf(
    base({
      ...noDelta,
      recipeMap: {
        schema_version: 1,
        entries: [entry({ packages: ["htop", "htop-doc"] })],
      },
      published: publishedHit({ packages: [pkg("htop")] }),
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("published hit without an entry needs every sourced package current", () => {
  const stale = {
    name: "htop-doc",
    epoch: 0,
    version: "3.2.0",
    release: "r0",
    sourcerpm: "htop-3.3.0-r0.src.rpm",
  };
  const v = verdictOf(
    base({
      ...noDelta,
      published: publishedHit({ packages: [pkg("htop"), stale] }),
    }),
  );
  assert.equal(v.verdict, "package_miss");
});

test("an entry with no packages gives no local hit", () => {
  const v = verdictOf(
    base({
      recipeMap: { schema_version: 1, entries: [entry({ packages: [] })] },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("an entry with no packages gives no published hit", () => {
  const v = verdictOf(
    base({
      delta: null,
      recipeMap: { schema_version: 1, entries: [entry({ packages: [] })] },
      published: publishedHit(),
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("an unproven ancestor test is no-cache-key, not stale-delta", () => {
  const ws: Workspace = {
    lastCommitFor: () => [{ commit: "abc1234", layer: "meta-oe" }],
    isAncestor: () => null,
  };
  const v = verdictOf(base({ workspace: ws }));
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "no-cache-key");
});

test("a recipe found with no commit is no-cache-key, not unknown-recipe", () => {
  const ws: Workspace = {
    lastCommitFor: () => [{ commit: "", layer: "meta-oe" }],
    isAncestor: () => true,
  };
  const local = verdictOf(base({ workspace: ws }));
  assert.equal(local.missing[0].reason, "no-cache-key");
  assert.notEqual(local.missing[0].recipe, null);
  const pub = verdictOf(
    base({ ...noDelta, workspace: ws, published: publishedHit() }),
  );
  assert.equal(pub.missing[0].reason, "no-cache-key");
  assert.notEqual(pub.missing[0].recipe, null);
});

test("an unknown layer commit is no-cache-key and never reaches the ancestor test", () => {
  let asked = 0;
  const ws: Workspace = {
    lastCommitFor: () => [{ commit: "abc1234", layer: "meta-oe" }],
    isAncestor: () => {
      asked++;
      return true;
    },
  };
  const v = verdictOf(
    base({
      workspace: ws,
      recipeMap: {
        schema_version: 1,
        entries: [entry({ layer_commit: null })],
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "no-cache-key");
  assert.equal(asked, 0);
});

// ---- paths that are neither image-level nor a recipe file ----

test("recipeDirOfPath names the recipe directory of any file below it", () => {
  assert.equal(
    recipeDirOfPath("meta-oe/recipes-support/htop/files/fix.patch"),
    "meta-oe/recipes-support/htop",
  );
  assert.equal(
    recipeDirOfPath("meta-oe/recipes-support/htop/htop.inc"),
    "meta-oe/recipes-support/htop",
  );
  assert.equal(recipeDirOfPath("meta-oe/recipes-support/loose.inc"), null);
  assert.equal(recipeDirOfPath("meta-oe/classes/foo.bbclass"), null);
});

const HTOP_DIR = { "meta-oe/recipes-support/htop": ["htop"] };
const htopWs = (commit = "abc1234") =>
  workspace(
    { htop: [{ commit, layer: "meta-oe" }] },
    ["abc1234", "def5678"],
    HTOP_DIR,
  );

test("a patch under the recipe's files directory classifies that recipe, not the map", () => {
  const v = verdictOf(
    base({
      recipeMap: {
        schema_version: 1,
        entries: [entry(), entry({ recipe: "nano", packages: ["nano"] })],
      },
      change: { paths: ["meta-oe/recipes-support/htop/files/fix.patch"] },
      workspace: htopWs(),
    }),
  );
  assert.deepEqual(Object.keys(v.cache_keys.local), ["htop"]);
});

test("a shared .inc names the recipes of its directory and a stale delta is a miss", () => {
  const v = verdictOf(
    base({
      change: { paths: ["meta-oe/recipes-support/htop/htop.inc"] },
      workspace: htopWs("def5678"),
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.equal(v.missing[0].reason, "stale-delta");
});

test("a file shared by several recipes of one directory classifies each of them", () => {
  const dirs = { "meta-oe/recipes-core/glibc": ["glibc", "glibc-locale"] };
  const v = verdictOf(
    base({
      recipeMap: null,
      delta: null,
      change: { paths: ["meta-oe/recipes-core/glibc/files/fix.patch"] },
      workspace: workspace(
        {
          glibc: [{ commit: "abc1234", layer: "meta-oe" }],
          "glibc-locale": [{ commit: "abc1234", layer: "meta-oe" }],
        },
        ["abc1234", "def5678"],
        dirs,
      ),
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(v.missing.map((m) => m.recipe).sort(), [
    "glibc",
    "glibc-locale",
  ]);
});

test("a recipe-directory path the workspace cannot map fails closed", () => {
  const path = "meta-oe/recipes-support/htop/files/fix.patch";
  for (const workspaceInput of [null, workspace({}, [])]) {
    const v = verdictOf(
      base({ change: { paths: [path] }, workspace: workspaceInput }),
    );
    assert.equal(v.verdict, "package_miss");
    assert.deepEqual(v.missing, []);
    assert.match(
      v.reasons.join("\n"),
      /recipes-support\/htop\/files\/fix\.patch/,
    );
  }
});

for (const path of [
  "meta-oe/classes/cmake.bbclass",
  "meta-oe/recipes-support/loose.inc",
  "meta-oe/lib/oe/utils.py",
  "meta/files/fs-perms.txt",
]) {
  test(`${path} is not ignorable: package miss, no missing package, a reason naming it`, () => {
    const v = verdictOf(base({ change: { paths: [path] } }));
    assert.equal(v.verdict, "package_miss");
    assert.deepEqual(v.missing, []);
    assert.match(v.reasons.join("\n"), new RegExp(path.replace(/\./g, "\\.")));
    assert.match(v.reasons.join("\n"), /no-cache-key/);
  });
}

test("an unmapped build path beside a hit recipe still misses, with no missing package", () => {
  const v = verdictOf(
    base({
      change: {
        recipes: ["htop"],
        paths: ["meta-oe/classes/cmake.bbclass"],
      },
    }),
  );
  assert.equal(v.verdict, "package_miss");
  assert.deepEqual(v.missing, []);
});

for (const path of [
  "meta-avocado/classes/image-os.bbclass",
  "meta-avocado/classes/image-packages-only.bbclass",
  "meta-avocado/classes/image-container-post-processing.bbclass",
  "meta-avocado/classes/package-image.bbclass",
  "meta-avocado/classes/avocado-kernel-feed.bbclass",
  "meta-avocado/classes/avocado-kernel-builtin-provides.bbclass",
  "meta-avocado-qcom/classes/image-avocado-qcom-deploy.bbclass",
  "meta/classes-recipe/rootfs-postcommands.bbclass",
  "meta/classes/populate_sdk_base.bbclass",
  "scripts/lib/wic/canned-wks/x.wks",
  "meta-avocado/wic/avocado.wks.in",
]) {
  test(`${path} is image miss`, () => {
    const v = verdictOf(base({ change: { paths: [path] } }));
    assert.equal(v.verdict, "image_miss");
  });
}

for (const path of [
  "docs/usage.rst",
  "meta-oe/README.md",
  "meta-oe/COPYING.MIT",
  ".github/workflows/ci.yml",
  "meta-oe/.gitignore",
  "meta-avocado/tests/test_x.py",
  "scripts/tests/golden/out.json",
  "support/ci-build/Containerfile",
  "meta-avocado-nvidia/recipes-core/swupdate/tests/t.sh",
]) {
  test(`${path} is ignorable`, () => {
    const v = verdictOf(base({ change: { paths: [path] } }));
    assert.equal(v.verdict, "feed_hit");
  });
}

test("a patch in a <pn>/ subdirectory maps to that recipe alone", () => {
  const dirs = {
    "meta-oe/recipes-devtools/python": ["python3-numpy", "python3-scipy"],
  };
  const ws = workspace(
    {
      "python3-numpy": [{ commit: "abc1234", layer: "meta-oe" }],
      "python3-scipy": [{ commit: "abc1234", layer: "meta-oe" }],
    },
    ["abc1234", "def5678"],
    dirs,
  );
  const only = (path: string) =>
    verdictOf(
      base({
        recipeMap: null,
        delta: null,
        change: { paths: [path] },
        workspace: ws,
      }),
    )
      .missing.map((m) => m.recipe)
      .sort();
  const dir = "meta-oe/recipes-devtools/python";
  assert.deepEqual(only(`${dir}/python3-numpy/0001.patch`), ["python3-numpy"]);
  assert.deepEqual(only(`${dir}/python3-numpy-1.26/0001.patch`), [
    "python3-numpy",
  ]);
  // files/, a directory-level include and a subdirectory naming no recipe
  // are shared, so every recipe of the directory is affected.
  const both = ["python3-numpy", "python3-scipy"];
  assert.deepEqual(only(`${dir}/files/0001.patch`), both);
  assert.deepEqual(only(`${dir}/python-common.inc`), both);
  assert.deepEqual(only(`${dir}/other/0001.patch`), both);
});

test("unmapped paths are listed in a structured field and an empty list otherwise", () => {
  const v = verdictOf(
    base({ change: { paths: ["meta-oe/classes/cmake.bbclass"] } }),
  );
  assert.deepEqual(v.unmapped, ["meta-oe/classes/cmake.bbclass"]);
  assert.deepEqual(verdictOf(base()).unmapped, []);
  assert.deepEqual(
    verdictOf(base({ change: { paths: ["meta-avocado/conf/machine/x.conf"] } }))
      .unmapped,
    [],
  );
});
