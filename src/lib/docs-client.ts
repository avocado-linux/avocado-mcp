/**
 * Docs corpus client — fetches Peridio + Avocado docs from `peridio/docs`
 * on GitHub, parses Docusaurus frontmatter, and caches everything on disk.
 *
 * Source layout in the upstream repo:
 *   src/docs-overview/      → docs.peridio.com/
 *   src/docs-hardware/      → docs.peridio.com/hardware/
 *   src/docs-guides/        → docs.peridio.com/developer-reference/
 *   src/docs-changelog/     → docs.peridio.com/changelog/
 *   src/field-notes/        → docs.peridio.com/field-notes/YYYY/MM/DD/<name> (blog)
 *
 * The non-obvious mapping (`docs-guides → /developer-reference/`) is driven
 * by `routeBasePath` in the docs site's `docusaurus.config.js`. We mirror
 * that mapping below so the URLs we return point at real pages.
 *
 * `docs-getting-started/` exists in the repo but isn't mounted as a plugin
 * (just an `index.md`); the real getting-started content lives in
 * `docs-guides/`. Skipped here.
 *
 * Cache layout under getCacheDir() / "docs":
 *   manifest.json   — { entries: DocEntry[], indexedAt }
 *   blob/<sha>.md   — file content keyed by GitHub blob SHA (immutable; no TTL)
 *
 * Cache invalidation: manifest is TTL'd (1 hour by default; overridable via
 * AVOCADO_MCP_DOCS_TTL_SEC env var). Blob files are content-addressable, so
 * stale blobs are harmless — they just won't be referenced by a fresh manifest.
 */

import * as fs from "fs/promises";
import * as fsSync from "fs";
import * as path from "path";
import { getCacheDir } from "./cache.js";

const REPO_OWNER = "peridio";
const REPO_NAME = "docs";
const REPO_BRANCH = "main";
const SITE_BASE = "https://docs.peridio.com";

const USER_AGENT = "avocado-os-mcp-server";
const MANIFEST_TTL_MS =
  Number(process.env.AVOCADO_MCP_DOCS_TTL_SEC ?? 3600) * 1000;
const MAX_FILE_BYTES = 512 * 1024; // 512 KB; trips a warning if a doc is bigger
/** Bump when the manifest shape or site-path rules change, so old caches rebuild. */
const MANIFEST_VERSION = 2;
const CONFIG_PATH = "src/docusaurus.config.js";

/** Section → URL prefix mapping from docusaurus.config.js. */
const SECTION_ROUTES: Record<string, string> = {
  "src/docs-overview/": "", // mounts at /
  "src/docs-hardware/": "hardware/",
  "src/docs-guides/": "developer-reference/",
  "src/docs-changelog/": "changelog/",
  "src/field-notes/": "field-notes/",
};

/** Files the field-notes blog plugin excludes in docusaurus.config.js. */
const FIELD_NOTES_EXCLUDE = new Set(["src/field-notes/CONTRIBUTING.md"]);

export interface DocEntry {
  /** Path inside the upstream repo, e.g. `src/docs-guides/seeding-var.md`. */
  repoPath: string;
  /** Site path with the leading "/" stripped, e.g. `developer-reference/seeding-var`. */
  sitePath: string;
  /** Full URL on docs.peridio.com. */
  url: string;
  /** Section the doc belongs to: overview / hardware / guides / changelog / field-notes. */
  section: "overview" | "hardware" | "guides" | "changelog" | "field-notes";
  /** Frontmatter title (falls back to the filename humanized). */
  title: string;
  /** Frontmatter description, if any. */
  description: string;
  /** GitHub blob SHA — used as the cache key for content. */
  sha: string;
}

interface Manifest {
  version: number;
  indexedAt: number;
  entries: DocEntry[];
  /** Redirect `from` → `to` site paths from docusaurus.config.js (no leading "/"). */
  redirects: Record<string, string>;
}

interface TreeBlob {
  path: string;
  type: "blob" | "tree";
  sha: string;
  size?: number;
}

let manifestCache: Manifest | null = null;
let pendingRefresh: Promise<Manifest> | null = null;

