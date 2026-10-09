import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createServer } from "http";
import { gzipSync } from "zlib";
import type { AddressInfo } from "net";
import { parse } from "yaml";
import { FeedContext, resolveFeed } from "../../src/lib/feed-config.js";
import { RepoClient, validateFeed } from "../../src/lib/repo-client.js";

const cfg = (y: string) => parse(y);

test("defaults to repo.avocadolinux.org 2024/edge with no project", () => {
  const f = resolveFeed({ env: {} });
  assert.equal(f.baseUrl, "https://repo.avocadolinux.org");
  assert.equal(f.releasever, "2024/edge");
  assert.equal(f.manifestPath, "2024/edge");
  assert.equal(f.sources.repoUrl, "default");
  assert.deepEqual(f.notes, []);
});

test("reads distro.release (int) and channel from avocado.yaml", () => {
  const f = resolveFeed({
    env: {},
    config: cfg("distro:\n  release: 2026\n  channel: apollo\n"),
  });
  assert.equal(f.releasever, "2026/apollo");
  assert.equal(f.release, "2026");
  assert.equal(f.sources.release, "avocado.yaml distro.release");
  assert.equal(f.sources.channel, "avocado.yaml distro.channel");
});

test("distro.version is an alias for distro.release", () => {
  const f = resolveFeed({
    env: {},
    config: cfg("distro:\n  version: 2025\n  channel: edge\n"),
  });
  assert.equal(f.releasever, "2025/edge");
  assert.equal(f.sources.release, "avocado.yaml distro.version");
});

test("env beats yaml for release/channel and repo URL", () => {
  const f = resolveFeed({
    env: {
      AVOCADO_DISTRO_RELEASE: "2027",
      AVOCADO_DISTRO_CHANNEL: "nightly",
      AVOCADO_REPO_URL: "https://mirror.example.com/",
    },
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\n  repo:\n    url: https://yaml.example.com\n",
    ),
  });
  assert.equal(f.baseUrl, "https://mirror.example.com");
  assert.equal(f.releasever, "2027/nightly");
  assert.equal(f.sources.repoUrl, "env AVOCADO_REPO_URL");
});

test("repo URL precedence: AVOCADO_SDK_REPO_URL > distro.repo.url > sdk.repo_url", () => {
  const y = cfg(
    "distro:\n  release: 2024\n  channel: edge\n  repo:\n    url: https://distro.example.com\nsdk:\n  repo_url: https://sdk.example.com\n",
  );
  assert.equal(
    resolveFeed({
      env: { AVOCADO_SDK_REPO_URL: "https://legacy.example.com" },
      config: y,
    }).baseUrl,
    "https://legacy.example.com",
  );
  assert.equal(
    resolveFeed({ env: {}, config: y }).baseUrl,
    "https://distro.example.com",
  );
  assert.equal(
    resolveFeed({
      env: {},
      config: cfg("sdk:\n  repo_url: https://sdk.example.com\n"),
    }).baseUrl,
    "https://sdk.example.com",
  );
});

test("releasever precedence: env > distro.repo.releasever > sdk.repo_release > derived", () => {
  const y = cfg(
    "distro:\n  release: 2024\n  channel: edge\n  repo:\n    releasever: 2026/apollo\nsdk:\n  repo_release: 2025/edge\n",
  );
  assert.equal(
    resolveFeed({ env: { AVOCADO_RELEASEVER: "2030/x" }, config: y })
      .releasever,
    "2030/x",
  );
  assert.equal(
    resolveFeed({ env: { AVOCADO_SDK_REPO_RELEASE: "2031/y" }, config: y })
      .releasever,
    "2031/y",
  );
  const r = resolveFeed({ env: {}, config: y });
  assert.equal(r.releasever, "2026/apollo");
  assert.equal(r.channel, "apollo");
  assert.equal(
    resolveFeed({
      env: {},
      config: cfg(
        "distro:\n  release: 2024\n  channel: edge\nsdk:\n  repo_release: 2025/edge\n",
      ),
    }).releasever,
    "2025/edge",
  );
});

test("explicit tool arguments beat env and config", () => {
  const f = resolveFeed({
    env: { AVOCADO_DISTRO_CHANNEL: "edge", AVOCADO_RELEASEVER: "2024/edge" },
    config: cfg("distro:\n  release: 2026\n  channel: edge\n"),
    overrides: { channel: "apollo" },
  });
  assert.equal(f.releasever, "2026/apollo");
  assert.equal(f.sources.channel, "tool argument `channel`");
});

