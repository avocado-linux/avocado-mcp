import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "os";
import { join } from "path";
import { loadSchema, validateWithCli } from "../../src/lib/schema-client.js";
import { FAKE_SCHEMA, fakeAvocado, fakeCli } from "./fake-cli.js";

afterEach(() => {
  delete process.env.AVOCADO_BINARY;
  delete process.env.FAKE_AVOCADO_REPORT;
});

test("reads the schema the CLI prints", async () => {
  process.env.AVOCADO_BINARY = fakeAvocado();
  const res = await loadSchema();
  assert.deepEqual(res.schema, FAKE_SCHEMA);
  assert.match(res.source, /config schema/);
});

test("returns the CLI report, also when the CLI exits 1", async () => {
  process.env.AVOCADO_BINARY = fakeAvocado();
  assert.deepEqual(await validateWithCli("a: 1\n"), {
    ok: true,
    errors: [],
    warnings: [],
  });
  const failing = {
    ok: false,
    errors: [{ path: "/a", message: "bad" }],
    warnings: [],
  };
  process.env.FAKE_AVOCADO_REPORT = JSON.stringify(failing);
  assert.deepEqual(await validateWithCli("a: 1\n"), failing);
});

test("a missing CLI says to install it", async () => {
  process.env.AVOCADO_BINARY = join(tmpdir(), "no-such-avocado");
  await assert.rejects(loadSchema(), /not installed or not on PATH/);
  await assert.rejects(validateWithCli(""), /not installed or not on PATH/);
});

test("a CLI without the config commands says to upgrade", async () => {
  process.env.AVOCADO_BINARY = fakeCli(
    `echo "error: unrecognized subcommand '$2'" >&2\nexit 2`,
  );
  await assert.rejects(loadSchema(), /config schema`\. Run `avocado upgrade`/);
  await assert.rejects(
    validateWithCli(""),
    /config validate`\. Run `avocado upgrade`/,
  );
});

test("output that is not a schema or a report is an error", async () => {
  process.env.AVOCADO_BINARY = fakeCli("echo not json");
  await assert.rejects(loadSchema(), /did not print JSON/);
  await assert.rejects(validateWithCli(""), /did not print JSON/);
  process.env.AVOCADO_BINARY = fakeCli("echo '{}'");
  await assert.rejects(loadSchema(), /did not print an avocado.yaml schema/);
  await assert.rejects(
    validateWithCli(""),
    /did not print a validation report/,
  );
});

test("a CLI error with no report is an error", async () => {
  process.env.AVOCADO_BINARY = fakeCli("echo boom >&2\nexit 1");
  await assert.rejects(validateWithCli(""), /config validate` failed: boom/);
});

test("a CLI that exits before it reads the YAML does not stop the server", async () => {
  // More than a pipe buffer, so the write fails with EPIPE every time.
  process.env.AVOCADO_BINARY = fakeCli(
    `echo "error: unexpected argument '-c' found" >&2\nexit 2`,
  );
  await assert.rejects(
    validateWithCli("a: 1\n".repeat(200_000)),
    /Run `avocado upgrade`/,
  );
});
