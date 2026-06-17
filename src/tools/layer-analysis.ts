import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Static layer-coverage analysis for kas compositions.
 *
 * meta-avocado is migrating to opt-in feature groups: removing layers from a
 * kas composition. When a vendor layer is absent, meta-avocado's own layers
 * still carry `.bbappend` files whose base recipe is gone, `.bb` recipes that
 * `inherit` a now-missing bbclass, or `require` a now-missing file — each of
 * which breaks the build at parse/collection time. These tools detect that
 * STATICALLY (no bitbake, no container) so the failure is caught before a
 * multi-hour build, not after it.
 *
 * The analysis is a fast pre-flight, not a substitute for a real bitbake parse:
 * PNs come from filenames (not resolved PROVIDES), and BBMASK matching is a
 * best-effort substring/regex check against workspace-relative paths.
 */

/**
 * Default workspace root: the directory that holds avocado-mcp and
 * `meta-avocado/` as siblings. The compiled module lives at
 * `build/tools/layer-analysis.js`, so three `..` hops land on avocado-mcp's
 * parent. Mirrors recipe.ts' `defaultWorkspaceRoot()`.
 */
function defaultWorkspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recursively list every file under `dir` whose name ends with one of `exts`.
 * A directory that cannot be read is skipped silently so a permission hiccup in
 * one subtree does not abort the whole walk.
 */
function listFiles(dir: string, exts: string[]): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    const full = resolve(dir, entry);
    let isDir: boolean;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      continue;
    }
    if (isDir) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Derive a recipe PN from a `.bb`/`.bbappend` basename. A Yocto PN cannot
 * contain `_` — the version follows the first `_` — so strip the extension,
 * then everything from the first underscore. Examples:
 *   `openjdk-17-jdk_%.bbappend` → `openjdk-17-jdk`
 *   `hpp-fcl_2.4.5-1.bb`        → `hpp-fcl`
 *   `kernel-devsrc.bb`          → `kernel-devsrc`
 */
function pnFromFile(filename: string): string {
  const base = filename.replace(/\.(bbappend|bb)$/, "");
  const underscore = base.indexOf("_");
  return underscore === -1 ? base : base.slice(0, underscore);
}

// ---------------------------------------------------------------------------
// kas composition resolution
// ---------------------------------------------------------------------------

interface KasResolution {
  presentLayerDirs: string[];
  presentCollections: Set<string>;
  localConfBbmask: string[];
}

interface RepoEntry {
  path: string;
  layers: Set<string>;
}

/** Parse a kas YAML file's text; returns undefined on any parse failure. */
function parseKasFile(filePath: string): Record<string, unknown> | undefined {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  return parsed as Record<string, unknown>;
}

