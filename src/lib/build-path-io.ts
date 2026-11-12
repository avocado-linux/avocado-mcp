/**
 * I/O side of the build path verdict: reads the project, the delta, the
 * workspace and the published feed, and hands the pure classifier in
 * `build-path.ts` what it needs. Nothing here writes to a feed.
 *
 * The only processes started are `git log -1`, `git merge-base
 * --is-ancestor` and the `avocado --version` query. Every one is spawned
 * without a shell, with a timeout.
 */

import { execFile, spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { basename, dirname, join, resolve } from "path";
import { promisify } from "util";
import { parse as parseYaml } from "yaml";
import {
  recipeOfPath,
  selectSnapshot,
  type DeltaManifest,
  type LastCommit,
  type PackageInfo,
  type PublishedState,
  type RecipeMap,
  type RecipeMapEntry,
  type VerdictFeed,
  type Workspace,
} from "./build-path.js";
import {
  isCliOutdated,
  MIN_CLI_VERSION,
  parseCliVersion,
} from "./cli-version.js";
import type { ResolvedFeed } from "./feed-config.js";
import {
  isSafeSegment,
  shownUrl,
  toPackageInfo,
  type FeedSpec,
  type RepoClient,
} from "./repo-client.js";
import { cliEnv } from "./schema-client.js";

const execFileP = promisify(execFile);

const GIT_TIMEOUT_MS = 15_000;
const VERSION_TIMEOUT_MS = 5_000;
const MAX_WALK_DEPTH = 10;
const SKIP_DIRS = new Set([".git", "node_modules"]);

// ---- target ---------------------------------------------------------------

/**
 * The target the project builds for: `AVOCADO_TARGET`, then `default_target`
 * in avocado.yaml. Same precedence as `projectTarget` in `src/tools`, which
 * the lib layer must not import.
 */
export function projectBuildTarget(
  configPath: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const fromEnv = env.AVOCADO_TARGET?.trim();
  if (fromEnv) return fromEnv;
  try {
    const doc = parseYaml(readFileSync(configPath, "utf8")) as {
      default_target?: unknown;
    } | null;
    const t = doc?.default_target;
    if (typeof t === "string" && t.trim()) return t.trim();
  } catch {
    /* unreadable YAML or no file: the caller asks for a target */
  }
  return undefined;
}

// ---- delta ----------------------------------------------------------------

export interface FoundDelta {
  /** Directory that holds `delta.json` and `recipe-map.json`. */
  root: string;
  manifest: DeltaManifest;
  /** The path-feed directories that sit below `root`. */
  feedDirs: string[];
}

const isStr = (v: unknown): v is string => typeof v === "string";

function parseDelta(text: string): DeltaManifest | null {
  let o: unknown;
  try {
    o = JSON.parse(text);
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) return null;
  const d = o as Record<string, unknown>;
  const base = d.base as Record<string, unknown> | null | undefined;
  if (!base || typeof base !== "object") return null;
  if (!isStr(base.release) || !isStr(base.channel)) return null;
  if (!Array.isArray(d.built_recipes) || !d.built_recipes.every(isStr))
    return null;
  return {
    schema_version: Number(d.schema_version ?? 1),
    base: {
      release: base.release,
      channel: base.channel,
      snapshot_id: isStr(base.snapshot_id) ? base.snapshot_id : null,
    },
    built_recipes: d.built_recipes,
    ...(isStr(d.bakar_run_id) ? { bakar_run_id: d.bakar_run_id } : {}),
    ...(isStr(d.delta_path) ? { delta_path: d.delta_path } : {}),
  };
}

/**
 * Find the delta: `delta.json` at most three directory levels above a
 * directory feed (the delta channel directory sits two levels above a
 * `target/<machine>` sub-repository). The first root found wins.
 */
export function findDelta(feedDirs: string[]): {
  found: FoundDelta | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  const byRoot = new Map<string, { m: DeltaManifest; dirs: string[] }>();
  const bad = new Set<string>();
  for (const raw of feedDirs) {
    const dir = resolve(raw);
    let cur = dir;
    for (let level = 1; level <= 3; level++) {
      cur = dirname(cur);
      const file = join(cur, "delta.json");
      if (!existsSync(file)) continue;
      const seen = byRoot.get(cur);
      if (seen) {
        seen.dirs.push(dir);
        break;
      }
      if (bad.has(cur)) break;
      let m: DeltaManifest | null = null;
      try {
        m = parseDelta(readFileSync(file, "utf8"));
      } catch {
        m = null;
      }
      if (!m) {
        bad.add(cur);
        warnings.push(`${file} is not a valid delta manifest; it was ignored`);
        break;
      }
      byRoot.set(cur, { m, dirs: [dir] });
      break;
    }
  }
  const first = [...byRoot.entries()][0];
  if (!first) return { found: null, warnings };
  if (byRoot.size > 1)
    warnings.push(
      `${byRoot.size} delta roots were found among the path feeds; ${first[0]} was used`,
    );
  return {
    found: { root: first[0], manifest: first[1].m, feedDirs: first[1].dirs },
    warnings,
  };
}

function parseEntry(e: unknown): RecipeMapEntry | null {
  if (!e || typeof e !== "object") return null;
  const o = e as Record<string, unknown>;
  const strs = ["recipe", "layer", "pv", "pr", "machine"];
  if (!strs.every((k) => isStr(o[k]))) return null;
  if (!isStr(o.release)) return null;
  // bakar writes null when it could not resolve the layer's commit.
  if (o.layer_commit !== null && !isStr(o.layer_commit)) return null;
  if (!Array.isArray(o.packages) || !o.packages.every(isStr)) return null;
  if (typeof o.epoch !== "number" && !isStr(o.epoch)) return null;
  if (o.task_hash !== undefined && o.task_hash !== null && !isStr(o.task_hash))
    return null;
  return {
    recipe: o.recipe as string,
    packages: o.packages,
    layer: o.layer as string,
    epoch: o.epoch,
    pv: o.pv as string,
    pr: o.pr as string,
    srcrev: isStr(o.srcrev) ? o.srcrev : "",
    layer_commit: o.layer_commit,
    machine: o.machine as string,
    release: o.release,
    task_hash: (o.task_hash as string | null | undefined) ?? null,
  };
}

/** `recipe-map.json` of a delta root: absent is no map and no warning. */
export function readRecipeMap(root: string): {
  map: RecipeMap | null;
  warnings: string[];
} {
  const file = join(root, "recipe-map.json");
  if (!existsSync(file)) return { map: null, warnings: [] };
  const bad = {
    map: null,
    warnings: [`${file} is not a valid recipe map; it was ignored`],
  };
  let o: unknown;
  try {
    o = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return bad;
  }
  const raw = (o as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(raw)) return bad;
  const entries = raw.map(parseEntry);
  if (entries.some((e) => e === null)) return bad;
  return {
    map: {
      schema_version: Number(
        (o as { schema_version?: unknown }).schema_version ?? 1,
      ),
      entries: entries as RecipeMapEntry[],
    },
    warnings: [],
  };
}

/** Packages of every sub-repository of the delta, as the classifier takes them. */
export async function loadDeltaPackages(
  client: Pick<RepoClient, "fetchExtraFeed">,
  feedDirs: string[],
): Promise<{ packages: PackageInfo[]; warnings: string[] }> {
  const packages: PackageInfo[] = [];
  const warnings: string[] = [];
  const results = await Promise.allSettled(
    feedDirs.map((path) =>
      client.fetchExtraFeed({ name: basename(path), priority: 0, path }),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "fulfilled") packages.push(...r.value.map(toPackageInfo));
    else
      warnings.push(
        `could not read delta repository ${feedDirs[i]}: ${String((r.reason as Error)?.message ?? r.reason)}`,
      );
  });
  return { packages, warnings };
}

