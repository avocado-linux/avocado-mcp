/**
 * Selectable-hardware source.
 *
 * The support matrix at docs.peridio.com is the authoritative list of the
 * boards/targets a user can actually select. The live package feed
 * (`targets.json`) is broader — it also carries arch/tune pseudo-targets
 * (`cortexa*`, `armv8*`, `x86_64_v*`, `noarch`, ...) that nobody builds for.
 * Surfacing those in "did you mean" suggestions ranks a machine string above a
 * real board (see the resolver's terse-query note), so we filter suggestions to
 * the selectable set.
 *
 * The set is sourced from the same machine-readable files the docs site renders
 * (`peridio/docs` → `src/src/data/hardware/{supported,virtual-environment}.json`),
 * so it stays data-driven and current rather than hardcoded. On ANY fetch
 * failure we return `null` and callers fall back to the full feed — a docs
 * outage must never hide real targets.
 */
import { resolveTargetInput, type TargetMatch } from "./target-resolver.js";

export const RAW_BASE =
  "https://raw.githubusercontent.com/peridio/docs/main/src/src/data/hardware";
const DATA_FILES = ["supported.json", "virtual-environment.json"];
export const CACHE_TTL_MS = 30 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT = "avocado-mcp-server";

interface HardwareDevice {
  name?: string;
  target?: string;
  board?: string;
}

let cache: { data: Set<string>; expiresAt: number } | null = null;
const fileCache = new Map<
  string,
  { data: Promise<unknown>; expiresAt: number }
>();

/**
 * Fetch one file from the docs hardware data. Throws on any failure.
 * Cached for 30 min per file, so `getHardwareData` and `getSelectableSlugs`
 * share one fetch in a tool call. A failed fetch is not cached.
 */
export function fetchHardwareFile(file: string): Promise<unknown> {
  const now = Date.now();
  const hit = fileCache.get(file);
  if (hit && now < hit.expiresAt) return hit.data;
  const data = fetchHardwareFileOnce(file);
  fileCache.set(file, { data, expiresAt: now + CACHE_TTL_MS });
  data.catch(() => {
    if (fileCache.get(file)?.data === data) fileCache.delete(file);
  });
  return data;
}

async function fetchHardwareFileOnce(file: string): Promise<unknown> {
  // Bound the request — a stalled connection must degrade to null (→ caller
  // falls back to the full feed) quickly, not hang a target-suggestion call.
  const res = await fetch(`${RAW_BASE}/${file}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${file} returned ${res.status}`);
  return res.json();
}

async function fetchDevices(file: string): Promise<HardwareDevice[]> {
  const json = await fetchHardwareFile(file);
  const devices =
    json && typeof json === "object" && "devices" in json
      ? (json as { devices: unknown }).devices
      : json;
  return Array.isArray(devices) ? (devices as HardwareDevice[]) : [];
}

/**
 * Slugs of every user-selectable target/board from the support matrix, exactly
 * as the docs write them.
 * Cached for 30 min. Returns `null` if the docs data can't be fetched — callers
 * must fall back to the full feed rather than hide targets.
 */
export async function getSelectableSlugs(): Promise<Set<string> | null> {
  const now = Date.now();
  if (cache && now < cache.expiresAt) return cache.data;
  try {
    const devices = (await Promise.all(DATA_FILES.map(fetchDevices))).flat();
    const set = new Set<string>();
    for (const d of devices) {
      for (const slug of [d.target, d.board]) {
        if (slug && slug.trim()) set.add(slug);
      }
    }
    if (set.size === 0) throw new Error("support matrix parsed no slugs");
    cache = { data: set, expiresAt: now + CACHE_TTL_MS };
    return set;
  } catch (error) {
    // Don't cache the failure — retry on the next call. Callers degrade to the
    // full feed, so this is unfiltered rather than broken. A file that
    // fetched but parsed empty must be fetched again too.
    clearHardwareFileCache();
    console.error("[hardware-support] could not fetch support matrix:", error);
    return null;
  }
}

/**
 * True when a feed slug names the same target as a docs slug. The docs data
 * has no feed-to-docs mapping, so this allows exactly one known difference:
 * the 2026 feed drops the `-devkit` suffix the docs use (feed
 * `jetson-orin-nano`, docs `jetson-orin-nano-devkit`). The compare is exact.
 * Any other mismatch, such as case or a separator (`fr-201` and `fr201`), is a
 * different board.
 */
export function sameTarget(feedSlug: string, docsSlug: string): boolean {
  return feedSlug === docsSlug || docsSlug === `${feedSlug}-devkit`;
}

/**
 * Narrow the feed's target slugs to the user-selectable set (the docs
 * slugs). A pure function: the caller fetches `selectable` and decides the
 * fallback.
 */
export function filterSelectable(
  feedTargets: string[],
  selectable: Set<string>,
): string[] {
  return feedTargets.filter((t) => {
    for (const s of selectable) {
      if (sameTarget(t, s)) return true;
    }
    return false;
  });
}

/**
 * The feed targets to list or suggest to a user: the ones in the support
 * matrix (real boards and QEMU). The feed's targets.json also carries
 * architecture entries (`armv8a`, `cortexa53`, `noarch`), which are not
 * hardware. Falls back to the whole feed when the matrix cannot be fetched,
 * so a docs outage never hides targets.
 */
export async function supportedTargets(
  feedTargets: string[],
): Promise<{ targets: string[]; fromMatrix: boolean }> {
  const selectable = await getSelectableSlugs();
  return selectable
    ? { targets: filterSelectable(feedTargets, selectable), fromMatrix: true }
    : { targets: feedTargets, fromMatrix: false };
}

/**
 * Resolve what a user typed to a feed target. An exact feed slug is always
 * accepted, so a real slug is never blocked. Any other input ("rpi5") is
 * resolved against the supported targets only, so it never lands on an
 * architecture entry.
 */
export async function resolveFeedTarget(
  input: string,
  feedTargets: string[],
  aliases: Parameters<typeof resolveTargetInput>[2] = [],
): Promise<TargetMatch & { supported: string[]; fromMatrix: boolean }> {
  const { targets: supported, fromMatrix } =
    await supportedTargets(feedTargets);
  const q = input.trim();
  const match = feedTargets.includes(q)
    ? { target: q, candidates: [q] }
    : resolveTargetInput(q, supported, aliases);
  return { ...match, supported, fromMatrix };
}

/** Drop every cached docs file, so the next call fetches them again. */
export function clearHardwareFileCache(): void {
  fileCache.clear();
}

/** Test seam: reset the in-memory cache, including the cached files. */
export function clearSelectableCache(): void {
  cache = null;
  clearHardwareFileCache();
}
