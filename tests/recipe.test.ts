import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RepoClient } from "../src/lib/repo-client.js";
import {
  registerRecipeTools,
  _setSleepForTest,
  _resetInFlightForTest,
  _resetCacheForTest,
  _setNowForTest,
} from "../src/tools/recipe.js";

// Top-level mock so execFileSync is interceptable in stage-recipe-to-feed tests.
// The default mock throws ENOENT (script absent), exercising the catch path.
// Individual tests override with mockImplementationOnce for the success path.
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:child_process")>();
  return {
    ...real,
    execFileSync: vi.fn(() => {
      const err = Object.assign(
        new Error("ENOENT: no such file or directory"),
        {
          code: "ENOENT",
          stdout: "",
          stderr: "",
        },
      );
      throw err;
    }),
  };
});

// Shape of an MCP callTool result. Tools in this server return both a
// `content` block (human-readable) and `structuredContent` (typed payload),
// plus an optional `isError` flag for *handled* error returns. A thrown,
// unhandled exception inside a tool handler surfaces as a rejected
// `callTool` promise, so awaiting it without a rejection is itself the
// "no unhandled exception escaped" assertion.
type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

let client: Client;

beforeEach(async () => {
  const server = new McpServer({ name: "test-recipe", version: "0.0.0" });
  const repoClient = new RepoClient();
  registerRecipeTools(server, repoClient);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  vi.restoreAllMocks();
  _resetCacheForTest();
  _resetInFlightForTest();
  await client.close();
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as ToolResult;
}

describe("search-layer-index", () => {
  it("returns found=false when no recipe matches the name", async () => {
    // The tool resolves the scarthgap branch id, then queries recipes.
    // Branch query -> one scarthgap branch so the tool does not short-circuit
    // on a missing branch; recipe query -> empty array so the result is a
    // legitimate zero-match (found=false), NOT the network-error {error} path.
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input: RequestInfo | URL) => {
        const url = typeof input === "string" ? input : input.toString();
        const body = url.includes("branches")
          ? [{ id: 42, name: "scarthgap" }]
          : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      });

    const result = await callTool("search-layer-index", {
      name: "definitely-no-such-recipe-xyz",
    });

    expect(fetchSpy).toHaveBeenCalled();
    // Return-value shape: found is explicitly false, and no error escaped.
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toBeDefined();
    expect(result.structuredContent?.found).toBe(false);
  });
});

