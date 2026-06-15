import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RepoClient } from "../lib/repo-client.js";

/**
 * Normalize a raw BitBake build-log signature into a stable corpus key.
 *
 * Three sequential regex passes strip the per-run variance out of an error
 * line so that the same failure across different packages, versions, and
 * checkout paths collapses to one `normalized_signature` for dedup and
 * retrieval (design.md D3):
 *
 *   1. absolute build paths (`/home/<user>/<repo>/<workdir>/...`) -> `<WORKDIR>/`
 *   2. `<pkg>-<version>-<rev>` tokens (`zeromq-4.3.5-r0`)        -> `<PKG>`
 *   3. `lib<name>.so` library names in QA messages               -> `<LIB>.so`
 *
 * Pure: no I/O, no global state, safe to test in isolation.
 */
export function normalizeSignature(raw: string): string {
  let s = raw;

  // Pass 1: collapse an absolute home-rooted build path prefix to <WORKDIR>/.
  // Matches /home/<user>/<repo>/<dir>/.
  s = s.replace(/\/home\/[^/\s]+\/[^/\s]+\/[^/\s]+\//g, "<WORKDIR>/");

  // Pass 1b: collapse BitBake tmp/work build paths to <WORKDIR>.
  // Handles build roots like /build/tmp/work/... (not under /home/) and the
  // tmp/work subtree remaining after Pass 1 collapses the /home/ prefix.
  s = s.replace(/(?:<WORKDIR>\/|\/[^\s/]+\/)tmp\/work\/\S*/g, "<WORKDIR>");

  // Pass 2: collapse BitBake <pkg>-<version>-<rev> tokens to <PKG>.
  // e.g. zeromq-4.3.5-r0, python3-numpy-1.26.4-r0.
  s = s.replace(/\b[\w.+-]+?-\d+(?:\.\d+)*-r\d+\b/g, "<PKG>");

  // Pass 3: collapse lib<name>.so library names in QA messages to <LIB>.so.
  s = s.replace(/\blib[\w+-]+\.so\b/g, "<LIB>.so");

  // Pass 4: collapse hex hash strings (>= 8 consecutive hex chars) to <HASH>.
  // Strips SHA256/MD5 digests from do_fetch checksum mismatch errors so the
  // same failure for different artifact versions collapses to one corpus key.
  s = s.replace(/\b[0-9a-f]{8,}(?:\.\.\.)?/gi, "<HASH>");

  return s;
}

/**
 * Default corpus root: the `corpus/` directory that sits beside the avocado-mcp
 * repo in the workspace. The compiled module lives at `build/tools/corpus.js`,
 * so three `..` hops land on the avocado-mcp root's parent (the workspace), and
 * `corpus/` is its child. Matches `find-recipe-examples`' path convention.
 */
function defaultCorpusDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../../corpus");
}

/** A corpus case as loaded from a `<corpus_dir>/cases/*.yaml` file. */
type CorpusCase = Record<string, unknown> & { normalized_signature?: unknown };

/**
 * Load every parseable case from `<corpus_dir>/cases/*.yaml`. A missing
 * directory yields an empty list; an unreadable or unparseable individual file
 * is skipped rather than failing the whole scan, so one corrupt case cannot
 * blind the diagnoser to every other case.
 */
function loadCorpusCases(corpusDir: string): CorpusCase[] {
  const casesDir = resolve(corpusDir, "cases");
  let entries: string[];
  try {
    entries = readdirSync(casesDir);
  } catch {
    return [];
  }

  const cases: CorpusCase[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    try {
      const raw = readFileSync(resolve(casesDir, entry), "utf8");
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cases.push(parsed as CorpusCase);
      }
    } catch {
      // Skip this file; a single bad case must not sink the scan.
    }
  }
  return cases;
}

type MatchType = "exact" | "fuzzy" | "none";

interface DiagnoseResult {
  [key: string]: unknown;
  match_type: MatchType;
  confidence: number;
  case: CorpusCase | null;
  normalized_key: string;
  kb_hint?: string;
}

