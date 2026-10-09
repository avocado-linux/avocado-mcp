/**
 * Client for the Avocado Linux package feed at repo.avocadolinux.org.
 *
 * Mirrors `avocado sdk dnf search <query>`: the SDK container's DNF config
 * combines a per-target set of repos. The authoritative list lives at
 * `{baseUrl}/{release}/{channel}/targets.json`. The feed (base URL +
 * releasever, optionally snapshot-pinned) comes from the project's config —
 * see `feed-config.ts`. For each target the manifest
 * provides every repo path the SDK has enabled (e.g. `target/armv8a`,
 * `target/armv8a_tegra`, `sdk/all`, `target/<machine>-ext`, …).
 *
 *   1. GET {host}/{release}/{channel}/targets.json
 *   2. For each repo path: GET {repo}/repodata/repomd.xml, parse primary href
 *   3. GET that primary.xml.gz, gunzip with Node's built-in DecompressionStream
 *   4. Extract every <package type="rpm">...</package> entry
 *   5. Merge across repos, dedup, filter by query string in memory
 *
 * Security: this code runs as a child process of an MCP client. To stay safe:
 *  - The base URL must be http(s) with no query / fragment. It comes from
 *    the user's own avocado.yaml / env (the same URL their CLI fetches from),
 *    defaulting to https://repo.avocadolinux.org.
 *  - releasever segments are validated against a strict regex.
 *  - Manifest repo paths are validated against a strict regex.
 *  - primary.xml.gz hrefs from repomd.xml are validated against a strict regex.
 *  - Gunzip output is read with a size cap.
 *  - Manifest + repomd responses are size-capped.
 *
 * This module is a faithful port of the FeedSearch client used on
 * docs.peridio.com/developer-reference/feed-search.
 */

import { createHash } from "crypto";

export interface FeedPackage {
  name: string;
  summary: string;
  description: string;
  version: string;
  release: string;
  arch: string;
  /** Full repo sub-path under {baseUrl}/{releasever}/, e.g. "target/armv8a_tegra" */
  repo: string;
  href: string;
  /** Name of the feed that served the package (`avocado` for the distro feed). */
  feed?: string;
}

export type TargetManifest = Record<string, string[]>;

/**
 * Where to fetch from. `releasever` is the dnf `$releasever` path
 * (`2024/edge`, or `2026/edge/snapshots/<id>` when snapshot-pinned);
 * `manifestPath` is where targets.json lives (the live channel head).
 */
export interface FeedSpec {
  baseUrl: string;
  releasever: string;
  manifestPath: string;
  tls?: { ca?: string; insecure?: boolean };
  /** Feed name for reporting. Defaults to `avocado`. */
  name?: string;
  /** dnf priority of the distro feed among the named feeds. */
  priority?: number;
  /** Named feeds from `repos:` that are enabled for this target. */
  extraFeeds?: ExtraFeed[];
  /** Named feeds the MCP can't read, with the reason. */
  notChecked?: NotChecked[];
  /**
   * Leave out the `target/<machine>-ext` repo. Extension and runtime installs
   * run dnf with `--disablerepo=${AVOCADO_TARGET}-target-ext` (avocado-cli).
   */
  skipExtRepo?: boolean;
  /**
   * Set when the feed's settings read an env var the MCP does not expand.
   * The feed is then never fetched, and this is the reason shown.
   */
  blocked?: string;
  /** Text that came from an env expansion. Masked in every displayed URL. */
  masks?: string[];
}

/**
 * One named feed from `repos:`. A `url:` feed is a single dnf repo at that
 * URL. A `path:` feed is a local directory with `repodata/`.
 */
export interface ExtraFeed {
  name: string;
  priority: number;
  url?: string;
  path?: string;
  tls?: { ca?: string; insecure?: boolean };
  /** Basic auth from `username`/`password`. Never shown in output. */
  auth?: { username: string; password: string };
  /** Text that came from an env expansion. Masked in every displayed URL. */
  masks?: string[];
}

export interface NotChecked {
  feed: string;
  reason: string;
}

