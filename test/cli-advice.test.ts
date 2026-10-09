import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

// Every string the MCP sends to a model (tool output, tool descriptions,
// prompts, skill resources, server instructions) lives in a source file, and
// tsc keeps string text as is. Scanning the compiled sources catches them all,
// including tool output that needs network access to render.
const SRC_DIR = fileURLToPath(new URL("../src/", import.meta.url));

const BANNED: { re: RegExp; why: string }[] = [
  {
    re: /\bprovision -r\b/,
    why: "use the positional runtime: `avocado provision dev`",
  },
  {
    re: /\bdeploy -r\b/,
    why: "use the positional runtime: `avocado deploy dev -d <ip>`",
  },
  { re: /\bsign -r\b/, why: "use the positional runtime: `avocado sign dev`" },
  {
    re: /script -q \/dev\/null/,
    why: "the CLI handles a non-TTY stdin since 1.0.0-rc.2",
  },
  {
    re: /To fix:[\\`]* (?:line that names [\\`]*)?avocado install/,
    why: "the stamp error lists per-step commands (`avocado sdk install`, `avocado ext install <name>`), never `avocado install`",
  },
  {
    re: /(?:run|Run) the commands (?:in (?:its|that) [\\`]*To fix:|the CLI lists under [\\`]*To fix:)|in the order the CLI prints/,
    why: "the CLI sorts the `To fix:` list by name, so it is not an install order. Run `avocado install`, which runs the steps SDK first",
  },
];

// `install -f` erases every extension's built content. It is allowed only on
// a line that says so (the deliberate-reset note).
const INSTALL_FORCE = /\binstall (?:-f|--force)\b/;
const RESET_WARNING = /full rebuild/;

test("no model-facing text gives deprecated or harmful CLI advice", () => {
  const files = readdirSync(SRC_DIR, { recursive: true })
    .map(String)
    .filter((f) => f.endsWith(".js"));
  assert.ok(files.length > 20, `expected compiled sources in ${SRC_DIR}`);

  const problems: string[] = [];
  for (const file of files) {
    const lines = readFileSync(join(SRC_DIR, file), "utf8").split("\n");
    lines.forEach((line, i) => {
      for (const { re, why } of BANNED) {
        if (re.test(line)) problems.push(`${file}:${i + 1} ${re} (${why})`);
      }
      if (INSTALL_FORCE.test(line) && !RESET_WARNING.test(line)) {
        problems.push(
          `${file}:${i + 1} \`install -f\` as routine advice (use plain \`avocado install\`)`,
        );
      }
    });
  }
  assert.deepEqual(problems, []);
});