/**
 * Match a normalized log key against the loaded corpus cases. Exact equality on
 * `normalized_signature` wins (confidence 1.0); failing that, a substring
 * relationship in either direction counts as a fuzzy hit (confidence 0.5);
 * otherwise no match (confidence 0.0). The first exact case short-circuits;
 * the first fuzzy case is kept only when no exact case is found.
 */
function matchCorpus(key: string, cases: CorpusCase[]): DiagnoseResult {
  let fuzzy: CorpusCase | null = null;

  for (const c of cases) {
    const sig = c.normalized_signature;
    if (typeof sig !== "string") continue;

    if (sig === key) {
      return {
        match_type: "exact",
        confidence: 1.0,
        case: c,
        normalized_key: key,
      };
    }

    if (fuzzy === null && (sig.includes(key) || key.includes(sig))) {
      fuzzy = c;
    }
  }

  if (fuzzy !== null) {
    return {
      match_type: "fuzzy",
      confidence: 0.5,
      case: fuzzy,
      normalized_key: key,
    };
  }

  return {
    match_type: "none",
    confidence: 0.0,
    case: null,
    normalized_key: key,
    kb_hint: `kb_recall(project="peridio", description="${key}")`,
  };
}

function renderDiagnosis(result: DiagnoseResult): string {
  let out = `# diagnose-build-failure\n\n`;
  out += `**Normalized key:** \`${result.normalized_key}\`\n`;
  out += `**Match:** ${result.match_type} (confidence ${result.confidence})\n`;

  if (result.match_type === "none" || result.case === null) {
    out += `\nNo corpus case matched this signature. This is a novel failure: extract the error, route to the relevant Yocto docs, and record the fix with \`record-recipe-fix\` once verified.\n`;
    if (result.kb_hint) {
      out += `\n**KB fallback:** run \`${result.kb_hint}\` for compiled KB knowledge on similar failures.\n`;
    }
    return out;
  }

  const c = result.case;
  const field = (name: string): string => {
    const v = c[name];
    return typeof v === "string" ? v : v === undefined ? "_(none)_" : String(v);
  };
  out += `\n**Failed task:** \`${field("failed_task")}\`\n`;
  out += `**Build system:** \`${field("build_system")}\`\n`;
  out += `**Root cause:** ${field("root_cause")}\n`;
  out += `**Fix:**\n\n\`\`\`\n${field("fix_diff")}\n\`\`\`\n`;
  out += `**Doc:** ${field("doc_link")}\n`;
  out += `**Falsifier:** ${field("falsifier")}\n`;
  return out;
}

/**
 * Register the corpus learn/retrieve MCP tools (diagnose-build-failure,
 * record-recipe-fix). `repoClient` is threaded through to match the registrar
 * convention used by the other tool groups; the corpus tools do not use it.
 */
