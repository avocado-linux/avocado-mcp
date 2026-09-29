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
