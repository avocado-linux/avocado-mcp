import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { AddressInfo } from "node:net";
import {
  DEFAULT_FEED,
  NO_TARGET_REPOS,
  RepoClient,
  redactUrl,
  validateFeed,
  type ExtraFeed,
} from "../../src/lib/repo-client.js";

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
    () => new RepoClient().fetchRepoPackages(DEFAULT_FEED, "repo/aarch64"),
    /Untrusted primary href/,
  );
});

test("an invalid feed never becomes a URL — it degrades to null", async () => {
  // The safety property: an unsafe segment must never reach a fetched URL.
  // getTargetManifest enforces this by bailing to null (a structured "couldn't
  // fetch" for callers) rather than throwing — see validateFeed.
  const calls = stubFeed({ targets: {} });
  const rc = new RepoClient();
  for (const bad of ["../..", "edge/../../x", "a b", ""]) {
    const feed = { ...DEFAULT_FEED, releasever: bad, manifestPath: bad };
    assert.equal(
      await rc.getTargetManifest(feed),
      null,
      `unsafe releasever must degrade to null: ${JSON.stringify(bad)}`,
    );
  }
  for (const baseUrl of [
    "file:///etc",
    "https://x.test/?q=1",
    "not a url",
    "https://a.test/x\n    tls_verify: false",
    "https://ci:s3cr3t@mirror.test/avocado",
  ]) {
    assert.equal(
      await rc.getTargetManifest({ ...DEFAULT_FEED, baseUrl }),
      null,
      `unsafe repo URL must degrade to null: ${baseUrl}`,
    );
  }
  assert.equal(calls.length, 0, "no request may be made for an unsafe feed");
});

