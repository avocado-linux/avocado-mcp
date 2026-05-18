/**
 * Docs corpus client — fetches Peridio + Avocado docs from `peridio/docs`
 * on GitHub, parses Docusaurus frontmatter, and caches everything on disk.
 *
 * Source layout in the upstream repo:
 *   src/docs-overview/      → docs.peridio.com/
 *   src/docs-hardware/      → docs.peridio.com/hardware/
 *   src/docs-guides/        → docs.peridio.com/developer-reference/
 *   src/docs-changelog/     → docs.peridio.com/changelog/
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

/** Section → URL prefix mapping from docusaurus.config.js. */
const SECTION_ROUTES: Record<string, string> = {
  "src/docs-overview/": "", // mounts at /
  "src/docs-hardware/": "hardware/",
  "src/docs-guides/": "developer-reference/",
  "src/docs-changelog/": "changelog/",
};

export interface DocEntry {
  /** Path inside the upstream repo, e.g. `src/docs-guides/seeding-var.md`. */
  repoPath: string;
  /** Site path with the leading "/" stripped, e.g. `developer-reference/seeding-var`. */
  sitePath: string;
  /** Full URL on docs.peridio.com. */
  url: string;
  /** Section the doc belongs to: overview / hardware / guides / changelog. */
  section: "overview" | "hardware" | "guides" | "changelog";
  /** Frontmatter title (falls back to the filename humanized). */
  title: string;
  /** Frontmatter description, if any. */
  description: string;
  /** GitHub blob SHA — used as the cache key for content. */
  sha: string;
}

interface Manifest {
  indexedAt: number;
  entries: DocEntry[];
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
  return null;
}

function deriveSitePath(repoPath: string): string {
  for (const [prefix, route] of Object.entries(SECTION_ROUTES)) {
    if (!repoPath.startsWith(prefix)) continue;
    let rel = repoPath.slice(prefix.length);
    // Strip the .md / .mdx extension.
    rel = rel.replace(/\.mdx?$/, "");
    // Docusaurus default: `index` → "" (the parent dir is the route).
    if (rel.endsWith("/index")) rel = rel.slice(0, -"index".length);
    if (rel === "index") rel = "";
    return route + rel;
  }
  return repoPath; // unreachable for filtered tree
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
function parseFrontmatter(body: string): {
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
    // Strip surrounding quotes.
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    meta[m[1]] = value;
  }
  return { meta, rest };
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
    .filter((b) => deriveSection(b.path) !== null);
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
      if (now - parsed.indexedAt < MANIFEST_TTL_MS) {
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
      const section = deriveSection(blob.path);
      if (!section) continue;
      let title = humanizeFilename(path.basename(blob.path));
      let description = "";
      try {
        const text = await fetchBlobContent(blob.path, blob.sha);
        const { meta } = parseFrontmatter(text);
        if (meta.title) title = meta.title;
        if (meta.description) description = meta.description;
      } catch (e) {
        console.error(
          `[avocado-mcp] WARN: failed to fetch ${blob.path}: ${(e as Error).message}`,
        );
        continue;
      }
      const sitePath = deriveSitePath(blob.path);
      entries.push({
        repoPath: blob.path,
        sitePath,
        url: `${SITE_BASE}/${sitePath}`,
        section,
        title,
        description,
        sha: blob.sha,
      });
    }
    entries.sort((a, b) => a.sitePath.localeCompare(b.sitePath));
    const manifest: Manifest = { indexedAt: Date.now(), entries };
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
  const { entries } = await buildManifest();
  const q = query.trim();
  // 1. Full URL.
  if (q.startsWith(SITE_BASE)) {
    const sitePath = q
      .slice(SITE_BASE.length)
      .replace(/^\//, "")
      .replace(/\/$/, "");
    return entries.find((e) => e.sitePath === sitePath) ?? null;
  }
  // 2. Repo path.
  if (q.startsWith("src/docs-")) {
    return entries.find((e) => e.repoPath === q) ?? null;
  }
  // 3. Site-path slug (with or without leading slash, with or without trailing slash).
  const normalized = q.replace(/^\//, "").replace(/\/$/, "");
  return entries.find((e) => e.sitePath === normalized) ?? null;
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
