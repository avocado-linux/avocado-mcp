import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
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
 * Default corpus root: the in-repo `corpus/` directory shipped with avocado-mcp.
 * The compiled module lives at `build/tools/corpus.js`, so two `..` hops land on
 * the avocado-mcp root and `corpus/` is its child. Keeping the corpus in-repo
 * (rather than beside the repo in the workspace) makes it portable for any
 * contributor and part of the package payload.
 */
function defaultCorpusDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../corpus");
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

/**
 * A static QA-check case as loaded from `<corpus_dir>/qa-checks/*.yaml`.
 * These use a different schema than the learned `cases/` corpus: they carry an
 * `identifier`, a `literal_message` (with printf placeholders), a `severity`,
 * and a `fix` — no `normalized_signature`. They are derived from upstream Yocto
 * documentation and are authoritative.
 */
type QaStaticCase = Record<string, unknown> & {
  identifier?: unknown;
  literal_message?: unknown;
  severity?: unknown;
  fix?: unknown;
};

/**
 * Load every parseable static QA-check case from `<corpus_dir>/qa-checks/*.yaml`.
 * Mirrors `loadCorpusCases` semantics: a missing directory yields an empty
 * list, and an unreadable or unparseable file is skipped rather than failing
 * the whole scan.
 */
function loadQaStaticCases(corpusDir: string): QaStaticCase[] {
  const qaDir = resolve(corpusDir, "qa-checks");
  let entries: string[];
  try {
    entries = readdirSync(qaDir);
  } catch {
    return [];
  }

  const cases: QaStaticCase[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    try {
      const raw = readFileSync(resolve(qaDir, entry), "utf8");
      const parsed = parseYaml(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        cases.push(parsed as QaStaticCase);
      }
    } catch {
      // Skip this file; a single bad case must not sink the scan.
    }
  }
  return cases;
}

/**
 * Split a printf-style `literal_message` template on its `%s`/`%d`/`%c`/`%u`/
 * `%x` placeholders and return the non-trivial literal fragments. These are the
 * parts of the message BitBake emits verbatim regardless of which file,
 * package, or uid triggered the check, so they are what an input log must
 * contain to be a match. Fragments shorter than 4 chars (e.g. `" in "`) are
 * dropped to avoid spuriously matching common English on unrelated logs.
 */
function literalFragments(template: string): string[] {
  return template
    .split(/%[sdcuxleEfgG]/g)
    .map((f) => f.trim())
    .filter((f) => f.length >= 4);
}

interface QaStaticMatch {
  source: "qa-static";
  identifier: string;
  literal_message: string;
  severity: string;
  fix: string;
  explanation?: string;
  doc_url?: string;
}

/**
 * Match a raw build log against the static QA-check cases. A case matches when
 * every literal fragment of its `literal_message` template appears as a
 * substring of the log (placeholder-tolerant: the `%s`/`%d` values in the log
 * are ignored). Matching is done on the RAW log, not the normalized signature,
 * because `literal_message` carries upstream printf placeholders rather than a
 * normalized signature.
 */
function matchQaStaticCases(log: string, cases: QaStaticCase[]): QaStaticMatch[] {
  const matches: QaStaticMatch[] = [];
  for (const c of cases) {
    const id = c.identifier;
    const msg = c.literal_message;
    const fix = c.fix;
    if (
      typeof id !== "string" ||
      typeof msg !== "string" ||
      typeof fix !== "string"
    ) {
      continue;
    }

    const fragments = literalFragments(msg);
    if (fragments.length === 0) continue;
    if (!fragments.every((frag) => log.includes(frag))) continue;

    matches.push({
      source: "qa-static",
      identifier: id,
      literal_message: msg,
      severity: typeof c.severity === "string" ? c.severity : "",
      fix,
      explanation: typeof c.explanation === "string" ? c.explanation : undefined,
      doc_url: typeof c.doc_url === "string" ? c.doc_url : undefined,
    });
  }
  return matches;
}

type MatchType = "exact" | "fuzzy" | "none";

