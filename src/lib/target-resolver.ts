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
  "qemux86-64": ["qemu", "x86", "x86-64", "x86_64", "amd64"],
  qemuarm64: ["qemu", "arm64", "aarch64", "arm"],
  // No "advantech" here: Advantech also makes the MIC boxes on Jetson
  // targets. The docs names ("Advantech ICAM-540") cover the vendor.
  "icam-540": ["icam", "camera", "540"],
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
export function squash(s: string): string {
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
  if (query.trim().length === 0) return allTargets;
  return scoreTargets(query, allTargets).map((s) => s.target);
}

export interface TargetMatch {
  /** The one slug the input names, when it is not ambiguous. */
  target?: string;
  /** The board the input names ("Advantech MIC-712-OX"), when it names one. */
  board?: string;
  /**
   * The one docs name that matched best ("CompuLab IOT-GATE-iMX8PLUS"), when
   * only one did. Two devices can share a target with no board.
   */
  name?: string;
  /** The best matches, for a "did you mean" list. */
  candidates: string[];
  /**
   * The boards the input matches equally on its one best target ("MIC-733"
   * matches two). No `target` is set then, so the caller asks which board.
   */
  boards?: string[];
}

/**
 * A name from the docs data for a target: a device name ("Advantech
 * MIC-712-OX") or a board slug, with the board when the name is for one.
 */
export interface TargetAlias {
  name: string;
  target: string;
  board?: string;
}

/**
 * Resolve what a user typed ("rpi5", "Raspberry Pi 5") to one slug. An exact
 * slug wins. Otherwise the top match wins when it matched a whole word and
 * is the only match or scores higher than the next one, and the names of
 * that match cover every word of the input. A tie ("jetson", "pi") is
 * ambiguous and returns only the candidates. So is a word the winner does not
 * have ("Thundercomm DragonBoard 410c" for the Rubik Pi 3).
 *
 * `aliases` adds the docs names. A target scores its best name. When that
 * name is for a board, the match returns the board too. A tie between two
 * boards of one target ("MIC-733") is ambiguous, so a board is never guessed.
 * An alias for a target not in `allTargets` can win, but then nothing
 * resolves: the input names hardware this list does not have.
 */
export function resolveTargetInput(
  query: string,
  allTargets: string[],
  aliases: TargetAlias[] = [],
): TargetMatch {
  const q = query.trim();
  if (allTargets.includes(q)) return { target: q, candidates: [q] };
  if (q.length === 0) return { candidates: [] };
  const ranked = scoreTargets(q, allTargets, aliases);
  const candidates = ranked
    .filter((s) => allTargets.includes(s.target))
    .slice(0, 5)
    .map((s) => s.target);
  const [top, next] = ranked;
  if (
    !top ||
    top.score < 3 ||
    (next && top.score === next.score) ||
    !allTargets.includes(top.target) ||
    !covers(q, top, aliases)
  ) {
    return { candidates };
  }
  if (top.boards.size > 1) {
    // A tie with a name that has no board ("") is a plain ambiguity.
    if (top.boards.has("")) return { candidates };
    return { candidates: [top.target], boards: [...top.boards].sort() };
  }
  const [board] = top.boards;
  const [name] = top.names.size === 1 ? top.names : [""];
  return {
    target: top.target,
    ...(board ? { board } : {}),
    ...(name ? { name } : {}),
    candidates,
  };
}

/**
 * True when the winner's names account for every word of the query. One
 * shared word is not enough: "Thundercomm DragonBoard 410c" shares only
 * "Thundercomm" with the Rubik Pi 3, so it must not resolve to it. A word
 * counts when it is a word of the slug, a synonym, or a best-matching alias,
 * or a prefix of one (2 characters or more). The whole query squashed
 * ("icam540") also counts when it equals or prefixes a squashed name.
 */
function covers(query: string, top: Scored, aliases: TargetAlias[]): boolean {
  const hay = haystackFor(top.target);
  const squashes = [squash(top.target)];
  for (const a of aliases) {
    if (a.target !== top.target || !top.names.has(a.name)) continue;
    const alias = aliasHaystack(a);
    hay.push(...alias.hay);
    squashes.push(...alias.squashes);
  }
  const qSquash = squash(query);
  if (squashes.some((t) => t.startsWith(qSquash))) return true;
  return tokenize(query).every((qt) =>
    hay.some((h) => h === qt || (qt.length >= 2 && h.startsWith(qt))),
  );
}