function cacheRoot(): string {
  const d = path.join(getCacheDir(), "docs");
  if (!fsSync.existsSync(d)) fsSync.mkdirSync(d, { recursive: true });
  const blob = path.join(d, "blob");
  if (!fsSync.existsSync(blob)) fsSync.mkdirSync(blob, { recursive: true });
  return d;
}

function manifestPath(): string {
  return path.join(cacheRoot(), "manifest.json");
}

function blobPath(sha: string): string {
  // SHA is 40 hex chars; safe as a filename.
  return path.join(cacheRoot(), "blob", `${sha}.md`);
}

function ghHeaders(): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "application/vnd.github+json",
  };
  const token =
    process.env.GITHUB_TOKEN ?? process.env.AVOCADO_MCP_GITHUB_TOKEN;
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

function deriveSection(repoPath: string): DocEntry["section"] | null {
  if (repoPath.startsWith("src/docs-overview/")) return "overview";
  if (repoPath.startsWith("src/docs-hardware/")) return "hardware";
  if (repoPath.startsWith("src/docs-guides/")) return "guides";
  if (repoPath.startsWith("src/docs-changelog/")) return "changelog";
  if (repoPath.startsWith("src/field-notes/")) return "field-notes";
  return null;
}

/**
 * Map a repo path to the path the site serves, without leading or trailing
 * "/" (the site uses `trailingSlash: false`). `slug` is the frontmatter
 * `slug:` value, if any.
 *
 * Docusaurus rules mirrored here:
 *   - `foo/index.md` serves at `foo`.
 *   - An absolute slug (`/x/y`) replaces the path inside the section route.
 *   - A relative slug (`y`) is resolved against the doc's directory.
 *   - Blog posts named `YYYY-MM-DD-name` serve at `YYYY/MM/DD/name`.
 */
export function deriveSitePath(repoPath: string, slug?: string): string {
  for (const [prefix, route] of Object.entries(SECTION_ROUTES)) {
    if (!repoPath.startsWith(prefix)) continue;
    // Strip the .md / .mdx extension.
    const rel = repoPath.slice(prefix.length).replace(/\.mdx?$/, "");
    const segments = rel.split("/");
    if (segments[segments.length - 1] === "index") segments.pop();
    let page = segments.join("/");
    if (slug) {
      if (slug.startsWith("/")) {
        page = slug;
      } else {
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        page = dir ? `${dir}/${slug}` : slug;
      }
    } else if (prefix === "src/field-notes/") {
      const m = page.match(/^(\d{4})-(\d{2})-(\d{2})-(.+)$/);
      if (m) page = `${m[1]}/${m[2]}/${m[3]}/${m[4]}`;
    }
    // Trim "/" at both ends, also when `page` is "" and only the route is left.
    return (route + page.replace(/^\/+|\/+$/g, "")).replace(/\/$/, "");
  }
  return repoPath; // unreachable for filtered tree
}

/**
 * True for files Docusaurus does not publish as pages: `_`-prefixed files
 * and directories (partials, templates) and the field-notes exclude list.
 */
export function isUnpublishedPath(repoPath: string): boolean {
  return (
    repoPath.split("/").some((s) => s.startsWith("_")) ||
    FIELD_NOTES_EXCLUDE.has(repoPath)
  );
}

/**
 * Read the `redirects` of plugin-client-redirects from docusaurus.config.js
 * source. The redirects are plain string literals, so a regex is enough.
 * Returns `from` → `to` site paths without the leading "/".
 */
