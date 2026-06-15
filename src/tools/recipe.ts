import { readdirSync, readFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoClient } from "../lib/repo-client.js";

/**
 * Recipe-authoring MCP tools backed by the OpenEmbedded layer-index REST API.
 *
 * The layer-index (https://layers.openembedded.org/layerindex/api/) is an
 * unauthenticated, read-only JSON API. The `?name=` filter on `recipes/` is
 * unreliable (it returns unrelated recipes), so this tool scopes results two
 * ways: by branch (resolve the scarthgap branch id from `branches?name=...`
 * and keep only recipes whose `layerbranch` belongs to that branch) and by a
 * client-side substring match on the caller-supplied `name`.
 */

const LAYER_INDEX_BASE = "https://layers.openembedded.org/layerindex/api/";
const BRANCH = "scarthgap";
const USER_AGENT = "avocado-mcp-server";

/** Recipe object as returned by the layer-index `recipes/` endpoint. */
interface LayerIndexRecipe {
  pn: string;
  pv: string;
  provides: string;
  bbclassextend: string;
  srcrev: string;
  layerbranch: number;
}

/** Branch object as returned by the layer-index `branches/` endpoint. */
interface LayerIndexBranch {
  id: number;
  name: string;
}

/**
 * A layerBranch object maps a layerbranch id to its owning layer. The layer
 * name lives on the nested `layer` object's `name` field; the flat
 * `layer__name` field is also exposed by the API for convenience.
 */
interface LayerIndexLayerBranch {
  id: number;
  layer?: { name?: string };
  layer__name?: string;
}

/** Result row surfaced to the caller. */
interface RecipeResult {
  pn: string;
  pv: string;
  layer: string;
  provides: string;
  bbclassextend: string;
  srcrev: string;
}

async function fetchJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`${url} returned ${res.status}`);
  }
  return res.json();
}

const recipeResultSchema = z.object({
  pn: z.string(),
  pv: z.string(),
  layer: z.string(),
  provides: z.string(),
  bbclassextend: z.string(),
  srcrev: z.string(),
});

export function registerRecipeTools(
  server: McpServer,
  _repoClient: RepoClient,
): void {
  server.registerTool(
    "search-layer-index",
    {
      title: "Search the OpenEmbedded layer-index",
      description:
        "Search the OpenEmbedded layer-index for recipes available on the scarthgap branch. Use this to discover whether an upstream recipe already exists for a package before authoring one from scratch — it tells you the recipe name (`pn`), version (`pv`), the layer that provides it, what it `provides`, its `bbclassextend` (e.g. native/nativesdk variants), and `srcrev`. Matches the recipe name by substring (case-insensitive) and is scoped to the scarthgap release branch. Returns live results from layers.openembedded.org; on a network error it returns an `error` string instead of throwing.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe(
            "Recipe name to search for (substring, case-insensitive). Examples: 'numpy', 'flatbuffers', 'tflite'.",
          ),
      },
      outputSchema: {
        found: z.boolean(),
        results: z.array(recipeResultSchema),
        error: z.string().optional(),
      },
      annotations: {
        title: "Search the OpenEmbedded layer-index",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ name }) => {
      try {
        // 1. Resolve the scarthgap branch id.
        const branchesRaw = await fetchJson(
          `${LAYER_INDEX_BASE}branches/?format=json&name=${encodeURIComponent(
            BRANCH,
          )}`,
        );
        const branches = Array.isArray(branchesRaw)
          ? (branchesRaw as LayerIndexBranch[])
          : [];
        const branch = branches.find((b) => b?.name === BRANCH);
        if (!branch) {
          const text = `# search-layer-index\n\nCould not resolve the \`${BRANCH}\` branch id from the layer-index. The API may have changed or be unavailable.`;
          return {
            content: [{ type: "text", text }],
            structuredContent: {
              found: false,
              results: [],
              error: `branch "${BRANCH}" not found in layer-index`,
            },
          };
        }
        const branchId = branch.id;

        // 2. Fetch all recipes, filter client-side by branch + name substring.
        //    `?name=` is unreliable on this endpoint, so we filter ourselves.
        const recipesRaw = await fetchJson(
          `${LAYER_INDEX_BASE}recipes/?format=json`,
        );
        const recipes = Array.isArray(recipesRaw)
          ? (recipesRaw as LayerIndexRecipe[])
          : [];
        const needle = name.trim().toLowerCase();
        const matched = recipes.filter(
          (r) =>
            r &&
            r.layerbranch === branchId &&
            typeof r.pn === "string" &&
            r.pn.toLowerCase().includes(needle),
        );

        // 3. Resolve layerbranch ids -> layer names so each row names its
        //    owning layer rather than an opaque numeric id.
        const layerNames = await resolveLayerNames(
          new Set(matched.map((r) => r.layerbranch)),
        );

        const results: RecipeResult[] = matched.map((r) => ({
          pn: r.pn,
          pv: r.pv ?? "",
          layer: layerNames.get(r.layerbranch) ?? String(r.layerbranch),
          provides: r.provides ?? "",
          bbclassextend: r.bbclassextend ?? "",
          srcrev: r.srcrev ?? "",
        }));

        const found = results.length > 0;
        return {
          content: [
            {
              type: "text",
              text: renderResults(name, branchId, results),
            },
          ],
          structuredContent: { found, results },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# search-layer-index failed\n\n❌ ${message}\n\n## Troubleshooting\n\n1. **Check connectivity.** The server must reach layers.openembedded.org.\n2. **Retry.** The layer-index API is occasionally slow or rate-limited.`,
            },
          ],
          structuredContent: { found: false, results: [], error: message },
        };
      }
    },
  );

  registerExplainBitbake(server);
  registerFindRecipeExamples(server);
  registerScaffoldRecipe(server);
}

