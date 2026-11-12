import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerSkillResources } from "../src/tools/resources.js";

// Reads a skill resource's text through an in-memory server, the way a model
// client does. Later guidance tests append to this file and reuse the helper.
async function readResource(uri: string): Promise<string> {
  const server = new McpServer({ name: "avocado-os", version: "test" });
  registerSkillResources(server);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  try {
    const { contents } = await client.readResource({ uri });
    return contents
      .map((item) => ("text" in item ? String(item.text) : ""))
      .join("\n");
  } finally {
    await client.close();
  }
}

test("upstream sources does not mark kernel configuration as requiring Yocto", async () => {
  const text = await readResource("avocado://skills/upstream-sources");
  const row = text
    .split("\n")
    .find((line) => line.startsWith("| Kernel configuration"));
  assert.ok(row, "kernel configuration row is present");
  assert.doesNotMatch(row, /\*\*Yes\*\*/);
  assert.match(row, /\| No \|/);
  assert.match(text, /kernel\.compile/);
  assert.doesNotMatch(text, /jetson-orin-nano-devkit/);
});
