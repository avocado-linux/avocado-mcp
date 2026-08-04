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
import { squash } from "./target-resolver.js";

const RAW_BASE =
  "https://raw.githubusercontent.com/peridio/docs/main/src/src/data/hardware";
const DATA_FILES = ["supported.json", "virtual-environment.json"];
const CACHE_TTL_MS = 30 * 60 * 1000;
const USER_AGENT = "avocado-mcp-server";

interface HardwareDevice {
  name?: string;
  target?: string;
  board?: string;
}

let cache: { data: Set<string>; expiresAt: number } | null = null;

async function fetchDevices(file: string): Promise<HardwareDevice[]> {
  const res = await fetch(`${RAW_BASE}/${file}`, {
    headers: { "User-Agent": USER_AGENT },
  });
  if (!res.ok) throw new Error(`${file} returned ${res.status}`);
  const json: unknown = await res.json();
  const devices =
    json && typeof json === "object" && "devices" in json
      ? (json as { devices: unknown }).devices
      : json;
  return Array.isArray(devices) ? (devices as HardwareDevice[]) : [];
}

/**
 * Squashed slugs of every user-selectable target/board from the support matrix.
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
        if (slug && slug.trim()) set.add(squash(slug));
      }
    }
    if (set.size === 0) throw new Error("support matrix parsed no slugs");
    cache = { data: set, expiresAt: now + CACHE_TTL_MS };
    return set;
  } catch (error) {
    // Don't cache the failure — retry on the next call. Callers degrade to the
    // full feed, so this is unfiltered rather than broken.
    console.error("[hardware-support] could not fetch support matrix:", error);
    return null;
  }
}

/**
 * Narrow the feed's target slugs to the user-selectable set. Reconciles the
 * small slug differences between the feed and the support matrix (e.g. the feed
 * has `jetson-orin-nano-devkit` while the matrix lists `jetson-orin-nano`) via a
 * squash prefix match in either direction. A pure function — the caller fetches
 * `selectable` and decides the fallback.
 */
export function filterSelectable(
  feedTargets: string[],
  selectable: Set<string>,
): string[] {
  return feedTargets.filter((t) => {
    const q = squash(t);
    for (const s of selectable) {
      if (q === s || q.startsWith(s) || s.startsWith(q)) return true;
    }
    return false;
  });
}

/** Test seam: reset the in-memory cache. */
export function clearSelectableCache(): void {
  cache = null;
}
