import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RepoClient } from "../lib/repo-client.js";
import { findLayerDirs } from "./layer-analysis.js";

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
  registerLintRecipe(server);
  registerIntrospectRecipe(server);
  registerStageRecipeToFeed(server);
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
  alternatives: z.string().optional(),
};

/**
 * Path to the vendored Yocto variable glossary, resolved relative to the
 * compiled module (`build/tools/recipe.js` -> `../../yocto-refs/...`), matching
 * how `defaultCorpusRoot()` resolves the in-repo corpus. A symbol not in the
 * 12-entry table falls through to a text scan of this file.
 */
function variablesRstPath(): string {
  return resolve(
    defaultCorpusRoot(),
    "yocto-refs/yocto-docs/documentation/ref-manual/variables.rst",
  );
}

/**
 * Scan the vendored `variables.rst` glossary for a `:term:`<SYMBOL>`` entry and
 * return its description as a single collapsed paragraph, or undefined when the
 * symbol is absent. The glossary lists each variable as
 *   `   :term:`VARNAME``
 * followed by 6-space-indented body lines until the next `   :term:` anchor (or
 * a dedent to a shallower directive). The first body paragraph is enough for an
 * explanation; later code blocks and cross-references are dropped. A missing or
 * unreadable file yields undefined rather than throwing, so the caller degrades
 * to the structured not-found.
 */
function lookupVariableInRst(
  symbol: string,
): { name: string; description: string } | undefined {
  let text: string;
  try {
    text = readFileSync(variablesRstPath(), "utf8");
  } catch {
    return undefined;
  }

  const lines = text.split("\n");
  // Match the `:term:` anchor case-insensitively (the glossary lists names in
  // uppercase; callers may pass any case) and recover the canonical casing
  // from the file so the doc_url anchor (#term-NAME) stays valid.
  const target = symbol.toLowerCase();
  const anchor = /^   :term:`([^`]+)`\s*$/;
  let start = -1;
  let name = symbol;
  for (let i = 0; i < lines.length; i += 1) {
    const m = anchor.exec(lines[i]);
    if (m && m[1].toLowerCase() === target) {
      name = m[1];
      start = i + 1;
      break;
    }
  }
  if (start === -1) return undefined;

  // Collect the first body paragraph: 6-space-indented prose lines, stopping at
  // the first blank line (paragraph break) once prose has started, or at the
  // next term anchor / dedent.
  const para: string[] = [];
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^   :term:`/.test(line)) break; // next glossary entry
    if (line.trim().length === 0) {
      if (para.length > 0) break; // end of first paragraph
      continue; // leading blank line
    }
    if (!/^ {6}/.test(line)) break; // dedent out of the entry body
    para.push(line.trim());
  }

  const description = para.join(" ").trim();
  return description.length > 0 ? { name, description } : undefined;
}

