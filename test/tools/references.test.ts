import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { registerReferenceTools } from "../../src/tools/references.js";
import { searchReferencesScored } from "../../src/lib/references-client.js";

/** Frontmatter `targets:` per fixture reference; undefined means no key. */
const FIXTURE: Record<string, string[] | undefined> = {
  "py-new": ["jetson-orin-nano"],
  "py-old": ["jetson-orin-nano-devkit"],
  "py-generic": undefined,
  "py-pi": ["raspberrypi5"],
};

function readme(slug: string): string {
  const targets = FIXTURE[slug];
  const fm = targets
    ? `---\nlanguage: python\ntargets:\n${targets.map((t) => `  - ${t}`).join("\n")}\n---\n`
    : `---\nlanguage: python\n---\n`;
  return `${fm}# ${slug}\n\nA python starter for ${slug}. More text.\n`;
}

async function withReferencesFixture<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      const tree = Object.keys(FIXTURE).flatMap((slug) => [
        { path: `${slug}/README.md`, type: "blob" },
        { path: `${slug}/avocado.yaml`, type: "blob" },
      ]);
      return new Response(JSON.stringify({ tree }), { status: 200 });
    }
    const m = u.match(/\/([a-z0-9-]+)\/README\.md$/);
    if (m && m[1] in FIXTURE) {
      return new Response(readme(m[1]), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
  }
}

async function connect() {
  const server = new McpServer({ name: "avocado-os", version: "test" });
  registerReferenceTools(server);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

async function search(args: Record<string, unknown>): Promise<string[]> {
  const client = await connect();
  const res = await client.callTool({
    name: "search-references",
    arguments: args,
  });
  const sc = res.structuredContent as {
    references: { slug: string; compatibility?: string }[];
  };
  return sc.references.map((r) => r.slug).sort();
}

test("a target keeps listed, equivalent-slug and generic references", async () => {
  await withReferencesFixture(async () => {
    const slugs = await search({ query: "python", target: "jetson-orin-nano" });
    assert.deepEqual(slugs, ["py-generic", "py-new", "py-old"]);
  });
});

test("browse mode with a target filters the same way", async () => {
  await withReferencesFixture(async () => {
    const slugs = await search({ target: "jetson-orin-nano" });
    assert.deepEqual(slugs, ["py-generic", "py-new", "py-old"]);
  });
});

test("include_incompatible returns every reference with its label", async () => {
  await withReferencesFixture(async () => {
    const client = await connect();
    const res = await client.callTool({
      name: "search-references",
      arguments: {
        query: "python",
        target: "jetson-orin-nano",
        include_incompatible: true,
      },
    });
    const refs = (
      res.structuredContent as {
        references: { slug: string; compatibility?: string }[];
      }
    ).references;
    const labels = Object.fromEntries(
      refs.map((r) => [r.slug, r.compatibility]),
    );
    assert.deepEqual(labels, {
      "py-generic": "generic",
      "py-new": "listed",
      "py-old": "listed",
      "py-pi": "unlisted",
    });
  });
});

test("no target leaves results unfiltered", async () => {
  await withReferencesFixture(async () => {
    const slugs = await search({ query: "python" });
    assert.deepEqual(slugs, ["py-generic", "py-new", "py-old", "py-pi"]);
  });
});

test("project initialization still lists unlisted references with their label", async () => {
  await withReferencesFixture(async () => {
    const scored = await searchReferencesScored("python", "jetson-orin-nano");
    const bySlug = Object.fromEntries(
      scored.map((s) => [s.entry.slug, s.compatibility]),
    );
    assert.equal(bySlug["py-pi"], "unlisted");
    assert.equal(bySlug["py-new"], "listed");
    assert.equal(bySlug["py-generic"], "generic");
    assert.equal(scored.length, 4);
  });
});
