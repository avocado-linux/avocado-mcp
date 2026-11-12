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

const pkg = (name: string, summary = "") => ({
  name,
  summary,
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
let feedPackages = [pkg("curl"), pkg("jq")];
let feedNotChecked: { feed: string; reason: string }[] = [];

class StubRepo extends RepoClient {
  override async getTargetsConfig() {
    return MANIFEST;
  }
  override async fetchTargetPackages(target: string) {
    asked.push(target);
    return {
      packages: feedPackages,
      errors: [],
      notChecked: feedNotChecked,
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
  feedPackages = [pkg("curl"), pkg("jq")];
  feedNotChecked = [];
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

interface Section {
  target: string;
  targetAvailable: boolean | null;
  summary: { present: number; total: number };
  results: unknown[];
  feedErrors: string[];
  notChecked: unknown[];
}

async function callWith(extra: Record<string, unknown>) {
  const client = await connect();
  const res = await client.callTool({
    name: "check-package-coverage",
    arguments: {
      release: "2026",
      channel: "edge",
      dependencies: [{ name: "curl", queries: ["curl"] }],
      ...extra,
    },
  });
  return {
    res,
    text: (res.content as { text: string }[])[0].text,
    sc: res.structuredContent as {
      release: string;
      channel: string;
      feed: unknown;
      targets: Section[];
    },
  };
}

test("two targets give one section per target in the order given", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await callWith({
      targets: ["qemux86-64", "jetson-orin-nano"],
    });
    assert.notEqual(res.isError, true);
    assert.deepEqual(
      sc.targets.map((t) => t.target),
      ["qemux86-64", "jetson-orin-nano"],
    );
    assert.deepEqual(asked, ["qemux86-64", "jetson-orin-nano"]);
    assert.equal(sc.release, "2026");
    assert.equal(sc.channel, "edge");
    assert.ok(sc.feed);
    for (const t of sc.targets) {
      assert.deepEqual(Object.keys(t).sort(), [
        "feedErrors",
        "notChecked",
        "results",
        "summary",
        "target",
        "targetAvailable",
      ]);
      assert.equal(t.summary.present, 1);
    }
    assert.ok(
      text.indexOf("`qemux86-64`") < text.indexOf("`jetson-orin-nano`"),
    );
  });
});

test("one unavailable target does not stop the others", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await callWith({
      targets: ["no-such-board", "qemux86-64"],
    });
    assert.notEqual(res.isError, true);
    assert.equal(sc.targets.length, 2);
    assert.equal(sc.targets[0].target, "no-such-board");
    assert.equal(sc.targets[0].targetAvailable, false);
    assert.equal(sc.targets[1].targetAvailable, true);
    assert.equal(sc.targets[1].summary.present, 1);
    assert.deepEqual(asked, ["qemux86-64"]);
    assert.match(text, /not available in the `2026\/edge` feed/);
  });
});

test("both target and targets are rejected", async () => {
  await withDocsFixture(async () => {
    const { res, text } = await callWith({
      target: "qemux86-64",
      targets: ["qemux86-64"],
    });
    assert.equal(res.isError, true);
    assert.match(text, /pass exactly one of target or targets/);
    assert.deepEqual(asked, []);
  });
});

test("neither target nor targets is rejected", async () => {
  await withDocsFixture(async () => {
    const { res, text } = await callWith({});
    assert.equal(res.isError, true);
    assert.match(text, /pass exactly one of target or targets/);
  });
});

test("an empty targets list is rejected", async () => {
  await withDocsFixture(async () => {
    const { res, text } = await callWith({ targets: [] });
    assert.equal(res.isError, true);
    assert.match(text, /pass exactly one of target or targets/);
  });
});

test("an empty targets list next to target runs the single-target form", async () => {
  await withDocsFixture(async () => {
    const { res } = await callWith({ target: "qemuarm64", targets: [] });
    assert.notEqual(res.isError, true);
  });
});
test("two entries that resolve to the same slug are evaluated once", async () => {
  await withDocsFixture(async () => {
    const { res, text, sc } = await callWith({
      targets: ["jetson-orin-nano-devkit", "qemux86-64", "jetson-orin-nano"],
    });
    assert.notEqual(res.isError, true);
    assert.deepEqual(
      sc.targets.map((t) => t.target),
      ["jetson-orin-nano", "qemux86-64"],
    );
    assert.deepEqual(asked, ["jetson-orin-nano", "qemux86-64"]);
    assert.match(text, /duplicate.*merged/i);
  });
});

test("isError is true only when no target could be evaluated", async () => {
  await withDocsFixture(async () => {
    const none = await callWith({ targets: ["no-such-board", "other-gone"] });
    assert.equal(none.res.isError, true);
    assert.equal(none.sc.targets.length, 2);
    assert.ok(none.sc.targets.every((t) => t.targetAvailable === false));

    const some = await callWith({ targets: ["no-such-board", "qemux86-64"] });
    assert.notEqual(some.res.isError, true);
  });
});