/**
 * Build a layerbranch-id -> layer-name map for the given ids. A failure here
 * is non-fatal: callers fall back to the numeric id, so a layerBranches fetch
 * error must not sink the whole search. Returns an empty map on any failure.
 */
async function resolveLayerNames(
  ids: Set<number>,
): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.size === 0) return out;
  try {
    const raw = await fetchJson(
      `${LAYER_INDEX_BASE}layerBranches/?format=json`,
    );
    const layerBranches = Array.isArray(raw)
      ? (raw as LayerIndexLayerBranch[])
      : [];
    for (const lb of layerBranches) {
      if (!lb || typeof lb.id !== "number" || !ids.has(lb.id)) continue;
      const layerName = lb.layer?.name ?? lb.layer__name;
      if (typeof layerName === "string" && layerName.length > 0) {
        out.set(lb.id, layerName);
      }
    }
  } catch {
    // Non-fatal: leave the map empty, callers fall back to the numeric id.
  }
  return out;
}

function renderResults(
  name: string,
  branchId: number,
  results: RecipeResult[],
): string {
  let out = `# search-layer-index\n\n`;
  out += `**Query:** \`${name}\` (substring, case-insensitive)\n`;
  out += `**Branch:** \`${BRANCH}\` (id ${branchId})\n`;
  out += `**Matches:** ${results.length}\n`;
  if (results.length === 0) {
    out += `\nNo scarthgap recipe name contains \`${name}\`. Try a shorter substring, or author a new recipe.\n`;
    return out;
  }
  out += `\n| pn | pv | layer | bbclassextend |\n`;
  out += `| --- | --- | --- | --- |\n`;
  for (const r of results) {
    out += `| \`${r.pn}\` | ${r.pv || "_(none)_"} | \`${r.layer}\` | ${
      r.bbclassextend || "_(none)_"
    } |\n`;
  }
  return out;
}

/** BitBake variable kinds surfaced by explain-bitbake. */
type BitbakeVarType = "string" | "list" | "path" | "task";

/** A single explain-bitbake table entry. */
interface BitbakeVarEntry {
  type: BitbakeVarType;
  description: string;
  doc_url: string;
}

const REF_VARS =
  "https://docs.yoctoproject.org/ref-manual/variables.html#term-";
const REF_TASKS =
  "https://docs.yoctoproject.org/ref-manual/tasks.html#ref-tasks-";

/**
 * The 12 most common BitBake recipe variables and tasks. Keyed by the
 * canonical variable/task name; lookup is case-insensitive (see
 * explain-bitbake).
 */
