import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "fs";
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

test("a fetched schema that does not compile falls back and is not cached", async () => {
  const calls = setup(
    () =>
      new Response(
        JSON.stringify({ properties: { a: { $ref: "#/nowhere" } } }),
      ),
  );
  assert.match((await loadSchema()).source, /vendored/);
  assert.ok(
    !existsSync(
      join(process.env.AVOCADO_MCP_CACHE_DIR!, "schema", "avocado-config.json"),
    ),
  );
  clearSchemaCache();
  await loadSchema();
  assert.equal(calls.length, 2, "the next call must fetch again");
});

test("a cache dir that cannot be written still serves the fetched schema", async () => {
  const live = { ...VENDORED, title: "live" };
  setup(() => new Response(JSON.stringify(live)));
  // A file where the cache dir must be: mkdir fails.
  const blocker = join(process.env.AVOCADO_MCP_CACHE_DIR!, "blocker");
  writeFileSync(blocker, "");
  process.env.AVOCADO_MCP_CACHE_DIR = blocker;
  const res = await loadSchema();
  assert.equal(res.source, SCHEMA_URL);
  assert.equal(res.schema.title, "live");
});

test("a disk entry keeps its age when it is loaded into memory", async () => {
  const live = { ...VENDORED, title: "live" };
  const calls = setup(() => new Response(JSON.stringify(live)));
  const file = join(
    process.env.AVOCADO_MCP_CACHE_DIR!,
    "schema",
    "avocado-config.json",
  );
  mkdirSync(join(process.env.AVOCADO_MCP_CACHE_DIR!, "schema"));
  // Fetched almost one hour ago: 100 ms of life left.
  writeFileSync(
    file,
    JSON.stringify({
      fetchedAt: Date.now() - 60 * 60 * 1000 + 100,
      schema: { ...VENDORED, title: "old" },
    }),
  );
  assert.equal((await loadSchema()).schema.title, "old");
  assert.equal(calls.length, 0);
  await new Promise((r) => setTimeout(r, 200));
  // Same process, no cache reset: the entry expired, so it fetches again.
  assert.equal((await loadSchema()).schema.title, "live");
  assert.equal(calls.length, 1);
});

test("the fallback is kept for five minutes, then the live schema is retried", async () => {
  const calls = setup(() => new Response("", { status: 503 }));
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    assert.match((await loadSchema()).source, /vendored/);
    assert.match((await loadSchema()).source, /vendored/);
    assert.equal(calls.length, 1, "a fresh fallback must not refetch");
    now += 5 * 60 * 1000 + 1;
    await loadSchema();
    assert.equal(calls.length, 2, "an expired fallback must fetch again");
  } finally {
    Date.now = realNow;
  }
});

test("AVOCADO_MCP_SCHEMA_OFFLINE=1 never touches the network", async () => {
  const calls = setup(() => {
    throw new Error("network");
  });
  process.env.AVOCADO_MCP_SCHEMA_OFFLINE = "1";
  assert.match((await loadSchema()).source, /vendored/);
  assert.deepEqual(calls, []);
});
