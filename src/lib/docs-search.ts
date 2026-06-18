/**
 * BM25-ish full-text search over the docs corpus.
 *
 * Approach:
 *   1. Tokenize query and each doc (lowercase, split on non-word, drop short
 *      tokens and a small English stoplist).
 *   2. Build document statistics on demand (corpus is small enough — ~140
 *      docs, ~10k unique tokens — that we don't bother persisting an index).
 *   3. Score with classic BM25 (k1=1.5, b=0.75) over a weighted bag-of-words:
 *      title × 5, description × 3, path × 2, body × 1.
 *   4. For top hits, return a line-anchored excerpt around the first match.
 *
 * Why not Elastic / lunr / FlexSearch: 140 docs is tiny; any of those adds
 * setup, dependencies, persistence concerns. A few hundred lines of TS beats
 * pulling a vendor.
 */

import { listDocs, fetchDocContent, type DocEntry } from "./docs-client.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

interface DocVec {
  entry: DocEntry;
  /** weighted term-frequency counts */
  tf: Map<string, number>;
  /** total weighted term count (denominator for BM25 normalization) */
  length: number;
  /** raw body for excerpt rendering */
  body: string;
}

interface IndexState {
  indexedAt: number;
  docs: DocVec[];
  /** Document Frequency per term — number of docs containing each token. */
  df: Map<string, number>;
  /** Average doc length (weighted), for BM25 normalization. */
  avgLength: number;
}

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "has",
  "have",
  "he",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "or",
  "she",
  "that",
  "the",
  "this",
  "to",
  "was",
  "were",
  "will",
  "with",
  "you",
  "your",
  "i",
  "we",
  "they",
  "them",
  "us",
  "but",
  "not",
  "no",
  "if",
  "do",
  "does",
  "did",
  "would",
  "could",
  "should",
  "may",
  "can",
  "into",
  "than",
  "then",
  "so",
  "such",
  "also",
  "via",
  "etc",
]);

const TITLE_WEIGHT = 5;
const DESC_WEIGHT = 3;
const PATH_WEIGHT = 2;
const BODY_WEIGHT = 1;

const K1 = 1.5;
const B = 0.75;
const INDEX_TTL_MS = 30 * 60 * 1000; // refresh index every 30 min at most

let indexCache: IndexState | null = null;
let pendingIndex: Promise<IndexState> | null = null;