const BITBAKE_VARS: Record<string, BitbakeVarEntry> = {
  DESCRIPTION: {
    type: "string",
    description: "Human-readable recipe description",
    doc_url: `${REF_VARS}DESCRIPTION`,
  },
  LICENSE: {
    type: "string",
    description: "SPDX license expression",
    doc_url: `${REF_VARS}LICENSE`,
  },
  LIC_FILES_CHKSUM: {
    type: "string",
    description: "License file paths with checksums",
    doc_url: `${REF_VARS}LIC_FILES_CHKSUM`,
  },
  SRC_URI: {
    type: "list",
    description: "Source file URIs to fetch",
    doc_url: `${REF_VARS}SRC_URI`,
  },
  SRCREV: {
    type: "string",
    description: "SCM revision to fetch",
    doc_url: `${REF_VARS}SRCREV`,
  },
  DEPENDS: {
    type: "list",
    description: "build-time package dependencies",
    doc_url: `${REF_VARS}DEPENDS`,
  },
  RDEPENDS: {
    type: "list",
    description: "Runtime package dependencies",
    doc_url: `${REF_VARS}RDEPENDS`,
  },
  S: {
    type: "path",
    description: "Source directory (defaults to WORKDIR/name-version)",
    doc_url: `${REF_VARS}S`,
  },
  B: {
    type: "path",
    description: "Build directory (defaults to S)",
    doc_url: `${REF_VARS}B`,
  },
  do_configure: {
    type: "task",
    description: "Custom configure step (run cmake, ./configure, etc.)",
    doc_url: `${REF_TASKS}configure`,
  },
  do_compile: {
    type: "task",
    description: "Custom compile step",
    doc_url: `${REF_TASKS}compile`,
  },
  do_install: {
    type: "task",
    description: "Install files into ${D}",
    doc_url: `${REF_TASKS}install`,
  },
};

/** Case-insensitive name -> canonical key map, built once at module load. */
const BITBAKE_VAR_LOOKUP = new Map<string, string>(
  Object.keys(BITBAKE_VARS).map((key) => [key.toLowerCase(), key]),
);

const explainBitbakeResultSchema = {
  found: z.boolean(),
  variable: z.string().optional(),
  type: z.enum(["string", "list", "path", "task"]).optional(),
  description: z.string().optional(),
  doc_url: z.string().optional(),
  error: z.string().optional(),
};

function registerExplainBitbake(server: McpServer): void {
  server.registerTool(
    "explain-bitbake",
    {
      title: "Explain a common BitBake recipe variable",
      description:
        "Explain one of the 12 most common BitBake recipe variables or tasks (DESCRIPTION, LICENSE, LIC_FILES_CHKSUM, SRC_URI, SRCREV, DEPENDS, RDEPENDS, S, B, do_configure, do_compile, do_install). Returns the variable's type (string/list/path/task), a one-line description, and a link to the Yocto reference manual. Lookup is case-insensitive. Unknown names return an `error` listing the known variables.",
      inputSchema: {
        symbol: z
          .string()
          .min(1)
          .describe(
            "BitBake variable or task name to explain (case-insensitive). Examples: 'DEPENDS', 'SRC_URI', 'do_install'.",
          ),
      },
      outputSchema: explainBitbakeResultSchema,
      annotations: {
        title: "Explain a common BitBake recipe variable",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ symbol }) => {
      const key = BITBAKE_VAR_LOOKUP.get(symbol.trim().toLowerCase());
      if (key === undefined) {
        const known = Object.keys(BITBAKE_VARS).join(", ");
        const error = `unknown variable ${symbol}; known: [${known}]`;
        return {
          content: [
            {
              type: "text",
              text: `# explain-bitbake\n\n❌ ${error}`,
            },
          ],
          structuredContent: { found: false, error },
        };
      }
      const entry = BITBAKE_VARS[key];
      return {
        content: [
          {
            type: "text",
            text:
              `# explain-bitbake: \`${key}\`\n\n` +
              `**Type:** ${entry.type}\n\n` +
              `${entry.description}\n\n` +
              `[Reference manual](${entry.doc_url})\n`,
          },
        ],
        structuredContent: {
          found: true,
          variable: key,
          type: entry.type,
          description: entry.description,
          doc_url: entry.doc_url,
        },
      };
    },
  );
}

