import { compareEvr } from "./rpm-version.js";

/** Bump when the verdict JSON shape changes. */
export const VERDICT_SCHEMA_VERSION = 1;

export type VerdictKind = "feed_hit" | "package_miss" | "image_miss";

export type MissReason =
  | "stale-delta"
  | "version-differs"
  | "no-cache-key"
  | "feed-unreachable"
  | "unknown-recipe";

/** Package shape the repo client produces (task 13.1). */
export interface PackageInfo {
  name: string;
  epoch: number;
  version: string;
  release: string;
  sourcerpm: string;
}

/** One entry of bakar's recipe-map.json. */
export interface RecipeMapEntry {
  recipe: string;
  packages: string[];
  layer: string;
  epoch: number | string;
  pv: string;
  pr: string;
  srcrev: string;
  /** May be abbreviated: bakar records the short form. Null when unknown. */
  layer_commit: string | null;
  machine: string;
  release: string;
  task_hash: string | null;
}

export interface RecipeMap {
  schema_version: number;
  entries: RecipeMapEntry[];
}

/** bakar's delta.json. */
export interface DeltaManifest {
  schema_version: number;
  base: {
    release: string;
    channel: string;
    snapshot_id: string | null;
  };
  built_recipes: string[];
  bakar_run_id?: string;
  delta_path?: string;
}

/** The last commit touching one file group of a recipe. */
export interface LastCommit {
  commit: string;
  /** Layer repository directory name. */
  layer: string;
}

export interface Workspace {
  /**
   * One entry per file group of the recipe: the recipe file with its files
   * directory, and each append file. Empty when the recipe is not found. A
   * group whose files have no commit (new or untracked) or have uncommitted
   * changes (a dirty group) carries an empty `commit`: the recipe exists but
   * cannot be proven against any layer commit until the changes are committed.
   */
  lastCommitFor(recipe: string): LastCommit[];
  /** Layer names holding a recipe file of this name, when more than one does. */
  duplicateLayers?(recipe: string): string[];
  /**
   * Names of the recipes whose `.bb` or `.bbappend` sits in exactly this
   * recipe directory (`recipeDirOfPath` of a changed path, with the same
   * layer prefix). A directory such as glibc holds several recipes sharing
   * one files directory and `.inc`. Empty when the directory holds none.
   */
  recipesInDir?(recipeDir: string): string[];
  /**
   * True when commit `a` is an ancestor of (or equal to) commit `b`, false
   * when it is not, null when the answer could not be established (a git
   * failure or an object the clone lacks).
   */
  isAncestor(a: string, b: string): boolean | null;
}

export interface PublishedState {
  /** False when the remote could not be read. */
  reachable: boolean;
  /** The snapshot the lookups read: pinned when it matches, else latest. */
  snapshotId: string | null;
  /** Packages of the snapshot's metadata. */
  packages: PackageInfo[];
  /** Layer map of the build manifest; null when missing or malformed. */
  buildManifest: { layers: Record<string, string> } | null;
}

export interface VerdictFeed {
  name: string;
  kind: string;
  url_or_path: string;
  release: string;
  channel: string;
  snapshot_id: string | null;
  commit: string | null;
}

export interface ChangeInput {
  recipes?: string[];
  paths?: string[];
}

export interface ClassifyInput {
  target: string;
  release: string;
  channel: string;
  change?: ChangeInput;
  recipeMap: RecipeMap | null;
  delta: { manifest: DeltaManifest; packages: PackageInfo[] } | null;
  workspace: Workspace | null;
  published: PublishedState | null;
  /** A mirror holds no snapshot content, so it cannot prove a hit. */
  mirrorConfigured?: boolean;
  feeds?: VerdictFeed[];
  /** ISO timestamp; defaults to the current time. */
  now?: string;
}

export interface MissingPackage {
  recipe: string | null;
  package: string;
  reason: MissReason;
}

export interface Verdict {
  schema_version: number;
  verdict: VerdictKind;
  missing: MissingPackage[];
  reasons: string[];
  /**
   * Changed paths that map to no package: a package miss whose `missing`
   * list says nothing about them. Empty for the other verdicts.
   */
  unmapped: string[];
  feeds: VerdictFeed[];
  cache_keys: {
    published: Record<string, string>;
    local: Record<string, string>;
  };
  warnings: string[];
  target: string;
  generated_at: string;
}

