const isDigit = (c: string): boolean => c >= "0" && c <= "9";
const isAlpha = (c: string): boolean =>
  (c >= "a" && c <= "z") || (c >= "A" && c <= "Z");
const isAlnum = (c: string): boolean => isDigit(c) || isAlpha(c);

/** Port of rpm's rpmvercmp(): returns -1, 0 or 1. */
export function rpmvercmp(a: string, b: string): number {
  if (a === b) return 0;
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    while (i < a.length && !isAlnum(a[i]) && a[i] !== "~" && a[i] !== "^") i++;
    while (j < b.length && !isAlnum(b[j]) && b[j] !== "~" && b[j] !== "^") j++;

    // Tilde sorts before everything, even the end of the string.
    if (a[i] === "~" || b[j] === "~") {
      if (a[i] !== "~") return 1;
      if (b[j] !== "~") return -1;
      i++;
      j++;
      continue;
    }
    // Caret sorts after the end of the string but before anything else.
    if (a[i] === "^" || b[j] === "^") {
      if (i >= a.length) return -1;
      if (j >= b.length) return 1;
      if (a[i] !== "^") return 1;
      if (b[j] !== "^") return -1;
      i++;
      j++;
      continue;
    }
    if (i >= a.length || j >= b.length) break;

    const numeric = isDigit(a[i]);
    const pred = numeric ? isDigit : isAlpha;
    let si = i;
    let sj = j;
    while (i < a.length && pred(a[i])) i++;
    while (j < b.length && pred(b[j])) j++;
    let segA = a.slice(si, i);
    let segB = b.slice(sj, j);
    // Segments of different kinds: numeric is newer.
    if (segB.length === 0) return numeric ? 1 : -1;
    if (numeric) {
      segA = segA.replace(/^0+/, "");
      segB = segB.replace(/^0+/, "");
      if (segA.length !== segB.length)
        return segA.length > segB.length ? 1 : -1;
    }
    if (segA !== segB) return segA < segB ? -1 : 1;
  }
  if (i >= a.length && j >= b.length) return 0;
  return i >= a.length ? -1 : 1;
}

export interface RpmEvr {
  epoch: number;
  version: string;
  release: string;
}

/** Parse "[epoch:]version[-release]". Missing epoch is 0. */
export function parseEvr(s: string): RpmEvr {
  let epoch = 0;
  let rest = s;
  const colon = rest.indexOf(":");
  if (colon > 0 && /^\d+$/.test(rest.slice(0, colon))) {
    epoch = parseInt(rest.slice(0, colon), 10);
    rest = rest.slice(colon + 1);
  }
  const dash = rest.lastIndexOf("-");
  if (dash < 0) return { epoch, version: rest, release: "" };
  return { epoch, version: rest.slice(0, dash), release: rest.slice(dash + 1) };
}

/** Compare two EVR strings (epoch, then version, then release). */
export function compareEvr(a: string, b: string): number {
  const x = parseEvr(a);
  const y = parseEvr(b);
  if (x.epoch !== y.epoch) return x.epoch > y.epoch ? 1 : -1;
  const v = rpmvercmp(x.version, y.version);
  if (v !== 0) return v;
  return rpmvercmp(x.release, y.release);
}