interface Row {
  name: string;
  status: "present" | "missing" | "not-checked";
  confidence: "exact" | null;
  match: { name: string } | null;
  matchedQuery: string | null;
  alternatives: string[];
  nearMatches: string[];
  candidates: string[];
}

interface Summary {
  total: number;
  present: number;
  missing: number;
  notChecked: number;
  coveragePercent: number;
  exact: number;
  candidates: number;
}

async function coverage(
  packages: ReturnType<typeof pkg>[],
  dependencies: { name: string; queries: string[] }[],
  extra: Record<string, unknown> = {},
) {
  feedPackages = packages;
  const { res, text, sc } = await callWith({
    target: "qemux86-64",
    dependencies,
    ...extra,
  });
  const section = sc as unknown as {
    summary: Summary;
    results: Row[];
  };
  return { res, text, summary: section.summary, results: section.results };
}

test("an exact name is covered", async () => {
  await withDocsFixture(async () => {
    const { summary, results, text } = await coverage(
      [pkg("openssl"), pkg("openssl-dev")],
      [{ name: "libssl-dev", queries: ["openssl"] }],
    );
    assert.equal(results[0].status, "present");
    assert.equal(results[0].confidence, "exact");
    assert.equal(results[0].match?.name, "openssl");
    assert.equal(results[0].matchedQuery, "openssl");
    assert.deepEqual(results[0].nearMatches, []);
    assert.deepEqual(results[0].candidates, ["openssl-dev"]);
    assert.equal(summary.present, 1);
    assert.equal(summary.exact, 1);
    assert.equal(summary.coveragePercent, 100);
    assert.match(text, /candidate, not the requested package/);
  });
});

test("any one of several queries can match exactly", async () => {
  await withDocsFixture(async () => {
    const { results } = await coverage(
      [pkg("paho-mqtt"), pkg("python3-paho-mqtt")],
      [
        {
          name: "paho-mqtt",
          queries: ["libpaho", "python3-paho-mqtt", "paho"],
        },
      ],
    );
    assert.equal(results[0].status, "present");
    assert.equal(results[0].match?.name, "python3-paho-mqtt");
    assert.equal(results[0].matchedQuery, "python3-paho-mqtt");
  });
});

test("a one-edit typo is missing and listed as a near match", async () => {
  await withDocsFixture(async () => {
    const { summary, results, text } = await coverage(
      [pkg("curl")],
      [{ name: "curl", queries: ["curll"] }],
    );
    assert.equal(results[0].status, "missing");
    assert.equal(results[0].match, null);
    assert.equal(results[0].confidence, null);
    assert.equal(results[0].matchedQuery, null);
    assert.deepEqual(results[0].nearMatches, ["curl"]);
    assert.deepEqual(results[0].alternatives, ["curl"]);
    assert.equal(summary.present, 0);
    assert.equal(summary.missing, 1);
    assert.equal(summary.candidates, 1);
    assert.match(text, /near match, not the requested package/);
  });
});

test("a name equal only ignoring case is missing and listed as a near match", async () => {
  await withDocsFixture(async () => {
    const { results } = await coverage(
      [pkg("openssl")],
      [{ name: "openssl", queries: ["OpenSSL"] }],
    );
    assert.equal(results[0].status, "missing");
    assert.deepEqual(results[0].nearMatches, ["openssl"]);
    assert.deepEqual(results[0].candidates, []);
    assert.deepEqual(results[0].alternatives, ["openssl"]);
  });
});

test("a summary-only hit is missing and listed as a candidate", async () => {
  await withDocsFixture(async () => {
    const { summary, results } = await coverage(
      [pkg("paho-client", "an mqtt client library")],
      [
        { name: "mqtt", queries: ["mqttlib"] },
        { name: "m", queries: ["mqtt"] },
      ],
    );
    assert.equal(results[0].status, "missing");
    assert.deepEqual(results[0].candidates, []);
    assert.equal(results[1].status, "missing");
    assert.equal(results[1].match, null);
    assert.deepEqual(results[1].nearMatches, []);
    assert.deepEqual(results[1].candidates, ["paho-client"]);
    assert.equal(summary.candidates, 1);
  });
});

test("a substring-only hit is missing and listed as a candidate", async () => {
  await withDocsFixture(async () => {
    const { results } = await coverage(
      [pkg("libpaho-mqtt3c"), pkg("python3-paho-mqtt")],
      [{ name: "paho-mqtt", queries: ["paho-mqtt"] }],
    );
    assert.equal(results[0].status, "missing");
    assert.equal(results[0].match, null);
    assert.deepEqual(results[0].nearMatches, []);
    assert.deepEqual(results[0].candidates, [
      "libpaho-mqtt3c",
      "python3-paho-mqtt",
    ]);
  });
});