/**
 * Default workspace root: the directory that holds avocado-mcp, `corpus/`, and
 * `meta-avocado/` as siblings. The compiled module lives at
 * `build/tools/recipe.js`, so three `..` hops land on avocado-mcp's parent.
 * Mirrors `corpus.ts`' `defaultCorpusDir()` path convention.
 */
function defaultWorkspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../");
}

/** A single find-recipe-examples result row. */
interface RecipeExample {
  path: string;
  content: string;
  score: number;
}

/** Split a free-text intent into lowercase keyword tokens for overlap scoring. */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9_]+/)
    .filter((t) => t.length > 0);
}

/**
 * Score a corpus case against the intent tokens. The score is the count of
 * distinct intent tokens that appear in the case's `build_system`,
 * `failed_task`, or `root_cause` fields. A zero score means no overlap.
 */
function scoreCase(
  intentTokens: Set<string>,
  caseObj: Record<string, unknown>,
): number {
  const haystack = ["build_system", "failed_task", "root_cause"]
    .map((field) => (typeof caseObj[field] === "string" ? caseObj[field] : ""))
    .join(" ");
  const haystackTokens = new Set(tokenize(haystack as string));
  let score = 0;
  for (const tok of intentTokens) {
    if (haystackTokens.has(tok)) score += 1;
  }
  return score;
}

/**
 * Collect corpus-case examples from `<root>/corpus/cases/*.yaml` whose
 * `build_system`/`failed_task`/`root_cause` fields overlap the intent tokens.
 * A missing corpus directory or an unparseable individual file is skipped
 * rather than failing the scan, so one corrupt case cannot blind retrieval.
 */
function collectCorpusExamples(
  root: string,
  intentTokens: Set<string>,
): RecipeExample[] {
  const casesDir = resolve(root, "corpus", "cases");
  let entries: string[];
  try {
    entries = readdirSync(casesDir);
  } catch {
    return [];
  }

  const examples: RecipeExample[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const filePath = resolve(casesDir, entry);
    let raw: string;
    try {
      raw = readFileSync(filePath, "utf8");
    } catch {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseYaml(raw);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      continue;
    }
    const score = scoreCase(intentTokens, parsed as Record<string, unknown>);
    if (score > 0) {
      examples.push({
        path: relative(root, filePath),
        content: raw,
        score,
      });
    }
  }
  return examples;
}

/**
 * Recursively list every `.bb` file under `dir`. A directory that cannot be
 * read is skipped silently so a permission hiccup in one subtree does not abort
 * the whole walk.
 */
function listBbFiles(dir: string): string[] {
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
      out.push(...listBbFiles(full));
    } else if (entry.endsWith(".bb")) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Collect `.bb` recipe examples from `<root>/meta-avocado/` that `inherit` the
 * given class. The score is fixed at 1: an inherit match is binary, not a
 * keyword overlap. A missing `meta-avocado/` tree yields no examples.
 */