interface DiagnoseResult {
  [key: string]: unknown;
  match_type: MatchType;
  confidence: number;
  case: CorpusCase | null;
  normalized_key: string;
  kb_hint?: string;
  static_matches?: QaStaticMatch[];
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

/**
 * Run the full diagnosis: rank the learned `cases/` corpus against the
 * normalized log key, then merge in any static QA-check matches from
 * `qa-checks/` (matched against the raw log, since their `literal_message`
 * carries printf placeholders rather than a normalized signature).
 *
 * When a static case and the learned case share the same QA `identifier`, the
 * static case is authoritative (upstream-documented fix) and the learned case
 * is dropped from the result so a stale learned entry cannot shadow it.
 */
function diagnose(
  log: string,
  learnedCases: CorpusCase[],
  staticCases: QaStaticCase[],
): DiagnoseResult {
  const key = normalizeSignature(log);
  const learned = matchCorpus(key, learnedCases);
  const staticMatches = matchQaStaticCases(log, staticCases);

  if (staticMatches.length === 0) {
    return learned;
  }

  // Prefer the static case when both name the same QA identifier: drop the
  // learned hit so the authoritative upstream fix is what surfaces.
  const staticIds = new Set(staticMatches.map((m) => m.identifier));
  const learnedId =
    learned.case && typeof learned.case.identifier === "string"
      ? learned.case.identifier
      : undefined;
  if (learnedId !== undefined && staticIds.has(learnedId)) {
    return {
      match_type: "none",
      confidence: 0.0,
      case: null,
      normalized_key: key,
      static_matches: staticMatches,
    };
  }

  return { ...learned, static_matches: staticMatches };
}

function renderStaticMatches(matches: QaStaticMatch[]): string {
  if (matches.length === 0) return "";
  let out = `\n## Static QA-check matches (source: qa-static)\n`;
  for (const m of matches) {
    out += `\n**[${m.identifier}]** (severity ${m.severity})\n`;
    out += `- Message: ${m.literal_message}\n`;
    out += `- Fix: ${m.fix}\n`;
    if (m.explanation) out += `- Why: ${m.explanation}\n`;
    if (m.doc_url) out += `- Doc: ${m.doc_url}\n`;
  }
  return out;
}

function renderDiagnosis(result: DiagnoseResult): string {
  let out = `# diagnose-build-failure\n\n`;
  out += `**Normalized key:** \`${result.normalized_key}\`\n`;
  out += `**Match:** ${result.match_type} (confidence ${result.confidence})\n`;

  const staticSection = renderStaticMatches(result.static_matches ?? []);

  if (result.match_type === "none" || result.case === null) {
    if (staticSection === "") {
      out += `\nNo corpus case matched this signature. This is a novel failure: extract the error, route to the relevant Yocto docs, and record the fix with \`record-recipe-fix\` once verified.\n`;
      if (result.kb_hint) {
        out += `\n**KB fallback:** run \`${result.kb_hint}\` for compiled KB knowledge on similar failures.\n`;
      }
    }
    return out + staticSection;
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
  return out + staticSection;
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
        "Normalize a raw BitBake build-log error and match it against the verified error-learning corpus. Pass the failing log snippet as `log`; the tool computes its normalized signature and scans `<corpus_dir>/cases/*.yaml` for a case with the same signature. An exact signature match returns confidence 1.0; a substring (fuzzy) match returns 0.5; no match returns 0.0 with a null case (a novel failure to route to docs and later record). It also matches the raw log against the static, upstream-derived QA-check cases in `<corpus_dir>/qa-checks/*.yaml` (placeholder-tolerant match on each case's `literal_message`) and returns any hits in `static_matches`, each tagged `source: \"qa-static\"`. When a static and a learned case name the same QA identifier, the static (authoritative) case is preferred. `corpus_dir` defaults to the `corpus/` directory beside avocado-mcp in the workspace.",
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
        static_matches: z
          .array(
            z.object({
              source: z.literal("qa-static"),
              identifier: z.string(),
              literal_message: z.string(),
              severity: z.string(),
              fix: z.string(),
              explanation: z.string().optional(),
              doc_url: z.string().optional(),
            }),
          )
          .optional(),
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
      const learnedCases = loadCorpusCases(corpusDir);
      const staticCases = loadQaStaticCases(corpusDir);
      const result = diagnose(log, learnedCases, staticCases);

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

      // Append a hash of the full signature so two distinct signatures sharing
      // the same 40-char prefix get distinct slugs and never overwrite each
      // other's case file.
      const sigHash = createHash("sha1")
        .update(normalized_signature)
        .digest("hex")
        .slice(0, 8);
      const slugSource = `${failed_task}-${normalized_signature.slice(
        0,
        40,
      )}-${sigHash}`;
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
      const recordYaml = stringifyYaml(record);
      writeFileSync(path, recordYaml, "utf8");

      const result = {
        written: true,
        path,
        kb_sync_needed: true,
        kb_ingest_args: {
          project: "peridio",
          source_type: "manual",
          source_id: slug,
          raw_content: recordYaml,
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
