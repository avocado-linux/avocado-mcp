/**
 * Client for the Avocado Linux package feed at repo.avocadolinux.org.
 *
 * Mirrors `avocado sdk dnf search <query>`: the SDK container's DNF config
 * combines a per-target set of repos. The authoritative list lives at
 * `{HOST}/{release}/{channel}/targets.json`. For each target the manifest
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
 *  - Host is hardcoded to https://repo.avocadolinux.org.
 *  - Release and channel are validated against a strict regex.
 *  - Manifest repo paths are validated against a strict regex.
 *  - primary.xml.gz hrefs from repomd.xml are validated against a strict regex.
 *  - Gunzip output is read with a size cap.
 *  - Manifest + repomd responses are size-capped.
 *
 * This module is a faithful port of the FeedSearch client used on
 * docs.peridio.com/developer-reference/feed-search.
 */

export interface FeedPackage {
  name: string;
  summary: string;
  description: string;
  version: string;
  release: string;
  arch: string;
  /** Full repo sub-path under {host}/{release}/{channel}/, e.g. "target/armv8a_tegra" */
  repo: string;
  href: string;
}

export type TargetManifest = Record<string, string[]>;

const HOST = "https://repo.avocadolinux.org";
export const DEFAULT_RELEASE = "2024";
export const DEFAULT_CHANNEL = "edge";

const SAFE_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_PATH_RE =
  /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*){0,2}$/;
const SAFE_HREF_RE = /^repodata\/[A-Za-z0-9][A-Za-z0-9._-]*\.xml\.gz$/;

const MAX_MANIFEST_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_REPOMD_BYTES = 1 * 1024 * 1024; // 1 MB
const MAX_PRIMARY_DECOMPRESSED_BYTES = 256 * 1024 * 1024; // 256 MB safety net
const MAX_SEGMENT_LEN = 64;
const MAX_PATH_LEN = 128;

const TARGETS_CACHE_TTL_MS = 10 * 60 * 1000;
const USER_AGENT = "avocado-mcp-server";

function isSafeSegment(s: unknown): s is string {
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

function repoUrl(release: string, channel: string, path: string): string {
  if (!isSafeSegment(release)) throw new Error(`Invalid release: ${release}`);
  if (!isSafeSegment(channel)) throw new Error(`Invalid channel: ${channel}`);
  if (!isSafePath(path)) throw new Error(`Invalid repo path: ${path}`);
  return `${HOST}/${release}/${channel}/${path}`;
}

async function readBounded(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${label} exceeded ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
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

async function fetchBoundedText(
  url: string,
  maxBytes: number,
  label: string,
): Promise<string> {
  const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  if (!res.body) throw new Error(`${url} returned no body`);
  const bytes = await readBounded(res.body, maxBytes, label);
  return new TextDecoder("utf-8").decode(bytes);
}

async function gunzipBoundedText(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
  label: string,
): Promise<string> {
  const ds = new DecompressionStream("gzip") as unknown as ReadableWritablePair<
    Uint8Array,
    Uint8Array
  >;
  const bytes = await readBounded(body.pipeThrough(ds), maxBytes, label);
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

function parsePrimaryXml(xml: string, repo: string): FeedPackage[] {
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
    });
  }
  return out;
}

export class RepoClient {
  private targetsCache = new Map<
    string,
    { data: TargetManifest; expiresAt: number }
  >();
  /** key: `${release}::${channel}::${repo}` */
  private packagesCache = new Map<string, FeedPackage[]>();

