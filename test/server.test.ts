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
  // Lower bound too: uniqueness alone (0 === 0) would still pass if a
  // registration regression dropped every tool — the failure this test names.
  assert.ok(names.length >= 24, `only ${names.length} tools registered`);
  console.log(`  ${names.length} tools:`, names.join(", "));

  const { resources } = await client.listResources();
  assert.ok(
    resources.length >= 14,
    `only ${resources.length} resources registered`,
  );
  console.log(`  ${resources.length} resources`);
  const { prompts } = await client.listPrompts();
  assert.ok(prompts.length >= 7, `only ${prompts.length} prompts registered`);
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
