import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { RepoClient } from "../../src/lib/repo-client.js";
import { registerPackageTools } from "../../src/tools/packages.js";
import { clearHardwareDataCache } from "../../src/lib/hardware-data.js";
import { clearSelectableCache } from "../../src/lib/hardware-support.js";
import { FEED_2026_NEXT, TARGETS, DEVICES } from "../lib/hardware-fixture.js";

const pkg = (name: string) => ({
  name,
  summary: "",
  description: "",
  version: "1",
  release: "r0",
  arch: "armv8a",
  repo: "target/armv8a",
  href: "",
  feed: "avocado",
});

// The 2026/edge manifest: `jetson-orin-nano` is a key, `-devkit` is not.
const MANIFEST = Object.fromEntries(
  FEED_2026_NEXT.map((t) => [t, ["target/armv8a"]]),
);

const asked: string[] = [];

class StubRepo extends RepoClient {
  override async getTargetsConfig() {
    return MANIFEST;
  }
  override async fetchTargetPackages(target: string) {
    asked.push(target);
    return {
      packages: [pkg("curl"), pkg("jq")],
      errors: [],
      notChecked: [],
    };
  }
}

async function connect() {
  const server = new McpServer({ name: "avocado-os", version: "test" });
  registerPackageTools(server, new StubRepo());
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return client;
}

async function withDocsFixture<T>(run: () => Promise<T>): Promise<T> {
  const realFetch = globalThis.fetch;
  clearHardwareDataCache();
  clearSelectableCache();
  asked.length = 0;
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const body = String(url).endsWith("targets.json")
      ? TARGETS
      : { devices: DEVICES };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = realFetch;
    clearHardwareDataCache();
    clearSelectableCache();
  }
}

async function check(target: string) {
  const client = await connect();
  const res = await client.callTool({
    name: "check-package-coverage",
    arguments: {
      target,
      release: "2026",
      channel: "edge",
      dependencies: [{ name: "curl", queries: ["curl"] }],
    },
  });
  return {
    res,
    text: (res.content as { text: string }[])[0].text,
    sc: res.structuredContent as {
      target: string;
      targetAvailable: boolean | null;
      summary: { present: number; total: number };
    },
  };
}

test("an alias resolves on 2026/edge", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await check("jetson-orin-nano-devkit");
    assert.notEqual(res.isError, true);
    assert.equal(sc.targetAvailable, true);
    assert.equal(sc.target, "jetson-orin-nano");
    assert.deepEqual(asked, ["jetson-orin-nano"]);
    assert.equal(sc.summary.present, 1);
    assert.match(text, /jetson-orin-nano-devkit/);
    assert.match(text, /`jetson-orin-nano`/);
  });
});

test("a slug the feed lists is used as given", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await check("jetson-orin-nano");
    assert.notEqual(res.isError, true);
    assert.equal(sc.target, "jetson-orin-nano");
    assert.deepEqual(asked, ["jetson-orin-nano"]);
    assert.doesNotMatch(text, /resolved|devkit/i);
  });
});

test("an unknown target is still unavailable with suggestions", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await check("jetson-orin-nan");
    assert.equal(res.isError, true);
    assert.equal(sc.targetAvailable, false);
    assert.deepEqual(asked, []);
    assert.match(text, /not available in the `2026\/edge` feed/);
    assert.match(text, /Did you mean: .*`jetson-orin-nano`/);
  });
});

test("a call with only target behaves as before", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await check("qemux86-64");
    assert.notEqual(res.isError, true);
    assert.deepEqual(Object.keys(sc).sort(), [
      "channel",
      "feed",
      "feedErrors",
      "notChecked",
      "release",
      "results",
      "summary",
      "target",
      "targetAvailable",
    ]);
    assert.equal(sc.target, "qemux86-64");
    assert.match(
      text,
      /^# check-package-coverage\n\n\*\*Target:\*\* `qemux86-64`\n/,
    );
  });
});
