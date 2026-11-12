/** Levenshtein distance: insert, delete and substitute each cost 1; case-sensitive. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      const sub = prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      cur[j] = Math.min(sub, prev[j] + 1, cur[j - 1] + 1);
    }
    prev = cur;
  }
  return prev[b.length];
}

export interface ClassifyOptions {
  /** Largest case-insensitive distance that counts as near. Default 1 for a query of up to 5 characters, else 2. */
  maxDistance?: number;
  /** Cap on the number of near names returned. Unlimited when omitted. */
  limit?: number;
}

export interface NameClassification {
  exact: string | null;
  near: string[];
}

/**
 * Split `names` into the one equal to `query` (case-sensitive) and the others
 * within `maxDistance` of it compared ignoring case, ordered by distance then name.
 */
export function classifyName(
  query: string,
  names: readonly string[],
  options: ClassifyOptions = {},
): NameClassification {
  // Two edits are a large share of a short name ("curl" vs "perl"), so a
  // query of up to 5 characters allows one.
  const maxDistance = options.maxDistance ?? (query.length <= 5 ? 1 : 2);
  const lowerQuery = query.toLowerCase();
  let exact: string | null = null;
  const scored: Array<{ name: string; distance: number }> = [];
  for (const name of names) {
    if (name === query) {
      exact ??= name;
      continue;
    }
    if (Math.abs(name.length - query.length) > maxDistance) continue;
    const distance = editDistance(lowerQuery, name.toLowerCase());
    if (distance <= maxDistance) scored.push({ name, distance });
  }
  scored.sort(
    (x, y) =>
      x.distance - y.distance ||
      (x.name < y.name ? -1 : x.name > y.name ? 1 : 0),
  );
  const near = scored.map((s) => s.name);
  return {
    exact,
    near: options.limit === undefined ? near : near.slice(0, options.limit),
  };
}