function registerExplainBitbake(server: McpServer): void {
  server.registerTool(
    "explain-bitbake",
    {
      title: "Explain a common BitBake recipe variable",
      description:
        'Explain a BitBake recipe variable or task. The 12 most common ones (DESCRIPTION, LICENSE, LIC_FILES_CHKSUM, SRC_URI, SRCREV, DEPENDS, RDEPENDS, S, B, do_configure, do_compile, do_install) return from a hardcoded fast-path table with a type (string/list/path/task), a one-line description, and a reference-manual link. Any other symbol falls through to a text scan of the vendored Yocto variable glossary (variables.rst); a glossary hit returns `found: true` with the extracted description and a doc_url. A symbol in neither returns `found: false` with `alternatives: "search-docs"` (no `error` field) — use search-docs as the fallback. Lookup is case-insensitive.',
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
        const trimmed = symbol.trim();
        if (trimmed.includes(":")) {
          // Colon override expression (e.g. do_install:append, SRC_URI:prepend).
          // These are operator expressions, not variable names; intercept before
          // the glossary scan so the caller gets override-syntax guidance.
          const docUrl =
            "https://docs.yoctoproject.org/bitbake/bitbake-user-manual/bitbake-user-manual-metadata.html#appending-and-prepending-override-style-syntax";
          const description =
            "Colon override expression. In scarthgap (BitBake 2.8+) the colon form " +
            "(VAR:append, VAR:prepend, VAR:remove, do_task:append) replaced the " +
            "deprecated underscore form (VAR_append). Hard parse error in scarthgap.";
          return {
            content: [
              {
                type: "text",
                text:
                  "# explain-bitbake: colon override syntax\n\n" +
                  "`" +
                  trimmed +
                  "` is a BitBake colon override expression, not a variable.\n\n" +
                  "In scarthgap (BitBake 2.8+), the colon syntax replaced the old underscore form:\n" +
                  "- `VAR:append = value` -- appends to a variable\n" +
                  "- `VAR:prepend = value` -- prepends to a variable\n" +
                  "- `VAR:remove = value` -- removes a word from a list variable\n" +
                  "- `do_task:append() { ... }` -- appends shell code to a task\n\n" +
                  "The old underscore form (`VAR_append`, `do_task_append`) is a hard error in scarthgap.\n\n" +
                  "[BitBake manual: override-style syntax](" +
                  docUrl +
                  ")\n",
              },
            ],
            structuredContent: {
              found: true,
              variable: trimmed,
              description,
              doc_url: docUrl,
            },
          };
        }
        if (trimmed.toLowerCase() === "inherit") {
          // "inherit" is the recipe directive. The glossary returns the INHERIT config
          // variable instead, which misleads recipe authors.
          const docUrl =
            "https://docs.yoctoproject.org/bitbake/bitbake-user-manual/bitbake-user-manual-metadata.html#inherit-directive";
          const description =
            "Recipe directive that includes a class, injecting its standard task " +
            "implementations (do_configure, do_compile, do_install). Examples: " +
            "`inherit cmake`, `inherit meson`, `inherit setuptools3`. " +
            "Distinct from the INHERIT config variable, which applies classes globally.";
          return {
            content: [
              {
                type: "text",
                text:
                  "# explain-bitbake: `inherit` directive\n\n" +
                  "The `inherit` statement includes a class in a recipe:\n\n" +
                  "```\n" +
                  "inherit cmake       # CMake build system\n" +
                  "inherit meson       # Meson build system\n" +
                  "inherit setuptools3 # Python package\n" +
                  "```\n\n" +
                  "Classes live in `classes/` or `classes-global/` directories across layers.\n\n" +
                  "If you meant the **INHERIT** config variable (global class inheritance), " +
                  "try search-docs with query INHERIT.\n\n" +
                  "[BitBake manual: inherit directive](" +
                  docUrl +
                  ")\n",
              },
            ],
            structuredContent: {
              found: true,
              variable: "inherit",
              description,
              doc_url: docUrl,
            },
          };
        }
        // Fall through to the vendored variable glossary.
        const hit = lookupVariableInRst(trimmed);
        if (hit !== undefined) {
          const doc_url = `${REF_VARS}${hit.name}`;
          return {
            content: [
              {
                type: "text",
                text:
                  `# explain-bitbake: \`${hit.name}\`\n\n` +
                  `${hit.description}\n\n` +
                  `[Reference manual](${doc_url})\n`,
              },
            ],
            structuredContent: {
              found: true,
              variable: hit.name,
              description: hit.description,
              doc_url,
            },
          };
        }
        // Not in the table nor the glossary: structured not-found, no error
        // field, so the caller falls back to search-docs.
        return {
          content: [
            {
              type: "text",
              text: `# explain-bitbake\n\n\`${trimmed}\` is not in the common-variable table or the Yocto glossary. Try \`search-docs\` with the variable name as the query.`,
            },
          ],
          structuredContent: { found: false, alternatives: "search-docs" },
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

  registerValidateRecipeParse(server);
}

const validateRecipeParseResultSchema = {
  ok: z.boolean(),
  errors: z.array(z.string()),
  warnings: z.array(z.string()),
  hint: z.string().optional(),
};

/**
 * Probe whether `bitbake` is resolvable on the current PATH without invoking
 * a parse. `execFileSync("bitbake", ["--version"])` throws an ENOENT-coded
 * error when the binary is absent (e.g. outside a kas/build environment); any
 * other failure (a bitbake that exists but errors) still proves the binary is
 * present, so only ENOENT counts as "unavailable". This keeps the tool from
 * letting an unhandled ENOENT escape the later `bitbake -e` call.
 */
function isBitbakeAvailable(): boolean {
  try {
    execFileSync("bitbake", ["--version"], {
      stdio: ["ignore", "ignore", "ignore"],
      timeout: 30_000,
    });
    return true;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error
        ? String((error as Record<string, unknown>).code)
        : "";
    return code !== "ENOENT";
  }
}

/**
 * Derive the recipe name (PN) bitbake should parse from a `.bb` file path.
 * BitBake parses by recipe name, not file path, so a path like
 * `…/foo_1.2.3.bb` resolves to the recipe `foo`. Strips the directory, the
 * `.bb` extension, and the trailing `_<version>` segment.
 */
function recipeNameFromPath(recipePath: string): string {
  const base = recipePath.replace(/^.*[/\\]/, "").replace(/\.bb$/, "");
  const underscore = base.indexOf("_");
  return underscore === -1 ? base : base.slice(0, underscore);
}

/**
 * Extract the individual SRC_URI fetcher entries from recipe text. Handles the
 * three shapes the linter cares about: `SRC_URI = "..."`, `SRC_URI:append`
 * (and any override/operator form like `SRC_URI:append:class-target += "..."`),
 * and backslash-continued multi-line values. This is a best-effort static scan,
 * not a bitbake parse: it concatenates every quoted SRC_URI assignment body and
 * splits the result on whitespace into URI tokens. Tokens with no `://` scheme
 * (bare `file` names, expansion fragments) are dropped.
 */
function parseSrcUriEntries(recipeText: string): string[] {
  // Join backslash-continued lines so a multi-line SRC_URI value is one string.
  const joined = recipeText.replace(/\\\r?\n/g, " ");
  const entries: string[] = [];
  // Match any SRC_URI assignment (with optional override suffix and operator)
  // capturing the double-quoted body. Single-line after the join above.
  const re =
    /^\s*SRC_URI(?::[A-Za-z0-9_${}.:-]+)?\s*(?:\+=|=\+|\?\?=|\?=|:=|\.=|=\.|=)\s*"([^"]*)"/gm;
  let match: RegExpExecArray | null;
  while ((match = re.exec(joined)) !== null) {
    for (const token of match[1].split(/\s+/)) {
      const trimmed = token.trim();
      if (trimmed.length > 0 && trimmed.includes("://")) {
        entries.push(trimmed);
      }
    }
  }
  return entries;
}

/**
 * Run the SRC_URI fetcher-syntax checks that oelint-adv's `src-uri` lints do
 * NOT cover: a git fetcher missing both `;branch=` and `;nobranch=1`, and a
 * remote source on a non-HTTPS scheme. Each finding is a one-line warning
 * string. Pure text analysis, so it runs regardless of bitbake availability.
 */
function checkSrcUriSyntax(recipeText: string): string[] {
  const warnings: string[] = [];
  for (const entry of parseSrcUriEntries(recipeText)) {
    const scheme = entry.slice(0, entry.indexOf("://")).toLowerCase();
    const params = entry.split(";").slice(1);
    const hasParam = (key: string): boolean =>
      params.some((p) => p.trim().toLowerCase().startsWith(`${key}=`));

    // 1. git fetcher must pin a branch (scarthgap default); `;nobranch=1` is the
    //    explicit opt-out and is equally valid, so only warn when neither is set.
    if (scheme === "git" || scheme === "gitsm") {
      const hasBranch = hasParam("branch");
      const hasNobranch = params.some(
        (p) => p.trim().toLowerCase() === "nobranch=1",
      );
      if (!hasBranch && !hasNobranch) {
        warnings.push(
          `SRC_URI git fetcher "${entry}" is missing a ;branch= parameter ` +
            `(scarthgap's git fetcher requires it; its absence fails do_fetch). ` +
            `Add ;branch=<name>, or ;nobranch=1 if the revision is not on a branch.`,
        );
      }
    }

    // 2. Remote sources should use https. A plain http:// or ftp:// source, or a
    //    git:///gitsm:// fetcher without protocol=https, is insecure. (file://
    //    is local, not remote, so it is exempt.)
    if (scheme === "http" || scheme === "ftp") {
      warnings.push(
        `SRC_URI entry "${entry}" uses the insecure ${scheme}:// scheme; ` +
          `prefer https:// for remote sources.`,
      );
    } else if (
      (scheme === "git" || scheme === "gitsm") &&
      !params.some((p) => p.trim().toLowerCase() === "protocol=https")
    ) {
      warnings.push(
        `SRC_URI git fetcher "${entry}" does not set protocol=https; ` +
          `prefer https for remote git sources.`,
      );
    }
  }
  return warnings;
}

/**
 * Parse-only correctness gate: run `bitbake -e <PN>` and report whether the
 * recipe parses. Returns the structured `{ ok, errors, warnings }` contract.
 * Outside a build environment (no bitbake on PATH) it returns a structured
 * `ok:false` error rather than throwing, so the skill's fix loop can surface
 * "needs a build environment" without a crash.
 */
function registerValidateRecipeParse(server: McpServer): void {
  server.registerTool(
    "validate-recipe-parse",
    {
      title: "Validate that a recipe parses (parse-only bitbake gate)",
      description:
        "Gate an authored recipe through a parse-only `bitbake -e <PN>` invocation and return `{ ok, errors, warnings }`. This is the final correctness gate before claiming a recipe is ready — call it after `lint-recipe` in the build-fix loop. The recipe name (PN) is derived from the `.bb` filename unless `pn` is given explicitly. When `bitbake` is not on PATH (outside a kas/build environment) it returns `ok:false` with a structured error rather than throwing — the caller must check `ok` and surface that a build environment is needed (enter one via `kas shell meta-avocado/kas/machine/qemuarm64.yml`). When bitbake exits non-zero (e.g. the deprecated underscore override syntax like `SRC_URI_append`, which scarthgap rejects with a hard `bb.fatal` from `data_smart.py`), its stderr lands in `errors`.",
      inputSchema: {
        recipe: z
          .string()
          .min(1)
          .describe(
            "Path to the `.bb` recipe file to parse. Examples: 'meta-avocado/recipes-foo/foo/foo_1.0.bb'.",
          ),
        pn: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Recipe name (PN) to parse, overriding the name derived from the filename. Examples: 'foo', 'python3-numpy'.",
          ),
      },
      outputSchema: validateRecipeParseResultSchema,
      annotations: {
        title: "Validate that a recipe parses (parse-only bitbake gate)",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ recipe, pn }) => {
      const name = pn ?? recipeNameFromPath(recipe);

      // SRC_URI fetcher-syntax checks are a static text pass over the recipe
      // file: they run regardless of bitbake availability so the warnings
      // surface even outside a build environment. A missing/unreadable file
      // yields no SRC_URI warnings rather than failing the gate.
      let srcUriWarnings: string[] = [];
      try {
        srcUriWarnings = checkSrcUriSyntax(readFileSync(recipe, "utf8"));
      } catch {
        srcUriWarnings = [];
      }

      if (!isBitbakeAvailable()) {
        const hint = "kas shell meta-avocado/kas/machine/qemuarm64.yml";
        const message =
          "bitbake is not available on PATH; enter a build environment first";
        return {
          content: [
            {
              type: "text",
              text: `# validate-recipe-parse\n\n❌ ${message}\n\n    ${hint}\n`,
            },
          ],
          structuredContent: {
            ok: false,
            errors: [message],
            warnings: srcUriWarnings,
            hint,
          },
        };
      }

      try {
        // execFileSync (no shell) so the recipe name cannot inject commands.
        // bitbake -e dumps the full resolved environment; we discard stdout and
        // care only that the parse succeeded (exit 0). A parse failure throws
        // with the bb.fatal/ParseError text on stderr, which we surface as a
        // structured `errors` entry.
        execFileSync("bitbake", ["-e", name], {
          timeout: 120_000,
          stdio: ["ignore", "ignore", "pipe"],
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (error) {
        const message = execErrorMessage(error, "stderr");
        return {
          content: [
            {
              type: "text",
              text: `# validate-recipe-parse: \`${name}\`\n\n❌ parse failed\n\n\`\`\`\n${message}\n\`\`\`\n`,
            },
          ],
          structuredContent: {
            ok: false,
            errors: [message],
            warnings: srcUriWarnings,
          },
        };
      }

      return {
        content: [
          {
            type: "text",
            text: renderValidateParse(name, srcUriWarnings),
          },
        ],
        structuredContent: { ok: true, errors: [], warnings: srcUriWarnings },
      };
    },
  );
}

/**
 * Render the validate-recipe-parse success message: the recipe parses, plus any
 * SRC_URI fetcher-syntax warnings the static pass surfaced.
 */
function renderValidateParse(name: string, warnings: string[]): string {
  let out = `# validate-recipe-parse: \`${name}\`\n\n✅ recipe parses cleanly\n`;
  if (warnings.length > 0) {
    out += `\n**SRC_URI warnings:**\n\n`;
    for (const w of warnings) out += `- ${w}\n`;
  }
  return out;
}

/**
 * Default workspace root: the directory that holds avocado-mcp and
 * `meta-avocado/` as siblings. The compiled module lives at
 * `build/tools/recipe.js`, so three `..` hops land on avocado-mcp's parent.
 * Used for `.bb` example scanning and the meta-avocado feed-validation script;
 * the corpus now ships in-repo (see `defaultCorpusRoot()`).
 */
function defaultWorkspaceRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../");
}

/**
 * Default corpus root: the avocado-mcp repo root, which now ships `corpus/`
 * in-repo. The compiled module lives at `build/tools/recipe.js`, so two `..`
 * hops land on the avocado-mcp root. Distinct from `defaultWorkspaceRoot()`,
 * which still points at the workspace for `.bb` example scanning and the
 * meta-avocado feed-validation script.
 */
function defaultCorpusRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../");
}

/**
 * Pull a captured stream (`stdout`/`stderr`) off the object `execFileSync` throws on
 * a non-zero exit. Returns "" when the error carries no such field.
 */
function capturedStream(error: unknown, field: "stdout" | "stderr"): string {
  return error && typeof error === "object" && field in error
    ? String((error as Record<string, unknown>)[field] ?? "")
    : "";
}

/**
 * Build a human-readable message from a failed `execFileSync`: prefer the trimmed
 * captured stream, falling back to the Error message or its string form.
 */
function execErrorMessage(
  error: unknown,
  field: "stdout" | "stderr" = "stderr",
): string {
  const captured = capturedStream(error, field).trim();
  if (captured.length > 0) return captured;
  return error instanceof Error ? error.message : String(error);
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
 * Collect `.bb` recipe examples that `inherit` the given class from every
 * workspace layer (each dir carrying `conf/layer.conf`, up to two levels under
 * `root` — e.g. meta-avocado, meta-openembedded layers). The score is fixed at
 * 1: an inherit match is binary, not a keyword overlap. A workspace with no
 * layers yields no examples.
 */
function collectBbExamples(
  root: string,
  inheritClass: string,
): RecipeExample[] {
  const layerDirs = findLayerDirs(root, 2);
  const needle = new RegExp(
    `^\\s*inherit\\b[^\\n]*\\b${escapeRegExp(inheritClass)}\\b`,
    "m",
  );
  const examples: RecipeExample[] = [];
  const seen = new Set<string>();
  for (const layerDir of layerDirs) {
    for (const file of listBbFiles(layerDir)) {
      if (seen.has(file)) continue;
      seen.add(file);
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

        const examples = collectCorpusExamples(
          defaultCorpusRoot(),
          intentTokens,
        );
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
      // A multi-license LIC_FILES_CHKSUM carries one md5= per file; flag if ANY
      // is a placeholder, not just the first (recipetool can leave a later
      // entry unresolved while the first is a real digest).
      const md5s = [...value.matchAll(/md5=([^;"'\s]*)/g)];
      if (md5s.some((m) => !/^[0-9a-f]{32}$/i.test(m[1]))) {
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
        "Generate a first-draft BitBake recipe for a package source URL (GitHub repo or PyPI) by shelling out to `recipetool create --fetch`. Requires an initialized build environment (`BUILDDIR` set; enter one via `kas shell meta-avocado/kas/machine/qemuarm64.yml`) — when it is not set the tool returns immediately with an `error` and a `hint`. On success it returns the generated recipe text, the `inherit` class recipetool detected, and a `needs_manual_review` list naming variables (e.g. DEPENDS, RDEPENDS, LIC_FILES_CHKSUM) that still hold placeholder values a human must resolve. A non-zero recipetool exit returns its stderr as `error`.",
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
        const hint = "kas shell meta-avocado/kas/machine/qemuarm64.yml";
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
        // execFileSync (no shell) so a hostile `url` cannot inject commands;
        // JSON.stringify quotes for JSON, not the shell, and leaves $()/backticks live.
        execFileSync("recipetool", ["create", "--fetch", url, "-o", outPath], {
          timeout: 60_000,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        const message = execErrorMessage(error, "stderr");
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

/** Severities surfaced by lint-recipe, mapped from oelint-adv's output. */
type LintSeverity = "error" | "warning" | "info";

/** A single oelint-adv finding parsed from one stdout line. */
interface LintFinding {
  file: string;
  line: number;
  severity: LintSeverity;
  rule: string;
  message: string;
}

const lintSeverityMap: Record<string, LintSeverity> = {
  error: "error",
  warning: "warning",
  info: "info",
};

/**
 * Parse oelint-adv stdout into findings. Each finding line has the form
 *   <file>:<line>:<severity>:<rule>:<message>
 * The message itself may contain colons, so only the first four fields are
 * split on `:` and the remainder is the message. Lines that do not match the
 * shape (blank lines, summary banners) are skipped.
 */
function parseLintOutput(stdout: string): LintFinding[] {
  const findings: LintFinding[] = [];
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trimEnd();
    if (line.length === 0) continue;
    const parts = line.split(":");
    if (parts.length < 5) continue;
    const [file, lineNoRaw, severityRaw, rule, ...rest] = parts;
    const severity = lintSeverityMap[severityRaw.trim().toLowerCase()];
    if (severity === undefined) continue;
    const lineNo = Number.parseInt(lineNoRaw, 10);
    if (Number.isNaN(lineNo)) continue;
    findings.push({
      file,
      line: lineNo,
      severity,
      rule: rule.trim(),
      message: rest.join(":").trim(),
    });
  }
  return findings;
}

const lintFindingSchema = z.object({
  file: z.string(),
  line: z.number(),
  severity: z.enum(["error", "warning", "info"]),
  rule: z.string(),
  message: z.string(),
});

const lintRecipeResultSchema = {
  findings: z.array(lintFindingSchema).optional(),
  clean: z.boolean().optional(),
  error: z.string().optional(),
};

function registerLintRecipe(server: McpServer): void {
  server.registerTool(
    "lint-recipe",
    {
      title: "Lint a BitBake recipe with oelint-adv",
      description:
        "Lint a BitBake `.bb` recipe with oelint-adv against the scarthgap release. Pass an absolute path to the recipe file; when the file does not exist the tool returns `{error: 'file not found'}` immediately without invoking oelint-adv. On a real run it shells out to `oelint-adv --quiet --release scarthgap <recipe_path>` and parses each `<file>:<line>:<severity>:<rule>:<message>` line into a structured finding (severity is one of error/warning/info). Returns `{findings, clean}` where `clean` is true only when there are no findings.",
      inputSchema: {
        recipe_path: z
          .string()
          .min(1)
          .describe(
            "Absolute path to the .bb recipe file to lint. The file must exist.",
          ),
      },
      outputSchema: lintRecipeResultSchema,
      annotations: {
        title: "Lint a BitBake recipe with oelint-adv",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ recipe_path }) => {
      if (!existsSync(recipe_path)) {
        const error = "file not found";
        return {
          content: [
            {
              type: "text",
              text: `# lint-recipe\n\n❌ ${error}: \`${recipe_path}\`\n`,
            },
          ],
          structuredContent: { error },
        };
      }

      // oelint-adv exits non-zero when it has findings, so the findings land on
      // the error object's `stdout`. Capture both paths and parse the same way.
      let stdout: string;
      try {
        stdout = execFileSync(
          "oelint-adv",
          ["--quiet", "--release", "scarthgap", recipe_path],
          {
            timeout: 60_000,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
          },
        );
      } catch (error) {
        stdout = capturedStream(error, "stdout");
      }

      const findings = parseLintOutput(stdout);
      const clean = findings.length === 0;
      return {
        content: [{ type: "text", text: renderLint(recipe_path, findings) }],
        structuredContent: { findings, clean },
      };
    },
  );
}

function renderLint(recipePath: string, findings: LintFinding[]): string {
  let out = `# lint-recipe\n\n`;
  out += `**Recipe:** \`${recipePath}\`\n`;
  out += `**Findings:** ${findings.length}\n`;
  if (findings.length === 0) {
    out += `\n✅ Clean — no oelint-adv findings.\n`;
    return out;
  }
  out += `\n| line | severity | rule | message |\n`;
  out += `| --- | --- | --- | --- |\n`;
  for (const f of findings) {
    out += `| ${f.line} | ${f.severity} | \`${f.rule}\` | ${f.message} |\n`;
  }
  return out;
}

/**
 * Parse `bitbake -e` lines of the form `VAR="value"` or `VAR=value` into a
 * `{[var]: value}` map, stripping a single layer of surrounding double or
 * single quotes. Only lines whose variable name is in `wanted` are kept, so a
 * grep that over-matches (e.g. `VAR_foo=`) is filtered out here. The last
 * assignment for a given variable wins.
 */
function parseIntrospectOutput(
  stdout: string,
  wanted: Set<string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const rawLine of stdout.split("\n")) {
    const match = rawLine.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const name = match[1];
    if (!wanted.has(name)) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    resolved[name] = value;
  }
  return resolved;
}

const introspectRecipeResultSchema = {
  resolved: z.record(z.string(), z.string()).optional(),
  env_active: z.boolean(),
  error: z.string().optional(),
  hint: z.string().optional(),
};

function registerIntrospectRecipe(server: McpServer): void {
  server.registerTool(
    "introspect-recipe",
    {
      title: "Resolve BitBake variables for a recipe",
      description:
        "Resolve the effective values of specific BitBake variables for a recipe by shelling out to `bitbake -e <recipe>` and filtering its output to the requested variable names. This is the recipe analogue of diffing requested-vs-effective `.config` — never trust the recipe source text, introspect the resolved state (e.g. DEPENDS, RDEPENDS, SRC_URI after all appends/overrides/class injection). Requires an initialized build environment (`BUILDDIR` set; enter one via `kas shell meta-avocado/kas/machine/qemuarm64.yml`) — when it is not set the tool returns immediately with an `error`, a `hint`, and `env_active: false`. On success it returns `{resolved, env_active: true}` where `resolved` maps each requested variable to its resolved value (variables not present in the output are omitted, not set to null). A non-zero exit returns its stderr as `error` with `env_active: false`.",
      inputSchema: {
        recipe: z
          .string()
          .min(1)
          .describe(
            "Recipe name to introspect. Examples: 'python3-numpy', 'flatbuffers', 'tflite-runtime'.",
          ),
        variables: z
          .array(z.string().min(1))
          .min(1)
          .describe(
            "BitBake variable names to resolve. Examples: ['DEPENDS', 'RDEPENDS', 'SRC_URI'].",
          ),
      },
      outputSchema: introspectRecipeResultSchema,
      annotations: {
        title: "Resolve BitBake variables for a recipe",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ recipe, variables }) => {
      if (!process.env.BUILDDIR) {
        const error = "build environment not initialized";
        const hint = "kas shell meta-avocado/kas/machine/qemuarm64.yml";
        return {
          content: [
            {
              type: "text",
              text: `# introspect-recipe\n\n❌ ${error}\n\nEnter a build environment first:\n\n    ${hint}\n`,
            },
          ],
          structuredContent: { env_active: false, error, hint },
        };
      }

      const wanted = new Set(variables);
      let stdout: string;
      try {
        // execFileSync (no shell) so the recipe name cannot inject commands.
        // bitbake -e dumps the whole environment to stdout (hence the large
        // maxBuffer); parseIntrospectOutput filters to the requested variables
        // in JS. A genuine bitbake failure throws and is reported as
        // env_active:false; a recipe that simply defines none of the requested
        // variables yields {resolved:{}, env_active:true} with no false failure.
        stdout = execFileSync("bitbake", ["-e", recipe], {
          timeout: 120_000,
          stdio: ["ignore", "pipe", "pipe"],
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch (error) {
        const message = execErrorMessage(error, "stderr");
        return {
          content: [
            {
              type: "text",
              text: `# introspect-recipe failed\n\n❌ ${message}\n`,
            },
          ],
          structuredContent: { env_active: false, error: message },
        };
      }

      const resolved = parseIntrospectOutput(stdout, wanted);
      return {
        content: [
          { type: "text", text: renderIntrospect(recipe, variables, resolved) },
        ],
        structuredContent: { resolved, env_active: true },
      };
    },
  );
}

function renderIntrospect(
  recipe: string,
  variables: string[],
  resolved: Record<string, string>,
): string {
  let out = `# introspect-recipe: \`${recipe}\`\n\n`;
  const names = Object.keys(resolved);
  out += `**Resolved:** ${names.length}/${variables.length}\n`;
  if (names.length === 0) {
    out += `\nNone of the requested variables appeared in \`bitbake -e\` output.\n`;
    return out;
  }
  out += `\n| variable | value |\n`;
  out += `| --- | --- |\n`;
  for (const name of names) {
    out += `| \`${name}\` | ${resolved[name] || "_(empty)_"} |\n`;
  }
  return out;
}

const FEED_URL =
  "https://github.com/avocado-linux/meta-avocado/tree/feed-bringup-zeromq";

const stageRecipeToFeedResultSchema = {
  sdk_pass: z.boolean(),
  boot_pass: z.boolean(),
  qga_output: z.string(),
  feed_url: z.string().optional(),
  hint: z.string().optional(),
};

/** Parsed verdict from validate-feed-local.sh stdout. */
interface FeedVerdict {
  sdk_pass: boolean;
  boot_pass: boolean;
}

/**
 * Read the SDK and BOOT tier verdicts from validate-feed-local.sh stdout. The
 * script prints "SDK PASS"/"SDK FAIL" and "BOOT PASS"/"BOOT FAIL" markers. A
 * tier passes only when its PASS marker is present and no FAIL marker for that
 * tier appears anywhere in the output; a tier with no marker defaults to false.
 */
function parseFeedVerdict(stdout: string): FeedVerdict {
  return {
    sdk_pass: /\bSDK PASS\b/.test(stdout) && !/\bSDK FAIL\b/.test(stdout),
    boot_pass: /\bBOOT PASS\b/.test(stdout) && !/\bBOOT FAIL\b/.test(stdout),
  };
}

/** Return the last non-empty line of `text`, or "" when there is none. */
function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i].trim();
    if (line.length > 0) return line;
  }
  return "";
}

/**
 * Stage a green recipe into the local package feed and validate it end-to-end.
 *
 * Requires the feed-bringup-zeromq branch of meta-avocado.
 */
function registerStageRecipeToFeed(server: McpServer): void {
  server.registerTool(
    "stage-recipe-to-feed",
    {
      title: "Stage a recipe into the local package feed",
      description:
        "Stage a built recipe into the local package feed and validate it end-to-end by shelling out to `bash meta-avocado/scripts/validate-feed-local.sh -b -l <lib_file> <package>` from the workspace root. The `-b` flag runs the full boot validation (SDK sysroot assertion plus a QEMU boot that asserts the library/module is present at runtime via the guest agent), so this can take several minutes. Requires the feed-bringup-zeromq branch of meta-avocado. On exit 0 it returns `{sdk_pass: true, boot_pass: true, qga_output, feed_url}`. On a non-zero exit it parses the SDK PASS/FAIL and BOOT PASS/FAIL markers to report which tier failed and returns `{sdk_pass, boot_pass: false, qga_output, hint}` — check `qga_output` for the failing assertion.",
      inputSchema: {
        package: z
          .string()
          .min(1)
          .describe(
            "Recipe package name to stage. Examples: 'python3-executorch', 'tflite-runtime'.",
          ),
        lib_file: z
          .string()
          .min(1)
          .describe(
            "Shared library or Python module file to assert in the SDK sysroot. Examples: 'executorch.so', 'executorch/__init__.py'.",
          ),
      },
      outputSchema: stageRecipeToFeedResultSchema,
      annotations: {
        title: "Stage a recipe into the local package feed",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ package: pkg, lib_file }) => {
      const root = defaultWorkspaceRoot();
      let stdout: string;
      try {
        // execFileSync (no shell) so `lib_file`/`pkg` reach the script as argv,
        // not interpolated into a shell command line.
        stdout = execFileSync(
          "bash",
          [
            "meta-avocado/scripts/validate-feed-local.sh",
            "-b",
            "-l",
            lib_file,
            pkg,
          ],
          {
            cwd: root,
            timeout: 300_000,
            stdio: ["ignore", "pipe", "pipe"],
            encoding: "utf8",
          },
        );
      } catch (error) {
        const errObj =
          error && typeof error === "object"
            ? (error as { stdout?: unknown; stderr?: unknown })
            : {};
        const outText = String(errObj.stdout ?? "");
        const errText = String(errObj.stderr ?? "");
        const verdict = parseFeedVerdict(outText);
        const qgaOutput =
          errText.trim().length > 0
            ? errText.trim()
            : lastNonEmptyLine(outText);
        const result = {
          sdk_pass: verdict.sdk_pass,
          boot_pass: false,
          qga_output: qgaOutput,
          hint: "Check qga_output for the failing assertion",
        };
        return {
          content: [
            { type: "text", text: renderStageFeed(pkg, lib_file, result) },
          ],
          structuredContent: result,
        };
      }

      const result = {
        sdk_pass: true,
        boot_pass: true,
        qga_output: lastNonEmptyLine(stdout),
        feed_url: FEED_URL,
      };
      return {
        content: [
          { type: "text", text: renderStageFeed(pkg, lib_file, result) },
        ],
        structuredContent: result,
      };
    },
  );
}

function renderStageFeed(
  pkg: string,
  libFile: string,
  result: {
    sdk_pass: boolean;
    boot_pass: boolean;
    qga_output: string;
    feed_url?: string;
    hint?: string;
  },
): string {
  let out = `# stage-recipe-to-feed: \`${pkg}\`\n\n`;
  out += `**Library asserted:** \`${libFile}\`\n`;
  out += `**SDK:** ${result.sdk_pass ? "✅ PASS" : "❌ FAIL"}\n`;
  out += `**Boot:** ${result.boot_pass ? "✅ PASS" : "❌ FAIL"}\n`;
  if (result.feed_url) {
    out += `**Feed:** ${result.feed_url}\n`;
  }
  out += `\n**QGA output:**\n\n    ${result.qga_output || "_(none)_"}\n`;
  if (result.hint) {
    out += `\n${result.hint}\n`;
  }
  return out;
}
