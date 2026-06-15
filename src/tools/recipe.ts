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
