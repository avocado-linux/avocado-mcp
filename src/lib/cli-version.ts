/**
 * Parse and compare `avocado --version` output.
 *
 * The CLI prints `avocado 1.0.0-rc.5 (abc1234 2026-03-05)`, or just
 * `avocado 1.0.0-rc.5` when built outside its git checkout. The MCP advice
 * assumes 1.0.0-rc.4 or later (no install prompts, no TTY wrapper), so
 * `environment-check` warns on anything older.
 */

export const MIN_CLI_VERSION = "1.0.0-rc.4";

const SEMVER_RE = /\b(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/;

/** The first semver in the output, or null when there is none. */
export function parseCliVersion(output: string): string | null {
  return SEMVER_RE.exec(output)?.[1] ?? null;
}

/**
 * Semver precedence: negative when a < b, 0 when equal, positive when a > b.
 * A release sorts after its prereleases. Prerelease identifiers compare
 * numerically when both are numbers, so rc.10 sorts after rc.9.
 */
export function compareVersions(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  for (let i = 0; i < 3; i++) {
    const d = (coreA[i] ?? 0) - (coreB[i] ?? 0);
    if (d !== 0) return d;
  }
  if (preA.length === 0 || preB.length === 0) {
    return preB.length - preA.length;
  }
  for (let i = 0; i < Math.min(preA.length, preB.length); i++) {
    const x = preA[i];
    const y = preB[i];
    if (x === y) continue;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) return Number(x) - Number(y);
    if (nx) return -1;
    if (ny) return 1;
    return x < y ? -1 : 1;
  }
  return preA.length - preB.length;
}

function splitVersion(v: string): [number[], string[]] {
  const dash = v.indexOf("-");
  const core = dash === -1 ? v : v.slice(0, dash);
  const pre = dash === -1 ? "" : v.slice(dash + 1);
  return [core.split(".").map(Number), pre ? pre.split(".") : []];
}

/** True when the output names a version older than MIN_CLI_VERSION. */
export function isCliOutdated(output: string): boolean {
  const v = parseCliVersion(output);
  return v !== null && compareVersions(v, MIN_CLI_VERSION) < 0;
}