test("primary.xml parses into FeedPackages and skips non-rpm entries", async () => {
  stubFeed({ targets: { t: ["repo/aarch64"] }, primaryXml: PRIMARY });
  const pkgs = await new RepoClient().fetchRepoPackages(
    DEFAULT_FEED,
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
  await rc.fetchRepoPackages(DEFAULT_FEED, "repo/aarch64");
  const after = calls.length;
  await rc.fetchRepoPackages(DEFAULT_FEED, "repo/aarch64");
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

test("credentials never appear in feed errors or redacted URLs", () => {
  const baseUrl = "https://ci:s3cr3t@mirror.test/avocado";
  assert.equal(redactUrl(baseUrl), "https://***@mirror.test/avocado");
  assert.equal(redactUrl(DEFAULT_FEED.baseUrl), DEFAULT_FEED.baseUrl);
  assert.throws(
    () => validateFeed({ ...DEFAULT_FEED, baseUrl }),
    (e: Error) => !e.message.includes("s3cr3t"),
  );
});

test("redactUrl masks query values and the fragment, and keeps parameter names", () => {
  assert.equal(
    redactUrl("https://u:p@vendor.test/r?token=s3cr3t&x=1#frag"),
    "https://***@vendor.test/r?token=***&x=***#***",
  );
  assert.equal(
    redactUrl("https://vendor.test/r?s3cr3t"),
    "https://vendor.test/r?***",
  );
  assert.throws(
    () =>
      validateFeed({
        ...DEFAULT_FEED,
        baseUrl: "https://vendor.test/r?token=s3cr3t",
      }),
    (e: Error) =>
      /token=\*\*\*/.test(e.message) && !e.message.includes("s3cr3t"),
  );
});

test("extra feeds cache per credential, and the key holds no raw password", async () => {
  const calls = stubFeed({ primaryXml: PRIMARY });
  const client = new RepoClient();
  const feed = (password: string) => ({
    name: "vendor",
    priority: 20,
    url: "https://vendor.example/r",
    auth: { username: "robot", password },
  });
  await client.fetchExtraFeed(feed("one"));
  await client.fetchExtraFeed(feed("one"));
  assert.equal(calls.length, 2, "same credential reuses the cache");
  await client.fetchExtraFeed(feed("two"));
  assert.equal(calls.length, 4, "a different password fetches again");
  const keys = [
    ...(
      client as unknown as { packagesCache: Map<string, unknown> }
    ).packagesCache.keys(),
  ];
  assert.equal(keys.length, 2);
  assert.ok(keys.every((k) => !k.includes("one") && !k.includes("two")));
});

test("concurrent lookups share one targets.json and one primary.xml.gz download", async () => {
  const calls = stubFeed({
    targets: { t: ["repo/aarch64"] },
    primaryXml: PRIMARY,
  });
  const rc = new RepoClient();
  await Promise.all(
    ["curl", "libcurl", "zlib", "jq", "git"].map((q) =>
      rc.searchPackages(["t"], q),
    ),
  );
  assert.equal(calls.filter((u) => u.endsWith("targets.json")).length, 1);
  assert.equal(calls.filter((u) => u.endsWith(".xml.gz")).length, 1);
});

test("a failed fetch is not cached, so the next call retries", async () => {
  stubFeed({ status: 500 });
  const rc = new RepoClient();
  assert.equal(await rc.getTargetManifest(), null);
  await assert.rejects(() =>
    rc.fetchRepoPackages(DEFAULT_FEED, "repo/aarch64"),
  );
  stubFeed({ targets: { t: ["repo/aarch64"] }, primaryXml: PRIMARY });
  assert.deepEqual(Object.keys((await rc.getTargetManifest())!), ["t"]);
  assert.equal(
    (await rc.fetchRepoPackages(DEFAULT_FEED, "repo/aarch64")).length,
    2,
  );
});

test("an unreadable targets.json is not reported as a missing target", async () => {
  stubFeed({ status: 500 });
  const down = await new RepoClient().fetchTargetPackages("t");
  assert.equal(down.errors.length, 1);
  assert.ok(!down.errors[0]!.startsWith(NO_TARGET_REPOS), down.errors[0]);
  assert.match(down.errors[0]!, /Could not read targets\.json/);

  stubFeed({ targets: { other: ["repo/aarch64"] } });
  const absent = await new RepoClient().fetchTargetPackages("t");
  assert.equal(absent.errors.length, 1);
  assert.ok(absent.errors[0]!.startsWith(NO_TARGET_REPOS), absent.errors[0]);
});

test("skipExtRepo leaves out the target-ext repo, and only that repo", async () => {
  const targets = { t: ["sdk/all", "target/t", "target/t-ext"] };
  let calls = stubFeed({ targets, primaryXml: PRIMARY });
  await new RepoClient().fetchTargetPackages("t", {
    ...DEFAULT_FEED,
    skipExtRepo: true,
  });
  assert.ok(calls.some((u) => u.includes("/target/t/repodata/")));
  assert.ok(!calls.some((u) => u.includes("/target/t-ext/")));

  calls = stubFeed({ targets, primaryXml: PRIMARY });
  await new RepoClient().fetchTargetPackages("t");
  assert.ok(calls.some((u) => u.includes("/target/t-ext/repodata/")));
});

test("redactUrl masks userinfo that holds a / or a #", () => {
  assert.equal(redactUrl("https://user:ab/cd@host/r"), "https://***@host/r");
  assert.equal(redactUrl("https://user:ab#cd@host/r"), "https://***@host/r");
  // A query value with an @ is not userinfo.
  assert.equal(redactUrl("https://host/r?mail=a@b"), "https://host/r?mail=***");
});

// Self-signed, for the node:https path. Test fixture only.
const TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgDyZqN3UkoyexBnZc
OgJY9kLxpG6j8cDgxrUb85nxBfWhRANCAATV4e/D5I2jolNXrCfYy50BT7h8yjUU
D3CGHibyiZAb2ZEtqCIWDOuejtcX6+GsnR8Ohq9qWI/1trxUZjFk8i3m
-----END PRIVATE KEY-----
`;
const TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBgDCCASWgAwIBAgIUK9PnJpx37aMaVfOtwq7LC8td5SwwCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJbG9jYWxob3N0MCAXDTI2MTAwOTIwMjQxNloYDzIxMjYwOTE1
MjAyNDE2WjAUMRIwEAYDVQQDDAlsb2NhbGhvc3QwWTATBgcqhkjOPQIBBggqhkjO
PQMBBwNCAATV4e/D5I2jolNXrCfYy50BT7h8yjUUD3CGHibyiZAb2ZEtqCIWDOue
jtcX6+GsnR8Ohq9qWI/1trxUZjFk8i3mo1MwUTAdBgNVHQ4EFgQUvK8qrZ9a7Jzx
CW3yuZ7rvQkVIdswHwYDVR0jBBgwFoAUvK8qrZ9a7JzxCW3yuZ7rvQkVIdswDwYD
VR0TAQH/BAUwAwEB/zAKBggqhkjOPQQDAgNJADBGAiEA52T9bdCfXxEIXy2kmHF/
P4Gfawo5CUVa7X1V9R5FgWkCIQD491Wp8j8i06l7CoSxsmTt4GxoAaORbge3Izon
n7U6VQ==
-----END CERTIFICATE-----
`;

test("a feed that never finishes its body times out on the fetch and node:https paths, and is not cached", async () => {
  const repomd = `<repomd><data type="primary"><location href="repodata/p-primary.xml.gz"/></data></repomd>`;
  const hits: string[] = [];
  // Headers and part of the body, then the connection stays open.
  const hang = (req: IncomingMessage, res: ServerResponse) => {
    hits.push(req.url ?? "");
    if (req.url?.endsWith("repomd.xml")) return res.end(repomd);
    res.writeHead(200);
    res.write(gzipSync(PRIMARY).subarray(0, 10));
  };
  const plain = createServer(hang);
  const secure = createHttpsServer({ key: TEST_KEY, cert: TEST_CERT }, hang);
  await new Promise<void>((r) => plain.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => secure.listen(0, "127.0.0.1", r));
  const port = (s: { address(): unknown }) => (s.address() as AddressInfo).port;
  const client = new RepoClient(200);
  const viaFetch: ExtraFeed = {
    name: "plain",
    priority: 20,
    url: `http://127.0.0.1:${port(plain)}/r`,
  };
  const viaHttps: ExtraFeed = {
    name: "tls",
    priority: 30,
    url: `https://127.0.0.1:${port(secure)}/r`,
    tls: { insecure: true },
  };
  try {
    for (const feed of [viaFetch, viaHttps]) {
      await assert.rejects(
        () => client.fetchExtraFeed(feed),
        /did not finish within 0\.2 s/,
      );
    }
    const primaries = () => hits.filter((u) => u.endsWith(".xml.gz")).length;
    assert.equal(primaries(), 2);
    // The timed-out entries left the cache, so a retry fetches again.
    await assert.rejects(() => client.fetchExtraFeed(viaFetch));
    assert.equal(primaries(), 3);

    // One hung feed no longer keeps the whole lookup from settling.
    const r = await client.fetchTargetPackages("t", {
      ...DEFAULT_FEED,
      baseUrl: `http://127.0.0.1:${port(plain)}`,
      extraFeeds: [viaHttps],
    });
    assert.equal(r.errors.length, 2, r.errors.join("\n"));
    assert.match(r.errors[1]!, /^tls: .*did not finish within 0\.2 s/);
  } finally {
    plain.closeAllConnections();
    secure.closeAllConnections();
    plain.close();
    secure.close();
  }
});