/** An HTTP error status from a feed, so callers can tell auth failures apart. */
export class FeedHttpError extends Error {
  constructor(
    url: string,
    readonly status: number,
    masks?: string[],
  ) {
    super(`${shownUrl(url, masks)} returned ${status}`);
  }
}

export const DISTRO_FEED_NAME = "avocado";

/**
 * Start of the error when the distro feed's targets.json was read and does
 * not list the target. A targets.json that failed to load gives a different
 * error, so callers can tell "absent" from "unknown".
 */
export const NO_TARGET_REPOS = "No repositories configured for target";

/** The distro feed's per-target extension repo, e.g. `target/armv8a-ext`. */
function isExtRepo(path: string): boolean {
  return path.startsWith("target/") && path.endsWith("-ext");
}

export const DEFAULT_FEED: FeedSpec = {
  baseUrl: "https://repo.avocadolinux.org",
  releasever: "2024/edge",
  manifestPath: "2024/edge",
};

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}$/;
const SAFE_RELEASEVER_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,3}$/;
const SAFE_HREF_RE = /^repodata\/[A-Za-z0-9][A-Za-z0-9._-]*\.xml\.gz$/;

const MAX_MANIFEST_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_REPOMD_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_PRIMARY_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB safety net
const MAX_SEGMENT_LEN = 64;
const MAX_PATH_LEN = 128;

const TARGETS_CACHE_TTL_MS = 10 * 60 * 1000;
/** Deadline for one feed request, headers and body included. */
const FEED_TIMEOUT_MS = 2 * 60 * 1000;
const USER_AGENT = "avocado-mcp-server";

export function isSafeSegment(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= MAX_SEGMENT_LEN &&
    SAFE_SEGMENT_RE.test(s)
  );
}

function isSafePath(p: unknown): p is string {
  if (typeof p !== "string" || p.length === 0 || p.length > MAX_PATH_LEN)
    return false;
  if (p.includes("..")) return false;
  return SAFE_PATH_RE.test(p);
}

function isSafeReleasever(p: unknown): p is string {
  return (
    typeof p === "string" &&
    p.length > 0 &&
    p.length <= MAX_PATH_LEN &&
    !p.includes("..") &&
    SAFE_RELEASEVER_RE.test(p)
  );
}

/**
 * Mask `user:password@`, query values and the fragment in a URL so
 * credentials never reach tool output. Query parameter names stay visible.
 * Works on the raw string, so it is safe to call before validation.
 *
 * The userinfo runs to the last `@` before the query, so a password with
 * `/` or `#` in it is masked too. A URL with `@` in its path loses its host
 * from the display, which is the safe way to be wrong.
 */