  /**
   * Fetch the per-target manifest. Validates every entry; entries that don't
   * pass the safe-path regex are silently dropped (so a future malicious or
   * malformed entry can never get used as a URL fragment).
   */
  async getTargetManifest(
    release: string = DEFAULT_RELEASE,
    channel: string = DEFAULT_CHANNEL,
  ): Promise<TargetManifest | null> {
    if (!isSafeSegment(release)) throw new Error(`Invalid release: ${release}`);
    if (!isSafeSegment(channel)) throw new Error(`Invalid channel: ${channel}`);

    const cacheKey = `${release}::${channel}`;
    const now = Date.now();
    const cached = this.targetsCache.get(cacheKey);
    if (cached && now < cached.expiresAt) return cached.data;

    try {
      const url = `${HOST}/${release}/${channel}/targets.json`;
      const text = await fetchBoundedText(
        url,
        MAX_MANIFEST_BYTES,
        "targets.json",
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
      this.targetsCache.set(cacheKey, {
        data: out,
        expiresAt: now + TARGETS_CACHE_TTL_MS,
      });
      return out;
    } catch (error) {
      console.error(`[ERROR] Failed to fetch targets configuration:`, error);
      return null;
    }
  }

  /** Backwards-compatible name used elsewhere in the codebase. */
  async getTargetsConfig(
    release?: string,
    channel?: string,
  ): Promise<TargetManifest | null> {
    return this.getTargetManifest(release, channel);
  }

  async getRepositoryPathsForTarget(
    target: string,
    release?: string,
    channel?: string,
  ): Promise<string[]> {
    const manifest = await this.getTargetManifest(release, channel);
    if (!manifest || !manifest[target]) return [];
    return manifest[target];
  }

  /**
   * Fetch + parse the package list for one (release, channel, repo).
   * Cached in memory for the lifetime of the server process.
   */
  async fetchRepoPackages(
    release: string,
    channel: string,
    repo: string,
  ): Promise<FeedPackage[]> {
    const cacheKey = `${release}::${channel}::${repo}`;
    const cached = this.packagesCache.get(cacheKey);
    if (cached) return cached;

    const base = repoUrl(release, channel, repo);

    const repomdText = await fetchBoundedText(
      `${base}/repodata/repomd.xml`,
      MAX_REPOMD_BYTES,
      `repomd.xml (${repo})`,
    );
    const match = repomdText.match(
      /<data\s+type="primary">[\s\S]*?<location\s+href="([^"]+)"/,
    );
    if (!match) {
      throw new Error(`No primary location in repomd.xml for ${repo}`);
    }
    const href = match[1];
    if (!SAFE_HREF_RE.test(href)) {
      throw new Error(`Untrusted primary href in repomd.xml for ${repo}`);
    }

    const url = `${base}/${href}`;
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`primary.xml.gz ${res.status} for ${repo}`);
    if (!res.body)
      throw new Error(`primary.xml.gz returned no body for ${repo}`);
    const xml = await gunzipBoundedText(
      res.body,
      MAX_PRIMARY_DECOMPRESSED_BYTES,
      `primary.xml (${repo})`,
    );

    const packages = parsePrimaryXml(xml, repo);
    this.packagesCache.set(cacheKey, packages);
    return packages;
  }

  /**
   * Fetch every repo configured for a target. Per-repo errors are returned
   * non-fatally; partial success still counts.
   */
  async fetchTargetPackages(
    target: string,
    release: string = DEFAULT_RELEASE,
    channel: string = DEFAULT_CHANNEL,
  ): Promise<{ packages: FeedPackage[]; errors: string[] }> {
    const repos = await this.getRepositoryPathsForTarget(
      target,
      release,
      channel,
    );
    if (repos.length === 0) {
      return {
        packages: [],
        errors: [
          `No repositories configured for target "${target}" in ${release}/${channel}. Verify the target name and release/channel — list-targets shows the canonical list.`,
        ],
      };
    }

    const settled = await Promise.allSettled(
      repos.map((r) => this.fetchRepoPackages(release, channel, r)),
    );
    const packages: FeedPackage[] = [];
    const errors: string[] = [];
    settled.forEach((r, i) => {
      if (r.status === "fulfilled") packages.push(...r.value);
      else errors.push(`${repos[i]}: ${r.reason?.message ?? r.reason}`);
    });
    return { packages, errors };
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
    release: string = DEFAULT_RELEASE,
    channel: string = DEFAULT_CHANNEL,
  ): Promise<{
    totalMatches: number;
    results: SearchResult[];
    errors: { target: string; messages: string[] }[];
  }> {
    const all: FeedPackage[] = [];
    const errors: { target: string; messages: string[] }[] = [];

    for (const target of targets) {
      const { packages, errors: tErrors } = await this.fetchTargetPackages(
        target,
        release,
        channel,
      );
      all.push(...packages);
      if (tErrors.length > 0) errors.push({ target, messages: tErrors });
    }

    const q = query.trim().toLowerCase();
    if (!q) return { totalMatches: 0, results: [], errors };

    const seen = new Set<string>();
    const matches: SearchResult[] = [];
    for (const p of all) {
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
    return {
      totalMatches: matches.length,
      results: matches.slice(0, limit),
      errors,
    };
  }
}

export interface SearchResult extends FeedPackage {
  /** higher = better match */
  score: number;
}