export function parseRedirects(configSource: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /from:\s*(['"])(.*?)\1\s*,\s*to:\s*(['"])(.*?)\3/g;
  for (const m of configSource.matchAll(re)) {
    out[m[2].replace(/^\/|\/$/g, "")] = m[4].replace(/^\/|\/$/g, "");
  }
  return out;
}

/** Humanize "lockfiles-and-build-stamps" → "Lockfiles And Build Stamps". */
function humanizeFilename(filename: string): string {
  return filename
    .replace(/\.mdx?$/, "")
    .replace(/[-_]/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Parse YAML frontmatter (between two `---` fences at the file head). We
 * only need a couple of fields; a real YAML parser would be overkill.
 */
export function parseFrontmatter(body: string): {
  meta: Record<string, string>;
  rest: string;
} {
  if (!body.startsWith("---\n") && !body.startsWith("---\r\n")) {
    return { meta: {}, rest: body };
  }
  const endIdx = body.indexOf("\n---", 4);
  if (endIdx === -1) return { meta: {}, rest: body };
  const block = body.slice(4, endIdx);
  const rest = body.slice(endIdx + 4).replace(/^\r?\n/, "");
  const meta: Record<string, string> = {};
  for (const line of block.split(/\r?\n/)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // Strip surrounding quotes, or a trailing YAML comment on a bare value.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      value = value.replace(/\s+#.*$/, "");
    }
    meta[m[1]] = value;
  }
  return { meta, rest };
}

/**
 * Build the catalog entry for one file. Returns null when the file is not a
 * published page: outside a known section, or `draft: true` (drafts are left
 * out of the production site).
 */
export function toDocEntry(
  repoPath: string,
  sha: string,
  text: string,
): DocEntry | null {
  const section = deriveSection(repoPath);
  if (!section) return null;
  const { meta } = parseFrontmatter(text);
  if (meta.draft === "true") return null;
  const sitePath = deriveSitePath(repoPath, meta.slug || undefined);
  return {
    repoPath,
    sitePath,
    url: `${SITE_BASE}/${sitePath}`,
    section,
    title: meta.title || humanizeFilename(path.basename(repoPath)),
    description: meta.description || "",
    sha,
  };
}

/**
 * Fetch the repo tree and return only the blobs we care about.
 */
async function fetchTree(): Promise<TreeBlob[]> {
  const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/git/trees/${REPO_BRANCH}?recursive=1`;
  const res = await fetch(url, { headers: ghHeaders() });
  if (!res.ok) {
    throw new Error(
      `GitHub trees API: ${res.status} ${res.statusText} (have you set GITHUB_TOKEN?)`,
    );
  }
  const data = (await res.json()) as {
    tree: TreeBlob[];
    truncated?: boolean;
  };
  if (data.truncated) {
    console.error(
      "[avocado-mcp] WARN: github trees API truncated; docs corpus may be incomplete",
    );
  }
  return data.tree
    .filter((b) => b.type === "blob")
    .filter((b) => /\.mdx?$/.test(b.path))
    .filter((b) => deriveSection(b.path) !== null)
    .filter((b) => !isUnpublishedPath(b.path));
}

/** Fetch redirects from the site config. A failure only loses the aliases. */
async function fetchRedirects(): Promise<Record<string, string>> {
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${CONFIG_PATH}`;
  try {
    const res = await fetch(rawUrl, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return parseRedirects(await res.text());
  } catch (e) {
    console.error(
      `[avocado-mcp] WARN: failed to fetch ${CONFIG_PATH}: ${(e as Error).message}`,
    );
    return {};
  }
}

/**
 * Fetch a file's content, keyed and cached by blob SHA on disk.
 *
 * Why we take BOTH a path and a sha:
 *   - SHA is the cache key (content-addressable; stale entries are harmless).
 *   - Path is used in the fetch URL because we hit `raw.githubusercontent.com`
 *     (a CDN with generous rate limits) rather than the blob API (60/hr
 *     unauthed, 5000/hr authed). Raw URLs are keyed by `<branch>/<path>`, not
 *     by blob SHA — so there's a tiny window where a file could change
 *     between when we read the tree and when we fetch from raw, but the next
 *     manifest refresh corrects it.
 */
async function fetchBlobContent(
  repoPath: string,
  sha: string,
): Promise<string> {
  // Try disk cache first (content-addressable, no TTL).
  const p = blobPath(sha);
  try {
    return await fs.readFile(p, "utf8");
  } catch {
    // not cached; fall through to fetch
  }
  const rawUrl = `https://raw.githubusercontent.com/${REPO_OWNER}/${REPO_NAME}/${REPO_BRANCH}/${repoPath}`;
  const res = await fetch(rawUrl, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) {
    throw new Error(`raw fetch ${repoPath}: ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) {
    console.error(
      `[avocado-mcp] WARN: doc file ${repoPath} exceeds ${MAX_FILE_BYTES} bytes; partial indexing only`,
    );
  }
  await fs.writeFile(p, text, "utf8");
  return text;
}

/**
 * Build (or refresh) the manifest. Reads on-disk cache when warm; refreshes
 * from GitHub when stale or missing. Concurrent refresh requests share one
 * in-flight promise.
 */
async function buildManifest(): Promise<Manifest> {
  const now = Date.now();
  if (manifestCache && now - manifestCache.indexedAt < MANIFEST_TTL_MS) {
    return manifestCache;
  }

  // Try disk-warm path: read the manifest file and check TTL.
  if (!manifestCache) {
    try {
      const raw = await fs.readFile(manifestPath(), "utf8");
      const parsed = JSON.parse(raw) as Manifest;
      if (
        parsed.version === MANIFEST_VERSION &&
        now - parsed.indexedAt < MANIFEST_TTL_MS
      ) {
        manifestCache = parsed;
        return parsed;
      }
    } catch {
      // No manifest or unreadable; continue to refresh.
    }
  }

  if (pendingRefresh) return pendingRefresh;
  pendingRefresh = (async (): Promise<Manifest> => {
    const tree = await fetchTree();
    const entries: DocEntry[] = [];
    for (const blob of tree) {
      let text: string;
      try {
        text = await fetchBlobContent(blob.path, blob.sha);
      } catch (e) {
        console.error(
          `[avocado-mcp] WARN: failed to fetch ${blob.path}: ${(e as Error).message}`,
        );
        continue;
      }
      const entry = toDocEntry(blob.path, blob.sha, text);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => a.sitePath.localeCompare(b.sitePath));
    const redirects = await fetchRedirects();
    const manifest: Manifest = {
      version: MANIFEST_VERSION,
      indexedAt: Date.now(),
      entries,
      redirects,
    };
    await fs.writeFile(
      manifestPath(),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    manifestCache = manifest;
    pendingRefresh = null;
    return manifest;
  })();
  return pendingRefresh;
}

// ----- public API -----

/** Get every doc page (the catalog). */
export async function listDocs(filter?: {
  section?: DocEntry["section"];
}): Promise<DocEntry[]> {
  const { entries } = await buildManifest();
  if (filter?.section) {
    return entries.filter((e) => e.section === filter.section);
  }
  return entries;
}

/** Find a doc by site-path slug, full URL, or repo path. */
export async function findDoc(query: string): Promise<DocEntry | null> {
  const { entries, redirects } = await buildManifest();
  return resolveDoc(entries, redirects, query);
}

/**
 * Match a query against the entries. Accepts a full URL, a repo path, or a
 * site path with or without leading and trailing "/". Redirect `from` paths
 * resolve to their target page.
 */
export function resolveDoc(
  entries: DocEntry[],
  redirects: Record<string, string>,
  query: string,
): DocEntry | null {
  const q = query.trim();
  // 1. Repo path.
  if (q.startsWith("src/")) {
    return entries.find((e) => e.repoPath === q) ?? null;
  }
  // 2. Full URL or site path. Drop the host, any #anchor or ?query, and the
  // leading and trailing "/".
  const sitePath = (q.startsWith(SITE_BASE) ? q.slice(SITE_BASE.length) : q)
    .replace(/[?#].*$/, "")
    .replace(/^\/+|\/+$/g, "");
  const target = redirects[sitePath] ?? sitePath;
  return (
    entries.find((e) => e.sitePath === sitePath) ??
    entries.find((e) => e.sitePath === target) ??
    null
  );
}

/** Fetch the raw markdown content for a doc (frontmatter included; caller decides whether to strip). */
export async function fetchDocContent(entry: DocEntry): Promise<string> {
  return fetchBlobContent(entry.repoPath, entry.sha);
}

/** For tests / external invalidation. */
export function clearCache(): void {
  manifestCache = null;
  pendingRefresh = null;
}
