import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { readFileSync } from "fs";
import { parse } from "yaml";

import { registerSkillResources } from "../src/tools/resources.js";
import { registerPrompts } from "../src/tools/prompts.js";

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
  assert.doesNotMatch(text, /It does not produce them/);
  assert.doesNotMatch(text, /kernel configuration change needs Yocto/);
});

test("package coverage names the SDK route before a recipe ticket", async () => {
  const text = await readResource("avocado://skills/package-coverage");
  const compile = text.indexOf("sdk compile");
  const pkg = text.indexOf("sdk package");
  const ext = text.indexOf("ext package");
  assert.ok(compile >= 0, "names sdk compile");
  assert.ok(pkg >= 0, "names sdk package");
  assert.ok(ext >= 0, "names avocado ext package");
  const recipe = text.search(
    /OpenEmbedded|Yocto recipe|feed request|feed-request/,
  );
  assert.ok(recipe >= 0, "still mentions the recipe or feed request route");
  const step = text.indexOf("Packaging signal");
  assert.ok(step >= 0, "has the packaging signal step");
  const stepText = text.slice(step);
  const firstRecipe = stepText.search(/OpenEmbedded|Yocto recipe|feed request/);
  for (const command of ["sdk compile", "sdk package", "ext package"]) {
    const at = stepText.indexOf(command);
    assert.ok(at >= 0, `the packaging step names ${command}`);
    assert.ok(at < firstRecipe, `${command} comes before the recipe route`);
  }
  assert.doesNotMatch(text, /jetson-orin-nano-devkit/);
  assert.match(text, /2024\/edge/);
});

test("package coverage describes candidates and near matches and no optimistic count", async () => {
  const text = await readResource("avocado://skills/package-coverage");
  assert.match(text, /nearMatches/);
  assert.match(text, /candidates/);
  assert.match(text, /not the requested package/);
  assert.doesNotMatch(text, /optimistic/i);
  assert.doesNotMatch(text, /\b(fuzzy|strong)\b/i);
});

test("application development names the SDK route before vendoring", async () => {
  const text = await readResource("avocado://skills/app-development");
  const vendor = text.search(/vendor/i);
  assert.ok(vendor >= 0, "still mentions vendoring");
  assert.ok(
    text.indexOf("sdk compile") >= 0 && text.indexOf("sdk compile") < vendor,
  );
  assert.ok(
    text.indexOf("sdk package") >= 0 && text.indexOf("sdk package") < vendor,
  );
  assert.ok(
    text.indexOf("ext package") >= 0 && text.indexOf("ext package") < vendor,
  );
});

test("feeds resource has the distro feeds list form and the overlay recipe", async () => {
  const text = await readResource("avocado://skills/feeds-and-lockfile");
  assert.match(text, /distro\.feeds: \[/);
  assert.match(text, /Using a locally built package/);
  assert.match(text, /sdk package/);
  // The recipe keeps the caveat that a local RPM replacing a distro-feed
  // package is unconfirmed, carries no test-run log or bakar mention, and
  // tells the reader to unlock after the local feed changes.
  assert.match(
    text,
    /replacing a package the distro feed also carries is not\s+confirmed/,
  );
  assert.doesNotMatch(text, /Confirmed with a local `path:` feed/);
  assert.doesNotMatch(text, /bakar/i);
  assert.match(text, /avocado unlock/);
  assert.doesNotMatch(text, /not yet verified/i);
});

test("the package-coverage prompt matches the exact-only tool and names no old tiers", async () => {
  const server = new McpServer({ name: "avocado-os", version: "test" });
  registerPrompts(server);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  try {
    const res = await client.getPrompt({
      name: "package-coverage",
      arguments: {},
    });
    const text = (res.messages[0].content as { text: string }).text;
    assert.match(text, /check-package-coverage/);
    assert.doesNotMatch(text, /\b(fuzzy|strong)\b/i);
  } finally {
    await client.close();
  }
});

test("config yaml guide shows the vendored CLI template", async () => {
  // The guide says its block is what `avocado init` writes. `npm run
  // sync-schema` updates only the vendored file, so this test fails when
  // a sync changes the template and the guide still shows the old values.
  const text = await readResource("avocado://skills/config-yaml-guide");
  const block = text.match(
    /## The default template\n[\s\S]*?```yaml\n([\s\S]*?)```/,
  );
  assert.ok(block, "the guide has a yaml block under The default template");
  const template = readFileSync(
    new URL("../src/lib/schema/default.yaml", import.meta.url),
    "utf8",
  );
  assert.deepEqual(
    parse(block[1].replaceAll("<target>", "{target}")),
    parse(template),
  );
});
