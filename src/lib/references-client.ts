/**
 * Reference catalog + content fetcher.
 *
 * Source of truth: github.com/avocado-linux/references (public). Every
 * reference is a top-level directory containing README.md + avocado.yaml
 * (plus app/, build hooks, icon.png).
 *
 * There is NO hardcoded catalog. The list of references is discovered from
 * the repo tree, and each entry's metadata (title, language, hardware, tags,
 * summary) is parsed live from that reference's README.md frontmatter + body.
 * Nothing is cached: every call reflects the current state of the repo.
 */

import { parse as parseYaml } from "yaml";

const REPO_OWNER = "avocado-linux";
const REPO_NAME = "references";
const REPO_REF = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_REF}`;
const API_TREE_URL = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_REF}?recursive=1`;
const SOURCE_BASE = `https://github.com/${REPO_OWNER}/${REPO_NAME}/tree/${REPO_REF}`;

const USER_AGENT = "avocado-mcp-server";
const MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB per file safety cap

const SAFE_SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

export interface ReferenceEntry {
  slug: string;
  title: string;
  language: string;
  /** one-liner shown in lists */
  summary: string;
  /** targets the reference is known to work on; empty means generic */
  hardware: string[];
  /** keywords for search */
  tags: string[];
}

export interface ReferenceProject {
  entry: ReferenceEntry;
  /** Source URL on github.com for the reference's root directory */
  sourceUrl: string;
  /** All paths under <slug>/, sorted */
  files: string[];
  avocadoYaml: string | null;
  readme: string | null;
  gettingStarted: string | null;
  /** Quick summary of build hooks present (app-clean.sh, app-compile.sh, …) */
  buildHooks: string[];
  /** All paths under <slug>/app/overlay/, relative to overlay/ */
  overlayPaths: string[];
}

// ----- tree + file fetching (live, no cache) -----

interface TreeEntry {
  path: string;
  type: "blob" | "tree";
  size?: number;
}

async function fetchRepoTree(): Promise<TreeEntry[]> {
  const res = await fetch(API_TREE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub trees API: HTTP ${res.status} ${res.statusText}`);
  }
  const data = (await res.json()) as {
    tree: { path: string; type: string; size?: number }[];
    truncated?: boolean;
  };
  if (data.truncated) {
    // Hasn't happened to date — the repo is small. Surface it loudly if it does.
    console.error(
      "[WARN] github trees API returned truncated:true; reference listings may be incomplete",
    );
  }
  return data.tree
    .filter((t) => t.type === "blob" || t.type === "tree")
    .map((t) => ({
      path: t.path,
      type: t.type as "blob" | "tree",
      size: t.size,
    }));
}

/**
 * Return all paths under <slug>/, sorted. Paths are stripped of the slug
 * prefix so callers get e.g. ["README.md", "app/server.js"] rather than
 * ["nodejs-dashboard/README.md", "nodejs-dashboard/app/server.js"].
 */
export async function fetchReferenceTree(slug: string): Promise<string[]> {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid reference slug: ${slug}`);
  }
  const all = await fetchRepoTree();
  const prefix = `${slug}/`;
  const out: string[] = [];
  for (const e of all) {
    if (e.type !== "blob") continue;
    if (!e.path.startsWith(prefix)) continue;
    out.push(e.path.slice(prefix.length));
  }
  out.sort();
  return out;
}

/**
 * Fetch a single file from a reference, e.g.
 * `fetchReferenceFile("nodejs-dashboard", "app/server.js")`.
 * Bounded to 1 MB to keep stray binaries / huge logs out of LLM context.
 */