test("nothing close is missing with no lists", async () => {
  await withDocsFixture(async () => {
    const { summary, results } = await coverage(
      [pkg("curl")],
      [{ name: "zstd", queries: ["zstd"] }],
    );
    assert.equal(results[0].status, "missing");
    assert.deepEqual(results[0].alternatives, []);
    assert.deepEqual(results[0].nearMatches, []);
    assert.deepEqual(results[0].candidates, []);
    assert.equal(summary.candidates, 0);
  });
});

test("an unread feed leaves the dependency not-checked", async () => {
  await withDocsFixture(async () => {
    feedNotChecked = [{ feed: "org:private", reason: "private" }];
    const { summary, results } = await coverage(
      [pkg("curl")],
      [{ name: "zstd", queries: ["zstd"] }],
    );
    assert.equal(results[0].status, "not-checked");
    assert.equal(summary.notChecked, 1);
    assert.equal(summary.present, 0);
  });
});

test("coverage percentage counts exact matches only", async () => {
  await withDocsFixture(async () => {
    const { summary } = await coverage(
      [pkg("curl"), pkg("jq"), pkg("openssl")],
      [
        { name: "curl", queries: ["curl"] },
        { name: "jq", queries: ["jqq"] },
        { name: "ssl", queries: ["ssl"] },
        { name: "zstd", queries: ["zstd"] },
      ],
    );
    assert.equal(summary.total, 4);
    assert.equal(summary.present, 1);
    assert.equal(summary.exact, 1);
    assert.equal(summary.missing, 3);
    assert.equal(summary.coveragePercent, 25);
    assert.equal(summary.candidates, 2);
  });
});

test("near matches come before candidates and are cut to maxAlternatives", async () => {
  await withDocsFixture(async () => {
    const packages = [
      pkg("libzlib1"),
      pkg("libzlib2"),
      pkg("libzlib3"),
      pkg("zlibb"),
      pkg("zlibs"),
    ];
    const all = await coverage(packages, [{ name: "z", queries: ["zlib"] }], {
      maxAlternatives: 10,
    });
    assert.deepEqual(all.results[0].nearMatches, ["zlibb", "zlibs"]);
    assert.deepEqual(all.results[0].candidates, [
      "libzlib1",
      "libzlib2",
      "libzlib3",
    ]);
    assert.deepEqual(all.results[0].alternatives, [
      "zlibb",
      "zlibs",
      "libzlib1",
      "libzlib2",
      "libzlib3",
    ]);
    const cut = await coverage(packages, [{ name: "z", queries: ["zlib"] }], {
      maxAlternatives: 3,
    });
    assert.deepEqual(cut.results[0].alternatives, [
      "zlibb",
      "zlibs",
      "libzlib1",
    ]);
    assert.deepEqual(cut.results[0].nearMatches, ["zlibb", "zlibs"]);
    assert.deepEqual(cut.results[0].candidates, ["libzlib1"]);
    const one = await coverage(packages, [{ name: "z", queries: ["zlib"] }], {
      maxAlternatives: 1,
    });
    assert.deepEqual(one.results[0].alternatives, ["zlibb"]);
    assert.deepEqual(one.results[0].candidates, []);
  });
});

test("a query with surrounding whitespace still matches exactly", async () => {
  await withDocsFixture(async () => {
    const { results } = await coverage(
      [pkg("openssl")],
      [{ name: "libssl-dev", queries: ["openssl "] }],
    );
    assert.equal(results[0].status, "present");
    assert.equal(results[0].match?.name, "openssl");
    assert.equal(results[0].matchedQuery, "openssl");
  });
});

test("a name that equals a later query exactly is not listed as a near match", async () => {
  await withDocsFixture(async () => {
    const { results } = await coverage(
      [pkg("openssl"), pkg("openssl3")],
      [{ name: "libssl-dev", queries: ["openssl", "openssl3"] }],
    );
    assert.equal(results[0].match?.name, "openssl");
    assert.deepEqual(results[0].nearMatches, []);
  });
});

test("search-packages output for the same query is unchanged", async () => {
  await withDocsFixture(async () => {
    feedPackages = [pkg("openssl"), pkg("openssl-dev"), pkg("libssl")];
    const client = await connect();
    const res = await client.callTool({
      name: "search-packages",
      arguments: {
        query: "OpenSSL",
        targets: ["qemux86-64"],
        release: "2026",
        channel: "edge",
      },
    });
    const text = (res.content as { text: string }[])
      .map((c) => c.text)
      .join("\n");
    assert.match(text, /\*\*Total matches:\*\* 2/);
    assert.match(text, /openssl-dev/);
    assert.doesNotMatch(text, /near match|candidate|not the requested/);
  });
});