test("missing channel falls back to default with a note (CLI defers to SDK image)", () => {
  const f = resolveFeed({ env: {}, config: cfg("distro:\n  release: 2026\n") });
  assert.equal(f.releasever, "2026/edge");
  assert.equal(f.notes.length, 1);
  assert.match(f.notes[0], /distro\.channel/);
});

test("interpolates env and config templates; flags unknown ones", () => {
  const f = resolveFeed({
    env: { FEED_HOST: "https://t.example.com" },
    config: cfg(
      'vars:\n  ch: apollo\ndistro:\n  release: 2026\n  channel: "{{ config.vars.ch }}"\n  repo:\n    url: "{{ env.FEED_HOST }}"\n',
    ),
  });
  assert.equal(f.baseUrl, "https://t.example.com");
  assert.equal(f.releasever, "2026/apollo");

  const g = resolveFeed({
    env: {},
    config: cfg(
      'distro:\n  release: 2026\n  channel: "{{ avocado.target }}"\n',
    ),
  });
  assert.ok(g.notes.some((n) => n.includes("avocado.target")));
});

test("lock-file snapshot pin rewrites releasever for that target only", () => {
  const config = cfg("distro:\n  release: 2026\n  channel: edge\n");
  const lock = {
    targets: {
      qemuarm64: {
        "repo-snapshot": {
          release: "2026",
          channel: "edge",
          snapshot: "20260901T000000Z",
        },
      },
    },
  };
  const pinned = resolveFeed({ env: {}, config, lock, target: "qemuarm64" });
  assert.equal(pinned.releasever, "2026/edge/snapshots/20260901T000000Z");
  assert.equal(pinned.manifestPath, "2026/edge");
  assert.equal(pinned.snapshot, "20260901T000000Z");
  const other = resolveFeed({ env: {}, config, lock, target: "raspberrypi5" });
  assert.equal(other.releasever, "2026/edge");
});

test("stale snapshot pin (different channel) is ignored with a note", () => {
  const f = resolveFeed({
    env: {},
    config: cfg("distro:\n  release: 2026\n  channel: apollo\n"),
    lock: {
      targets: {
        t: {
          "repo-snapshot": { release: "2026", channel: "edge", snapshot: "s1" },
        },
      },
    },
    target: "t",
  });
  assert.equal(f.releasever, "2026/apollo");
  assert.ok(f.notes.some((n) => n.includes("avocado update")));
});

test("explicit releasever disables snapshot pinning (CLI: user owns resolution)", () => {
  const f = resolveFeed({
    env: {},
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\n  repo:\n    releasever: 2026/edge\n",
    ),
    lock: {
      targets: {
        t: {
          "repo-snapshot": { release: "2026", channel: "edge", snapshot: "s1" },
        },
      },
    },
    target: "t",
  });
  assert.equal(f.releasever, "2026/edge");
});

test("repos: release/channel on the distro feed still takes the snapshot pin", () => {
  const lock = {
    targets: {
      t: {
        "repo-snapshot": { release: "2026", channel: "edge", snapshot: "s1" },
      },
    },
  };
  const derived = resolveFeed({
    env: {},
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\nrepos:\n  avocado:\n    url: https://m.example.com\n    release: 2026\n    channel: edge\n",
    ),
    lock,
    target: "t",
  });
  assert.equal(derived.releasever, "2026/edge/snapshots/s1");
  assert.equal(derived.snapshot, "s1");

  const explicit = resolveFeed({
    env: {},
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\nrepos:\n  avocado:\n    url: https://m.example.com\n    releasever: 2026/edge\n",
    ),
    lock,
    target: "t",
  });
  assert.equal(explicit.releasever, "2026/edge");
  assert.equal(explicit.snapshot, undefined);
});

test("TLS: AVOCADO_REPO_CA / AVOCADO_REPO_INSECURE / tls_verify", () => {
  const y = cfg(
    "distro:\n  release: 2024\n  channel: edge\n  repo:\n    ca: certs/ca.pem\n    tls_verify: false\n",
  );
  const f = resolveFeed({ env: {}, config: y, baseDir: "/proj" });
  assert.equal(f.tls?.ca, "/proj/certs/ca.pem");
  assert.equal(f.tls?.insecure, true);
  const g = resolveFeed({
    env: { AVOCADO_REPO_INSECURE: "0", AVOCADO_REPO_CA: "/x.pem" },
    config: y,
  });
  assert.equal(g.tls?.ca, "/x.pem");
  assert.equal(g.tls?.insecure, false);
});