export function registerCorpusTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  void repoClient;

  server.registerTool(
    "diagnose-build-failure",
    {
      title: "Diagnose a BitBake build failure against the corpus",
      description:
        "Normalize a raw BitBake build-log error and match it against the verified error-learning corpus. Pass the failing log snippet as `log`; the tool computes its normalized signature and scans `<corpus_dir>/cases/*.yaml` for a case with the same signature. An exact signature match returns confidence 1.0; a substring (fuzzy) match returns 0.5; no match returns 0.0 with a null case (a novel failure to route to docs and later record). `corpus_dir` defaults to the `corpus/` directory beside avocado-mcp in the workspace.",
      inputSchema: {
        log: z
          .string()
          .min(1)
          .describe(
            "Raw BitBake build-log snippet containing the error line(s).",
          ),
        corpus_dir: z
          .string()
          .optional()
          .describe(
            "Corpus root to scan; the tool reads `<corpus_dir>/cases/*.yaml`. Defaults to the `corpus/` directory beside avocado-mcp.",
          ),
      },
      outputSchema: {
        match_type: z.enum(["exact", "fuzzy", "none"]),
        confidence: z.number(),
        case: z.record(z.unknown()).nullable(),
        normalized_key: z.string(),
        kb_hint: z.string().optional(),
      },
      annotations: {
        title: "Diagnose a BitBake build failure against the corpus",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ log, corpus_dir }) => {
      const corpusDir = corpus_dir ?? defaultCorpusDir();
      const key = normalizeSignature(log);
      const cases = loadCorpusCases(corpusDir);
      const result = matchCorpus(key, cases);

      return {
        content: [{ type: "text", text: renderDiagnosis(result) }],
        structuredContent: result,
      };
    },
  );

  server.registerTool(
    "record-recipe-fix",
    {
      title: "Record a verified BitBake recipe fix into the corpus",
      description:
        'Append a new error-learning case to `<corpus_dir>/cases/*.yaml`. `normalized_signature` must already be the normalized corpus key (call `diagnose-build-failure` or normalize the raw log first); a raw, un-normalized log is rejected. An empty `falsifier` is rejected (a case with no way to verify the fix is worthless). A signature already present in the corpus is rejected as a duplicate. On success the case is written with `verified: false` and `source: "user-recorded"` so a later human/CI pass can promote it.',
      inputSchema: {
        normalized_signature: z
          .string()
          .min(1)
          .describe(
            "The normalized corpus key (NOT a raw log). Must already be normalized; the tool rejects input that differs from its own normalization.",
          ),
        failed_task: z
          .string()
          .min(1)
          .describe('The failing BitBake task, e.g. "do_package_qa".'),
        build_system: z
          .string()
          .min(1)
          .describe('The recipe build system, e.g. "cmake", "autotools".'),
        root_cause: z
          .string()
          .min(1)
          .describe("One-sentence root cause of the failure."),
        fix_diff: z
          .string()
          .min(1)
          .describe("Unified diff of the fix applied to the recipe."),
        doc_link: z
          .string()
          .min(1)
          .describe("URL to the relevant Yocto documentation."),
        falsifier: z
          .string()
          .describe("How to verify the fix works; an empty value is rejected."),
        corpus_dir: z
          .string()
          .optional()
          .describe(
            "Corpus root to write into; the case lands in `<corpus_dir>/cases/`. Defaults to the `corpus/` directory beside avocado-mcp.",
          ),
      },
      annotations: {
        title: "Record a verified BitBake recipe fix into the corpus",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({
      normalized_signature,
      failed_task,
      build_system,
      root_cause,
      fix_diff,
      doc_link,
      falsifier,
      corpus_dir,
    }) => {
      const fail = (error: string) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ error }) }],
        structuredContent: { error },
      });

      if (falsifier === "") {
        return fail("falsifier required");
      }

      const normalized = normalizeSignature(normalized_signature);
      if (normalized !== normalized_signature) {
        return fail(
          `normalized_signature must already be normalized; got ${normalized_signature}, expected ${normalized}`,
        );
      }

      const corpusDir = corpus_dir ?? defaultCorpusDir();
      const cases = loadCorpusCases(corpusDir);
      if (cases.some((c) => c.normalized_signature === normalized_signature)) {
        return fail("duplicate");
      }

      const slugSource = `${failed_task}-${normalized_signature.slice(0, 40)}`;
      const slug = slugSource.replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase();

      const casesDir = resolve(corpusDir, "cases");
      if (!existsSync(casesDir)) {
        mkdirSync(casesDir, { recursive: true });
      }
      const path = resolve(casesDir, `${slug}.yaml`);

      const record = {
        normalized_signature,
        failed_task,
        build_system,
        root_cause,
        fix_diff,
        doc_link,
        falsifier,
        verified: false,
        source: "user-recorded",
      };
      writeFileSync(path, stringifyYaml(record), "utf8");

      const result = {
        written: true,
        path,
        kb_sync_needed: true,
        kb_ingest_args: {
          project: "peridio",
          source_type: "manual",
          source_id: slug,
          raw_content: stringifyYaml(record),
          keywords: ["yocto", "bitbake", "build-failure", failed_task],
        },
        kb_compile_args: {
          project: "peridio",
          entries: [slug],
        },
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result) }],
        structuredContent: result,
      };
    },
  );
}