export async function fetchReferenceFile(
  slug: string,
  relativePath: string,
): Promise<string> {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid reference slug: ${slug}`);
  }
  if (!SAFE_PATH_RE.test(relativePath) || relativePath.includes("..")) {
    throw new Error(`Invalid file path: ${relativePath}`);
  }

  const url = `${RAW_BASE}/${slug}/${relativePath}`;
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) {
    throw new Error(`${slug}/${relativePath}: HTTP ${res.status}`);
  }
  // Bounded read to defend against surprise large files.
  const reader = res.body?.getReader();
  if (!reader) throw new Error(`${slug}/${relativePath}: empty body`);
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        throw new Error(
          `${slug}/${relativePath} exceeds ${MAX_FILE_BYTES} bytes`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    buf.set(c, pos);
    pos += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(buf);
}

// ----- catalog derivation from READMEs -----

/**
 * Top-level directories that are references: those that have BOTH a README.md
 * and an avocado.yaml at their root.
 */
async function discoverReferenceSlugs(): Promise<string[]> {
  const tree = await fetchRepoTree();
  const hasReadme = new Set<string>();
  const hasYaml = new Set<string>();
  for (const e of tree) {
    if (e.type !== "blob") continue;
    const parts = e.path.split("/");
    if (parts.length !== 2) continue; // only top-level <dir>/<file>
    const [dir, file] = parts;
    if (!SAFE_SLUG_RE.test(dir)) continue;
    if (file === "README.md") hasReadme.add(dir);
    else if (file === "avocado.yaml") hasYaml.add(dir);
  }
  return [...hasReadme].filter((d) => hasYaml.has(d)).sort();
}

/** Pull the leading `--- ... ---` YAML frontmatter block out of a README. */
function extractFrontmatter(markdown: string): Record<string, unknown> {
  const m = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  try {
    const obj = parseYaml(m[1]) as unknown;
    return obj && typeof obj === "object"
      ? (obj as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** First `# ` heading, with any inline icon `<img>` and markdown stripped. */
function extractTitle(markdown: string): string | null {
  const line = markdown.split(/\r?\n/).find((l) => /^#\s+/.test(l));
  if (!line) return null;
  return (
    line
      .replace(/^#\s+/, "")
      .replace(/<img[^>]*\/?>/gi, "")
      .replace(/[`*]/g, "")
      .trim() || null
  );
}

/** First sentence of the first body paragraph after the title heading. */
function extractSummary(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  const titleIdx = lines.findIndex((l) => /^#\s+/.test(l));
  const para: string[] = [];
  for (let i = titleIdx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t || t.startsWith("#") || t.startsWith("---")) {
      if (para.length) break;
      continue;
    }
    para.push(t);
  }
  const text = para
    .join(" ")
    .replace(/[`*]/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // markdown links -> text
    .replace(/&mdash;/g, "—")
    .replace(/\s+/g, " ")
    .trim();
  // First sentence: split on ". " so we don't break on "3.10"/"v2." etc.
  const dot = text.indexOf(". ");
  return dot >= 0 ? text.slice(0, dot + 1) : text;
}

/** Build a catalog entry from a reference's README content. */
function parseReferenceEntry(slug: string, readme: string): ReferenceEntry {
  const fm = extractFrontmatter(readme);

  const language =
    typeof fm.language === "string" && fm.language.trim()
      ? fm.language.trim()
      : "n/a";

  const targets = fm.targets;
  let hardware: string[] = [];
  if (Array.isArray(targets)) {
    hardware = targets.map((t) => String(t)).filter((t) => t !== "*");
  } else if (typeof targets === "string" && targets !== "*") {
    hardware = [targets];
  }

  const tags = Array.isArray(fm.topics) ? fm.topics.map((t) => String(t)) : [];

  return {
    slug,
    title: extractTitle(readme) ?? slug,
    language,
    summary: extractSummary(readme),
    hardware,
    tags,
  };
}

/**
 * Discover every reference and build its catalog entry from its README.
 * Each README is fetched in parallel; a reference whose README can't be
 * fetched/parsed is dropped rather than failing the whole listing.
 */
export async function listReferences(): Promise<ReferenceEntry[]> {
  const slugs = await discoverReferenceSlugs();
  const entries = await Promise.all(
    slugs.map(async (slug) => {
      try {
        return parseReferenceEntry(
          slug,
          await fetchReferenceFile(slug, "README.md"),
        );
      } catch {
        return null;
      }
    }),
  );
  return entries
    .filter((e): e is ReferenceEntry => e !== null)
    .sort((a, b) => a.title.localeCompare(b.title));
}

/**
 * Compatibility of a reference relative to a target.
 *  - "generic": reference hardware list is empty — works on any target.
 *  - "listed": reference explicitly lists the target as supported.
 *  - "unlisted": reference lists OTHER hardware but not this target. Surface
 *    it anyway with a warning — it may still work but isn't tested for this target.
 */
export type ReferenceCompatibility = "generic" | "listed" | "unlisted";

export interface ScoredReference {
  entry: ReferenceEntry;
  compatibility: ReferenceCompatibility;
}

export async function searchReferences(
  query: string,
  target?: string,
): Promise<ReferenceEntry[]> {
  return (await searchReferencesScored(query, target)).map((s) => s.entry);
}

export async function searchReferencesScored(
  query: string,
  target?: string,
): Promise<ScoredReference[]> {
  const refs = await listReferences();
  const tokens = query
    .toLowerCase()
    .split(/[^a-z0-9+#.-]+/)
    .filter((t) => t.length > 0);

  type Scored = {
    entry: ReferenceEntry;
    score: number;
    compatibility: ReferenceCompatibility;
  };
  const scored: Scored[] = [];
  for (const r of refs) {
    // Compatibility is informational only — surfaced so the LLM knows whether
    // the reference's authors tested it on this target. Does NOT affect ordering.
    let compatibility: ReferenceCompatibility;
    if (r.hardware.length === 0) compatibility = "generic";
    else if (target && r.hardware.includes(target)) compatibility = "listed";
    else compatibility = "unlisted";

    if (tokens.length === 0) {
      scored.push({ entry: r, score: 0, compatibility });
      continue;
    }

    const haystack = [r.slug, r.title, r.language, r.summary, ...r.tags]
      .join(" ")
      .toLowerCase();
    let score = 0;
    for (const t of tokens) {
      if (haystack.includes(t)) score++;
    }
    if (tokens.includes(r.slug)) score += 10;

    if (score > 0) scored.push({ entry: r, score, compatibility });
  }

  return scored
    .sort(
      (a, b) => b.score - a.score || a.entry.title.localeCompare(b.entry.title),
    )
    .map(({ entry, compatibility }) => ({ entry, compatibility }));
}

export async function getReferenceEntry(
  slug: string,
): Promise<ReferenceEntry | undefined> {
  if (!SAFE_SLUG_RE.test(slug)) return undefined;
  try {
    return parseReferenceEntry(
      slug,
      await fetchReferenceFile(slug, "README.md"),
    );
  } catch {
    return undefined;
  }
}

export function referenceUrl(slug: string): string {
  return `${SOURCE_BASE}/${slug}`;
}

/**
 * Compose a project bundle for the LLM: catalog entry (derived from the
 * README) + file tree + pre-fetched README/getting_started/avocado.yaml +
 * overlay summary.
 *
 * Files are fetched in parallel; any individual fetch failure becomes a null
 * field rather than a fatal error so the LLM gets partial data instead of an
 * outright failure.
 */
export async function fetchReferenceProject(
  slug: string,
): Promise<ReferenceProject> {
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(`Invalid reference slug: ${slug}`);
  }
  const files = await fetchReferenceTree(slug);
  if (files.length === 0) {
    throw new Error(
      `Unknown reference "${slug}". Use search-references (with no query) to see the catalog.`,
    );
  }

  const buildHooks = files.filter(
    (f) =>
      f === "app-clean.sh" || f === "app-compile.sh" || f === "app-install.sh",
  );

  const overlayPrefix = "app/overlay/";
  const overlayPaths = files
    .filter((f) => f.startsWith(overlayPrefix))
    .map((f) => f.slice(overlayPrefix.length));

  async function tryFetch(p: string): Promise<string | null> {
    try {
      return files.includes(p) ? await fetchReferenceFile(slug, p) : null;
    } catch {
      return null;
    }
  }
  const [readme, gettingStarted, avocadoYaml] = await Promise.all([
    tryFetch("README.md"),
    tryFetch("getting_started.md"),
    tryFetch("avocado.yaml"),
  ]);

  const entry: ReferenceEntry = readme
    ? parseReferenceEntry(slug, readme)
    : {
        slug,
        title: slug,
        language: "n/a",
        summary: "",
        hardware: [],
        tags: [],
      };

  return {
    entry,
    sourceUrl: referenceUrl(slug),
    files,
    avocadoYaml,
    readme,
    gettingStarted,
    buildHooks,
    overlayPaths,
  };
}