test("FeedContext loads avocado.yaml + src_dir lock file from a project dir", () => {
  const dir = mkdtempSync(join(tmpdir(), "feedctx-"));
  writeFileSync(
    join(dir, "avocado.yaml"),
    "src_dir: src\ndistro:\n  release: 2026\n  channel: edge\n",
  );
  mkdirSync(join(dir, "src", ".avocado"), { recursive: true });
  writeFileSync(
    join(dir, "src", ".avocado", "lock.json"),
    JSON.stringify({
      version: 7,
      targets: {
        qemux86_64: {
          "repo-snapshot": {
            release: "2026",
            channel: "edge",
            snapshot: "abc",
          },
        },
      },
    }),
  );
  const ctx = FeedContext.load({ projectDir: dir, env: {} });
  assert.equal(ctx.base.releasever, "2026/edge");
  assert.equal(
    ctx.forTarget("qemux86_64").releasever,
    "2026/edge/snapshots/abc",
  );
  assert.equal(
    ctx.withStream("2024", "edge").forTarget("qemux86_64").releasever,
    "2024/edge",
  );
  assert.match(ctx.describe(["qemux86_64"]), /snapshots\/abc/);
  assert.deepEqual(ctx.structured(["qemux86_64"]).snapshots, {
    qemux86_64: "abc",
  });
});

test("validateFeed rejects unsafe feeds", () => {
  const ok = {
    baseUrl: "https://a.example.com",
    releasever: "2024/edge",
    manifestPath: "2024/edge",
  };
  assert.equal(validateFeed(ok), "https://a.example.com");
  assert.throws(() => validateFeed({ ...ok, baseUrl: "file:///etc" }));
  assert.throws(() => validateFeed({ ...ok, baseUrl: "https://a?x=1" }));
  assert.throws(() => validateFeed({ ...ok, releasever: "../../etc" }));
  assert.throws(() => validateFeed({ ...ok, releasever: "a/b/c/d/e" }));
  assert.doesNotThrow(() =>
    validateFeed({ ...ok, releasever: "2026/edge/snapshots/abc" }),
  );
});

test("RepoClient fetches targets.json from the head and repos from the snapshot", async () => {
  const hits: string[] = [];
  const primary = gzipSync(
    `<metadata><package type="rpm"><name>hello</name><arch>aarch64</arch><version epoch="0" ver="1.0" rel="r0"/><summary>hi</summary><description>d</description><location href="hello.rpm"/></package></metadata>`,
  );
  const server = createServer((req, res) => {
    hits.push(req.url ?? "");
    if (req.url === "/feed/2026/edge/targets.json") {
      res.end(JSON.stringify({ qemuarm64: ["target/qemuarm64"] }));
    } else if (
      req.url ===
      "/feed/2026/edge/snapshots/s1/target/qemuarm64/repodata/repomd.xml"
    ) {
      res.end(
        `<repomd><data type="primary"><location href="repodata/p-primary.xml.gz"/></data></repomd>`,
      );
    } else if (
      req.url ===
      "/feed/2026/edge/snapshots/s1/target/qemuarm64/repodata/p-primary.xml.gz"
    ) {
      res.end(primary);
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), "feedsrv-"));
    writeFileSync(
      join(dir, "avocado.yaml"),
      `distro:\n  release: 2026\n  channel: edge\n  repo:\n    url: http://127.0.0.1:${port}/feed\n`,
    );
    mkdirSync(join(dir, ".avocado"));
    writeFileSync(
      join(dir, ".avocado", "lock.json"),
      JSON.stringify({
        targets: {
          qemuarm64: {
            "repo-snapshot": {
              release: "2026",
              channel: "edge",
              snapshot: "s1",
            },
          },
        },
      }),
    );
    const ctx = FeedContext.load({ projectDir: dir, env: {} });
    const client = new RepoClient();
    const r = await client.searchPackages(["qemuarm64"], "hello", 5, (t) =>
      ctx.forTarget(t),
    );
    assert.deepEqual(r.errors, []);
    assert.equal(r.results[0]?.name, "hello");
    assert.ok(hits.includes("/feed/2026/edge/targets.json"));
  } finally {
    server.close();
  }
});

// ── avocado.lock and named feeds (repos: / distro.feeds) ───────────────