// ---- workspace ------------------------------------------------------------

export interface GitResult {
  /** Null when git did not run to completion (timeout, spawn failure). */
  status: number | null;
  stdout: string;
}

export type GitRunner = (cwd: string, args: string[]) => GitResult;

/** Runs git without a shell and with a timeout. */
export const runGit: GitRunner = (cwd, args) => {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    shell: false,
    timeout: GIT_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
  });
  return { status: r.status, stdout: r.stdout ?? "" };
};

const COMMIT_RE = /^[0-9a-f]{4,64}$/i;

interface RecipeFile {
  /** Path relative to the layer repository, with `/` separators. */
  rel: string;
  dir: string;
  base: string;
  append: boolean;
}

function walk(root: string, rel: string, depth: number, out: string[]): void {
  if (depth > MAX_WALK_DEPTH) return;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      // A directory with its own .git is another layer repository, walked
      // as that layer and never as part of this one.
      if (SKIP_DIRS.has(e.name) || existsSync(join(root, p, ".git"))) continue;
      walk(root, p, depth + 1, out);
    } else if (e.isFile() && /\.(bb|bbappend)$/.test(e.name)) {
      out.push(p);
    }
  }
}

function isDir(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface WorkspaceHandle {
  workspace: Workspace;
  /**
   * Notes the tool surfaces as warnings: git runs that did not end with exit
   * 0 or 1, a recipe found in two layers, and a recipe file with no commit.
   */
  failures: string[];
}

/**
 * The workspace's layers are its immediate subdirectories that are git
 * repositories, plus the directory itself when it is one: a workspace root
 * that is a repository (with its layer repositories ignored by it) does not
 * hide them. A recipe name found in two layers is unknown; append files are
 * collected from every layer. Answers are memoized per workspace, so a
 * recipe or commit pair costs one git run however often it is asked.
 */
export function createWorkspace(
  workspaceDir: string,
  run: GitRunner = runGit,
): WorkspaceHandle {
  const failures: string[] = [];
  const root = resolve(workspaceDir);
  const layers: Array<{ name: string; dir: string }> = [];
  if (existsSync(join(root, ".git")))
    layers.push({ name: basename(root), dir: root });
  let kids: string[] = [];
  try {
    kids = readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."))
      .map((d) => d.name)
      .sort();
  } catch {
    /* unreadable workspace: no layers */
  }
  for (const k of kids)
    if (existsSync(join(root, k, ".git")))
      layers.push({ name: k, dir: join(root, k) });

  const index = new Map<string, string[]>();
  const filesOf = (l: { dir: string }): string[] => {
    let f = index.get(l.dir);
    if (!f) {
      f = [];
      walk(l.dir, "", 0, f);
      index.set(l.dir, f);
    }
    return f;
  };
  const commitRepo = new Map<string, string>();
  const note = (w: string) => {
    if (!failures.includes(w)) failures.push(w);
  };

  const recipeFiles = (recipe: string, all: string[]) => {
    const esc = recipe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`^${esc}(_[^/]*)?\\.(bb|bbappend)$`);
    const out: RecipeFile[] = [];
    for (const rel of all) {
      const base = rel.split("/").pop() ?? "";
      if (!re.test(base)) continue;
      out.push({
        rel,
        dir: dirname(rel) === "." ? "" : dirname(rel),
        base,
        append: base.endsWith(".bbappend"),
      });
    }
    return out;
  };

  const besides = (recipe: string, layerDir: string, f: RecipeFile) => {
    const names = new Set(["files", recipe]);
    const stem = f.base.replace(/\.(bb|bbappend)$/, "");
    if (stem.includes("_")) names.add(stem.replace("_", "-"));
    const paths: string[] = [];
    for (const n of names) {
      const rel = f.dir ? `${f.dir}/${n}` : n;
      if (isDir(join(layerDir, rel))) paths.push(rel);
    }
    // A shared .inc beside the recipe changes what it builds, and a recipe
    // pulling one in by `require` has no file of its own to show it.
    try {
      for (const e of readdirSync(join(layerDir, f.dir), {
        withFileTypes: true,
      }))
        if (e.isFile() && e.name.endsWith(".inc"))
          paths.push(f.dir ? `${f.dir}/${e.name}` : e.name);
    } catch {
      /* unreadable directory: the recipe file's own group still stands */
    }
    return paths;
  };

  const lastCommit = (
    layer: { name: string; dir: string },
    paths: string[],
  ): LastCommit => {
    const r = run(layer.dir, [
      "log",
      "-1",
      "--format=%H",
      "--",
      ...paths.map((p) => `:(literal)${p}`),
    ]);
    let commit = "";
    if (r.status === 0) {
      commit = r.stdout.trim();
      if (!COMMIT_RE.test(commit)) commit = "";
      // Exit 0 with no output: no commit touches these paths (an untracked
      // or uncommitted file), which is not the same as an old commit.
      if (!commit)
        note(
          `${layer.name}: ${paths.join(", ")} has no commit; uncommitted edits are not seen, so the recipe has no cache key`,
        );
    } else {
      failures.push(
        `git log in ${layer.name} ended with ${r.status === null ? "no exit status" : `exit ${r.status}`}`,
      );
    }
    if (commit) commitRepo.set(commit, layer.dir);
    return { commit, layer: layer.name };
  };

  const lastCommitMemo = new Map<string, LastCommit[]>();
  const duplicateMemo = new Map<string, string[]>();
  const dirMemo = new Map<string, string[]>();
  const ancestorMemo = new Map<string, boolean | null>();

  const computeLastCommits = (recipe: string): LastCommit[] => {
    const withBb = layers.filter((l) =>
      recipeFiles(recipe, filesOf(l)).some((f) => !f.append),
    );
    if (withBb.length > 1) {
      note(
        `recipe ${recipe} is found in layers ${withBb.map((l) => l.name).join(" and ")}; it is treated as unknown`,
      );
      return [];
    }
    if (withBb.length === 0) return [];
    const groups: LastCommit[] = [];
    for (const l of layers) {
      const files = recipeFiles(recipe, filesOf(l));
      if (l === withBb[0]) {
        const bbs = files.filter((f) => !f.append);
        const paths = new Set<string>();
        for (const f of bbs) {
          paths.add(f.rel);
          for (const p of besides(recipe, l.dir, f)) paths.add(p);
        }
        groups.push(lastCommit(l, [...paths]));
      }
      for (const f of files.filter((x) => x.append))
        groups.push(lastCommit(l, [f.rel, ...besides(recipe, l.dir, f)]));
    }
    // A group whose files have no commit stays in the list with an empty
    // commit: the recipe exists, and cannot be proven against any layer.
    return groups;
  };

  const computeAncestor = (a: string, b: string): boolean | null => {
    if (!COMMIT_RE.test(a) || !COMMIT_RE.test(b)) return null;
    const dir = commitRepo.get(a);
    if (!dir) return null;
    const r = run(dir, ["merge-base", "--is-ancestor", a, b]);
    if (r.status === 0) return true;
    // Exit 1 is the answer "not an ancestor". Anything else (an object
    // the clone lacks, a timeout) leaves the answer unproven.
    if (r.status === 1) return false;
    failures.push(
      `git merge-base in ${basename(dir)} ended with ${r.status === null ? "no exit status" : `exit ${r.status}`}`,
    );
    return null;
  };

  const memo = <T>(m: Map<string, T>, key: string, compute: () => T): T => {
    if (m.has(key)) return m.get(key) as T;
    const v = compute();
    m.set(key, v);
    return v;
  };

  const workspace: Workspace = {
    lastCommitFor: (recipe) =>
      memo(lastCommitMemo, recipe, () => computeLastCommits(recipe)),
    duplicateLayers: (recipe) =>
      memo(duplicateMemo, recipe, () => {
        const names = layers
          .filter((l) => recipeFiles(recipe, filesOf(l)).some((f) => !f.append))
          .map((l) => l.name);
        return names.length > 1 ? names : [];
      }),
    recipesInDir: (recipeDir) =>
      memo(dirMemo, recipeDir, () => {
        const names = new Set<string>();
        for (const l of layers)
          for (const rel of filesOf(l)) {
            // Exactly this layer and this directory: the changed path names it
            // from the workspace root (`<layer>/<dir>`) or from the layer
            // repository (`<dir>`, which holds a layer kept in a subdirectory).
            // A same-named directory of another layer is another recipe set.
            const d = dirname(rel);
            if (d !== recipeDir && `${l.name}/${d}` !== recipeDir) continue;
            const name = recipeOfPath(rel);
            if (name) names.add(name);
          }
        return [...names].sort();
      }),
    isAncestor: (a, b) =>
      memo(ancestorMemo, `${a}\0${b}`, () => computeAncestor(a, b)),
  };
  return { workspace, failures };
}

