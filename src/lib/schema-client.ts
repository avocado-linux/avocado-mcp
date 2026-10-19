/**
 * The JSON Schema for `avocado.yaml`, read from the installed avocado CLI
 * with `avocado config schema`. The MCP keeps no copy of it. Users of the MCP
 * must have the CLI installed, and the schema the CLI prints is the one it
 * applies, so a schema change in the CLI needs no change here.
 *
 * The CLI runs on every call, so an upgraded CLI is used at once. The
 * validator is compiled again only when the printed schema changes.
 *
 * Set AVOCADO_BINARY to use a CLI that is not `avocado` on PATH.
 */

import { execFile } from "child_process";
import { createRequire } from "module";
import { promisify } from "util";

const execFileP = promisify(execFile);
const SCHEMA_ARGS = ["config", "schema"];
const TIMEOUT_MS = 15000;

// Ajv 8 / ajv-formats are CJS modules; reach for them via createRequire to
// avoid TypeScript Node16-ESM default-interop awkwardness.
const cjsRequire = createRequire(import.meta.url);
export type AjvErrorObject = {
  instancePath: string;
  keyword: string;
  message?: string;
  params?: Record<string, unknown>;
};
export type SchemaValidator = ((data: unknown) => boolean) & {
  errors?: AjvErrorObject[] | null;
};
type AjvInstance = {
  addKeyword: (keyword: string) => AjvInstance;
  compile: (schema: object) => SchemaValidator;
};
type AjvCtor = new (opts?: unknown) => AjvInstance;
const Ajv = cjsRequire("ajv/dist/2020").default as AjvCtor;
const addFormats = cjsRequire("ajv-formats").default as (
  ajv: AjvInstance,
) => AjvInstance;

export interface LoadedSchema {
  /** The schema as published. Use it for display and for the key lint. */
  schema: Record<string, unknown>;
  source: string;
  /**
   * Validator for hard errors. It ignores `additionalProperties: false`,
   * because the CLI only warns about unknown keys (see config-lint.ts). The
   * one exception is where the rule picks a branch (keepSingletonKeys).
   */
  validate: SchemaValidator;
}

let loaded: (LoadedSchema & { text: string }) | null = null;

/**
 * Compile the schema with the unknown-key rule removed. The draft is 2020-12.
 * Unknown keywords are ignored, because the schema comes from whichever CLI
 * is installed, and a keyword added in a newer CLI must not stop validation.
 * Union types (`type: [string, array]`) are allowed because the schema uses
 * them.
 */
function compile(schema: Record<string, unknown>): SchemaValidator {
  const relaxed = JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "additionalProperties" && value === false ? undefined : value,
    ),
  );
  keepSingletonKeys(schema, relaxed);
  const ajv = new Ajv({
    allErrors: true,
    allowUnionTypes: true,
    strictSchema: false,
  });
  addFormats(ajv);
  return ajv.compile(relaxed);
}

type Node = Record<string, unknown>;

function isNode(v: unknown): v is Node {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Put the unknown-key rule back where it picks the branch. `rootfs`,
 * `initramfs`, `kernel` and `permissions` take one block or a map of named
 * blocks. The CLI reads the mapping as one block when a key is a field of
 * that block, and then every other key is an error, except `target-<name>`
 * and `kernel-<spec>` overrides (`named_or_single_deserializer` in the CLI
 * config.rs). Without the rule, the one-block branch accepts any mapping, so
 * named entries are never checked.
 *
 * Only the branch site gets the rule. The named entries themselves stay
 * relaxed, so their unknown keys are warnings from config-lint.ts.
 */
function keepSingletonKeys(original: Node, relaxed: unknown): void {
  const resolve = (node: Node): Node => {
    const ref = node.$ref;
    if (typeof ref !== "string" || !ref.startsWith("#/")) return node;
    let target: unknown = original;
    for (const part of ref.slice(2).split("/")) {
      target = isNode(target) ? target[part] : undefined;
    }
    return isNode(target) ? target : node;
  };
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(visit);
    if (!isNode(node)) return;
    for (const value of Object.values(node)) visit(value);
    const branches = node.anyOf ?? node.oneOf;
    if (!Array.isArray(branches)) return;
    // The named-entry form: a map with no fields of its own.
    const named = branches.some(
      (b) =>
        isNode(b) &&
        !resolve(b).properties &&
        isNode(resolve(b).additionalProperties),
    );
    if (!named) return;
    branches.forEach((b, i) => {
      if (!isNode(b)) return;
      const single = resolve(b);
      if (!isNode(single.properties) || single.additionalProperties !== false) {
        return;
      }
      const fields = Object.fromEntries(
        Object.keys(single.properties).map((k) => [k, true]),
      );
      branches[i] = {
        ...b,
        type: "object",
        properties: { ...fields, ...(b.properties as Node | undefined) },
        patternProperties: {
          "^(target|kernel)-": true,
          ...(b.patternProperties as Node | undefined),
        },
        additionalProperties: false,
      };
    });
  };
  visit(relaxed);
}

/** Turn a failed `avocado config schema` into an error the user can act on. */
function cliError(binary: string, error: unknown): Error {
  const e = error as { code?: string; stderr?: string; message?: string };
  if (e.code === "ENOENT") {
    return new Error(
      `The avocado CLI (\`${binary}\`) is not installed or not on PATH. ` +
        "The MCP reads the avocado.yaml schema from the CLI. Install the avocado CLI and try again.",
    );
  }
  const detail = (e.stderr ?? "").trim() || e.message || "unknown error";
  if (/unrecognized subcommand/i.test(detail)) {
    return new Error(
      "Your avocado CLI is too old to print its avocado.yaml schema " +
        "(`avocado config schema`). Run `avocado upgrade` and try again.",
    );
  }
  return new Error(`\`${binary} config schema\` failed: ${detail}`);
}

/**
 * Return the schema the installed CLI uses and a compiled validator. Throws
 * when the CLI is missing, too old, or prints something that is not a schema.
 */
export async function loadSchema(): Promise<LoadedSchema> {
  const binary = process.env.AVOCADO_BINARY ?? "avocado";
  let text: string;
  try {
    ({ stdout: text } = await execFileP(binary, SCHEMA_ARGS, {
      timeout: TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    }));
  } catch (error) {
    throw cliError(binary, error);
  }
  if (loaded?.text === text) return loaded;
  let schema: unknown;
  try {
    schema = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `\`${binary} config schema\` did not print JSON: ${(error as Error).message}`,
    );
  }
  if (!isNode(schema) || !("properties" in schema)) {
    throw new Error(
      `\`${binary} config schema\` did not print an avocado.yaml schema`,
    );
  }
  loaded = {
    text,
    schema,
    source: `\`${binary} config schema\``,
    validate: compile(schema),
  };
  return loaded;
}

/** Test seam: forget the compiled schema. */
export function clearSchemaCache(): void {
  loaded = null;
}
