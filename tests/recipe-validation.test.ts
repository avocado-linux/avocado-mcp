import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RepoClient } from "../src/lib/repo-client.js";
import { registerRecipeTools } from "../src/tools/recipe.js";

// See tests/recipe.test.ts for the ToolResult contract: a thrown, unhandled
// exception inside a handler surfaces as a rejected callTool promise, so
// awaiting it without a rejection is itself the "no unhandled exception
// escaped" assertion.
type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

let client: Client;
let tmpDir: string;

beforeEach(async () => {
  const server = new McpServer({ name: "test-recipe-validation", version: "0.0.0" });
  const repoClient = new RepoClient();
  registerRecipeTools(server, repoClient);

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  tmpDir = mkdtempSync(join(tmpdir(), "avocado-recipe-validation-"));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await client.close();
  rmSync(tmpDir, { recursive: true, force: true });
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

/** Write a .bb file into the per-test temp dir and return its path. */
function writeRecipe(name: string, body: string): string {
  const path = join(tmpDir, name);
  writeFileSync(path, body, "utf8");
  return path;
}

describe("validate-recipe-parse", () => {
  it("returns a structured error (ok:false, no throw) when bitbake is not on PATH", async () => {
    // Force bitbake-absent deterministically regardless of host: point PATH at
    // an empty temp dir so execFileSync("bitbake", ...) cannot resolve the
    // binary. The tool MUST surface this as a structured {ok:false} result, not
    // a thrown ENOENT (an unhandled throw would reject this promise).
    const recipe = writeRecipe("foo_1.0.bb", 'SUMMARY = "stub"\n');
    const savedPath = process.env.PATH;
    const savedBuilddir = process.env.BUILDDIR;
    process.env.PATH = tmpDir;
    process.env.BUILDDIR = tmpDir; // ensure the env gate does not short-circuit first
    try {
      const result = await callTool("validate-recipe-parse", { recipe });

      expect(result.isError).not.toBe(true);
      const out = result.structuredContent ?? {};
      expect(out.ok).toBe(false);
      expect(Array.isArray(out.errors)).toBe(true);
      expect((out.errors as string[]).length).toBeGreaterThan(0);
      expect((out.errors as string[]).join(" ").toLowerCase()).toContain("bitbake");
      expect(out.warnings).toEqual([]);
    } finally {
      if (savedPath === undefined) delete process.env.PATH;
      else process.env.PATH = savedPath;
      if (savedBuilddir === undefined) delete process.env.BUILDDIR;
      else process.env.BUILDDIR = savedBuilddir;
    }
  });
});
