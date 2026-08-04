/**
 * Map free-text user hardware descriptions ("rpi4", "pi 4", "jetson orin
 * nano") to canonical target slugs from targets.json.
 *
 * Strategy: tokenize both sides on non-alphanumerics, score each candidate
 * by how many query tokens appear in its expanded haystack (slug + a small
 * synonym table). Exact slug match always wins.
 */

const SYNONYMS: Record<string, string[]> = {
  rpi: ["raspberry", "pi"],
  rpi3: ["raspberry", "pi", "3", "raspberrypi3"],
  rpi4: ["raspberry", "pi", "4", "raspberrypi4"],
  rpi5: ["raspberry", "pi", "5", "raspberrypi5"],
  raspberrypi3: ["raspberry", "pi", "3", "rpi3", "rpi"],
  raspberrypi4: ["raspberry", "pi", "4", "rpi4", "rpi"],
  raspberrypi5: ["raspberry", "pi", "5", "rpi5", "rpi"],
  "jetson-orin-nano-devkit": [
    "jetson",
    "orin",
    "nano",
    "devkit",
    "nvidia",
    "dev",
    "kit",
  ],
  "jetson-agx-orin-devkit": [
    "jetson",
    "agx",
    "orin",
    "devkit",
    "nvidia",
    "dev",
    "kit",
  ],
  "imx8mp-evk": ["imx8mp", "imx", "nxp", "8mp", "evk"],
  "qemux86-64": ["qemu", "x86", "x86-64", "x86_64", "amd64", "intel"],
  qemuarm64: ["qemu", "arm64", "aarch64", "arm"],
  "icam-540": ["icam", "advantech", "camera", "540"],
  fr201: ["fr201", "fr-201"],
};

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

/**
 * Collapse a string to its tokens joined: "i.MX 8M Plus" → "imx8mplus",
 * "imx93-evk" → "imx93evk". This lets a spelled-out query match a matrix slug
 * across the separators and spacing that differ between how people write a
 * board name and how the feed slugs it — no per-board aliases required. Defined
 * via `tokenize` so the separator class has a single definition.
 */
function squash(s: string): string {
  return tokenize(s).join("");
}

function haystackFor(slug: string): string[] {
  const tokens = tokenize(slug);
  const extras = SYNONYMS[slug] ?? [];
  return Array.from(new Set([slug.toLowerCase(), ...tokens, ...extras]));
}

/**
 * Score and return canonical target slugs that match the query.
 *
 * Matching is driven by the target slugs themselves (which the caller fetches
 * from the live hardware matrix); the `SYNONYMS` table is a pure enhancement
 * for colloquial names that can't be derived from a slug ("rpi", "nvidia"),
 * never a correctness dependency — a board must be findable from its slug
 * alone. Returns matches sorted by score desc, then alphabetical.
 */
export function resolveTarget(query: string, allTargets: string[]): string[] {
  const q = query.trim();
  if (q.length === 0) return allTargets;
  const qLower = q.toLowerCase();

  // Exact-slug fast path.
  const exact = allTargets.find((t) => t.toLowerCase() === qLower);

  const qTokens = tokenize(q);
  const qSquash = squash(q);
  if (qTokens.length === 0) return exact ? [exact] : [];

  type Scored = { target: string; score: number };
  const scored: Scored[] = [];
  for (const t of allTargets) {
    const hay = haystackFor(t);
    const tSquash = squash(t);
    let score = 0;

    // Separator-free whole-query containment — the strongest slug-derived
    // signal. It ranks "i.MX 93" → imx93-evk / imx93-frdm above SoC-named
    // entries that merely contain "93" mid-slug. Skip 1-char queries: they'd
    // match most of the catalog.
    if (qSquash.length >= 2) {
      if (tSquash === qSquash) score += 50;
      else if (tSquash.startsWith(qSquash)) score += 20;
      else if (tSquash.includes(qSquash)) score += 10;
    }

    // Per-token: exact > prefix > substring. A 2-char token earns credit only
    // when it *prefixes* a haystack token — a bare substring at that length is
    // noise (e.g. "64" is inside "qemuarm64", pulling an arm board into an
    // x86_64 query). Mid-slug numerics like "93" are handled by the squash
    // bonus above, not here, so they don't need the substring path.
    for (const qt of qTokens) {
      if (hay.some((h) => h === qt)) score += 3;
      else if (qt.length >= 2 && hay.some((h) => h.startsWith(qt))) score += 2;
      else if (qt.length >= 3 && hay.some((h) => h.includes(qt))) score += 1;
    }

    if (t.toLowerCase() === qLower) score += 100;
    if (score > 0) scored.push({ target: t, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.target.localeCompare(b.target))
    .map((s) => s.target);
}
