import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { RepoClient } from "../lib/repo-client.js";

/**
 * Normalize a raw BitBake build-log signature into a stable corpus key.
 *
 * Three sequential regex passes strip the per-run variance out of an error
 * line so that the same failure across different packages, versions, and
 * checkout paths collapses to one `normalized_signature` for dedup and
 * retrieval (design.md D3):
 *
 *   1. absolute build paths (`/home/<user>/<repo>/<workdir>/...`) -> `<WORKDIR>/`
 *   2. `<pkg>-<version>-<rev>` tokens (`zeromq-4.3.5-r0`)        -> `<PKG>`
 *   3. `lib<name>.so` library names in QA messages               -> `<LIB>.so`
 *
 * Pure: no I/O, no global state, safe to test in isolation.
 */
export function normalizeSignature(raw: string): string {
  let s = raw;

  // Pass 1: collapse an absolute home-rooted build path prefix to <WORKDIR>/.
  // Matches /home/<user>/<repo>/<dir>/ and the deeper tmp/work tree beneath it.
  s = s.replace(/\/home\/[^/\s]+\/[^/\s]+\/[^/\s]+\//g, "<WORKDIR>/");

  // Pass 2: collapse BitBake <pkg>-<version>-<rev> tokens to <PKG>.
  // e.g. zeromq-4.3.5-r0, python3-numpy-1.26.4-r0.
  s = s.replace(/\b[\w.+-]+?-\d+(?:\.\d+)*-r\d+\b/g, "<PKG>");

  // Pass 3: collapse lib<name>.so library names in QA messages to <LIB>.so.
  s = s.replace(/\blib[\w+-]+\.so\b/g, "<LIB>.so");

  return s;
}

/**
 * Register the corpus learn/retrieve MCP tools (diagnose-build-failure,
 * record-recipe-fix). Stub for now: subsequent tasks add the actual tools.
 * `repoClient` is threaded through to match the registrar convention used by
 * the other tool groups; the corpus tools do not use it today.
 */
export function registerCorpusTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  void server;
  void repoClient;
}