/** Scan a local_conf_header text blob for BBMASK right-hand-side tokens. */
function extractBbmask(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const match = rawLine.match(/^\s*BBMASK\s*[+:]?=\s*"?([^"]*)"?/);
    if (!match) continue;
    for (const tok of match[1].split(/\s+/)) {
      const t = tok.trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

/**
 * Resolve the present-layer set from a (possibly colon-joined) kas composition
 * argument. Degrades gracefully: an unparseable or missing include is skipped
 * rather than thrown; the function returns whatever resolved plus the dirs that
 * exist on disk.
 */
function resolveKasComposition(
  compositionArg: string,
  workspaceRoot: string,
): KasResolution {
  const repos = new Map<string, RepoEntry>();
  const localConfBbmask: string[] = [];
  const processed = new Set<string>();

  // Seed worklist from the colon-joined composition argument.
  const worklist: string[] = [];
  for (const part of compositionArg.split(":")) {
    const p = part.trim();
    if (p.length === 0) continue;
    worklist.push(isAbsolute(p) ? p : resolve(workspaceRoot, p));
  }

  const ensureRepo = (name: string): RepoEntry => {
    let entry = repos.get(name);
    if (!entry) {
      entry = { path: name, layers: new Set() };
      repos.set(name, entry);
    }
    return entry;
  };

  while (worklist.length > 0) {
    const filePath = worklist.shift() as string;
    if (processed.has(filePath)) continue;
    processed.add(filePath);

    const doc = parseKasFile(filePath);
    if (!doc) continue;

    // Merge this file's repos block FIRST so its includes can resolve repo
    // paths declared here (e.g. the top-level composition declares meta-avocado
    // with path: meta-avocado before referencing kas/... includes).
    const reposBlock = doc.repos;
    if (reposBlock && typeof reposBlock === "object") {
      for (const [name, value] of Object.entries(
        reposBlock as Record<string, unknown>,
      )) {
        const entry = ensureRepo(name);
        if (value && typeof value === "object" && !Array.isArray(value)) {
          const v = value as Record<string, unknown>;
          if (typeof v.path === "string" && v.path.length > 0) {
            entry.path = v.path;
          }
          const layers = v.layers;
          if (layers && typeof layers === "object" && !Array.isArray(layers)) {
            for (const layerKey of Object.keys(
              layers as Record<string, unknown>,
            )) {
              entry.layers.add(layerKey);
            }
          }
        }
      }
    }

    // local_conf_header: scan every block's text for BBMASK lines.
    const header = doc.header;
    if (header && typeof header === "object" && !Array.isArray(header)) {
      const lch = (header as Record<string, unknown>).local_conf_header;
      if (lch && typeof lch === "object" && !Array.isArray(lch)) {
        for (const val of Object.values(lch as Record<string, unknown>)) {
          if (typeof val === "string") {
            localConfBbmask.push(...extractBbmask(val));
          }
        }
      }

      // header.includes: object {repo, file} or bare string forms.
      const includes = (header as Record<string, unknown>).includes;
      if (Array.isArray(includes)) {
        for (const inc of includes) {
          let resolvedInc: string | undefined;
          if (typeof inc === "string") {
            resolvedInc = resolve(dirname(filePath), inc);
          } else if (inc && typeof inc === "object") {
            const o = inc as Record<string, unknown>;
            if (typeof o.repo === "string" && typeof o.file === "string") {
              const repoEntry = repos.get(o.repo);
              if (repoEntry) {
                resolvedInc = resolve(workspaceRoot, repoEntry.path, o.file);
              } else {
                // Fallback: resolve relative to the current file's directory.
                resolvedInc = resolve(dirname(filePath), o.file);
              }
            }
          }
          if (resolvedInc && !processed.has(resolvedInc)) {
            worklist.push(resolvedInc);
          }
        }
      }
    }
  }

  // presentLayerDirs: union over all repos of <root>/<repo.path>/<layerKey>.
  const presentLayerDirs: string[] = [];
  for (const entry of repos.values()) {
    const repoRoot = isAbsolute(entry.path)
      ? entry.path
      : resolve(workspaceRoot, entry.path);
    for (const layerKey of entry.layers) {
      const dir = layerKey === "." ? repoRoot : resolve(repoRoot, layerKey);
      if (existsSync(dir) && !presentLayerDirs.includes(dir)) {
        presentLayerDirs.push(dir);
      }
    }
  }

  // presentCollections: read each present layer's conf/layer.conf.
  const presentCollections = new Set<string>();
  for (const dir of presentLayerDirs) {
    for (const name of collectionsForLayer(dir)) {
      presentCollections.add(name);
    }
  }

  return { presentLayerDirs, presentCollections, localConfBbmask };
}

/** Extract BBFILE_COLLECTIONS tokens from a layer's conf/layer.conf. */
function collectionsForLayer(layerDir: string): string[] {
  const confPath = resolve(layerDir, "conf", "layer.conf");
  let text: string;
  try {
    text = readFileSync(confPath, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const match = rawLine.match(/BBFILE_COLLECTIONS\s*[+:]?=\s*"([^"]*)"/);
    if (!match) continue;
    for (const tok of match[1].split(/\s+/)) {
      const t = tok.trim();
      if (t.length > 0) out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Workspace layer index
// ---------------------------------------------------------------------------

interface LayerInfo {
  name: string;
  dir: string;
  pns: Set<string>;
  classes: Set<string>;
  /** Repo-relative file paths under common require dirs. */
  requirePaths: Set<string>;
}

/**
 * Find every directory up to ~2 levels under `workspaceRoot` that contains a
 * `conf/layer.conf` (these are layers), and build a provider index for each:
 * PN→layer, class→layer, and a require-path provenance set.
 */
function scanWorkspaceLayers(workspaceRoot: string): LayerInfo[] {
  const layerDirs = findLayerDirs(workspaceRoot, 2);
  const out: LayerInfo[] = [];
  for (const dir of layerDirs) {
    out.push(buildLayerInfo(dir));
  }
  return out;
}

/**
 * Find layer dirs (those carrying conf/layer.conf) up to `maxDepth` levels deep
 * under `root`. Depth 0 is `root` itself.
 */
function findLayerDirs(root: string, maxDepth: number): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (existsSync(resolve(dir, "conf", "layer.conf"))) {
      found.push(dir);
      // A layer dir can still contain nested layers (e.g. oe-core/meta),
      // so keep descending until maxDepth.
    }
    if (depth >= maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const full = resolve(dir, entry);
      let isDir: boolean;
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue;
      }
      if (isDir) walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/** Build the provider index for a single layer dir. */
function buildLayerInfo(dir: string): LayerInfo {
  const name = dir.split(/[/\\]/).filter(Boolean).pop() ?? dir;
  const pns = new Set<string>();
  for (const file of listFiles(dir, [".bb"])) {
    pns.add(pnFromFile(file.split(/[/\\]/).pop() as string));
  }
  const classes = new Set<string>();
  for (const classDir of ["classes", "classes-recipe", "classes-global"]) {
    for (const file of listFiles(resolve(dir, classDir), [".bbclass"])) {
      const cls = (file.split(/[/\\]/).pop() as string).replace(
        /\.bbclass$/,
        "",
      );
      classes.add(cls);
    }
  }
  const requirePaths = new Set<string>();
  for (const file of listFiles(dir, [".bb", ".bbappend", ".inc", ".conf"])) {
    requirePaths.add(relative(dir, file));
  }
  return { name, dir, pns, classes, requirePaths };
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

type FindingKind = "dangling_append" | "missing_class" | "missing_require";

interface CoverageFinding {
  file: string;
  kind: FindingKind;
  target: string;
  satisfied_by_layer?: string;
}

/** Parse the classes named on every `inherit` line (ignore inherit_defer). */
function parseInheritClasses(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = line.match(/^inherit\s+(.+)$/);
    if (!match) continue;
    for (const cls of match[1].split(/\s+/)) {
      const c = cls.trim();
      if (c.length > 0) out.push(c);
    }
  }
  return out;
}

/** Parse `require <path>` lines, skipping those with unexpanded ${...}. */
function parseRequirePaths(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("#")) continue;
    const match = line.match(/^require\s+(\S+)/);
    if (!match) continue;
    const path = match[1];
    if (path.includes("${")) continue;
    out.push(path);
  }
  return out;
}

/**
 * Detect whether a file under an audited layer sits in a dynamic-layers tree
 * gated on a collection that is NOT present. Returns the gating collection when
 * the file should be skipped, or undefined when it should be audited.
 */
function dynamicLayerGate(
  workspaceRelPath: string,
  presentCollections: Set<string>,
): string | undefined {
  const match = workspaceRelPath.match(/\/dynamic-layers\/([^/]+)\//);
  if (!match) return undefined;
  const collection = match[1];
  return presentCollections.has(collection) ? undefined : collection;
}

interface AuditContext {
  workspaceRoot: string;
  presentLayerDirs: string[];
  presentCollections: Set<string>;
  localConfBbmask: string[];
  presentPns: Set<string>;
  presentClasses: Set<string>;
  presentLayerRoots: string[];
  workspaceLayers: LayerInfo[];
  presentDirSet: Set<string>;
}

/** Layer (by name) in the workspace that provides the given recipe PN, absent from the present set. */
function absentLayerForPn(ctx: AuditContext, pn: string): string | undefined {
  for (const layer of ctx.workspaceLayers) {
    if (ctx.presentDirSet.has(layer.dir)) continue;
    if (layer.pns.has(pn)) return layer.name;
  }
  return undefined;
}

/** Absent workspace layer providing the given class. */
function absentLayerForClass(
  ctx: AuditContext,
  cls: string,
): string | undefined {
  for (const layer of ctx.workspaceLayers) {
    if (ctx.presentDirSet.has(layer.dir)) continue;
    if (layer.classes.has(cls)) return layer.name;
  }
  return undefined;
}

/** Absent workspace layer that holds the given require path. */
function absentLayerForRequire(
  ctx: AuditContext,
  reqPath: string,
): string | undefined {
  for (const layer of ctx.workspaceLayers) {
    if (ctx.presentDirSet.has(layer.dir)) continue;
    if (layer.requirePaths.has(reqPath)) return layer.name;
  }
  return undefined;
}

/**
 * True when a require path resolves the way bitbake searches for it: first
 * relative to the requiring file's own directory (a bare `require qemu.inc`
 * with a co-located qemu.inc), then relative to any present layer root (a
 * `require recipes-x/foo.inc` resolved via BBPATH).
 */
function requireResolves(
  ctx: AuditContext,
  reqPath: string,
  fileDir: string,
): boolean {
  if (existsSync(resolve(fileDir, reqPath))) return true;
  for (const root of ctx.presentLayerRoots) {
    if (existsSync(resolve(root, reqPath))) return true;
  }
  return false;
}

/** Audit a single .bb/.bbappend file, pushing any findings. */
function auditFile(
  ctx: AuditContext,
  filePath: string,
  findings: CoverageFinding[],
): void {
  const workspaceRel = relative(ctx.workspaceRoot, filePath);

  // dynamic-layers gating.
  if (dynamicLayerGate("/" + workspaceRel, ctx.presentCollections)) return;

  // BBMASK best-effort match.
  for (const pattern of ctx.localConfBbmask) {
    if (pattern.length === 0) continue;
    if (workspaceRel.includes(pattern)) return;
    try {
      if (new RegExp(pattern).test(workspaceRel)) return;
    } catch {
      // Not a valid regex; the substring check above already ran.
    }
  }

  const basename = filePath.split(/[/\\]/).pop() as string;
  let text: string;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    return;
  }

  // dangling_append: a .bbappend whose target PN is provided by no present layer.
  if (basename.endsWith(".bbappend")) {
    const pn = pnFromFile(basename);
    if (!ctx.presentPns.has(pn)) {
      findings.push({
        file: workspaceRel,
        kind: "dangling_append",
        target: pn,
        satisfied_by_layer: absentLayerForPn(ctx, pn),
      });
    }
  }

  // missing_class: an inherited class provided by no present layer.
  for (const cls of parseInheritClasses(text)) {
    if (cls === "inherit_defer") continue;
    if (!ctx.presentClasses.has(cls)) {
      findings.push({
        file: workspaceRel,
        kind: "missing_class",
        target: cls,
        satisfied_by_layer: absentLayerForClass(ctx, cls),
      });
    }
  }

  // missing_require: a require path that resolves under neither the requiring
  // file's own directory nor any present layer root.
  const fileDir = dirname(filePath);
  for (const reqPath of parseRequirePaths(text)) {
    if (!requireResolves(ctx, reqPath, fileDir)) {
      findings.push({
        file: workspaceRel,
        kind: "missing_require",
        target: reqPath,
        satisfied_by_layer: absentLayerForRequire(ctx, reqPath),
      });
    }
  }
}

/** Build the set of PNs provided by present layers. */
function presentPnsFor(presentLayerDirs: string[]): Set<string> {
  const out = new Set<string>();
  for (const dir of presentLayerDirs) {
    for (const file of listFiles(dir, [".bb"])) {
      out.add(pnFromFile(file.split(/[/\\]/).pop() as string));
    }
  }
  return out;
}

/** Build the set of classes provided by present layers. */
function presentClassesFor(presentLayerDirs: string[]): Set<string> {
  const out = new Set<string>();
  for (const dir of presentLayerDirs) {
    for (const classDir of ["classes", "classes-recipe", "classes-global"]) {
      for (const file of listFiles(resolve(dir, classDir), [".bbclass"])) {
        out.add(
          (file.split(/[/\\]/).pop() as string).replace(/\.bbclass$/, ""),
        );
      }
    }
  }
  return out;
}

interface CoverageResult {
  clean: boolean;
  findings: CoverageFinding[];
  present_layers: string[];
  error?: string;
}

function runCoverage(
  composition: string,
  workspaceRoot: string,
): CoverageResult {
  const { presentLayerDirs, presentCollections, localConfBbmask } =
    resolveKasComposition(composition, workspaceRoot);

  const workspaceLayers = scanWorkspaceLayers(workspaceRoot);
  const presentDirSet = new Set(presentLayerDirs);
  const presentPns = presentPnsFor(presentLayerDirs);
  const presentClasses = presentClassesFor(presentLayerDirs);

  const ctx: AuditContext = {
    workspaceRoot,
    presentLayerDirs,
    presentCollections,
    localConfBbmask,
    presentPns,
    presentClasses,
    presentLayerRoots: presentLayerDirs,
    workspaceLayers,
    presentDirSet,
  };

  // Audit target layers = present layer dirs under <root>/meta-avocado/.
  const metaAvocadoRoot = resolve(workspaceRoot, "meta-avocado");
  const findings: CoverageFinding[] = [];
  for (const dir of presentLayerDirs) {
    if (!dir.startsWith(metaAvocadoRoot)) continue;
    for (const file of listFiles(dir, [".bb", ".bbappend"])) {
      auditFile(ctx, file, findings);
    }
  }

  const present_layers = presentLayerDirs.map((d) =>
    relative(workspaceRoot, d),
  );
  return { clean: findings.length === 0, findings, present_layers };
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

const coverageFindingSchema = z.object({
  file: z.string(),
  kind: z.enum(["dangling_append", "missing_class", "missing_require"]),
  target: z.string(),
  satisfied_by_layer: z.string().optional(),
});

export function registerLayerAnalysisTools(server: McpServer): void {
  server.registerTool(
    "check-layer-coverage",
    {
      title: "Check a kas composition's layer coverage",
      description:
        "Statically detect dangling bbappends, missing inherited bbclasses, and missing requires in meta-avocado's own layers for a given kas composition — catching opt-in-layer regressions before a build instead of after a multi-hour parse failure. As meta-avocado moves to opt-in feature groups, removing a vendor layer can leave a `.bbappend` whose base recipe is gone, a `.bb` that inherits a now-missing bbclass, or a `require` of a now-missing file. This tool resolves the present-layer set from the composition (no bitbake, no container), audits only meta-avocado's layers, honors dynamic-layers (BBFILES_DYNAMIC) gating so a recipe under `dynamic-layers/<collection>/` is skipped when that collection is absent, and names the absent workspace layer that would fix each finding. It is a fast pre-flight, not a substitute for a real bitbake parse: PNs are derived from filenames and BBMASK matching is best-effort.",
      inputSchema: {
        composition: z
          .string()
          .min(1)
          .describe(
            "kas composition, workspace-relative or absolute; colon-join overlays e.g. 'meta-avocado/kas/machine/qemuarm64.yml:meta-avocado/kas/feature/qt.yml'",
          ),
        workspace_root: z
          .string()
          .optional()
          .describe(
            "Workspace root holding meta-avocado/ as a sibling. Defaults to avocado-mcp's parent directory.",
          ),
      },
      outputSchema: {
        clean: z.boolean(),
        findings: z.array(coverageFindingSchema),
        present_layers: z.array(z.string()),
        error: z.string().optional(),
      },
      annotations: {
        title: "Check a kas composition's layer coverage",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ composition, workspace_root }) => {
      try {
        const root = workspace_root
          ? isAbsolute(workspace_root)
            ? workspace_root
            : resolve(defaultWorkspaceRoot(), workspace_root)
          : defaultWorkspaceRoot();
        const result = runCoverage(composition, root);
        return {
          content: [
            { type: "text", text: renderCoverage(composition, result) },
          ],
          structuredContent: {
            clean: result.clean,
            findings: result.findings,
            present_layers: result.present_layers,
          },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# check-layer-coverage failed\n\n❌ ${message}\n`,
            },
          ],
          structuredContent: {
            clean: false,
            findings: [],
            present_layers: [],
            error: message,
          },
        };
      }
    },
  );

  registerFindRecipeProviders(server);
}

function renderCoverage(composition: string, result: CoverageResult): string {
  let out = `# check-layer-coverage\n\n`;
  out += `**Composition:** \`${composition}\`\n`;
  out += `**Present layers:** ${result.present_layers.length}\n`;
  out += `**Findings:** ${result.findings.length}\n`;
  if (result.findings.length === 0) {
    out += `\n✅ Clean — every meta-avocado bbappend, inherit, and require resolves against a present layer.\n`;
    return out;
  }

  const byKind = new Map<FindingKind, CoverageFinding[]>();
  for (const f of result.findings) {
    const list = byKind.get(f.kind) ?? [];
    list.push(f);
    byKind.set(f.kind, list);
  }
  for (const [kind, list] of byKind) {
    out += `\n## ${kind} (${list.length})\n\n`;
    out += `| file | target | fix: add layer |\n`;
    out += `| --- | --- | --- |\n`;
    for (const f of list) {
      out += `| \`${f.file}\` | \`${f.target}\` | ${
        f.satisfied_by_layer
          ? `\`${f.satisfied_by_layer}\``
          : "_(none in workspace)_"
      } |\n`;
    }
  }
  return out;
}

const providerSchema = z.object({
  layer: z.string(),
  path: z.string(),
});

function registerFindRecipeProviders(server: McpServer): void {
  server.registerTool(
    "find-recipe-providers",
    {
      title: "Find which layer provides a recipe or class",
      description:
        "Find which workspace layer provides a given recipe (PN) or bbclass by scanning every layer (a dir carrying conf/layer.conf) up to two levels under the workspace root. For kind=recipe it matches the PN derived from each `.bb` filename (basename minus the version after the first `_`); for kind=class it matches `<name>.bbclass` under classes/, classes-recipe/, or classes-global/. Returns the providing layers as `{layer, path}` rows, or `found: false` when nothing in the workspace provides it.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            "Recipe name (PN) or class name to look up. Examples: 'flatbuffers', 'qmake5'.",
          ),
        kind: z
          .enum(["recipe", "class"])
          .optional()
          .describe(
            "Whether to look up a recipe PN or a bbclass. Default 'recipe'.",
          ),
        workspace_root: z
          .string()
          .optional()
          .describe(
            "Workspace root holding the layers as siblings. Defaults to avocado-mcp's parent directory.",
          ),
      },
      outputSchema: {
        found: z.boolean(),
        providers: z.array(providerSchema),
        error: z.string().optional(),
      },
      annotations: {
        title: "Find which layer provides a recipe or class",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ name, kind, workspace_root }) => {
      try {
        const root = workspace_root
          ? isAbsolute(workspace_root)
            ? workspace_root
            : resolve(defaultWorkspaceRoot(), workspace_root)
          : defaultWorkspaceRoot();
        const lookupKind = kind ?? "recipe";
        const layers = scanWorkspaceLayers(root);
        const providers: Array<{ layer: string; path: string }> = [];
        for (const layer of layers) {
          const hit =
            lookupKind === "recipe"
              ? layer.pns.has(name)
              : layer.classes.has(name);
          if (hit) {
            providers.push({
              layer: layer.name,
              path: relative(root, layer.dir),
            });
          }
        }
        const found = providers.length > 0;
        return {
          content: [
            {
              type: "text",
              text: renderProviders(name, lookupKind, providers),
            },
          ],
          structuredContent: { found, providers },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# find-recipe-providers failed\n\n❌ ${message}\n`,
            },
          ],
          structuredContent: { found: false, providers: [], error: message },
        };
      }
    },
  );
}

function renderProviders(
  name: string,
  kind: string,
  providers: Array<{ layer: string; path: string }>,
): string {
  let out = `# find-recipe-providers\n\n`;
  out += `**Looking up:** \`${name}\` (${kind})\n`;
  out += `**Providers:** ${providers.length}\n`;
  if (providers.length === 0) {
    out += `\nNo workspace layer provides \`${name}\`.\n`;
    return out;
  }
  out += `\n| layer | path |\n`;
  out += `| --- | --- |\n`;
  for (const p of providers) {
    out += `| \`${p.layer}\` | \`${p.path}\` |\n`;
  }
  return out;
}
