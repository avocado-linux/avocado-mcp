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

function haystackFor(slug: string): string[] {
  const tokens = tokenize(slug);
  const extras = SYNONYMS[slug] ?? [];
  return Array.from(new Set([slug.toLowerCase(), ...tokens, ...extras]));
}

/**
 * Score and return canonical target slugs that match the query.
 * Returns matches sorted by score desc, then alphabetical. Exact slug match
 * gets a +100 bonus so it always tops the list.
 */
export function resolveTarget(query: string, allTargets: string[]): string[] {
  const q = query.trim();
  if (q.length === 0) return allTargets;
  const qLower = q.toLowerCase();

  // Exact-slug fast path.
  const exact = allTargets.find((t) => t.toLowerCase() === qLower);

  const qTokens = tokenize(q);
  if (qTokens.length === 0) return exact ? [exact] : [];

  type Scored = { target: string; score: number };
  const scored: Scored[] = [];
  for (const t of allTargets) {
    const hay = haystackFor(t);
    let score = 0;
    for (const qt of qTokens) {
      if (hay.some((h) => h === qt)) score += 2;
      else if (hay.some((h) => h.includes(qt))) score += 1;
    }
    if (t.toLowerCase() === qLower) score += 100;
    if (score > 0) scored.push({ target: t, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.target.localeCompare(b.target))
    .map((s) => s.target);
}