function tokenize(text: string): string[] {
  if (!text) return [];
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\w]+/)) {
    if (!raw) continue;
    if (raw.length < 2) continue;
    if (STOPWORDS.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

function addWeighted(
  tf: Map<string, number>,
  text: string,
  weight: number,
): number {
  let added = 0;
  for (const tok of tokenize(text)) {
    tf.set(tok, (tf.get(tok) ?? 0) + weight);
    added += weight;
  }
  return added;
}

/**
 * A yocto-refs corpus section: a synthetic {@link DocEntry} plus the raw body
 * text of the section. `DocEntry` has no body field (GitHub-backed entries
 * fetch their body lazily via `fetchDocContent`), so a local-file corpus must
 * carry the body alongside the metadata for the index to score it without a
 * network round-trip. `buildIndex()` (task 3.3) consumes these.
 */
export interface YoctoRefsEntry {
  entry: DocEntry;
  body: string;
}

/**
 * Resolve the in-repo `yocto-refs/` directory relative to the compiled module.
 * The compiled file is `build/lib/docs-search.js`, so two `..` hops reach the
 * avocado-mcp root and `yocto-refs/` is its child — the same pattern
 * `corpus.ts:defaultCorpusDir()` uses for `corpus/`.
 */
function yoctoRefsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../yocto-refs");
}

/**
 * Each vendored file in the yocto-refs corpus, with the metadata needed to
 * build a real docs.yoctoproject.org URL per section. `urlBase` is the page
 * the file maps to upstream; `anchorKind` selects how a section title becomes
 * the in-page anchor (the RST `:term:` glossary builds `#term-NAME` anchors,
 * headings build slug anchors, source files have no upstream HTML page).
 */
interface YoctoRefsFile {
  /** Path relative to `yocto-refs/`. */
  relPath: string;
  /** Logical corpus name used in the synthetic sitePath. */
  name: string;
  /** Upstream HTML page URL, or null for source files with no doc page. */
  urlBase: string | null;
  /** How section titles map to in-page anchors. */
  anchorKind: "term" | "heading" | "none";
}

const YOCTO_REFS_FILES: YoctoRefsFile[] = [
  {
    relPath: "yocto-docs/documentation/ref-manual/variables.rst",
    name: "variables",
    urlBase: "https://docs.yoctoproject.org/ref-manual/variables.html",
    anchorKind: "term",
  },
  {
    relPath: "yocto-docs/documentation/ref-manual/qa-checks.rst",
    name: "qa-checks",
    urlBase: "https://docs.yoctoproject.org/ref-manual/qa-checks.html",
    anchorKind: "heading",
  },
  {
    relPath: "bitbake/doc/bitbake-user-manual/bitbake-user-manual-metadata.rst",
    name: "bitbake-metadata",
    urlBase:
      "https://docs.yoctoproject.org/bitbake/bitbake-user-manual/bitbake-user-manual-metadata.html",
    anchorKind: "heading",
  },
  {
    relPath: "openembedded-core/meta/classes-global/insane.bbclass",
    name: "insane-bbclass",
    urlBase: null,
    anchorKind: "none",
  },
  {
    relPath: "openembedded-core/meta/lib/oe/qa.py",
    name: "oe-qa",
    urlBase: null,
    anchorKind: "none",
  },
];

/** Slugify a section heading into a docs.yoctoproject.org-style anchor. */
function slugifyHeading(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface RawSection {
  title: string;
  body: string;
}

/**
 * Split the RST glossary in `variables.rst` into one section per `:term:`
 * entry. Each glossary term is a line `   :term:`NAME`` followed by its
 * (further-indented) description until the next `:term:` line. Falls back to
 * an empty list if no `:term:` entries are present.
 */
function splitGlossary(text: string): RawSection[] {
  const lines = text.split(/\r?\n/);
  const termRe = /^\s+:term:`([A-Za-z0-9_${}]+)`\s*$/;
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (const line of lines) {
    const m = line.match(termRe);
    if (m) {
      if (current) sections.push(current);
      current = { title: m[1], body: line + "\n" };
    } else if (current) {
      current.body += line + "\n";
    }
  }
  if (current) sections.push(current);
  return sections;
}

/**
 * Split an RST document on its section-heading underlines (a heading line
 * immediately followed by a run of `=`, `-`, `~`, `*`, `^`, or `"`). Each
 * section spans from one heading to the next. Falls back to a single section
 * (title from the file name) when no headings are found.
 */
function splitByHeadings(text: string, fallbackTitle: string): RawSection[] {
  const lines = text.split(/\r?\n/);
  const underlineRe = /^[=\-~*^"]{3,}\s*$/;
  const sections: RawSection[] = [];
  let current: RawSection | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const next = lines[i + 1];
    const isHeading =
      line.trim().length > 0 &&
      !underlineRe.test(line) &&
      next !== undefined &&
      underlineRe.test(next) &&
      next.trim().length >= Math.min(line.trim().length, 3);
    if (isHeading) {
      if (current) sections.push(current);
      current = { title: line.trim(), body: line + "\n" + next + "\n" };
      i++; // consume the underline
      continue;
    }
    if (current) {
      current.body += line + "\n";
    }
  }
  if (current) sections.push(current);
  if (sections.length === 0) {
    return [{ title: fallbackTitle, body: text }];
  }
  return sections;
}

/**
 * Split source files (no RST headings) into blank-line-delimited blocks. Each
 * block becomes a section whose title is its first non-empty line, truncated.
 * Empty/whitespace-only blocks are dropped.
 */
function splitByBlankLines(text: string, fallbackTitle: string): RawSection[] {
  const blocks = text.split(/\r?\n\s*\r?\n/);
  const sections: RawSection[] = [];
  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const firstLine = trimmed.split(/\r?\n/, 1)[0].trim();
    const title = (firstLine || fallbackTitle).slice(0, 80);
    sections.push({ title, body: block });
  }
  if (sections.length === 0) {
    return [{ title: fallbackTitle, body: text }];
  }
  return sections;
}

/**
 * Load the vendored Yocto/BitBake reference corpus from local files under
 * `yocto-refs/` and return one {@link YoctoRefsEntry} per indexable section,
 * each tagged `source: "yocto-refs"`.
 *
 * This performs NO network access — it only reads files from disk, so it works
 * with `GITHUB_TOKEN` unset. A missing `yocto-refs/` directory (or any
 * unreadable individual file) yields no entries for that file rather than
 * throwing, so a partial corpus degrades gracefully instead of failing the
 * whole index build.
 *
 * Each section becomes a synthetic `DocEntry`:
 *   - `repoPath` / `sitePath` live under a `yocto-refs/` namespace,
 *   - `title` is the section/variable name,
 *   - `url` points at docs.yoctoproject.org when the file maps to a doc page
 *     (with a `#term-NAME` or `#slug` anchor), else a `yocto-refs://` placeholder,
 *   - `section` is set to `"guides"` (the closest existing `DocEntry` section),
 *   - `sha` is `""` (local file; no blob SHA),
 *   - `source` is `"yocto-refs"`.
 */
export function loadYoctoRefsEntries(): YoctoRefsEntry[] {
  const baseDir = yoctoRefsDir();
  const out: YoctoRefsEntry[] = [];

  for (const file of YOCTO_REFS_FILES) {
    let text: string;
    try {
      text = readFileSync(resolve(baseDir, file.relPath), "utf8");
    } catch {
      // Missing or unreadable file: skip it, don't sink the whole corpus.
      continue;
    }

    let sections: RawSection[];
    if (file.anchorKind === "term") {
      sections = splitGlossary(text);
      // A glossary file with no :term: entries (corrupt/empty) falls back to
      // heading-split so we still index something.
      if (sections.length === 0) {
        sections = splitByHeadings(text, file.name);
      }
    } else if (file.anchorKind === "heading") {
      sections = splitByHeadings(text, file.name);
    } else {
      sections = splitByBlankLines(text, file.name);
    }

    for (const sec of sections) {
      const url =
        file.urlBase === null
          ? `yocto-refs://${file.name}`
          : file.anchorKind === "term"
            ? `${file.urlBase}#term-${sec.title}`
            : file.anchorKind === "heading"
              ? `${file.urlBase}#${slugifyHeading(sec.title)}`
              : file.urlBase;

      const slug = slugifyHeading(sec.title) || "section";
      const sitePath = `yocto-refs/${file.name}/${slug}`;
      const entry: DocEntry = {
        repoPath: `yocto-refs/${file.relPath}`,
        sitePath,
        url,
        section: "guides",
        title: sec.title,
        description: "",
        sha: "",
        source: "yocto-refs",
      };
      out.push({ entry, body: sec.body });
    }
  }

  return out;
}

async function buildIndex(): Promise<IndexState> {
  const docs = await listDocs();
  const vecs: DocVec[] = [];
  const df = new Map<string, number>();

  for (const d of docs) {
    let body = "";
    try {
      body = await fetchDocContent(d);
    } catch {
      body = "";
    }
    const tf = new Map<string, number>();
    let length = 0;
    length += addWeighted(tf, d.title, TITLE_WEIGHT);
    length += addWeighted(tf, d.description, DESC_WEIGHT);
    length += addWeighted(tf, d.sitePath, PATH_WEIGHT);
    length += addWeighted(tf, body, BODY_WEIGHT);

    // DF: count distinct tokens once per doc
    const seen = new Set<string>();
    for (const tok of tf.keys()) {
      if (!seen.has(tok)) {
        df.set(tok, (df.get(tok) ?? 0) + 1);
        seen.add(tok);
      }
    }
    vecs.push({ entry: d, tf, length, body });
  }

  const total = vecs.reduce((acc, v) => acc + v.length, 0);
  const avgLength = vecs.length > 0 ? total / vecs.length : 0;
  return { indexedAt: Date.now(), docs: vecs, df, avgLength };
}

async function getIndex(): Promise<IndexState> {
  const now = Date.now();
  if (indexCache && now - indexCache.indexedAt < INDEX_TTL_MS) {
    return indexCache;
  }
  if (pendingIndex) return pendingIndex;
  pendingIndex = (async () => {
    const idx = await buildIndex();
    indexCache = idx;
    pendingIndex = null;
    return idx;
  })();
  return pendingIndex;
}

export interface SearchHit {
  /** The matched doc. Carries `source` (`peridio-docs` | `yocto-refs`) via DocEntry. */
  entry: DocEntry;
  score: number;
  excerpt: string;
}

export async function searchDocs(
  query: string,
  opts?: { section?: DocEntry["section"]; maxResults?: number },
): Promise<SearchHit[]> {
  const tokens = tokenize(query);
  if (tokens.length === 0) return [];

  const idx = await getIndex();
  const N = idx.docs.length;
  if (N === 0) return [];

  // Precompute IDF per query token.
  const idf = new Map<string, number>();
  for (const tok of tokens) {
    const n = idx.df.get(tok) ?? 0;
    // BM25 idf with +1 smoothing — never negative for our small corpus.
    idf.set(tok, Math.log(1 + (N - n + 0.5) / (n + 0.5)));
  }

  const scored: SearchHit[] = [];
  for (const v of idx.docs) {
    if (opts?.section && v.entry.section !== opts.section) continue;

    let score = 0;
    for (const tok of tokens) {
      const tf = v.tf.get(tok);
      if (!tf) continue;
      const w = idf.get(tok) ?? 0;
      const norm =
        idx.avgLength > 0 ? 1 - B + B * (v.length / idx.avgLength) : 1;
      score += w * ((tf * (K1 + 1)) / (tf + K1 * norm));
    }
    if (score <= 0) continue;
    scored.push({
      entry: v.entry,
      score,
      excerpt: makeExcerpt(v.body, tokens),
    });
  }

  scored.sort((a, b) => b.score - a.score);
  const max = opts?.maxResults ?? 5;
  return scored.slice(0, max);
}

/**
 * Produce a short excerpt around the first line containing any query token.
 * Falls back to the first 200 chars of the body when no match is found
 * (the doc scored on title/path/desc but the body doesn't contain the literal tokens).
 */
function makeExcerpt(body: string, tokens: string[]): string {
  if (!body) return "";
  // Strip frontmatter for readability.
  let text = body;
  if (text.startsWith("---")) {
    const end = text.indexOf("\n---", 4);
    if (end !== -1) text = text.slice(end + 4).replace(/^\r?\n/, "");
  }
  const lines = text.split(/\r?\n/);
  const re = new RegExp(
    `\\b(${tokens.map((t) => escapeRe(t)).join("|")})`,
    "i",
  );
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) {
      const start = Math.max(0, i - 1);
      const end = Math.min(lines.length, i + 3);
      return lines
        .slice(start, end)
        .join(" ")
        .replace(/\s+/g, " ")
        .slice(0, 280)
        .trim();
    }
  }
  return text.replace(/\s+/g, " ").slice(0, 200).trim();
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** For tests / external invalidation. */
export function clearSearchIndex(): void {
  indexCache = null;
  pendingIndex = null;
}