function project(yaml: string, files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "feedproj-"));
  writeFileSync(join(dir, "avocado.yaml"), yaml);
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

const pinLock = (snapshot: string) =>
  JSON.stringify({
    version: 8,
    targets: {
      qemuarm64: {
        "repo-snapshot": { release: "2026", channel: "edge", snapshot },
      },
    },
  });

test("avocado.lock wins over the legacy .avocado/lock.json", () => {
  const dir = project("distro:\n  release: 2026\n  channel: edge\n", {
    "avocado.lock": pinLock("new"),
    ".avocado/lock.json": pinLock("old"),
  });
  const ctx = FeedContext.load({ projectDir: dir, env: {} });
  assert.equal(
    ctx.forTarget("qemuarm64").releasever,
    "2026/edge/snapshots/new",
  );
});

test("falls back to the legacy .avocado/lock.json", () => {
  const dir = project("distro:\n  release: 2026\n  channel: edge\n", {
    ".avocado/lock.json": pinLock("old"),
  });
  const ctx = FeedContext.load({ projectDir: dir, env: {} });
  assert.equal(
    ctx.forTarget("qemuarm64").releasever,
    "2026/edge/snapshots/old",
  );
});

test("a string distro.repo names the repos: entry used as the distro feed", () => {
  const f = resolveFeed({
    env: {},
    target: "qemuarm64",
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\n  repo: mirror\nrepos:\n  mirror:\n    url: https://mirror.example.com\n    tls_verify: false\n",
    ),
  });
  assert.equal(f.baseUrl, "https://mirror.example.com");
  assert.equal(f.sources.repoUrl, "avocado.yaml repos.mirror.url");
  assert.equal(f.name, "mirror");
  assert.equal(f.tls?.insecure, true);
  assert.deepEqual(
    f.feeds?.map((e) => [e.name, e.kind]),
    [["mirror", "distro"]],
  );
});

test("repos.avocado is the distro feed when distro.repo is absent", () => {
  const f = resolveFeed({
    env: {},
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\nrepos:\n  avocado:\n    url: https://m.example.com\n",
    ),
  });
  assert.equal(f.baseUrl, "https://m.example.com");
});

test("distro.feeds enables and orders repos:; unlisted entries stay off", () => {
  const f = resolveFeed({
    env: {},
    target: "raspberrypi5",
    config: cfg(`
distro:
  release: 2026
  channel: edge
  feeds: [first, avocado, second]
repos:
  first:
    url: https://first.example.com/$releasever/target/$target
  second:
    url: https://second.example.com/repo
  unlisted:
    url: https://unlisted.example.com/repo
`),
  });
  assert.deepEqual(
    f.feeds?.map((e) => [e.name, e.priority]),
    [
      ["first", 10],
      ["avocado", 20],
      ["second", 30],
    ],
  );
  assert.equal(f.priority, 20);
  assert.deepEqual(
    f.extraFeeds?.map((x) => x.url),
    [
      "https://first.example.com/2026/edge/target/raspberrypi5",
      "https://second.example.com/repo",
    ],
  );
});

test("stages: and targets: keep a feed out of target package lookups", () => {
  const f = resolveFeed({
    env: {},
    target: "qemuarm64",
    config: cfg(`
distro:
  release: 2026
  channel: edge
  feeds: [sdkonly, extonly, pi]
repos:
  sdkonly:
    url: https://a.example.com/r
    stages: [sdk]
  extonly:
    url: https://b.example.com/r
    stages: [ext]
  pi:
    url: https://c.example.com/r
    targets: [raspberrypi5]
`),
  });
  const status = Object.fromEntries(
    (f.feeds ?? []).map((e) => [e.name, e.status]),
  );
  assert.deepEqual(status, {
    avocado: "queried",
    sdkonly: "excluded",
    extonly: "queried",
    pi: "excluded",
  });
  assert.deepEqual(
    f.extraFeeds?.map((x) => x.name),
    ["extonly"],
  );
  assert.deepEqual(f.notChecked, []);
});