// ---- mirror ---------------------------------------------------------------

const MIRROR_MARKER = ".bakar-mirror.json";

/** The tool input wins over `AVOCADO_FEED_MIRROR_DIR`. */
export function mirrorDirFrom(
  input: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const i = input?.trim();
  if (i) return i;
  const e = env.AVOCADO_FEED_MIRROR_DIR?.trim();
  return e ? e : undefined;
}

function safeRepoPath(repo: string): boolean {
  return repo.split("/").every((s) => isSafeSegment(s));
}

/**
 * `repomd_sha256` from `<mirror>/<release>/<channel>/<repo>/.bakar-mirror.json`,
 * or null when the marker is absent, unreadable or has no digest.
 */
export function readMirrorMarker(
  mirrorDir: string,
  release: string,
  channel: string,
  repo: string,
): string | null {
  if (!isSafeSegment(release) || !isSafeSegment(channel)) return null;
  if (!safeRepoPath(repo)) return null;
  try {
    const o: unknown = JSON.parse(
      readFileSync(
        join(mirrorDir, release, channel, repo, MIRROR_MARKER),
        "utf8",
      ),
    );
    const d = (o as { repomd_sha256?: unknown } | null)?.repomd_sha256;
    return isStr(d) && /^[0-9a-f]{64}$/i.test(d) ? d.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** Mirrored repositories of one target, found by their markers. */
function mirrorRepos(
  mirrorDir: string,
  release: string,
  channel: string,
  target: string,
): string[] {
  if (![release, channel, target].every((s) => isSafeSegment(s))) return [];
  const base = join(mirrorDir, release, channel);
  const out: string[] = [];
  const visit = (rel: string, depth: number) => {
    if (existsSync(join(base, rel, MIRROR_MARKER))) out.push(rel);
    if (depth >= 3) return;
    let kids;
    try {
      kids = readdirSync(join(base, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const k of kids)
      if (k.isDirectory() && isSafeSegment(k.name))
        visit(`${rel}/${k.name}`, depth + 1);
  };
  visit(`target/${target}`, 0);
  return out.sort();
}

// ---- published state ------------------------------------------------------

export type PublishedClient = Pick<
  RepoClient,
  | "getTargetManifest"
  | "fetchSnapshotPointer"
  | "fetchBuildManifest"
  | "fetchRepoPackageInfos"
  | "fetchRepomdDigest"
  | "fetchExtraFeed"
>;

export interface PublishedLoad {
  published: PublishedState;
  /** True when a mirror directory was given, used or not. */
  mirrorConfigured: boolean;
  warnings: string[];
  /** The build manifest's meta-avocado commit, when there is one. */
  commit: string | null;
}

const errText = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * Read the published feed for one target. The snapshot pointer, targets
 * index and build manifest always come from the remote. Package metadata
 * comes from the mirror when every marker digest equals the remote head's
 * `repomd.xml` digest (never a pinned snapshot's, and a matching pin skips
 * the mirror), otherwise from the remote.
 */
export async function loadPublishedState(input: {
  client: PublishedClient;
  feed: ResolvedFeed;
  target: string;
  mirrorDir?: string;
}): Promise<PublishedLoad> {
  const { client, feed, target } = input;
  const mirrorDir = input.mirrorDir;
  const warnings: string[] = [];
  const headFeed: FeedSpec = { ...feed, releasever: feed.manifestPath };

  const [manifest, pointer] = await Promise.all([
    client.getTargetManifest(headFeed),
    client.fetchSnapshotPointer(headFeed, target),
  ]);
  // The repository list comes from targets.json; without it there is nothing
  // to read, whatever the pointer says.
  const remoteDown = manifest === null;

  // A pin recorded against another feed URL is not this feed's pin.
  const pin =
    feed.snapshot !== undefined
      ? { snapshot_id: feed.snapshot, url: feed.snapshotRepoUrl ?? null }
      : null;
  const pinned =
    pin !== null && selectSnapshot(pin, feed.baseUrl, null) === pin.snapshot_id;
  const snapshotId = remoteDown
    ? null
    : selectSnapshot(pin, feed.baseUrl, pointer);

  let buildManifest: PublishedState["buildManifest"] = null;
  let commit: string | null = null;
  let manifestDown = false;
  if (snapshotId) {
    const b = await client.fetchBuildManifest(feed, snapshotId);
    if (b.kind === "manifest") {
      buildManifest = { layers: b.layers };
      commit = b.commit;
    } else if (b.kind === "unreachable") {
      manifestDown = true;
    }
  }
  let reachable = !remoteDown && !manifestDown;

  const release = feed.release;
  const channel = feed.channel;
  const mirrorUsable = Boolean(mirrorDir && !pinned && release && channel);
  let packages: PackageInfo[] = [];

  const readMirror = async (repos: string[]) => {
    const out: PackageInfo[] = [];
    for (const repo of repos) {
      const path = join(
        mirrorDir as string,
        release as string,
        channel as string,
        repo,
      );
      const feedPkgs = await client.fetchExtraFeed({
        name: "mirror",
        priority: 0,
        path,
      });
      out.push(...feedPkgs.map(toPackageInfo));
    }
    return out;
  };

  if (mirrorDir && !pinned && !mirrorUsable) {
    warnings.push(
      "the mirror was not used: the feed release or channel is not known",
    );
  }

  let served = false;
  if (mirrorUsable) {
    const repos = remoteDown
      ? mirrorRepos(
          mirrorDir as string,
          release as string,
          channel as string,
          target,
        )
      : (manifest?.[target] ?? []);
    const markers = repos.map((r) =>
      readMirrorMarker(
        mirrorDir as string,
        release as string,
        channel as string,
        r,
      ),
    );
    if (repos.length === 0 || markers.some((m) => m === null)) {
      warnings.push(
        repos.length === 0
          ? remoteDown
            ? `the remote feed could not be read and the mirror at ${mirrorDir} has no repository for ${target}`
            : `the remote feed lists no repository for ${target}, so the mirror at ${mirrorDir} was not used`
          : "the mirror is missing a marker for a repository, so it was not used",
      );
    } else if (remoteDown) {
      try {
        packages = await readMirror(repos);
        served = true;
        warnings.push(
          "the remote feed could not be read; the mirror was used and its freshness was not verified",
        );
      } catch (e) {
        warnings.push(`the mirror could not be read: ${errText(e)}`);
      }
    } else {
      // The mirror holds the head, while the manifest and the remote read
      // describe the snapshot the pointer names. A head that has moved past
      // that snapshot would pair this metadata with another build's manifest.
      const snapFeed: FeedSpec | null =
        !pinned && snapshotId
          ? {
              ...headFeed,
              releasever: `${feed.manifestPath}/snapshots/${snapshotId}`,
            }
          : null;
      let stale: string | null = null;
      let behindSnapshot = false;
      try {
        for (let i = 0; i < repos.length && stale === null; i++) {
          const d = await client.fetchRepomdDigest(headFeed, repos[i]);
          if (d.toLowerCase() !== markers[i]) {
            stale = repos[i];
            continue;
          }
          if (snapFeed) {
            const sd = await client.fetchRepomdDigest(snapFeed, repos[i]);
            if (sd.toLowerCase() !== markers[i]) {
              stale = repos[i];
              behindSnapshot = true;
            }
          }
        }
      } catch (e) {
        warnings.push(
          `the remote metadata index could not be read to check the mirror: ${errText(e)}`,
        );
        stale = "";
      }
      if (stale === null) {
        try {
          packages = await readMirror(repos);
          served = true;
        } catch (e) {
          warnings.push(`the mirror could not be read: ${errText(e)}`);
        }
      } else if (stale) {
        warnings.push(
          behindSnapshot
            ? `the mirror is stale: ${stale} differs from the snapshot ${snapshotId} the pointer names; the remote feed was read`
            : `the mirror is stale: ${stale} differs from the remote head; the remote feed was read`,
        );
      }
    }
  }

  if (!served && !remoteDown) {
    const repos = manifest?.[target] ?? [];
    // The head is read through the snapshot the pointer named, so the
    // packages are the ones the build manifest just fetched describes; the
    // head path itself is cached for the session and may be a snapshot old.
    const source: FeedSpec = pinned
      ? feed
      : snapshotId
        ? {
            ...headFeed,
            releasever: `${feed.manifestPath}/snapshots/${snapshotId}`,
          }
        : headFeed;
    const results = await Promise.allSettled(
      repos.map((r) => client.fetchRepoPackageInfos(source, r)),
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") packages.push(...r.value);
      else {
        reachable = false;
        warnings.push(`could not read ${repos[i]}: ${errText(r.reason)}`);
      }
    });
  }

  if (remoteDown && !served)
    warnings.push("the published feed could not be read");

  return {
    published: { reachable, snapshotId, packages, buildManifest },
    mirrorConfigured: Boolean(mirrorDir),
    warnings,
    commit,
  };
}

/** The feeds the verdict reports, from the resolved feed set. */
export function verdictFeeds(
  feed: ResolvedFeed,
  snapshotId: string | null,
  commit: string | null,
): VerdictFeed[] {
  const release = feed.release ?? "";
  const channel = feed.channel ?? "";
  const entries = feed.feeds ?? [];
  if (entries.length === 0)
    return [
      {
        name: feed.name ?? "avocado",
        kind: "distro",
        url_or_path: shownUrl(
          `${feed.baseUrl}/${feed.manifestPath}`,
          feed.masks,
        ),
        release,
        channel,
        snapshot_id: snapshotId,
        commit,
      },
    ];
  return entries
    .filter((f) => f.status !== "excluded")
    .map((f) => ({
      name: f.name,
      kind: f.kind,
      url_or_path: f.location,
      release,
      channel,
      snapshot_id: f.kind === "distro" ? snapshotId : null,
      commit: f.kind === "distro" ? commit : null,
    }));
}

// ---- CLI version ----------------------------------------------------------

/** Runs `<AVOCADO_BINARY> --version`, the binary taken from the given environment. */
function versionRunner(
  vars: Record<string, string | undefined>,
): () => Promise<string> {
  return async () => {
    const { stdout } = await execFileP(
      vars.AVOCADO_BINARY ?? "avocado",
      ["--version"],
      { env: cliEnv(), timeout: VERSION_TIMEOUT_MS, maxBuffer: 64 * 1024 },
    );
    return stdout;
  };
}

/**
 * A warning when `avocado --version` names a release older than 1.0.0; null
 * when it is current, absent or unreadable.
 */
export async function cliVersionWarning(
  run?: () => Promise<string>,
  vars: Record<string, string | undefined> = process.env,
): Promise<string | null> {
  let out: string;
  try {
    out = await (run ?? versionRunner(vars))();
  } catch {
    return null;
  }
  if (!isCliOutdated(out)) return null;
  return `avocado ${parseCliVersion(out)} is older than ${MIN_CLI_VERSION}; the verdict is still returned`;
}
