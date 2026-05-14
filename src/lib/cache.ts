import * as path from "path";
import * as os from "os";
import { existsSync, mkdirSync } from "fs";

/**
 * Returns the persistent cache directory for the MCP server.
 *
 * Resolution order:
 *   1. $AVOCADO_MCP_CACHE_DIR (explicit override)
 *   2. $XDG_CACHE_HOME/avocado-mcp (Linux XDG convention)
 *   3. ~/.cache/avocado-mcp (default, macOS + Linux)
 *
 * v4 used process.cwd()/.avocado-cache, which leaked cache files into the
 * user's working directory. This module fixes that.
 */
export function getCacheDir(): string {
  const override = process.env.AVOCADO_MCP_CACHE_DIR;
  if (override) return ensureDir(override);

  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg) return ensureDir(path.join(xdg, "avocado-mcp"));

  return ensureDir(path.join(os.homedir(), ".cache", "avocado-mcp"));
}

function ensureDir(dir: string): string {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}
