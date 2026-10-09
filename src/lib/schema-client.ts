/**
 * The JSON Schema for `avocado.yaml`, as the avocado CLI ships it.
 *
 * Source of truth: `avocado-cli/schemas/avocado-config.json`. The docs site
 * serves the same file at SCHEMA_URL. We fetch it from there, cache it in
 * memory and on disk under getCacheDir()/schema, and fall back to the copy
 * vendored in `src/lib/schema/` when the fetch fails or the fetched schema
 * does not compile. The fallback is kept in memory for five minutes, then
 * the live schema is tried again. CI fails when the vendored copy drifts from the CLI
 * (`npm run sync-schema` refreshes it).
 *
 * Set AVOCADO_MCP_SCHEMA_OFFLINE=1 to skip the network and use the vendored
 * copy (air-gapped hosts, and the test suite).
 */

import * as path from "path";
import { promises as fs, readFileSync } from "fs";
import { createRequire } from "module";
import { getCacheDir } from "./cache.js";

export const SCHEMA_URL =
  "https://docs.peridio.com/schemas/avocado-config.json";
const TTL_MS = 60 * 60 * 1000;
const FALLBACK_TTL_MS = 5 * 60 * 1000;
const FETCH_TIMEOUT_MS = 5000;
const USER_AGENT = "avocado-mcp-server";
const VENDORED_SOURCE =
  "vendored copy of avocado-cli/schemas/avocado-config.json";

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

let memory: (LoadedSchema & { expiresAt: number }) | null = null;
let vendored: LoadedSchema | null = null;

function vendoredSchema(): LoadedSchema {
  if (!vendored) {
    const file = new URL("./schema/avocado-config.json", import.meta.url);
    const schema = JSON.parse(readFileSync(file, "utf8"));
    vendored = { schema, source: VENDORED_SOURCE, validate: compile(schema) };
  }
  return vendored;
}

/**
 * Compile the schema with the unknown-key rule removed. The draft is 2020-12.
 * Strict mode stays on, so the two CLI keywords are declared, and union types
 * (`type: [string, array]`) are allowed because the schema uses them.
 */
function compile(schema: Record<string, unknown>): SchemaValidator {
  const relaxed = JSON.parse(
    JSON.stringify(schema, (key, value) =>
      key === "additionalProperties" && value === false ? undefined : value,
    ),
  );
  keepSingletonKeys(schema, relaxed);
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  ajv.addKeyword("x-avocado-warning");
  ajv.addKeyword("x-avocado-target-overrides");
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

function diskPath(): string {
  return path.join(getCacheDir(), "schema", "avocado-config.json");
}

async function readDisk(): Promise<{
  schema: Record<string, unknown>;
  fetchedAt: number;
} | null> {
  try {
    const raw = JSON.parse(await fs.readFile(diskPath(), "utf8"));
    if (Date.now() - raw.fetchedAt < TTL_MS) {
      return { schema: raw.schema, fetchedAt: raw.fetchedAt };
    }
  } catch {
    // Missing or unreadable; fetch instead.
  }
  return null;
}

async function fetchRemote(): Promise<Record<string, unknown>> {
  const res = await fetch(SCHEMA_URL, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`${SCHEMA_URL} returned HTTP ${res.status}`);
  const schema: unknown = await res.json();
  if (!schema || typeof schema !== "object" || !("properties" in schema)) {
    throw new Error(`${SCHEMA_URL} is not an avocado.yaml schema`);
  }
  return schema as Record<string, unknown>;
}

/**
 * Return the current schema and a compiled validator. Never throws: any
 * failure on the live path gives the vendored copy.
 */
export async function loadSchema(): Promise<LoadedSchema> {
  if (process.env.AVOCADO_MCP_SCHEMA_OFFLINE === "1") return vendoredSchema();
  if (memory && Date.now() < memory.expiresAt) return memory;
  try {
    const cached = await readDisk();
    const schema = cached?.schema ?? (await fetchRemote());
    // A disk entry keeps its own age, so the schema refreshes one hour after
    // it was fetched, not one hour after this process read it.
    const fetchedAt = cached?.fetchedAt ?? Date.now();
    // Compile before caching, so a schema that does not compile never
    // reaches the disk cache and the next call fetches again.
    const validate = compile(schema);
    if (!cached) {
      // Best effort: a read-only or full cache dir must not throw away a
      // schema that was fetched and compiled.
      try {
        await fs.mkdir(path.dirname(diskPath()), { recursive: true });
        await fs.writeFile(
          diskPath(),
          JSON.stringify({ fetchedAt, schema }),
          "utf8",
        );
      } catch (error) {
        console.error(
          "[schema-client] could not cache the schema:",
          (error as Error).message,
        );
      }
    }
    memory = {
      schema,
      source: SCHEMA_URL,
      validate,
      expiresAt: fetchedAt + TTL_MS,
    };
    return memory;
  } catch (error) {
    // Keep the fallback for a short time, so a slow or broken live schema
    // does not cost every call the full fetch timeout. Retry after that.
    console.error(
      "[schema-client] using the vendored schema:",
      (error as Error).message,
    );
    memory = { ...vendoredSchema(), expiresAt: Date.now() + FALLBACK_TTL_MS };
    return memory;
  }
}

/** Test seam: reset the in-memory cache. */
export function clearSchemaCache(): void {
  memory = null;
}