export function redactUrl(url: string): string {
  return url
    .replace(/^([a-z][a-z0-9+.-]*:\/\/)[^?]*@/i, "$1***@")
    .replace(/\?[^#]*/, (q) =>
      q.replace(/([?&])([^=&]*)(=?)[^&]*/g, (_, sep, key, eq) =>
        eq ? `${sep}${key}=***` : key ? `${sep}***` : sep,
      ),
    )
    .replace(/#.*$/s, "#***");
}

/**
 * Replace each mask (text that came from an env expansion) with `***`. The
 * URL-encoded forms are masked too, because `new URL()` encodes some
 * characters.
 */
export function maskText(text: string, masks: string[] = []): string {
  const forms = masks
    .flatMap((m) => [m, encodeURI(m), encodeURIComponent(m)])
    .filter((m) => m.length > 0)
    .sort((a, b) => b.length - a.length);
  for (const m of new Set(forms)) text = text.replaceAll(m, "***");
  return text;
}

/** A URL as tool output may show it: env-expanded text and credentials masked. */
export function shownUrl(url: string, masks?: string[]): string {
  return redactUrl(maskText(url, masks));
}

/** Validate a repo URL and return it normalised. Throws on anything unsafe. */
export function validateRepoUrl(url: string, masks?: string[]): string {
  const shown = shownUrl(url, masks);
  // `new URL()` silently strips tabs/newlines, so check the raw string. C1
  // controls are included because YAML 1.1 (avocado-cli's parser) treats
  // U+0085 as a line break.
  if (/[\s\x00-\x1f\x7f-\x9f]/.test(url)) {
    throw new Error(
      `Repo URL must not contain whitespace or control characters: ${JSON.stringify(shown)}`,
    );
  }
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Invalid repo URL: ${JSON.stringify(shown)}`);
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new Error(`Repo URL must be http(s): ${shown}`);
  }
  // Node's fetch refuses credentialed URLs (and echoes them in the error).
  if (u.username || u.password) {
    throw new Error(`Repo URL must not include credentials: ${shown}`);
  }
  if (u.search || u.hash) {
    throw new Error(`Repo URL must not carry a query or fragment: ${shown}`);
  }
  return u.href.replace(/\/+$/, "");
}

/** Validate a feed and return its normalised base URL. Throws on anything unsafe. */
export function validateFeed(feed: FeedSpec): string {
  if (feed.blocked) throw new Error(feed.blocked);
  const base = validateRepoUrl(feed.baseUrl, feed.masks);
  if (!isSafeReleasever(feed.releasever)) {
    throw new Error(
      `Invalid releasever: ${maskText(feed.releasever, feed.masks)}`,
    );
  }
  if (!isSafeReleasever(feed.manifestPath)) {
    throw new Error(
      `Invalid manifest path: ${maskText(feed.manifestPath, feed.masks)}`,
    );
  }
  return base;
}

function feedKey(feed: FeedSpec): string {
  return `${feed.baseUrl}::${feed.releasever}::${feed.manifestPath}::${feed.tls?.ca ?? ""}::${feed.tls?.insecure ? 1 : 0}`;
}

function repoUrl(feed: FeedSpec, path: string): string {
  const base = validateFeed(feed);
  if (!isSafePath(path)) throw new Error(`Invalid repo path: ${path}`);
  return `${base}/${feed.releasever}/${path}`;
}

/** How to reach a feed: TLS posture, optional basic auth, and output masks. */
type FeedConn = Pick<ExtraFeed, "tls" | "auth" | "masks">;

/**
 * GET with the feed's TLS posture. Plain `fetch` unless a custom CA or
 * insecure mode is configured, in which case we fall back to node:https
 * (Node's global fetch can't take per-request CAs without undici).
 *
 * Basic auth is sent only to the origin of `url`. Node's fetch drops the
 * header on a cross-origin redirect, and the node:https path below does the
 * same.
 */
async function feedFetch(
  url: string,
  conn: FeedConn,
  signal: AbortSignal,
): Promise<Response> {
  const tls = conn.tls;
  const headers: Record<string, string> = { "User-Agent": USER_AGENT };
  if (conn.auth) {
    headers.Authorization = `Basic ${Buffer.from(`${conn.auth.username}:${conn.auth.password}`).toString("base64")}`;
  }
  if (!tls || (!tls.ca && !tls.insecure) || !url.startsWith("https:")) {
    return fetch(url, { headers, signal });
  }
  const { request } = await import("https");
  const { readFileSync } = await import("fs");
  const { Readable } = await import("stream");
  let ca: Buffer | undefined;
  if (tls.ca) {
    try {
      ca = readFileSync(tls.ca);
    } catch (e) {
      throw new Error(
        `Failed to read repo CA bundle ${tls.ca}: ${(e as Error).message}`,
      );
    }
  }
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const res = await new Promise<import("http").IncomingMessage>(
      (resolvePromise, reject) => {
        const req = request(
          current,
          {
            headers,
            ca,
            rejectUnauthorized: !tls.insecure,
            signal,
          },
          resolvePromise,
        );
        req.on("error", reject);
        req.end();
      },
    );
    const status = res.statusCode ?? 0;
    if (status >= 300 && status < 400 && res.headers.location) {
      res.resume();
      const next = new URL(res.headers.location, current);
      if (next.protocol !== "https:") {
        throw new Error(
          `Refusing non-https redirect to ${shownUrl(next.href, conn.masks)}`,
        );
      }
      if (next.origin !== new URL(current).origin) delete headers.Authorization;
      current = next.href;
      continue;
    }
    const body = Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status });
  }
  throw new Error(`Too many redirects fetching ${shownUrl(url, conn.masks)}`);
}

/**
 * Run one feed request under a deadline that covers the headers and the
 * body. A feed that holds the connection open fails instead of hanging the
 * whole lookup.
 */
async function withDeadline<T>(
  url: string,
  conn: FeedConn,
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signal = AbortSignal.timeout(timeoutMs);
  try {
    return await run(signal);
  } catch (e) {
    if (signal.aborted) {
      throw new Error(
        `${shownUrl(url, conn.masks)} did not finish within ${timeoutMs / 1000} s`,
      );
    }
    throw e;
  }
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Not every body stream errors on abort, so cancel the read here too.
  const stop = () => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${label} exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
    signal?.throwIfAborted();
  } finally {
    signal?.removeEventListener("abort", stop);
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let pos = 0;
  for (const c of chunks) {
    out.set(c, pos);
    pos += c.byteLength;
  }
  return out;
}

/** GET a feed file and return its body as text, or gunzipped text. */
async function fetchBoundedText(
  url: string,
  conn: FeedConn,
  maxBytes: number,
  label: string,
  timeoutMs: number,
  gzip = false,
): Promise<string> {
  return withDeadline(url, conn, timeoutMs, async (signal) => {
    const res = await feedFetch(url, conn, signal);
    if (!res.ok) throw new FeedHttpError(url, res.status, conn.masks);
    if (!res.body) {
      throw new Error(`${shownUrl(url, conn.masks)} returned no body`);
    }
    return gzip
      ? gunzipBoundedText(res.body, maxBytes, label, signal)
      : new TextDecoder("utf-8").decode(
          await readBounded(res.body, maxBytes, label, signal),
        );
  });
}

async function gunzipBoundedText(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
  signal?: AbortSignal,
): Promise<string> {
  const ds = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const bytes = await readBounded(
    body.pipeThrough(ds),
    maxBytes,
    label,
    signal,
  );
  return new TextDecoder("utf-8").decode(bytes);
}

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function parsePrimaryXml(
  xml: string,
  repo: string,
  feed: string,
): FeedPackage[] {
  const out: FeedPackage[] = [];
  const pkgRe = /<package\s+type="rpm">([\s\S]*?)<\/package>/g;
  let m: RegExpExecArray | null;
  while ((m = pkgRe.exec(xml)) !== null) {
    const inner = m[1];
    const name = inner.match(/<name>([^<]+)<\/name>/)?.[1];
    if (!name) continue;
    const arch = inner.match(/<arch>([^<]+)<\/arch>/)?.[1] ?? "";
    const summary = unescapeXml(
      inner.match(/<summary>([^<]*)<\/summary>/)?.[1] ?? "",
    );
    const description = unescapeXml(
      inner.match(/<description>([^<]*)<\/description>/)?.[1] ?? "",
    );
    const versionMatch = inner.match(
      /<version[^/]*ver="([^"]+)"[^/]*rel="([^"]+)"/,
    );
    const version = versionMatch?.[1] ?? "";
    const release = versionMatch?.[2] ?? "";
    const href = inner.match(/<location\s+href="([^"]+)"/)?.[1] ?? "";
    out.push({
      name,
      summary,
      description,
      version,
      release,
      arch,
      repo,
      href,
      feed,
    });
  }
  return out;
}

/** Pull the primary.xml.gz href out of repomd.xml, refusing anything odd. */
function primaryHref(repomdText: string, repo: string): string {
  const match = repomdText.match(
    /<data\s+type="primary">[\s\S]*?<location\s+href="([^"]+)"/,
  );
  if (!match) {
    throw new Error(`No primary location in repomd.xml for ${repo}`);
  }
  if (!SAFE_HREF_RE.test(match[1])) {
    throw new Error(`Untrusted primary href in repomd.xml for ${repo}`);
  }
  return match[1];
}

/**
 * Read a `path:` feed from disk. Not cached: the user rebuilds these RPMs
 * locally, and reading a few files is cheap.
 */
async function readLocalRepo(
  dir: string,
  feed: string,
): Promise<FeedPackage[]> {
  const { readFile, stat } = await import("fs/promises");
  const { join } = await import("path");
  const repomdPath = join(dir, "repodata", "repomd.xml");
  if ((await stat(repomdPath)).size > MAX_REPOMD_BYTES) {
    throw new Error(`repomd.xml (${feed}) exceeded ${MAX_REPOMD_BYTES} bytes`);
  }
  const href = primaryHref(await readFile(repomdPath, "utf-8"), feed);
  const gz = await readFile(join(dir, href));
  const xml = await gunzipBoundedText(
    new Blob([gz]).stream(),
    MAX_PRIMARY_DECOMPRESSED_BYTES,
    `primary.xml (${feed})`,
  );
  return parsePrimaryXml(xml, feed, feed);
}

/** A feed for every target, or a per-target resolver (snapshot pins are per target). */
export type FeedSelector = FeedSpec | ((target: string) => FeedSpec);

function feedFor(sel: FeedSelector | undefined, target: string): FeedSpec {
  if (!sel) return DEFAULT_FEED;
  return typeof sel === "function" ? sel(target) : sel;
}

export class RepoClient {
  /** @param timeoutMs Deadline for one feed request, headers and body included. */
  constructor(private readonly timeoutMs = FEED_TIMEOUT_MS) {}

  /**
   * Both caches hold the promise, so concurrent callers share one download.
   * A failed fetch is removed so the next call retries.
   */
  private targetsCache = new Map<
    string,
    { data: Promise<TargetManifest | null>; expiresAt: number }
  >();
  /** key: `${feedKey}::${repo}` */
  private packagesCache = new Map<string, Promise<FeedPackage[]>>();

  /**
   * Fetch the per-target manifest. Validates every entry; entries that don't
   * pass the safe-path regex are silently dropped (so a future malicious or
   * malformed entry can never get used as a URL fragment).
   */
  async getTargetManifest(
    feed: FeedSpec = DEFAULT_FEED,
  ): Promise<TargetManifest | null> {
    // An unsafe feed fails soft (null), not throw: release/channel/repo URL
    // come from tool args and the user's config, and every caller maps null
    // to a structured "couldn't fetch targets.json — check the feed" error.
    // Returning early also keeps the anti-path-injection guarantee: no URL
    // is ever built from an unsafe segment.
    let base: string;
    try {
      base = validateFeed(feed);
    } catch (error) {
      console.error(`[ERROR] Refusing to fetch targets.json:`, error);
      return null;
    }

    const cacheKey = feedKey(feed);
    const now = Date.now();
    const cached = this.targetsCache.get(cacheKey);
    if (cached && now < cached.expiresAt) return cached.data;

    const entry = {
      data: this.loadTargetManifest(base, feed),
      expiresAt: now + TARGETS_CACHE_TTL_MS,
    };
    this.targetsCache.set(cacheKey, entry);
    const out = await entry.data;
    if (!out && this.targetsCache.get(cacheKey) === entry) {
      this.targetsCache.delete(cacheKey);
    }
    return out;
  }

  private async loadTargetManifest(
    base: string,
    feed: FeedSpec,
  ): Promise<TargetManifest | null> {
    try {
      const url = `${base}/${feed.manifestPath}/targets.json`;
      const text = await fetchBoundedText(
        url,
        feed,
        MAX_MANIFEST_BYTES,
        "targets.json",
        this.timeoutMs,
      );
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error("targets.json is not valid JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("targets.json is not an object");
      }
      const out: TargetManifest = {};
      for (const [target, value] of Object.entries(
        parsed as Record<string, unknown>,
      )) {
        if (!isSafeSegment(target)) continue;
        if (!Array.isArray(value)) continue;
        const paths: string[] = [];
        for (const entry of value) {
          if (typeof entry === "string" && isSafePath(entry)) paths.push(entry);
        }
        if (paths.length > 0) out[target] = paths;
      }
      return out;
    } catch (error) {
      console.error(`[ERROR] Failed to fetch targets configuration:`, error);
      return null;
    }
  }

  /** Backwards-compatible name used elsewhere in the codebase. */
  async getTargetsConfig(feed?: FeedSpec): Promise<TargetManifest | null> {
    return this.getTargetManifest(feed);
  }

  /**
   * Fetch + parse the package list for one (feed, repo).
   * Cached in memory for the lifetime of the server process.
   */
  async fetchRepoPackages(
    feed: FeedSpec,
    repo: string,
  ): Promise<FeedPackage[]> {
    const name = feed.name ?? DISTRO_FEED_NAME;
    return this.fetchPackagesAt(
      repoUrl(feed, repo),
      feed,
      repo,
      name,
      `${feedKey(feed)}::${name}::${repo}`,
    );
  }

  /** Fetch + parse one named feed from `repos:`. */
  async fetchExtraFeed(extra: ExtraFeed): Promise<FeedPackage[]> {
    if (extra.path) return readLocalRepo(extra.path, extra.name);
    if (!extra.url) throw new Error(`Feed ${extra.name} has no url or path`);
    const base = validateRepoUrl(extra.url, extra.masks);
    // Keyed per feed, including TLS and a SHA-256 digest of the full
    // credential. The raw password never goes into the key.
    const authKey = extra.auth
      ? createHash("sha256")
          .update(`${extra.auth.username}\0${extra.auth.password}`)
          .digest("hex")
      : "";
    const key = `${extra.name}::${base}::${extra.tls?.ca ?? ""}::${extra.tls?.insecure ? 1 : 0}::${authKey}`;
    return this.fetchPackagesAt(base, extra, extra.name, extra.name, key);
  }

  private async fetchPackagesAt(
    base: string,
    conn: FeedConn,
    repo: string,
    feedName: string,
    cacheKey: string,
  ): Promise<FeedPackage[]> {
    const cached = this.packagesCache.get(cacheKey);
    if (cached) return cached;
    const pending = this.loadPackagesAt(base, conn, repo, feedName);
    this.packagesCache.set(cacheKey, pending);
    pending.catch(() => {
      if (this.packagesCache.get(cacheKey) === pending) {
        this.packagesCache.delete(cacheKey);
      }
    });
    return pending;
  }

  private async loadPackagesAt(
    base: string,
    conn: FeedConn,
    repo: string,
    feedName: string,
  ): Promise<FeedPackage[]> {
    const repomdText = await fetchBoundedText(
      `${base}/repodata/repomd.xml`,
      conn,
      MAX_REPOMD_BYTES,
      `repomd.xml (${repo})`,
      this.timeoutMs,
    );
    const href = primaryHref(repomdText, repo);
    const xml = await fetchBoundedText(
      `${base}/${href}`,
      conn,
      MAX_PRIMARY_DECOMPRESSED_BYTES,
      `primary.xml (${repo})`,
      this.timeoutMs,
      true,
    );

    return parsePrimaryXml(xml, repo, feedName);
  }

  /**
   * Fetch every repo configured for a target: the distro feed's repos from
   * targets.json, then the named feeds in `feed.extraFeeds`. Results come
   * back in dnf priority order. Per-repo errors are returned non-fatally;
   * partial success still counts. A named feed that answers 401/403 is
   * reported in `notChecked`, not as an error, because its content is
   * unknown rather than absent.
   */
  async fetchTargetPackages(
    target: string,
    feed: FeedSpec = DEFAULT_FEED,
  ): Promise<{
    packages: FeedPackage[];
    errors: string[];
    notChecked: NotChecked[];
  }> {
    const errors: string[] = [];
    const notChecked: NotChecked[] = [...(feed.notChecked ?? [])];
    const groups: { priority: number; packages: FeedPackage[] }[] = [];

    // A blocked distro feed is never fetched. It is unread, not missing.
    const manifest = feed.blocked ? null : await this.getTargetManifest(feed);
    let repos = manifest?.[target] ?? [];
    if (feed.skipExtRepo) repos = repos.filter((r) => !isExtRepo(r));
    const manifestUrl = shownUrl(
      `${feed.baseUrl}/${feed.manifestPath}`,
      feed.masks,
    );
    if (feed.blocked) {
      notChecked.unshift({
        feed: feed.name ?? DISTRO_FEED_NAME,
        reason: feed.blocked,
      });
    } else if (!manifest) {
      errors.push(
        `Could not read targets.json from ${manifestUrl}. Check the feed URL and the network.`,
      );
    } else if (!manifest[target]) {
      errors.push(
        `${NO_TARGET_REPOS} "${target}" in ${manifestUrl}. Verify the target name and the configured feed. list-targets shows the canonical list.`,
      );
    }
    const extras = feed.extraFeeds ?? [];
    const [distro, named] = await Promise.all([
      Promise.allSettled(repos.map((r) => this.fetchRepoPackages(feed, r))),
      Promise.allSettled(extras.map((x) => this.fetchExtraFeed(x))),
    ]);
    const distroPackages: FeedPackage[] = [];
    distro.forEach((r, i) => {
      if (r.status === "fulfilled") distroPackages.push(...r.value);
      else
        errors.push(
          `${repos[i]}: ${maskText(String(r.reason?.message ?? r.reason), feed.masks)}`,
        );
    });
    groups.push({ priority: feed.priority ?? 0, packages: distroPackages });
    named.forEach((r, i) => {
      const x = extras[i];
      if (r.status === "fulfilled") {
        groups.push({ priority: x.priority, packages: r.value });
      } else if (
        r.reason instanceof FeedHttpError &&
        (r.reason.status === 401 || r.reason.status === 403)
      ) {
        notChecked.push({
          feed: x.name,
          reason: `the feed answered ${r.reason.status}, so its credentials are missing or rejected. Check \`username\`/\`password\` in \`repos.${x.name}\` and the env vars they read.`,
        });
      } else {
        errors.push(
          `${x.name}: ${maskText(String(r.reason?.message ?? r.reason), x.masks)}`,
        );
      }
    });
    groups.sort((a, b) => a.priority - b.priority);
    return {
      packages: groups.flatMap((g) => g.packages),
      errors,
      notChecked,
    };
  }

  /**
   * Free-text search across all repos for one or more targets. Matches the
   * default `dnf search` behaviour: name + summary only, with ranking based
   * on where the hit lands. Description matching is intentionally excluded
   * (use `describe-package` for full-text details on a specific name).
   *
   * Dedups by (name, arch, version, release) — the same RPM is listed in
   * multiple repo paths and rendering duplicates is just noise.
   */
  async searchPackages(
    targets: string[],
    query: string,
    limit = 50,
    feed?: FeedSelector,
  ): Promise<{
    totalMatches: number;
    results: SearchResult[];
    errors: { target: string; messages: string[] }[];
    notChecked: (NotChecked & { target: string })[];
  }> {
    const all: FeedPackage[] = [];
    const errors: { target: string; messages: string[] }[] = [];
    const notChecked: (NotChecked & { target: string })[] = [];

    for (const target of targets) {
      const r = await this.fetchTargetPackages(target, feedFor(feed, target));
      all.push(...r.packages);
      if (r.errors.length > 0) errors.push({ target, messages: r.errors });
      notChecked.push(...r.notChecked.map((n) => ({ target, ...n })));
    }

    const ranked = rankMatches(all, query);
    return {
      totalMatches: ranked.length,
      results: ranked.slice(0, limit),
      errors,
      notChecked,
    };
  }
}