function collectBbExamples(
  root: string,
  inheritClass: string,
): RecipeExample[] {
  const metaDir = resolve(root, "meta-avocado");
  const files = listBbFiles(metaDir);
  const needle = new RegExp(
    `^\\s*inherit\\b[^\\n]*\\b${escapeRegExp(inheritClass)}\\b`,
    "m",
  );
  const examples: RecipeExample[] = [];
  for (const file of files) {
    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    if (needle.test(content)) {
      examples.push({
        path: relative(root, file),
        content,
        score: 1,
      });
    }
  }
  return examples;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const recipeExampleSchema = z.object({
  path: z.string(),
  content: z.string(),
  score: z.number(),
});

function registerFindRecipeExamples(server: McpServer): void {
  server.registerTool(
    "find-recipe-examples",
    {
      title: "Find real recipe examples by intent",
      description:
        "Retrieve real recipe examples as pattern fuel before authoring or fixing a BitBake recipe. Matches an `intent` string against the verified error-learning corpus (`corpus/cases/*.yaml`) by keyword overlap on each case's `build_system`, `failed_task`, and `root_cause` fields, and — when an `inherit` class is given — additionally returns `.bb` recipes under `meta-avocado/` whose `inherit` line includes that class (e.g. cmake, meson, setuptools3, autotools, cargo). Returns up to `limit` examples as `{path, content, score}` rows sorted by descending score (corpus keyword-overlap count; inherit matches score 1). On a filesystem error it returns an `error` string instead of throwing.",
      inputSchema: {
        intent: z
          .string()
          .min(1)
          .describe(
            "Free-text description of what you are trying to author or fix. Matched (keyword overlap) against corpus cases' build_system/failed_task/root_cause. Examples: 'cmake do_install staging', 'setuptools3 numpy runtime dependency'.",
          ),
        inherit: z
          .string()
          .optional()
          .describe(
            "BitBake class to additionally find `.bb` examples for under meta-avocado/ (matches the `inherit` line). Examples: 'cmake', 'meson', 'setuptools3', 'autotools', 'cargo'.",
          ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum number of examples to return (default 5)."),
      },
      outputSchema: {
        found: z.boolean(),
        count: z.number(),
        examples: z.array(recipeExampleSchema),
        error: z.string().optional(),
      },
      annotations: {
        title: "Find real recipe examples by intent",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ intent, inherit, limit }) => {
      try {
        const root = defaultWorkspaceRoot();
        const cap = limit ?? 5;
        const intentTokens = new Set(tokenize(intent));

        const examples = collectCorpusExamples(root, intentTokens);
        if (typeof inherit === "string" && inherit.trim().length > 0) {
          examples.push(...collectBbExamples(root, inherit.trim()));
        }

        examples.sort((a, b) => b.score - a.score);
        const top = examples.slice(0, cap);
        const found = top.length > 0;

        return {
          content: [
            { type: "text", text: renderExamples(intent, inherit, top) },
          ],
          structuredContent: { found, count: top.length, examples: top },
        };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# find-recipe-examples failed\n\n❌ ${message}`,
            },
          ],
          structuredContent: {
            found: false,
            count: 0,
            examples: [],
            error: message,
          },
        };
      }
    },
  );
}

function renderExamples(
  intent: string,
  inherit: string | undefined,
  examples: RecipeExample[],
): string {
  let out = `# find-recipe-examples\n\n`;
  out += `**Intent:** \`${intent}\`\n`;
  if (inherit) out += `**Inherit:** \`${inherit}\`\n`;
  out += `**Matches:** ${examples.length}\n`;
  if (examples.length === 0) {
    out += `\nNo corpus case or recipe matched. Broaden the intent or drop the inherit filter.\n`;
    return out;
  }
  out += `\n`;
  for (const ex of examples) {
    out += `## \`${ex.path}\` (score ${ex.score})\n\n`;
  }
  return out;
}

/**
 * Parse the first `inherit` line from recipe text and return the inherited
 * classes as a single space-joined string (e.g. "setuptools3"), or undefined
 * when the recipe has no inherit line. Leading/trailing whitespace and the
 * `inherit` keyword are stripped.
 */
