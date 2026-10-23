/**
 * Fake `avocado` CLIs for tests. The MCP gets the avocado.yaml schema and
 * validation from the CLI, and the CLI tests what it reports, so these only
 * print what a test needs.
 */

import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";

/** Write an executable shell script with this body and return its path. */
export function fakeCli(body: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), "fake-avocado-")), "avocado");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

export const FAKE_SCHEMA = { title: "fake", properties: {} };

/**
 * A CLI with `config schema` and `config validate`. `config validate` saves
 * stdin next to the binary as `stdin.yaml` and prints `report.json` from
 * there (a clean report when it is missing), exiting 1 when it is not ok, as
 * the CLI does. The report is a file because the CLI does not get the
 * server's environment.
 */
export function fakeAvocado(): string {
  return fakeCli(
    [
      `dir=$(dirname "$0")`,
      `case "$1 $2" in`,
      `"config schema") echo '${JSON.stringify(FAKE_SCHEMA)}' ;;`,
      `"config validate")`,
      `  cat > "$dir/stdin.yaml"`,
      `  report='{"ok":true,"errors":[],"warnings":[]}'`,
      `  [ -f "$dir/report.json" ] && report=$(cat "$dir/report.json")`,
      // printf, not echo: dash's echo turns a `\\n` in a message into a
      // newline, which breaks the JSON.
      `  printf '%s\\n' "$report"`,
      `  case "$report" in *'"ok":false'*) exit 1 ;; esac ;;`,
      `*) echo "error: unrecognized subcommand '$2'" >&2; exit 2 ;;`,
      `esac`,
    ].join("\n"),
  );
}

/** Make the fake CLI at AVOCADO_BINARY print `report`, or a clean one for null. */
export function setReport(report: object | null): void {
  const file = join(dirname(process.env.AVOCADO_BINARY!), "report.json");
  if (report === null) rmSync(file, { force: true });
  else writeFileSync(file, JSON.stringify(report));
}

/** Run `fn` with the fake CLI at AVOCADO_BINARY printing `report`. */
export async function withReport<T>(
  report: object,
  fn: () => Promise<T>,
): Promise<T> {
  setReport(report);
  try {
    return await fn();
  } finally {
    setReport(null);
  }
}
