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
  console.log(`  ${names.length} tools:`, names.join(", "));

  const { resources } = await client.listResources();
  console.log(`  ${resources.length} resources`);
  const { prompts } = await client.listPrompts();
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
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: { yaml: "extensions:\n  app:\n    types: [sysext]\n" },
  });
  assert.equal(res.isError, undefined);
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
