import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadSchema,
  clearSchemaCache,
  SCHEMA_URL,
} from "../../src/lib/schema-client.js";

const realFetch = globalThis.fetch;
const VENDORED = JSON.parse(
  readFileSync(
    new URL("../../src/lib/schema/avocado-config.json", import.meta.url),
    "utf8",
  ),
);

afterEach(() => {
  globalThis.fetch = realFetch;
  clearSchemaCache();
  delete process.env.AVOCADO_MCP_SCHEMA_OFFLINE;
});

/** A fresh cache dir, and a fetch stub that counts its calls. */
function setup(respond: () => Response | Promise<Response>) {
  process.env.AVOCADO_MCP_CACHE_DIR = mkdtempSync(join(tmpdir(), "schema-"));
  const calls: string[] = [];
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    calls.push(String(url));
    return respond();
  }) as typeof fetch;
  return calls;
}

test("fetches the docs schema once, then serves it from the disk cache", async () => {
  const live = { ...VENDORED, title: "live" };
  const calls = setup(() => new Response(JSON.stringify(live)));

  const first = await loadSchema();
  assert.equal(first.source, SCHEMA_URL);
  assert.equal(first.schema.title, "live");
  assert.deepEqual(calls, [SCHEMA_URL]);
  assert.ok(
    existsSync(
      join(process.env.AVOCADO_MCP_CACHE_DIR!, "schema", "avocado-config.json"),
    ),
  );

  clearSchemaCache(); // a new process: memory is empty, disk is warm
  const second = await loadSchema();
  assert.equal(second.schema.title, "live");
  assert.equal(calls.length, 1, "a warm disk cache must not refetch");
});

test("a failed fetch falls back to the vendored schema", async () => {
  setup(() => new Response("", { status: 503 }));
  const res = await loadSchema();
  assert.match(res.source, /vendored/);
  assert.equal(res.validate({ distro: { release: 2024 } }), true);
});

test("a response that is not a schema falls back to the vendored schema", async () => {
  setup(() => new Response(JSON.stringify({ hello: "world" })));
  assert.match((await loadSchema()).source, /vendored/);
});

test("a fetched schema that does not compile falls back", async () => {
  setup(
    () =>
      new Response(
        JSON.stringify({ properties: { a: { $ref: "#/nowhere" } } }),
      ),
  );
  assert.match((await loadSchema()).source, /vendored/);
});

test("AVOCADO_MCP_SCHEMA_OFFLINE=1 never touches the network", async () => {
  const calls = setup(() => {
    throw new Error("network");
  });
  process.env.AVOCADO_MCP_SCHEMA_OFFLINE = "1";
  assert.match((await loadSchema()).source, /vendored/);
  assert.deepEqual(calls, []);
});
