import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { loadSchema, clearSchemaCache } from "../../src/lib/schema-client.js";
import { SCHEMA, fakeCli, schemaCli } from "./schema-fixture.js";

afterEach(() => {
  clearSchemaCache();
  delete process.env.AVOCADO_BINARY;
});

test("reads the schema the CLI prints", async () => {
  process.env.AVOCADO_BINARY = schemaCli();
  const res = await loadSchema();
  assert.deepEqual(res.schema, SCHEMA);
  assert.match(res.source, /config schema/);
  assert.equal(res.validate({ default_target: "qemux86-64" }), true);
});

test("compiles again only when the CLI prints a different schema", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "schema-")), "schema.json");
  writeFileSync(file, JSON.stringify({ ...SCHEMA, title: "old" }));
  process.env.AVOCADO_BINARY = schemaCli(file);

  const first = await loadSchema();
  assert.equal(first.schema.title, "old");
  assert.equal(await loadSchema(), first);

  // An upgraded CLI is used on the next call.
  writeFileSync(file, JSON.stringify({ ...SCHEMA, title: "new" }));
  assert.equal((await loadSchema()).schema.title, "new");
});

test("a keyword the MCP does not know does not stop validation", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "schema-")), "schema.json");
  writeFileSync(file, JSON.stringify({ ...SCHEMA, "x-avocado-new": true }));
  process.env.AVOCADO_BINARY = schemaCli(file);
  assert.equal((await loadSchema()).validate({}), true);
});

test("a missing CLI says to install it", async () => {
  process.env.AVOCADO_BINARY = join(tmpdir(), "no-such-avocado");
  await assert.rejects(loadSchema(), /not installed or not on PATH/);
});

test("a CLI without `config schema` says to upgrade", async () => {
  process.env.AVOCADO_BINARY = fakeCli(
    `echo "error: unrecognized subcommand 'schema'" >&2\nexit 2`,
  );
  await assert.rejects(loadSchema(), /avocado upgrade/);
});

test("output that is not a schema is an error", async () => {
  process.env.AVOCADO_BINARY = fakeCli("echo not json");
  await assert.rejects(loadSchema(), /did not print JSON/);
  process.env.AVOCADO_BINARY = fakeCli("echo '{}'");
  await assert.rejects(loadSchema(), /did not print an avocado.yaml schema/);
});
