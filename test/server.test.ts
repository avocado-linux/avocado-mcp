import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { RepoClient } from "../src/lib/repo-client.js";
import { registerConfigTools } from "../src/tools/config.js";
import { registerPackageTools } from "../src/tools/packages.js";
import { registerDiscoveryTools } from "../src/tools/discovery.js";
import { registerReferenceTools } from "../src/tools/references.js";
import { registerProjectTools } from "../src/tools/project.js";
import { registerDiagnosticsTools } from "../src/tools/diagnostics.js";
import { registerDebuggingTools } from "../src/tools/debugging.js";
import { registerDocsTools } from "../src/tools/docs.js";
import { registerConnectTools } from "../src/tools/connect.js";
import { registerSkillResources } from "../src/tools/resources.js";
import { registerPrompts } from "../src/tools/prompts.js";

// Validate against the vendored schema: no network in tests.
process.env.AVOCADO_MCP_SCHEMA_OFFLINE = "1";

async function connect() {
  const server = new McpServer({ name: "avocado-os", version: "test" });
  const repoClient = new RepoClient();
  registerSkillResources(server);
  registerPrompts(server);
  registerDiscoveryTools(server, repoClient);
  registerReferenceTools(server);
  registerConfigTools(server);
  registerPackageTools(server, repoClient);
  registerProjectTools(server, repoClient);
  registerDiagnosticsTools(server, repoClient);
  registerDebuggingTools(server);
  registerDocsTools(server);
  registerConnectTools(server);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return { client, server };
}

test("every tool/resource/prompt registers without collision", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  // Exact counts, not floors: a `>=` below actual lets a small drop pass
  // silently. Bump these deliberately when adding a tool/resource/prompt —
  // the change is the point where you confirm the registration is intended.
  assert.equal(names.length, 26, `tool count changed: ${names.join(", ")}`);
  console.log(`  ${names.length} tools:`, names.join(", "));

  const { resources } = await client.listResources();
  assert.equal(resources.length, 17, "resource count changed");
  console.log(`  ${resources.length} resources`);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts.length, 8, "prompt count changed");
  console.log(
    `  ${prompts.length} prompts:`,
    prompts.map((p) => p.name).join(", "),
  );
});

test("tool contract: every tool has description + object schema", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(
      t.description && t.description.length > 30,
      `${t.name}: thin description`,
    );
    assert.equal(t.inputSchema.type, "object", `${t.name}: bad schema`);
  }
});

test("offline tool round-trips through the protocol", async () => {
  const { client } = await connect();
  // A schema-VALID fixture, so this exercises the happy path it's named for.
  // (A minimal extensions-only doc fails validation — the tool would report
  // errors, which isn't an isError, so the round-trip would pass vacuously.)
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: {
      yaml: "distro:\n  release: 2024\n  channel: edge\nruntimes:\n  dev:\n    extensions: [app]\nextensions:\n  app:\n    types: [sysext]\n",
    },
  });
  // Success may omit isError OR set it false, per the MCP spec — assert it's
  // simply not an error rather than coupling to one representation...
  assert.notEqual(res.isError, true);
  // ...and assert it actually reports success, not just "didn't error".
  const structured = res.structuredContent as { ok?: boolean } | undefined;
  assert.equal(structured?.ok, true, JSON.stringify(res.content));
  console.log("  ->", JSON.stringify(res.content).slice(0, 200));
});

test("bad arguments are rejected as isError, not coerced or crashed", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: { yaml: 42 },
  });
  assert.equal(res.isError, true, "wrong-typed arg should be an error result");
});

test("unknown tool name is an error result, not a hang", async () => {
  const { client } = await connect();
  const res = await client.callTool({ name: "no-such-tool", arguments: {} });
  assert.equal(res.isError, true);
});

test("a flag-like serial port is rejected by the tool's input schema", async () => {
  // The port pattern lives on the zod field, so the SDK rejects it before the
  // handler — the LLM is told the constraint rather than getting a bare throw.
  const { client } = await connect();
  const res = await client.callTool({
    name: "get-tmux-uart-snippet",
    arguments: { portPath: "-oProxyCommand=evil", target: "raspberrypi5" },
  });
  assert.equal(res.isError, true, "schema-invalid portPath must be an error");
  // Pin the SCHEMA constraint itself. The handler's assertSafePortPath throws
  // "is not a usable device path", which also contains "device path" — so match
  // the schema's UNIQUE phrasing ("must be a device path"). Deleting
  // `.regex(SAFE_PORT_RE)` would fall through to the handler message and fail.
  assert.match(
    JSON.stringify(res.content),
    /must be a device path/,
    JSON.stringify(res.content),
  );
});

test("init-project refuses feed args that would inject into avocado.yaml", async () => {
  const { client } = await connect();
  for (const args of [
    { release: "2026\n  repo:\n    url: https://evil.example" },
    { repoUrl: "https://a.example/x\n    tls_verify: false" },
    { repoUrl: "https://a.example/x\u0085tls_verify:\u0085" },
    { repoUrl: "https://ci:s3cr3t@mirror.example/avocado" },
  ]) {
    const res = await client.callTool({
      name: "init-project",
      arguments: { target: "qemux86-64", forceFromScratch: true, ...args },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /^# init-project failed/, JSON.stringify(args));
    assert.doesNotMatch(text, /```yaml|s3cr3t/, JSON.stringify(args));
  }
});

test("init-project refuses runtime, board and extension values that would inject", async () => {
  const { client } = await connect();
  for (const args of [
    { runtimeName: "dev; rm -rf ~" },
    { board: "a\nb" },
    { extraExtensions: ["ok", "x\u0085evil: 1"] },
  ]) {
    const res = await client.callTool({
      name: "init-project",
      arguments: { target: "qemux86-64", forceFromScratch: true, ...args },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /^# init-project failed/, JSON.stringify(args));
  }
});

test("init-project from scratch tells the model to run avocado init", async () => {
  // No network: the feed's target list is unavailable, so the target is not
  // checked, and the from-scratch path runs.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const { client } = await connect();
    const call = async (extra: Record<string, unknown>) => {
      const res = await client.callTool({
        name: "init-project",
        arguments: {
          target: "jetson-orin-nx",
          forceFromScratch: true,
          board: "mic-712-ox-16gb",
          ...extra,
        },
      });
      return (res.content as { text: string }[])[0].text;
    };

    const withCli = await call({});
    assert.match(withCli, /avocado init --target jetson-orin-nx <project-dir>/);
    assert.match(withCli, /default_target_board: mic-712-ox-16gb/);
    assert.doesNotMatch(withCli, /```yaml/);

    const noCli = await call({ cliAvailable: false });
    assert.doesNotMatch(noCli, /avocado init --target/);
    assert.match(noCli, /```yaml\n# yaml-language-server/);
    assert.match(noCli, /default_target_board: mic-712-ox-16gb/);
    assert.match(noCli, /validates against the schema/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("validate-yaml reports ignored keys as warnings, not errors", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: { yaml: "runtimes:\n  dev:\n    extentions: [app]\n" },
  });
  const s = res.structuredContent as { ok: boolean; warnings: string[] };
  assert.equal(s.ok, true);
  assert.deepEqual(s.warnings, [
    "unknown key 'runtimes.dev.extentions' is ignored; did you mean 'extensions'?",
  ]);
});