export type ClassifyResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; error: string };

const IMAGE_CLASSES: Array<{ name: string; re: RegExp; not?: RegExp }> = [
  { name: "machine configuration", re: /(^|\/)conf\/machine\// },
  {
    name: "kas machine file",
    re: /(^|\/)kas\//,
    // A recipe directory named kas (recipes-devtools/kas) is a recipe, not a kas file.
    not: /(^|\/)recipes-[^/]+\/kas\//,
  },
  { name: "kernel recipe or fragment", re: /(^|\/)recipes-kernel\// },
  { name: "kernel fragment", re: /(^|\/)linux(-[^/]+)?\/(.*\/)?[^/]+\.cfg$/ },
  { name: "board-support layer path", re: /(^|\/)recipes-bsp\// },
  { name: "layer configuration", re: /(^|\/)conf\/layer\.conf$/ },
  { name: "distro configuration", re: /(^|\/)conf\/distro\// },
  { name: "package group", re: /(^|\/)recipes-[^/]+\/packagegroups\// },
  { name: "image recipe", re: /(^|\/)recipes-[^/]+\/images\// },
  {
    name: "image, kernel, rootfs or SDK class",
    re: /(^|\/)classes[^/]*\/[^/]*(image|kernel|rootfs|populate_sdk)[^/]*\.bbclass$/,
  },
  { name: "wic image layout", re: /\.wks(\.in)?$/ },
];

/** Returns the image-level class name of a path, or null. */
export function imageClassOf(path: string): string | null {
  const p = path.replace(/\\/g, "/");
  for (const c of IMAGE_CLASSES)
    if (c.re.test(p) && !(c.not?.test(p) ?? false)) return c.name;
  return null;
}

/** Recipe name of a `.bb` or `.bbappend` path: the file name before the first underscore. */
export function recipeOfPath(path: string): string | null {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const m = /^(.+)\.(bb|bbappend)$/.exec(base);
  if (!m) return null;
  const name = m[1].split("_")[0];
  return name.length > 0 ? name : null;
}

/**
 * The recipe directory of any file below it, with whatever precedes
 * `recipes-<kind>` in the path (the layer): `meta-oe/recipes-support/htop`.
 * The files directory, patches and shared `.inc` files all lie below it. A
 * directory can hold several recipes, so the recipes come from the workspace
 * (`Workspace.recipesInDir`), scoped to this layer and this exact directory.
 */
export function recipeDirOfPath(path: string): string | null {
  const parts = path.replace(/\\/g, "/").split("/");
  const i = parts.findIndex((x) => x.startsWith("recipes-"));
  // The recipe directory needs a name after recipes-<kind> and a file below it.
  if (i < 0 || parts.length < i + 3) return null;
  return parts.slice(0, i + 2).join("/");
}

/** Trees of tests and CI: they build nothing that ships. */
const TEST_TREES: RegExp[] = [/(^|\/)tests?\//, /(^|\/)support\/ci-build\//];

/** Documentation and repository metadata cannot change what a build produces. */
const IGNORABLE: RegExp[] = [
  /(^|\/)(docs?|\.github|\.gitlab)\//,
  // .txt is absent on purpose: oe-core ships fs-perms.txt and
  // device_table-minimal.txt, which image builds read.
  /\.(md|rst)$/i,
  /(^|\/)(README|LICENSE|COPYING|CONTRIBUTING|MAINTAINERS|CHANGELOG|NOTICE|AUTHORS)[^/]*$/,
  /(^|\/)\.[^/]+$/,
];

const matchesAny = (res: RegExp[], path: string): boolean => {
  const p = path.replace(/\\/g, "/");
  return res.some((re) => re.test(p));
};

/**
 * Pick the published snapshot: the pinned one when the pin matches the feed
 * URL now in use (a pin with no recorded URL matches), otherwise the latest.
 */
export function selectSnapshot(
  pin: { snapshot_id: string; url?: string | null } | null,
  feedUrl: string,
  latestSnapshotId: string | null,
): string | null {
  if (pin) {
    const trim = (u: string) => u.replace(/\/+$/, "");
    if (!pin.url || trim(pin.url) === trim(feedUrl)) return pin.snapshot_id;
  }
  return latestSnapshotId;
}

const evr = (p: { epoch: number | string; version: string; release: string }) =>
  `${Number(p.epoch)}:${p.version}-${p.release}`;

/** Recipe name from a source rpm file name, e.g. `htop-3.3.0-r0.src.rpm`. */
function sourcerpmParts(
  s: string,
): { name: string; version: string; release: string } | null {
  const m = /^(.+)-([^-]+)-([^-]+)\.src\.rpm$/.exec(s);
  return m ? { name: m[1], version: m[2], release: m[3] } : null;
}

interface RecipeOutcome {
  hit: boolean;
  reason?: MissReason;
  packages: string[];
  localKey?: string;
  publishedKey?: string;
  extraReasons: string[];
}

function localKey(e: RecipeMapEntry): string {
  if (e.task_hash) return e.task_hash;
  return [Number(e.epoch), e.pv, e.pr, e.srcrev, e.layer_commit].join("|");
}

/** Pure verdict classifier: every external fact arrives through `input`. */
export function classifyBuildPath(input: ClassifyInput): ClassifyResult {
  const warnings: string[] = [];
  const warn = (w: string) => {
    if (!warnings.includes(w)) warnings.push(w);
  };
  const change = input.change ?? {};
  const named = [...new Set(change.recipes ?? [])];
  const paths = change.paths ?? [];

  // Image-level paths win over any recipe.
  const imageReasons: string[] = [];
  const pathRecipes: string[] = [];
  const unmapped: string[] = [];
  for (const p of paths) {
    const cls = imageClassOf(p);
    if (cls) {
      imageReasons.push(`${cls}: ${p}`);
      continue;
    }
    const r = recipeOfPath(p);
    if (r) {
      pathRecipes.push(r);
      continue;
    }
    if (matchesAny(TEST_TREES, p)) continue;
    const dir = recipeDirOfPath(p);
    if (dir) {
      // Without the workspace nothing says which recipes share the directory.
      const names = input.workspace?.recipesInDir?.(dir) ?? [];
      if (names.length === 0) unmapped.push(p);
      // Every file below the directory names every recipe in it: a <pn>/
      // subdirectory is on the file path of the sibling recipes (gcc-cross
      // and libgcc search gcc/), so naming fewer would leave one stale.
      else pathRecipes.push(...names);
      continue;
    }
    // Anything else under a layer (a bbclass, an include, a library file)
    // can change what builds, and no cache key covers it: it fails closed.
    if (!matchesAny(IGNORABLE, p)) unmapped.push(p);
  }

  const result = (
    verdict: VerdictKind,
    missing: MissingPackage[],
    reasons: string[],
    keys: Verdict["cache_keys"],
    unmappedPaths: string[] = [],
  ): ClassifyResult => ({
    ok: true,
    verdict: {
      schema_version: VERDICT_SCHEMA_VERSION,
      verdict,
      missing,
      reasons,
      unmapped: unmappedPaths,
      feeds: input.feeds ?? [],
      cache_keys: keys,
      warnings,
      target: input.target,
      generated_at: input.now ?? new Date().toISOString(),
    },
  });
  const noKeys = { published: {}, local: {} };

  if (imageReasons.length > 0)
    return result("image_miss", [], imageReasons, noKeys);

  // Recipe map usability.
  let map = input.recipeMap;
  if (map) {
    const foreign = map.entries.some(
      (e) => e.machine !== input.target || e.release !== input.release,
    );
    if (foreign) {
      warn(
        `recipe map is for another machine or release stream (expected ${input.target}, ${input.release}); the local rule was skipped`,
      );
      map = null;
    }
  } else {
    warn("recipe map is missing; recipes fall to the published lookup");
  }

  // A path that names no recipe (documentation, say) is ignored, so it
  // leaves the recipe map to classify exactly as an empty change does.
  let recipes = [...new Set([...named, ...pathRecipes])];
  // Unmapped build paths are the change, so the recipe map has no say.
  if (recipes.length === 0 && unmapped.length === 0) {
    const fromMap = input.recipeMap?.entries.map((e) => e.recipe) ?? [];
    recipes = [...new Set(fromMap)];
    if (recipes.length === 0) {
      return {
        ok: false,
        error:
          "nothing to classify: no recipe, no path that names one and no recipe map; no verdict",
      };
    }
  }

  if (
    input.delta?.manifest.base.snapshot_id &&
    input.published?.snapshotId &&
    input.delta.manifest.base.snapshot_id !== input.published.snapshotId
  ) {
    warn(
      `delta base snapshot ${input.delta.manifest.base.snapshot_id} differs from the current published snapshot ${input.published.snapshotId}; the published lookups read the current one`,
    );
  }

  const outcomes = new Map<string, RecipeOutcome>();
  const missing: MissingPackage[] = [];
  const reasons: string[] = [];
  const keys: Verdict["cache_keys"] = { published: {}, local: {} };

  // Paths stay out of `missing`, which names packages a caller builds.
  for (const p of unmapped) {
    reasons.push(
      `${p}: no-cache-key: the path maps to no recipe and may change any build`,
    );
  }

  for (const recipe of recipes) {
    const o = evaluateRecipe(recipe, input, map);
    outcomes.set(recipe, o);
    if (o.hit) {
      if (o.localKey) keys.local[recipe] = o.localKey;
      if (o.publishedKey) keys.published[recipe] = o.publishedKey;
      continue;
    }
    const reason = o.reason ?? "no-cache-key";
    const unknown = reason === "unknown-recipe";
    const dups = input.workspace?.duplicateLayers?.(recipe) ?? [];
    if (unknown)
      warn(
        dups.length > 1
          ? `recipe ${recipe} is found in layers ${dups.join(" and ")}; it is treated as unknown`
          : `recipe ${recipe} is not in the recipe map or the workspace`,
      );
    const pkgs = o.packages.length > 0 ? o.packages : [recipe];
    for (const p of pkgs)
      missing.push({ recipe: unknown ? null : recipe, package: p, reason });
    reasons.push(`${recipe}: ${reason}`);
    reasons.push(...o.extraReasons);
  }

  warnNewerPublished(input, warn);

  if (missing.length > 0 || unmapped.length > 0)
    return result("package_miss", missing, reasons, keys, unmapped);
  return result("feed_hit", [], [], keys);
}

function evaluateRecipe(
  recipe: string,
  input: ClassifyInput,
  map: RecipeMap | null,
): RecipeOutcome {
  const entry = map?.entries.find((e) => e.recipe === recipe) ?? null;
  const ws = input.workspace;
  const out: RecipeOutcome = { hit: false, packages: [], extraReasons: [] };
  if (entry) out.packages = entry.packages;
  // Memoized. Asking first collects the dirty-group warning for every recipe,
  // including those the rules below reject before they reach the groups
  // (version-differs, no-cache-key); no verdict reads this call's result.
  ws?.lastCommitFor(recipe);

  let localReason: MissReason | null = null;
  const built = input.delta?.manifest.built_recipes.includes(recipe) ?? false;

  if (entry && built && input.delta) {
    if (!ws) {
      // Without a workspace no group can be checked, so there is no commit to
      // compare; a dirty group carries an empty commit too, once one is given.
      localReason = "no-cache-key";
    } else {
      localReason = localRule(entry, input.delta.packages, ws, recipe);
      if (localReason === null) {
        out.hit = true;
        out.localKey = localKey(entry);
        return out;
      }
    }
  }

  const pub = publishedRule(recipe, entry, input, ws);
  if (pub.hit) {
    out.hit = true;
    out.publishedKey = pub.key;
    return out;
  }
  if (pub.packages.length > 0 && out.packages.length === 0)
    out.packages = pub.packages;

  if (localReason) {
    out.reason = localReason;
    out.extraReasons.push(`${recipe}: published lookup: ${pub.reason}`);
  } else {
    out.reason = pub.reason;
  }
  if (ws && (ws.duplicateLayers?.(recipe).length ?? 0) > 1)
    out.reason = "unknown-recipe";
  else if (!entry && ws && ws.lastCommitFor(recipe).length === 0)
    out.reason = "unknown-recipe";
  return out;
}

/** Rule (a). Returns null on a hit, otherwise the miss reason. */
function localRule(
  entry: RecipeMapEntry,
  deltaPackages: PackageInfo[],
  ws: Workspace,
  recipe: string,
): MissReason | null {
  // An entry that lists no package proves nothing about what was built.
  if (entry.packages.length === 0) return "no-cache-key";
  for (const name of entry.packages) {
    const cands = deltaPackages.filter((p) => p.name === name);
    if (cands.length === 0) return "no-cache-key";
    const exact = cands.some(
      (p) =>
        Number(p.epoch) === Number(entry.epoch) &&
        p.version === entry.pv &&
        p.release === entry.pr,
    );
    if (!exact) return "version-differs";
  }
  // Without the layer commit there is nothing to compare the groups with.
  if (entry.layer_commit === null) return "no-cache-key";
  const groups = ws.lastCommitFor(recipe);
  if (groups.length === 0 || groups.some((g) => g.commit === ""))
    return "no-cache-key";
  for (const g of groups) {
    // entry.layer_commit is the recipe layer's commit; a group in another
    // layer cannot be proven against it (rule (b) evaluates it per layer).
    if (g.layer !== entry.layer) return "no-cache-key";
    const anc = ws.isAncestor(g.commit, entry.layer_commit);
    if (anc === null) return "no-cache-key";
    if (!anc) return "stale-delta";
  }
  return null;
}

interface PublishedOutcome {
  hit: boolean;
  key?: string;
  reason: MissReason;
  packages: string[];
}

/** Rule (b): the published layer-manifest ancestor test. */
function publishedRule(
  recipe: string,
  entry: RecipeMapEntry | null,
  input: ClassifyInput,
  ws: Workspace | null,
): PublishedOutcome {
  const miss = (
    reason: MissReason,
    packages: string[] = [],
  ): PublishedOutcome => ({
    hit: false,
    reason,
    packages,
  });
  const pub = input.published;
  if (!pub || !pub.reachable)
    return miss(input.mirrorConfigured ? "no-cache-key" : "feed-unreachable");

  const sourced = pub.packages.filter(
    (p) => sourcerpmParts(p.sourcerpm)?.name === recipe,
  );
  const names = [...new Set(sourced.map((p) => p.name))];
  if (sourced.length === 0) return miss("no-cache-key");

  // Every package of the recipe must match at the same epoch, version and
  // package release: the entry's packages when there is one, otherwise every
  // package the snapshot sources from the recipe. One current package beside
  // a stale sibling would let a hit hide a package that was not rebuilt.
  if (entry && entry.packages.length === 0) return miss("no-cache-key", names);
  const required = entry ? entry.packages : names;
  const matches = (p: PackageInfo): boolean => {
    if (entry)
      return (
        Number(p.epoch) === Number(entry.epoch) &&
        p.version === entry.pv &&
        p.release === entry.pr
      );
    const sp = sourcerpmParts(p.sourcerpm);
    return sp !== null && sp.version === p.version && sp.release === p.release;
  };
  for (const name of required) {
    const cands = sourced.filter((p) => p.name === name);
    if (cands.length === 0) return miss("no-cache-key", names);
    if (!cands.some(matches)) return miss("version-differs", names);
  }
  if (!ws || !pub.buildManifest) return miss("no-cache-key", names);

  const groups = ws.lastCommitFor(recipe);
  if (groups.length === 0 || groups.some((g) => g.commit === ""))
    return miss("no-cache-key", names);
  const keys = new Set<string>();
  for (const g of groups) {
    const layerCommit = pub.buildManifest.layers[g.layer];
    if (!layerCommit) return miss("no-cache-key", names);
    // false and unproven both leave the build without a proven cache key.
    if (ws.isAncestor(g.commit, layerCommit) !== true)
      return miss("no-cache-key", names);
    keys.add(`${g.layer}@${layerCommit}`);
  }
  const key = [...keys].sort().join(",");
  return { hit: true, key, reason: "no-cache-key", packages: names };
}

function warnNewerPublished(
  input: ClassifyInput,
  warn: (w: string) => void,
): void {
  if (!input.delta || !input.published?.reachable) return;
  for (const d of input.delta.packages) {
    for (const p of input.published.packages) {
      if (p.name !== d.name) continue;
      if (compareEvr(evr(p), evr(d)) > 0)
        warn(
          `published ${p.name} ${evr(p)} is newer than the local delta's ${evr(d)}; the verdict is not changed by it`,
        );
    }
  }
}