test("a stage-specific caller drops feeds scoped to the other stage", () => {
  const config = cfg(`
distro:
  release: 2026
  channel: edge
  feeds: [rtonly, extonly]
repos:
  rtonly:
    url: https://a.example.com/r
    stages: [runtime]
  extonly:
    url: https://b.example.com/r
    stages: [ext]
`);
  const ext = resolveFeed({
    env: {},
    target: "qemuarm64",
    config,
    stage: "ext",
  });
  assert.deepEqual(
    ext.extraFeeds?.map((x) => x.name),
    ["extonly"],
  );
  const rt = ext.feeds?.find((e) => e.name === "rtonly");
  assert.equal(rt?.status, "excluded");
  assert.match(
    rt?.reason ?? "",
    /does not include `ext`, so extension installs/,
  );

  // No stage: either package stage is enough.
  const any = resolveFeed({ env: {}, target: "qemuarm64", config });
  assert.deepEqual(
    any.extraFeeds?.map((x) => x.name),
    ["rtonly", "extonly"],
  );
});

test("the built-in avocado-ext feed is part of the distro feed, not a named feed", () => {
  const base = "distro:\n  release: 2026\n  channel: edge\n";
  // Default: no entry, nothing to resolve.
  assert.equal(
    resolveFeed({ env: {}, target: "qemuarm64", config: cfg(base) }).feeds,
    undefined,
  );
  // A stages-only re-scope is valid. It adds no feed and no unread feed.
  const scoped = resolveFeed({
    env: {},
    target: "qemuarm64",
    config: cfg(`${base}repos:\n  avocado-ext:\n    stages: [ext]\n`),
  });
  assert.deepEqual(
    scoped.feeds?.map((e) => e.name),
    ["avocado"],
  );
  assert.deepEqual(scoped.notChecked, []);
  assert.deepEqual(scoped.notes, []);
  // Listing it in distro.feeds is a config error in the CLI.
  const listed = resolveFeed({
    env: {},
    target: "qemuarm64",
    config: cfg(
      `${base}  feeds: [avocado-ext]\nrepos:\n  avocado-ext:\n    stages: [ext]\n`,
    ),
  });
  assert.deepEqual(listed.notChecked, []);
  assert.match(listed.notes.join("\n"), /built-in `avocado-ext`.*CLI rejects/);
});

test("an org: feed is reported as not checked, never fetched", () => {
  const f = resolveFeed({
    env: {},
    target: "qemuarm64",
    config: cfg(
      "distro:\n  release: 2026\n  channel: edge\n  feeds: [acme]\nrepos:\n  acme:\n    org: acme\n",
    ),
  });
  assert.equal(f.extraFeeds?.length, 0);
  assert.equal(f.notChecked?.[0]?.feed, "acme");
  assert.match(f.notChecked?.[0]?.reason ?? "", /avocado login/);
  assert.equal(f.feeds?.[1]?.location, "org:acme");
});

test("an unset env var in a feed url is not checked, unless the lock recorded the url", () => {
  const config = cfg(
    "distro:\n  release: 2026\n  channel: edge\n  feeds: [m]\nrepos:\n  m:\n    url: '{{ env.MIRROR }}/r'\n",
  );
  const f = resolveFeed({ env: {}, target: "qemuarm64", config });
  assert.match(f.notChecked?.[0]?.reason ?? "", /env\.MIRROR/);
  const g = resolveFeed({
    env: {},
    target: "qemuarm64",
    config,
    lock: {
      targets: {
        qemuarm64: {
          feeds: [{ name: "m", position: 20, url: "https://locked.example/r" }],
        },
      },
    },
  });
  assert.equal(g.extraFeeds?.[0]?.url, "https://locked.example/r");
  const h = resolveFeed({
    env: { MIRROR: "https://env.example" },
    target: "qemuarm64",
    config,
  });
  assert.equal(h.extraFeeds?.[0]?.url, "https://env.example/r");
});

test("a token in a feed url query never reaches the summary, structured output or errors", () => {
  const dir = project(
    "distro:\n  release: 2026\n  channel: edge\n  feeds: [vendor]\nrepos:\n  vendor:\n    url: 'https://vendor.example/repo?token={{ env.TOKEN }}'\n",
  );
  const ctx = FeedContext.load({
    projectDir: dir,
    env: {
      TOKEN: "s3cr3t-token",
      AVOCADO_REPO_URL: "https://mirror.example/r?key=s3cr3t-key",
    },
  });
  const f = ctx.forTarget("qemuarm64");
  const vendor = f.feeds?.find((e) => e.name === "vendor");
  assert.equal(vendor?.status, "not-checked");
  assert.equal(vendor?.location, "https://vendor.example/repo?token=***");
  assert.match(vendor?.reason ?? "", /query or fragment/);
  const shown = JSON.stringify([
    f.feeds,
    f.notChecked,
    ctx.describe(["qemuarm64"]),
    ctx.structured(["qemuarm64"]),
  ]);
  assert.doesNotMatch(shown, /s3cr3t/);
  assert.throws(
    () => validateFeed(f),
    (e: Error) => !e.message.includes("s3cr3t"),
  );
});

