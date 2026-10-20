/**
 * Fake `avocado` CLIs for tests. The MCP gets the avocado.yaml schema and
 * validation from the CLI, and the CLI tests what it reports, so these only
 * print what a test needs.
 */

import { chmodSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

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
 * stdin next to the binary as `stdin.yaml` and prints FAKE_AVOCADO_REPORT
 * (a clean report by default), exiting 1 when it is not ok, as the CLI does.
 */
export function fakeAvocado(): string {
  return fakeCli(
    [
      `case "$1 $2" in`,
      `"config schema") echo '${JSON.stringify(FAKE_SCHEMA)}' ;;`,
      `"config validate")`,
      `  cat > "$(dirname "$0")/stdin.yaml"`,
      `  report=\${FAKE_AVOCADO_REPORT:-'{"ok":true,"errors":[],"warnings":[]}'}`,
      // printf, not echo: dash's echo turns a `\\n` in a message into a
      // newline, which breaks the JSON.
      `  printf '%s\\n' "$report"`,
      `  case "$report" in *'"ok":false'*) exit 1 ;; esac ;;`,
      `*) echo "error: unrecognized subcommand '$2'" >&2; exit 2 ;;`,
      `esac`,
    ].join("\n"),
  );
}