describe("explain-bitbake", () => {
  it("returns a build-time description and a doc_url for DEPENDS", async () => {
    const result = await callTool("explain-bitbake", { symbol: "DEPENDS" });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(true);
    expect(String(out.description)).toContain("build-time");
    expect(typeof out.doc_url).toBe("string");
    expect(String(out.doc_url).length).toBeGreaterThan(0);
  });

  it("returns the hardcoded list entry unchanged for SRC_URI (fast path)", async () => {
    const result = await callTool("explain-bitbake", { symbol: "SRC_URI" });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(true);
    expect(out.type).toBe("list");
    expect(out.variable).toBe("SRC_URI");
    expect(String(out.doc_url).length).toBeGreaterThan(0);
  });

  it("falls through to variables.rst for an unknown-but-real var (PACKAGE_CLASSES)", async () => {
    const result = await callTool("explain-bitbake", {
      symbol: "PACKAGE_CLASSES",
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(true);
    expect(typeof out.description).toBe("string");
    expect(String(out.description).length).toBeGreaterThan(0);
    expect(String(out.doc_url)).toContain("term-PACKAGE_CLASSES");
    expect(out.error).toBeUndefined();
  });

  it("returns structured not-found for a bogus symbol (no error field)", async () => {
    const result = await callTool("explain-bitbake", {
      symbol: "NOTAREALYOCTOVARIABLE",
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(false);
    expect(out.alternatives).toBe("search-docs");
    expect(out.error).toBeUndefined();
  });
});

describe("lint-recipe", () => {
  it("returns {error: 'file not found'} for a non-existent recipe path", async () => {
    const result = await callTool("lint-recipe", {
      recipe_path: "/nonexistent/path/to/no-such-recipe.bb",
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.error).toBe("file not found");
  });
});

describe("scaffold-recipe", () => {
  let savedBuilddir: string | undefined;

  beforeEach(() => {
    savedBuilddir = process.env.BUILDDIR;
    delete process.env.BUILDDIR;
  });

  afterEach(() => {
    if (savedBuilddir === undefined) {
      delete process.env.BUILDDIR;
    } else {
      process.env.BUILDDIR = savedBuilddir;
    }
  });

  it("returns the env-not-initialized error when BUILDDIR is unset", async () => {
    const result = await callTool("scaffold-recipe", {
      url: "https://example.com/some-project",
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.error).toBe("build environment not initialized");
    expect(out.hint).toBe("kas shell meta-avocado/kas/machine/qemuarm64.yml");
  });
});

describe("introspect-recipe", () => {
  let savedBuilddir: string | undefined;

  beforeEach(() => {
    savedBuilddir = process.env.BUILDDIR;
    delete process.env.BUILDDIR;
  });

  afterEach(() => {
    if (savedBuilddir === undefined) {
      delete process.env.BUILDDIR;
    } else {
      process.env.BUILDDIR = savedBuilddir;
    }
  });

  it("returns env_active: false and a hint when BUILDDIR is unset", async () => {
    const result = await callTool("introspect-recipe", {
      recipe: "zlib",
      variables: ["DEPENDS", "RDEPENDS"],
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.env_active).toBe(false);
    expect(typeof out.error).toBe("string");
    expect(String(out.error).length).toBeGreaterThan(0);
    expect(typeof out.hint).toBe("string");
  });
});

describe("stage-recipe-to-feed", () => {
  it("propagates sdk_pass and boot_pass from parseFeedVerdict on exit-0 stdout", async () => {
    // Override the top-level mock for this one call: exit 0 with mixed output.
    // Before finding #2 the success path hardcoded sdk_pass: true unconditionally.
    const { execFileSync } = await import("node:child_process");
    vi.mocked(execFileSync).mockImplementationOnce(
      () => "SDK PASS\nBOOT FAIL\n",
    );

    const result = await callTool("stage-recipe-to-feed", {
      package: "zlib",
      lib_file: "libz.so",
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.sdk_pass).toBe(true);
    expect(out.boot_pass).toBe(false);
    expect(typeof out.feed_url).toBe("string");
  });

  it("returns sdk_pass and boot_pass as false when the script throws ENOENT", async () => {
    // Default top-level mock throws ENOENT — the catch block must return
    // structured output with booleans, not isError: true.
    const result = await callTool("stage-recipe-to-feed", {
      package: "zlib",
      lib_file: "libz.so",
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.sdk_pass).toBe(false);
    expect(out.boot_pass).toBe(false);
    expect(out.feed_url).toBeUndefined();
  });
});

describe("search-layer-index retry behavior", () => {
  beforeEach(() => {
    _resetCacheForTest();
    _setSleepForTest(() => Promise.resolve());
  });

  afterEach(() => {
    _setSleepForTest(null);
    _resetInFlightForTest();
    _resetCacheForTest();
  });

  it("retries on 503 and succeeds on 200", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async (input: RequestInfo | URL) => {
        callCount += 1;
        const url = typeof input === "string" ? input : input.toString();
        // First call returns 503 regardless of URL; subsequent calls succeed.
        if (callCount === 1) {
          return new Response("Service Unavailable", { status: 503 });
        }
        const body = url.includes("branches")
          ? [{ id: 42, name: "scarthgap" }]
          : [];
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );

    const result = await callTool("search-layer-index", {
      name: "definitely-no-such-recipe-xyz",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.error).toBeUndefined();
    expect(callCount).toBeGreaterThan(1);
  });

  it("returns found:false with error after exhausting all retries on 504", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount += 1;
      return new Response("Gateway Timeout", { status: 504 });
    });

    const result = await callTool("search-layer-index", {
      name: "some-recipe",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.found).toBe(false);
    expect(typeof result.structuredContent?.error).toBe("string");
    expect(callCount).toBe(3);
  });

  it("does not retry on 404 (client error)", async () => {
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount += 1;
      return new Response("Not Found", { status: 404 });
    });

    const result = await callTool("search-layer-index", {
      name: "some-recipe",
    });

    expect(result.isError).not.toBe(true);
    expect(result.structuredContent?.found).toBe(false);
    expect(typeof result.structuredContent?.error).toBe("string");
    expect(callCount).toBe(1);
  });

  it("coalesces concurrent fetches for the same URL into one in-flight request", async () => {
    _setSleepForTest(() => Promise.resolve());

    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetchCallCount++;
      const url = input.toString();
      // Slow down to let concurrent calls queue up
      await new Promise((r) => setTimeout(r, 10));
      if (url.includes("branches")) {
        return new Response(JSON.stringify([{ id: 42, name: "scarthgap" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // Fire 3 concurrent searches
    await Promise.all([
      callTool("search-layer-index", { name: "zlib" }),
      callTool("search-layer-index", { name: "openssl" }),
      callTool("search-layer-index", { name: "curl" }),
    ]);

    // branches/ and recipes/ are shared across all 3 calls (single-flight)
    // layerBranches/ is only fetched when there are matched recipes (none here)
    // So branches/ should be fetched once, recipes/ once = 2 total (not 6)
    expect(fetchCallCount).toBeLessThan(6);
    expect(fetchCallCount).toBe(2); // branches once + recipes once
  });
});

describe("search-layer-index TTL cache", () => {
  beforeEach(() => {
    _setSleepForTest(() => Promise.resolve());
  });

  afterEach(() => {
    _setSleepForTest(null);
    _resetInFlightForTest();
    _resetCacheForTest();
    _setNowForTest(null);
  });

  it("serves second search from cache (zero new upstream fetches)", async () => {
    _resetCacheForTest();
    _setSleepForTest(() => Promise.resolve());

    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetchCallCount++;
      const url = input.toString();
      if (url.includes("branches")) {
        return new Response(JSON.stringify([{ id: 42, name: "scarthgap" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    await callTool("search-layer-index", { name: "zlib" });
    const countAfterFirst = fetchCallCount;

    await callTool("search-layer-index", { name: "openssl" }); // different name, same endpoints
    expect(fetchCallCount).toBe(countAfterFirst); // no new fetches
  });

  it("re-fetches after TTL expires", async () => {
    _resetCacheForTest();
    _setSleepForTest(() => Promise.resolve());

    let fetchCallCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      fetchCallCount++;
      const url = input.toString();
      if (url.includes("branches")) {
        return new Response(JSON.stringify([{ id: 42, name: "scarthgap" }]), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    // First search - populates cache
    await callTool("search-layer-index", { name: "zlib" });
    const countAfterFirst = fetchCallCount;

    // Advance clock past TTL
    _setNowForTest(() => Date.now() + 700_000);

    // Second search - cache expired, should re-fetch
    await callTool("search-layer-index", { name: "openssl" });
    expect(fetchCallCount).toBeGreaterThan(countAfterFirst);

    // Reset now
    _setNowForTest(null);
  });
});