/** The words and squashed forms of a docs name and its board. */
function aliasHaystack(a: TargetAlias): { hay: string[]; squashes: string[] } {
  const board = a.board?.trim() ?? "";
  return {
    hay: [...tokenize(a.name), ...tokenize(board), board.toLowerCase()],
    squashes: [squash(a.name), squash(board)].filter((x) => x),
  };
}

type Scored = {
  target: string;
  score: number;
  boards: Set<string>;
  names: Set<string>;
};

/** Score one haystack against the query. */
function scoreHaystack(
  qTokens: string[],
  qSquash: string,
  hay: string[],
  squashes: string[],
): number {
  let score = 0;

  // Separator-free whole-query containment: the strongest slug-derived
  // signal. It ranks "i.MX 93" → imx93-evk / imx93-frdm above SoC-named
  // entries that merely contain "93" mid-slug. Skip 1-char queries: they'd
  // match most of the catalog.
  if (qSquash.length >= 2) {
    if (squashes.some((t) => t === qSquash)) score += 50;
    else if (squashes.some((t) => t.startsWith(qSquash))) score += 20;
    else if (squashes.some((t) => t.includes(qSquash))) score += 10;
  }

  // Per-token: exact > prefix > substring. A 2-char token earns credit only
  // when it *prefixes* a haystack token. A bare substring at that length is
  // noise (e.g. "64" is inside "qemuarm64", pulling an arm board into an
  // x86_64 query). Mid-slug numerics like "93" are handled by the squash
  // bonus above, not here, so they don't need the substring path.
  for (const qt of qTokens) {
    if (hay.some((h) => h === qt)) score += 3;
    else if (qt.length >= 2 && hay.some((h) => h.startsWith(qt))) score += 2;
    else if (qt.length >= 3 && hay.some((h) => h.includes(qt))) score += 1;
  }
  return score;
}

/**
 * Score each target by its best name: the slug, or an alias. `boards` holds
 * the board of each name that reached that best score ("" for a name with no
 * board), so a caller can tell when the best names disagree on the board.
 * `names` holds those names ("" for the slug).
 */
function scoreTargets(
  query: string,
  allTargets: string[],
  aliases: TargetAlias[] = [],
): Scored[] {
  const q = query.trim();
  const qLower = q.toLowerCase();

  // Exact-slug fast path.
  const exact = allTargets.find((t) => t.toLowerCase() === qLower);

  const qTokens = tokenize(q);
  const qSquash = squash(q);
  if (qTokens.length === 0)
    return exact
      ? [
          {
            target: exact,
            score: 100,
            boards: new Set([""]),
            names: new Set([""]),
          },
        ]
      : [];

  const best = new Map<string, Scored>();
  const add = (target: string, score: number, board: string, name: string) => {
    if (score <= 0) return;
    const cur = best.get(target);
    if (!cur || score > cur.score) {
      best.set(target, {
        target,
        score,
        boards: new Set([board]),
        names: new Set([name]),
      });
    } else if (score === cur.score) {
      cur.boards.add(board);
      cur.names.add(name);
    }
  };
  for (const t of allTargets) {
    let score = scoreHaystack(qTokens, qSquash, haystackFor(t), [squash(t)]);
    if (t.toLowerCase() === qLower) score += 100;
    add(t, score, "", "");
  }
  for (const a of aliases) {
    const board = a.board?.trim() ?? "";
    const { hay, squashes } = aliasHaystack(a);
    const score = scoreHaystack(qTokens, qSquash, hay, squashes);
    // Docs names are long ("SolidRun HummingBoard RZ/V2N AIOT"), so a weak
    // substring hit ("board") is noise. An alias counts from a whole word.
    if (score >= 3) add(a.target, score, board, a.name);
  }
  const scored = [...best.values()];

  return scored.sort(
    (a, b) => b.score - a.score || a.target.localeCompare(b.target),
  );
}
