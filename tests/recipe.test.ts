import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RepoClient } from "../src/lib/repo-client.js";
import { registerRecipeTools } from "../src/tools/recipe.js";

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
