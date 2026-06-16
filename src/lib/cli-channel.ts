/**
 * Avocado-CLI execution channel detection.
 *
 * There are two ways an `avocado` subcommand can run in a session:
 *   - `bash`      — the MCP runs on the user's workstation; the CLI is invoked
 *                   locally (their binary, their config, their credentials).
 *   - `host-tool` — the MCP runs inside the avocado-vm; the real CLI/config/
 *                   credentials live on the Mac host and avocado subcommands are
 *                   delegated out to the Avocado desktop's `run_avocado_cli` tool.
 *
 * Most of this MCP is "advisory": it hands the agent guidance and the agent runs
 * the subcommand through the active channel. The `connect-*` tools are the one
 * exception — they `execFile("avocado")` locally — so they must detect a
 * host-tool session and refuse rather than run against the wrong environment.
 */

// When this MCP runs inside the avocado-vm, the QEMU user-mode NAT routes
// 10.0.2.2 to the macOS host's loopback, so the desktop app's MCP server
// (`MCPHostServer.swift`, default port 11551) is reachable. On a developer's
// workstation the address isn't routable and the connect fails fast — that's
// the workstation signal.
export const HOST_MCP_URL = "http://10.0.2.2:11551/mcp";
const HOST_MCP_PROBE_TIMEOUT_MS = 600;

export interface HostMcpDelegation {
  available: boolean;
  runToolName?: string;
  statusToolName?: string;
  awaitToolName?: string;
  detail: string;
}

async function doProbeHostMcp(): Promise<HostMcpDelegation> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HOST_MCP_PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(HOST_MCP_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: {},
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      return {
        available: false,
        detail: `host MCP responded HTTP ${resp.status}`,
      };
    }
    const body = (await resp.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = new Set(
      (body.result?.tools ?? []).map((t) => t.name).filter(Boolean),
    );
    if (names.has("run_avocado_cli") && names.has("avocado_cli_status")) {
      return {
        available: true,
        runToolName: "run_avocado_cli",
        statusToolName: "avocado_cli_status",
        // Older host MCPs don't expose await_avocado_cli yet — surface
        // it only when it's actually there so the agent's instructions
        // line up with what it can call.
        awaitToolName: names.has("await_avocado_cli")
          ? "await_avocado_cli"
          : undefined,
        detail: "host MCP advertises CLI delegation",
      };
    }
    return {
      available: false,
      detail: "host MCP reachable but does not expose run_avocado_cli",
    };
  } catch (e) {
    // The expected workstation path: ECONNREFUSED / ENETUNREACH /
    // AbortError. We don't surface the underlying error to the user —
    // it's just "no host MCP" and that's fine.
    const err = e as { name?: string; code?: string };
    if (err.name === "AbortError") {
      return { available: false, detail: "no host MCP (probe timed out)" };
    }
    return { available: false, detail: "no host MCP reachable" };
  } finally {
    clearTimeout(timer);
  }
}

let cached: Promise<HostMcpDelegation> | null = null;

/**
 * Detect whether the session can delegate avocado-cli to the host (host-tool
 * channel). Memoized — the channel is stable for the life of the process, and
 * memoizing keeps the tight Connect selection cascade from re-probing per call.
 */
export function probeHostMcp(): Promise<HostMcpDelegation> {
  if (!cached) cached = doProbeHostMcp();
  return cached;
}

/**
 * Throw if this session uses the host-tool channel. The `connect-*` tools run
 * `avocado` locally via `execFile`, which inside the avocado-vm would hit the
 * wrong CLI, with no Connect credentials, against VM-local paths instead of the
 * user's real project. Fail fast with an actionable message instead.
 */
export async function assertWorkstationChannel(): Promise<void> {
  const delegation = await probeHostMcp();
  if (delegation.available) {
    throw new Error(
      "Avocado Connect tools run `avocado` locally, but this session is using the " +
        "host-tool execution channel — the Avocado desktop runs the CLI on your Mac " +
        "with your credentials and project files, and these tools cannot reach it from " +
        "inside the VM. Run `avocado connect …` through the host channel (the way build " +
        "and deploy are run), or use the Connect tools from a workstation session where " +
        "`avocado` runs locally.",
    );
  }
}
