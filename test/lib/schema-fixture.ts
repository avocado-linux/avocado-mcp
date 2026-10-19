/**
 * The avocado.yaml schema for tests, and fake `avocado` CLIs. The MCP reads
 * the schema from `avocado config schema`, so tests point AVOCADO_BINARY at a
 * script that prints test/fixtures/avocado-config.json. That file is a copy
 * of avocado-cli `schemas/avocado-config.json`. Refresh it when a test needs
 * a newer schema rule.
 */

import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { fileURLToPath } from "url";

// Tests run from build-test/test/lib, and the fixture is not copied there.
export const SCHEMA_PATH = fileURLToPath(
  new URL("../../../test/fixtures/avocado-config.json", import.meta.url),
);
export const SCHEMA = JSON.parse(readFileSync(SCHEMA_PATH, "utf8"));

/** Write an executable shell script with this body and return its path. */
export function fakeCli(body: string): string {
  const bin = join(mkdtempSync(join(tmpdir(), "fake-avocado-")), "avocado");
  writeFileSync(bin, `#!/bin/sh\n${body}\n`);
  chmodSync(bin, 0o755);
  return bin;
}

/** A CLI that prints `file` for `avocado config schema`. */
export function schemaCli(file = SCHEMA_PATH): string {
  return fakeCli(
    `[ "$1 $2" = "config schema" ] && exec cat '${file}'\n` +
      `echo "error: unrecognized subcommand '$1'" >&2\nexit 2`,
  );
}