test("withStream drops the named feeds (they don't follow the stream)", () => {
  const dir = project(
    "distro:\n  release: 2026\n  channel: edge\n  feeds: [x]\nrepos:\n  x:\n    url: https://x.example/r\n",
  );
  const ctx = FeedContext.load({ projectDir: dir, env: {} });
  assert.equal(ctx.forTarget("qemuarm64").extraFeeds?.length, 1);
  assert.equal(
    ctx.withStream("2024", "edge").forTarget("qemuarm64").extraFeeds,
    undefined,
  );
});

test("named feeds: search reports the matching feed, auth failures and credentials stay out of output", async () => {
  const pkg = (name: string) =>
    gzipSync(
      `<metadata><package type="rpm"><name>${name}</name><arch>aarch64</arch><version epoch="0" ver="1.0" rel="r0"/><summary>s</summary><description>d</description><location href="${name}.rpm"/></package></metadata>`,
    );
  const repomd = `<repomd><data type="primary"><location href="repodata/p-primary.xml.gz"/></data></repomd>`;
  const auths: (string | undefined)[] = [];
  const server = createServer((req, res) => {
    const u = req.url ?? "";
    if (u === "/distro/2026/edge/targets.json") {
      return res.end(JSON.stringify({ qemuarm64: ["target/qemuarm64"] }));
    }
    if (u.startsWith("/distro/2026/edge/target/qemuarm64/repodata/")) {
      return res.end(u.endsWith("repomd.xml") ? repomd : pkg("distro-pkg"));
    }
    if (u.startsWith("/vendor/qemuarm64/repodata/")) {
      auths.push(req.headers.authorization);
      return res.end(u.endsWith("repomd.xml") ? repomd : pkg("vendor-pkg"));
    }
    if (u.startsWith("/denied/")) {
      res.statusCode = 401;
      return res.end();
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const dir = project(
      `
distro:
  release: 2026
  channel: edge
  repo:
    url: ${base}/distro
  feeds: [local, avocado, vendor, denied, acme]
repos:
  vendor:
    url: ${base}/vendor/$target
    username: robot
    password: "{{ env.VENDOR_TOKEN }}"
  denied:
    url: ${base}/denied
  local:
    path: rpms
  acme:
    org: acme
`,
      {
        "rpms/repodata/repomd.xml": repomd,
      },
    );
    writeFileSync(
      join(dir, "rpms", "repodata", "p-primary.xml.gz"),
      pkg("local-pkg"),
    );
    const env = { VENDOR_TOKEN: "s3cret-token" };
    const ctx = FeedContext.load({ projectDir: dir, env });
    const client = new RepoClient();
    const r = await client.searchPackages(["qemuarm64"], "pkg", 10, (t) =>
      ctx.forTarget(t),
    );
    assert.deepEqual(r.errors, []);
    const byName = Object.fromEntries(r.results.map((p) => [p.name, p.feed]));
    assert.deepEqual(byName, {
      "distro-pkg": "avocado",
      "vendor-pkg": "vendor",
      "local-pkg": "local",
    });
    assert.deepEqual(r.notChecked.map((n) => n.feed).sort(), [
      "acme",
      "denied",
    ]);
    assert.match(
      r.notChecked.find((n) => n.feed === "denied")?.reason ?? "",
      /401/,
    );
    // Basic auth reached the feed...
    assert.equal(
      auths[0],
      `Basic ${Buffer.from("robot:s3cret-token").toString("base64")}`,
    );
    // ...but never any tool-facing text.
    const shown = JSON.stringify([
      r,
      ctx.describe(["qemuarm64"]),
      ctx.structured(["qemuarm64"]),
    ]);
    assert.doesNotMatch(shown, /s3cret-token|robot/);
  } finally {
    server.close();
  }
});

test("a stage-specific lookup skips the target-ext repo, a stageless one keeps it", () => {
  assert.equal(resolveFeed({ env: {}, stage: "ext" }).skipExtRepo, true);
  assert.equal(resolveFeed({ env: {}, stage: "runtime" }).skipExtRepo, true);
  assert.equal(resolveFeed({ env: {} }).skipExtRepo, undefined);
});