export interface SearchResult extends FeedPackage {
  /** higher = better match */
  score: number;
}

/**
 * Rank a package set against a single free-text query, mirroring
 * `dnf search`: exact name (100) > name prefix (80) > name substring (60) >
 * summary substring (30). Dedups by (name, arch, version, release) so the
 * same RPM listed under multiple repo paths appears once. Returns the full
 * sorted list (no limit) — callers slice as needed. Shared by
 * `searchPackages` and the batch coverage tool so scoring never diverges.
 */
export function rankMatches(
  packages: FeedPackage[],
  query: string,
): SearchResult[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const seen = new Set<string>();
  const matches: SearchResult[] = [];
  for (const p of packages) {
    const name = p.name.toLowerCase();
    let score = 0;
    if (name === q) score = 100;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 60;
    else if (p.summary.toLowerCase().includes(q)) score = 30;
    else continue;

    const dedupKey = `${p.name}.${p.arch}-${p.version}-${p.release}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    matches.push({ ...p, score });
  }

  matches.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return matches;
}

/** Map a `rankMatches` score to a coverage confidence tier. */
export function scoreToConfidence(score: number): "exact" | "strong" | "fuzzy" {
  if (score >= 100) return "exact";
  if (score >= 60) return "strong";
  return "fuzzy";
}
