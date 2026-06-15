import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RepoClient } from "../src/lib/repo-client.js";
import {
  normalizeSignature,
  registerCorpusTools,
} from "../src/tools/corpus.js";

// A raw zeromq dev-so build log carrying a concrete package token
// (zeromq-4.3.5-r0) and a concrete library name (libzmq.so) so the
// normalizer's <PKG>/<LIB> passes are actually exercised, not bypassed.
const DEV_SO_RAW_LOG = [
  "ERROR: zeromq-4.3.5-r0 do_package_qa: QA Issue: non -dev/-dbg",
  "package contains symlink .so: libzmq.so [dev-so]",
].join(" ");

// The signature the corpus stores is whatever normalizeSignature produces for
// the raw log. Deriving it (rather than hardcoding) keeps the exact-match test
// robust to the normalizer's precise regex behavior — the contract under test
// is "diagnose matches what record stored", not a literal string.
const DEV_SO_SIGNATURE = normalizeSignature(DEV_SO_RAW_LOG);

// A v0-schema case file (7 required fields + verified/source) whose
// normalized_signature matches the dev-so log. Written into each test's tmp
// corpus so the exact-match path has a target without depending on the real
// workspace corpus.
function devSoCase(): Record<string, unknown> {
  return {
    normalized_signature: DEV_SO_SIGNATURE,
    failed_task: "do_package_qa",
    build_system: "cmake",
    root_cause:
      "The recipe shipped the development symlink in the runtime package.",
    fix_diff: 'FILES:${PN}-dev += "${libdir}/libzmq.so"',
    doc_link: "https://docs.yoctoproject.org/ref-manual/qa-checks.html#dev-so",
    falsifier: "do_package_qa still reports the dev-so warning after the fix.",
    verified: true,
    source: "bringup-seed",
  };
}

interface Harness {
  client: Client;
  corpusDir: string;
  cleanup: () => Promise<void>;
}

async function makeHarness(): Promise<Harness> {
  const corpusDir = await mkdtemp(join(tmpdir(), "corpus-test-"));

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerCorpusTools(server, new RepoClient());

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    corpusDir,
    cleanup: async () => {
      await client.close();
      await rm(corpusDir, { recursive: true, force: true });
    },
  };
}

// MCP tool results carry the typed payload in `structuredContent`. Fall back
// to parsing the text content's JSON block if a tool only emits text, so the
// assertions stay robust to either shape.
function payload(result: {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  if (result.structuredContent) return result.structuredContent;
  const text =
    result.content?.find((c) => c.type === "text" && c.text)?.text ?? "";
  const match = text.match(/```json\s*([\s\S]*?)```/);
  if (match) return JSON.parse(match[1]);
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

describe("normalizeSignature", () => {
  it("strips an absolute WORKDIR path and a library name from a dev-so log", () => {
    const raw =
      "/home/user/build/tmp/work/core2-64-poky-linux/zeromq/4.3.5-r0/" +
      "package: QA Issue: contains symlink .so: libzmq.so [dev-so]";
    const normalized = normalizeSignature(raw);

    // The absolute path must be collapsed to the <WORKDIR> placeholder.
    expect(normalized).not.toContain("/home/user/build/tmp/work");
    expect(normalized).toContain("<WORKDIR>");

    // The concrete library name must be generalized to <LIB>.so so the case
    // dedupes across packages hitting the same dev-so split.
    expect(normalized).not.toContain("libzmq.so");
    expect(normalized).toContain("<LIB>.so");
  });

  it("collapses the versioned package token to <PKG> and is idempotent", () => {
    const normalized = normalizeSignature(DEV_SO_RAW_LOG);

    // The <pkg>-<version>-<rev> token must collapse to <PKG>.
    expect(normalized).not.toContain("zeromq-4.3.5-r0");
    expect(normalized).toContain("<PKG>");

    // Re-normalizing an already-normalized signature must be a fixed point,
    // otherwise a stored signature could fail to match a freshly normalized log.
    expect(normalizeSignature(normalized)).toBe(normalized);
  });
});

describe("diagnose-build-failure", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("returns confidence=1.0 and match_type=exact for the seeded dev-so case", async () => {
    await mkdir(join(h.corpusDir, "cases"), { recursive: true });
    await writeFile(
      join(h.corpusDir, "cases", "cmake-dev-so-symlink.yaml"),
      stringify(devSoCase()),
    );

    const result = await h.client.callTool({
      name: "diagnose-build-failure",
      arguments: { log: DEV_SO_RAW_LOG, corpus_dir: h.corpusDir },
    });

    const out = payload(result as never);
    expect(out.match_type).toBe("exact");
    expect(out.confidence).toBe(1.0);
  });
});

describe("record-recipe-fix", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await makeHarness();
  });
  afterEach(async () => {
    await h.cleanup();
  });

  it("rejects an empty falsifier without writing a case file", async () => {
    await mkdir(join(h.corpusDir, "cases"), { recursive: true });

    const result = await h.client.callTool({
      name: "record-recipe-fix",
      arguments: {
        normalized_signature: "QA Issue: <PKG>: some new error [new-check]",
        failed_task: "do_compile",
        build_system: "cmake",
        root_cause: "A concrete root cause.",
        fix_diff: "some fix",
        doc_link: "https://docs.yoctoproject.org/ref-manual/qa-checks.html",
        falsifier: "",
        corpus_dir: h.corpusDir,
      },
    });

    const out = payload(result as never);
    expect(out.error).toBe("falsifier required");

    // The guard must reject before any file is written.
    const files = await readdir(join(h.corpusDir, "cases"));
    expect(files).toHaveLength(0);
  });

  it("rejects a duplicate normalized_signature", async () => {
    await mkdir(join(h.corpusDir, "cases"), { recursive: true });
    await writeFile(
      join(h.corpusDir, "cases", "cmake-dev-so-symlink.yaml"),
      stringify(devSoCase()),
    );

    const result = await h.client.callTool({
      name: "record-recipe-fix",
      arguments: {
        normalized_signature: DEV_SO_SIGNATURE,
        failed_task: "do_package_qa",
        build_system: "cmake",
        root_cause: "A different root cause for the same signature.",
        fix_diff: "another fix",
        doc_link:
          "https://docs.yoctoproject.org/ref-manual/qa-checks.html#dev-so",
        falsifier: "A non-empty falsifier.",
        corpus_dir: h.corpusDir,
      },
    });

    const out = payload(result as never);
    expect(out.error).toBe("duplicate");

    // The pre-existing case is the only file; no duplicate was written.
    const files = await readdir(join(h.corpusDir, "cases"));
    expect(files).toHaveLength(1);
  });
});
