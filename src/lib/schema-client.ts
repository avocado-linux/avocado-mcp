/**
 * The avocado.yaml schema and validation, from the installed avocado CLI.
 * The MCP keeps no copy of the schema and no validator of its own. Users of
 * the MCP must have the CLI installed, and what the CLI reports is what it
 * applies, so a schema or rule change in the CLI needs no change here.
 *
 * - `loadSchema`: `avocado config schema`
 * - `validateWithCli`: `avocado config validate -c - --output json`
 *
 * Set AVOCADO_BINARY to use a CLI that is not `avocado` on PATH.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileP = promisify(execFile);
const TIMEOUT_MS = 15000;
const MAX_BUFFER = 8 * 1024 * 1024;

export interface LoadedSchema {
  schema: Record<string, unknown>;
  source: string;
}

/** What `avocado config validate --output json` prints. */
export interface CliValidation {
  ok: boolean;
  /** `path` is a JSON pointer into the config, empty for the whole file. */
  errors: { path: string; message: string }[];
  /** Keys the CLI ignores or deprecates. */
  warnings: string[];
}

function binary(): string {
  return process.env.AVOCADO_BINARY ?? "avocado";
}

type ExecError = {
  code?: string | number;
  stdout?: string;
  stderr?: string;
  message?: string;
};

/** Turn a failed `avocado config <command>` into an error the user can act on. */
function cliError(command: string, error: ExecError): Error {
  if (error.code === "ENOENT") {
    return new Error(
      `The avocado CLI (\`${binary()}\`) is not installed or not on PATH. ` +
        "The MCP reads the avocado.yaml schema and checks avocado.yaml with the CLI. Install the avocado CLI and try again.",
    );
  }
  const detail =
    (error.stderr ?? "").trim() || error.message || "unknown error";
  if (/unrecognized subcommand|unexpected argument/i.test(detail)) {
    return new Error(
      `Your avocado CLI is too old to run \`avocado config ${command}\`. ` +
        "Run `avocado upgrade` and try again.",
    );
  }
  return new Error(`\`${binary()} config ${command}\` failed: ${detail}`);
}

/**
 * Return the schema the installed CLI uses. Throws when the CLI is missing,
 * too old, or prints something that is not a schema.
 */
export async function loadSchema(): Promise<LoadedSchema> {
  let stdout: string;
  try {
    ({ stdout } = await execFileP(binary(), ["config", "schema"], {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    }));
  } catch (error) {
    throw cliError("schema", error as ExecError);
  }
  let schema: unknown;
  try {
    schema = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `\`${binary()} config schema\` did not print JSON: ${(error as Error).message}`,
    );
  }
  if (!schema || typeof schema !== "object" || !("properties" in schema)) {
    throw new Error(
      `\`${binary()} config schema\` did not print an avocado.yaml schema`,
    );
  }
  return {
    schema: schema as Record<string, unknown>,
    source: `\`${binary()} config schema\``,
  };
}

/**
 * Check config text with the installed CLI. The CLI exits 1 when the config
 * has errors, and still prints its report. Throws when the CLI is missing,
 * too old, or prints no report.
 */
export async function validateWithCli(yaml: string): Promise<CliValidation> {
  const args = ["config", "validate", "-c", "-", "--output", "json"];
  let stdout: string;
  try {
    const run = execFileP(binary(), args, {
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
    });
    // A CLI that exits before it reads stdin (an old CLI rejects the
    // arguments at once) makes this write fail with EPIPE. Without a
    // handler that error is uncaught and stops the server. The exit code and
    // stderr report the real problem.
    run.child.stdin?.on("error", () => {});
    run.child.stdin?.end(yaml);
    ({ stdout } = await run);
  } catch (error) {
    const e = error as ExecError;
    if (e.code !== 1 || !e.stdout) throw cliError("validate", e);
    stdout = e.stdout;
  }
  let report: unknown;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    throw new Error(
      `\`${binary()} config validate\` did not print JSON: ${(error as Error).message}`,
    );
  }
  const r = report as Partial<CliValidation> | null;
  if (
    typeof r?.ok !== "boolean" ||
    !Array.isArray(r.errors) ||
    !Array.isArray(r.warnings)
  ) {
    throw new Error(
      `\`${binary()} config validate\` did not print a validation report`,
    );
  }
  return r as CliValidation;
}
