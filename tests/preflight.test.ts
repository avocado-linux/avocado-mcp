import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// Mock discovery so tests never shell out.
vi.mock("../src/tools/discovery.js", () => ({
  checkBinary: vi.fn(),
}));

// Mock fs/promises so tests never touch the real filesystem.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
}));

import { registerPreflightTools } from "../src/tools/preflight.js";
import { checkBinary } from "../src/tools/discovery.js";
import { readFile, writeFile } from "node:fs/promises";

const mockCheckBinary = vi.mocked(checkBinary);
const mockReadFile = vi.mocked(readFile);
const mockWriteFile = vi.mocked(writeFile);

const ALL_TOOLS = ["gh", "curl", "git", "uv", "oelint-adv"];

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

let client: Client;

beforeEach(async () => {
  const server = new McpServer({ name: "test-preflight", version: "0.0.0" });
  registerPreflightTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  vi.clearAllMocks();
  await client.close();
});

async function callTool(
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await client.callTool({ name, arguments: args })) as ToolResult;
}

/** Build a valid sentinel JSON that satisfies PREFLIGHT_VERSION=1 + current tool set. */
function makeSentinel(
  overrides: Partial<Record<string, unknown>> = {},
): string {
  return JSON.stringify({
    version: 1,
    tools: ALL_TOOLS,
    verifiedAt: new Date().toISOString(),
    ...overrides,
  });
}

describe("preflight-recipe-tools", () => {
  it("returns skipped: true and ok: true when a satisfying sentinel exists", async () => {
    mockReadFile.mockResolvedValue(makeSentinel() as never);

    const result = await callTool("preflight-recipe-tools");

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(true);
    expect(out.sentinelWritten).toBe(false);
    expect(out.results).toEqual([]);
    // Sentinel satisfies — checkBinary must not have been called.
    expect(mockCheckBinary).not.toHaveBeenCalled();
  });

  it("probes all tools and writes a sentinel when no sentinel exists and all tools present", async () => {
    // Simulate missing sentinel file.
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    // All binaries present.
    mockCheckBinary.mockResolvedValue({ ok: true, detail: "1.0.0" });

    const result = await callTool("preflight-recipe-tools");

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(false);
    expect(out.sentinelWritten).toBe(true);
    expect(Array.isArray(out.missing)).toBe(true);
    expect((out.missing as string[]).length).toBe(0);
    expect(mockCheckBinary).toHaveBeenCalledTimes(ALL_TOOLS.length);
    expect(mockWriteFile).toHaveBeenCalledOnce();
  });

  it("returns ok: false with missing list and does NOT write sentinel when a tool is absent", async () => {
    mockReadFile.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    // All binaries present except oelint-adv.
    mockCheckBinary.mockImplementation(async (cmd: string) =>
      cmd === "oelint-adv"
        ? { ok: false, detail: "not found" }
        : { ok: true, detail: "1.0.0" },
    );

    const result = await callTool("preflight-recipe-tools");

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(false);
    expect(out.sentinelWritten).toBe(false);
    const missing = out.missing as string[];
    expect(missing).toContain("oelint-adv");
    expect(missing.length).toBe(1);
    const fixes = out.fixes as string[];
    expect(fixes.length).toBe(1);
    expect(fixes[0]).toContain("oelint-adv");
    // No sentinel written when tools are missing.
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("re-probes and rewrites sentinel when force: true even with a satisfying sentinel", async () => {
    mockReadFile.mockResolvedValue(makeSentinel() as never);
    mockCheckBinary.mockResolvedValue({ ok: true, detail: "1.0.0" });

    const result = await callTool("preflight-recipe-tools", { force: true });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.ok).toBe(true);
    expect(out.skipped).toBe(false);
    expect(out.sentinelWritten).toBe(true);
    // Even though the sentinel file existed, force=true must have probed anyway.
    expect(mockCheckBinary).toHaveBeenCalledTimes(ALL_TOOLS.length);
  });

  it("does not satisfy an old-version sentinel and re-probes", async () => {
    // version: 0 does not match PREFLIGHT_VERSION = 1.
    mockReadFile.mockResolvedValue(makeSentinel({ version: 0 }) as never);
    mockCheckBinary.mockResolvedValue({ ok: true, detail: "1.0.0" });

    const result = await callTool("preflight-recipe-tools");

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    // Old sentinel version → must NOT have skipped.
    expect(out.skipped).toBe(false);
    expect(mockCheckBinary).toHaveBeenCalledTimes(ALL_TOOLS.length);
  });
});