function parseInheritLine(recipeText: string): string | undefined {
  for (const line of recipeText.split("\n")) {
    const match = line.match(/^\s*inherit\s+(.+?)\s*$/);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * Scan recipetool's output for variables that still hold placeholder values a
 * human must resolve before the recipe will build:
 *   - any variable whose value contains `???` (recipetool's unknown marker);
 *   - DEPENDS / RDEPENDS assigned an empty value (unresolved dependencies);
 *   - LIC_FILES_CHKSUM whose md5 checksum is a placeholder rather than a real
 *     32-hex digest.
 * Returns the offending variable names (deduplicated, in first-seen order).
 */
function detectManualReview(recipeText: string): string[] {
  const flagged: string[] = [];
  const seen = new Set<string>();
  const flag = (name: string): void => {
    if (!seen.has(name)) {
      seen.add(name);
      flagged.push(name);
    }
  };

  for (const rawLine of recipeText.split("\n")) {
    const line = rawLine.trim();
    const assign = line.match(
      /^([A-Za-z_][A-Za-z0-9_:${}.-]*)\s*[+?:]?=\s*(.*)$/,
    );
    if (!assign) continue;
    const name = assign[1].replace(/:.*$/, "");
    const value = assign[2].replace(/^["']|["']$/g, "").trim();

    if (assign[2].includes("???")) {
      flag(name);
      continue;
    }
    if ((name === "DEPENDS" || name === "RDEPENDS") && value.length === 0) {
      flag(name);
      continue;
    }
    if (name === "LIC_FILES_CHKSUM") {
      const md5 = value.match(/md5=([^;"'\s]*)/);
      if (md5 && !/^[0-9a-f]{32}$/i.test(md5[1])) {
        flag(name);
      }
    }
  }
  return flagged;
}

const scaffoldRecipeResultSchema = {
  recipe_text: z.string().optional(),
  inherit_detected: z.string().optional(),
  needs_manual_review: z.array(z.string()).optional(),
  error: z.string().optional(),
  hint: z.string().optional(),
};

function registerScaffoldRecipe(server: McpServer): void {
  server.registerTool(
    "scaffold-recipe",
    {
      title: "Scaffold a BitBake recipe with recipetool",
      description:
        "Generate a first-draft BitBake recipe for a package source URL (GitHub repo or PyPI) by shelling out to `recipetool create --fetch`. Requires an initialized build environment (`BUILDDIR` set; enter one via `kas shell meta-avocado/kas/machine/qemux86-64.yml`) — when it is not set the tool returns immediately with an `error` and a `hint`. On success it returns the generated recipe text, the `inherit` class recipetool detected, and a `needs_manual_review` list naming variables (e.g. DEPENDS, RDEPENDS, LIC_FILES_CHKSUM) that still hold placeholder values a human must resolve. A non-zero recipetool exit returns its stderr as `error`.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            "Package source URL to scaffold from. Examples: a GitHub repo URL or a PyPI project/sdist URL.",
          ),
      },
      outputSchema: scaffoldRecipeResultSchema,
      annotations: {
        title: "Scaffold a BitBake recipe with recipetool",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ url }) => {
      if (!process.env.BUILDDIR) {
        const error = "build environment not initialized";
        const hint = "kas shell meta-avocado/kas/machine/qemux86-64.yml";
        return {
          content: [
            {
              type: "text",
              text: `# scaffold-recipe\n\n❌ ${error}\n\nEnter a build environment first:\n\n    ${hint}\n`,
            },
          ],
          structuredContent: { error, hint },
        };
      }

      const outPath = `/tmp/scaffold-${Date.now()}.bb`;
      try {
        execSync(
          `recipetool create --fetch ${JSON.stringify(url)} -o ${JSON.stringify(
            outPath,
          )}`,
          { timeout: 60_000, stdio: ["ignore", "pipe", "pipe"] },
        );
      } catch (error) {
        const stderr =
          error && typeof error === "object" && "stderr" in error
            ? String((error as { stderr: unknown }).stderr ?? "")
            : "";
        const message =
          stderr.trim().length > 0
            ? stderr.trim()
            : error instanceof Error
              ? error.message
              : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# scaffold-recipe failed\n\n❌ ${message}\n`,
            },
          ],
          structuredContent: { error: message },
        };
      }

      let recipeText: string;
      try {
        recipeText = readFileSync(outPath, "utf8");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          content: [
            {
              type: "text",
              text: `# scaffold-recipe failed\n\n❌ ${message}\n`,
            },
          ],
          structuredContent: { error: message },
        };
      }

      const inheritDetected = parseInheritLine(recipeText);
      const needsManualReview = detectManualReview(recipeText);

      return {
        content: [
          {
            type: "text",
            text: renderScaffold(inheritDetected, needsManualReview),
          },
        ],
        structuredContent: {
          recipe_text: recipeText,
          inherit_detected: inheritDetected,
          needs_manual_review: needsManualReview,
        },
      };
    },
  );
}

function renderScaffold(
  inheritDetected: string | undefined,
  needsManualReview: string[],
): string {
  let out = `# scaffold-recipe\n\n`;
  out += `**inherit:** ${
    inheritDetected ? `\`${inheritDetected}\`` : "_(none detected)_"
  }\n`;
  out += `**Needs manual review:** ${
    needsManualReview.length > 0
      ? needsManualReview.map((v) => `\`${v}\``).join(", ")
      : "_(none)_"
  }\n`;
  return out;
}
