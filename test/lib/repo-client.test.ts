import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { RepoClient } from "../../src/lib/repo-client.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Minimal fake of the three-hop repo protocol: targets.json → repomd → primary.xml.gz */
function stubFeed(opts: {
  targets?: unknown;
  repomd?: string;
  primaryXml?: string;
  status?: number;
}) {
  const calls: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const status = opts.status ?? 200;
    const body = (payload: BodyInit) =>
      new Response(payload, { status, statusText: "OK" });

    if (url.endsWith("targets.json"))
      return body(JSON.stringify(opts.targets ?? {}));
    if (url.endsWith("repomd.xml"))
      return body(
        opts.repomd ??
          `<repomd><data type="primary"><location href="repodata/primary.xml.gz"/></data></repomd>`,
      );
    if (url.endsWith(".xml.gz"))
      return body(gzipSync(Buffer.from(opts.primaryXml ?? "<metadata/>")));
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

const PRIMARY = `<metadata>
  <package type="rpm">
    <name>curl</name><arch>aarch64</arch>
    <version epoch="0" ver="8.5.0" rel="r0"/>
    <summary>Command line tool for transferring data</summary>
    <description>curl &amp; friends</description>
    <location href="curl-8.5.0-r0.aarch64.rpm"/>
  </package>
  <package type="rpm">
    <name>libcurl</name><arch>aarch64</arch>
    <version epoch="0" ver="8.5.0" rel="r0"/>
    <summary>Shared library for curl</summary>
    <description/>
    <location href="libcurl-8.5.0-r0.aarch64.rpm"/>
  </package>
  <package type="srpm"><name>should-be-ignored</name></package>
</metadata>`;

test("targets.json entries that fail the safety regex are dropped", async () => {
  stubFeed({
    targets: {
      raspberrypi5: ["repo/aarch64", "repo/noarch"],
      "../evil": ["repo/aarch64"], // path traversal in key
      "bad-paths": ["../../etc/passwd"], // traversal in value
      "http-url": ["https://evil.test/x"], // absolute URL
      "empty-after-filter": ["!!!"],
      "not-an-array": "repo/aarch64",
    },
  });
  const manifest = await new RepoClient().getTargetManifest();
  assert.deepEqual(Object.keys(manifest!), ["raspberrypi5"]);
});

test("a malicious primary href in repomd.xml is refused", async () => {
  stubFeed({
    targets: { t: ["repo/aarch64"] },
    repomd: `<repomd><data type="primary"><location href="../../../etc/shadow"/></data></repomd>`,
  });
  await assert.rejects(
    () => new RepoClient().fetchRepoPackages("2024", "edge", "repo/aarch64"),
    /Untrusted primary href/,
  );
});

test("an invalid release/channel never becomes a URL segment — it degrades to null", async () => {
  // The safety property: an unsafe segment must never reach a fetched URL.
  // getTargetManifest enforces this by bailing to null (a structured "couldn't
  // fetch" for callers) rather than throwing — see normalizeStream + the
  // isSafeSegment guard.
  stubFeed({ targets: {} });
  const rc = new RepoClient();
  for (const bad of ["../..", "edge/../../x", "a b", ""]) {
    assert.equal(
      await rc.getTargetManifest(bad),
      null,
      `unsafe segment must degrade to null: ${JSON.stringify(bad)}`,
    );
  }
});

test("primary.xml parses into FeedPackages and skips non-rpm entries", async () => {
  stubFeed({ targets: { t: ["repo/aarch64"] }, primaryXml: PRIMARY });
  const pkgs = await new RepoClient().fetchRepoPackages(
    "2024",
    "edge",
    "repo/aarch64",
  );
  assert.deepEqual(
    pkgs.map((p) => p.name),
    ["curl", "libcurl"],
  );
  const curl = pkgs[0]!;
  assert.equal(curl.version, "8.5.0");
  assert.equal(curl.release, "r0");
  assert.equal(curl.arch, "aarch64");
  assert.equal(
    curl.description,
    "curl & friends",
    "XML entities must be unescaped",
  );
});

test("in-memory cache means a second call makes no network requests", async () => {
  const calls = stubFeed({
    targets: { t: ["repo/aarch64"] },
    primaryXml: PRIMARY,
  });
  const rc = new RepoClient();
  await rc.fetchRepoPackages("2024", "edge", "repo/aarch64");
  const after = calls.length;
  await rc.fetchRepoPackages("2024", "edge", "repo/aarch64");
  assert.equal(calls.length, after, "second call should be served from cache");
});

test("search ranks exact > prefix > substring > summary-only", async () => {
  stubFeed({ targets: { t: ["repo/aarch64"] }, primaryXml: PRIMARY });
  const rc = new RepoClient();
  const { results } = await rc.searchPackages(["t"], "curl");
  assert.deepEqual(
    results.map((r) => r.name),
    ["curl", "libcurl"],
  );
  assert.ok(results[0]!.score > results[1]!.score);
});

test("summary-only hits are included, description-only hits are not", async () => {
  stubFeed({ targets: { t: ["repo/aarch64"] }, primaryXml: PRIMARY });
  const rc = new RepoClient();
  assert.equal(
    (await rc.searchPackages(["t"], "transferring")).totalMatches,
    1,
  );
  assert.equal(
    (await new RepoClient().searchPackages(["t"], "friends")).totalMatches,
    0,
    "description text must not leak into search results",
  );
});

test("a dead feed degrades to null, not an unhandled rejection", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  assert.equal(await new RepoClient().getTargetManifest(), null);
});

test("HTTP 500 on targets.json degrades to null", async () => {
  stubFeed({ status: 500 });
  assert.equal(await new RepoClient().getTargetManifest(), null);
});
