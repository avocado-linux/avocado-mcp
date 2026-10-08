/**
 * avocado.yaml helpers: parse / validate / safe-mutate.
 *
 * Validation uses Ajv against the CLI's JSON Schema (see schema-client.ts),
 * and reports keys the CLI ignores as warnings (see config-lint.ts).
 * Mutations preserve formatting and comments by using the `yaml` package's
 * Document API rather than parse + stringify.
 */

import { readFileSync } from "fs";
import {
  parseDocument,
  isMap,
  isSeq,
  Pair,
  YAMLMap,
  YAMLSeq,
  Scalar,
} from "yaml";
import { loadSchema } from "./schema-client.js";
import { ignoredKeys } from "./config-lint.js";

export interface YamlValidationResult {
  /** True when there are no errors. Warnings do not fail validation. */
  ok: boolean;
  errors: { instancePath: string; message: string }[];
  /** Keys the CLI ignores or deprecates. The CLI warns and keeps going. */
  warnings: string[];
  schemaSource: string;
}

export async function validateAvocadoYaml(
  yamlText: string,
): Promise<YamlValidationResult> {
  const { schema, source, validate } = await loadSchema();

  const fail = (message: string): YamlValidationResult => ({
    ok: false,
    errors: [{ instancePath: "", message: `YAML parse error: ${message}` }],
    warnings: [],
    schemaSource: source,
  });
  let parsed: unknown;
  try {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0) return fail(doc.errors[0].message);
    parsed = doc.toJS();
  } catch (e) {
    return fail((e as Error).message);
  }

  const ok = validate(parsed);
  const errors: { instancePath: string; message: string }[] = ok
    ? []
    : (validate.errors ?? []).map((e) => {
        // The schema uses `false` for keys that exclude each other, such as
        // kernel `cmdline` and `cmdline_extra`.
        const message =
          e.keyword === "false schema"
            ? "must not be set together with another key in this block"
            : (e.message ?? "(no message)");
        const params =
          e.params && Object.keys(e.params).length > 0
            ? `: ${JSON.stringify(e.params)}`
            : "";
        return {
          instancePath: e.instancePath || "(root)",
          message: message + params,
        };
      });

  return {
    ok: !!ok,
    errors,
    warnings: ignoredKeys(schema, parsed),
    schemaSource: source,
  };
}

const DEFAULT_TEMPLATE = readFileSync(
  new URL("./schema/default.yaml", import.meta.url),
  "utf8",
);

/**
 * Starter avocado.yaml for when the avocado CLI is not available. It is the
 * CLI's own `configs/default.yaml` (vendored next to the schema), with the
 * caller's values set through the Document API so every value is quoted
 * correctly. When the CLI is available, `avocado init` is the better path.
 */
export function buildStarterYaml(opts: {
  target: string;
  runtimeName?: string;
  extraExtensions?: string[];
  /** Feed values. The template default is 2024/edge. */
  release?: string;
  channel?: string;
  repoUrl?: string;
  /** Written as `default_target_board`. */
  board?: string;
}): string {
  // `- {target}` would parse as a flow map, so substitute a plain word first
  // and then set the real value as data.
  const doc = parseDocument(DEFAULT_TEMPLATE.replaceAll("{target}", "TARGET"));
  doc.set("default_target", opts.target);
  doc.setIn(["supported_targets", 0], opts.target);
  if (opts.board) {
    const root = doc.contents as YAMLMap;
    const at = root.items.findIndex(
      (p) => (p.key as Scalar).value === "default_target",
    );
    root.items.splice(
      at + 1,
      0,
      doc.createPair("default_target_board", opts.board) as Pair,
    );
  }

  if (opts.release) {
    doc.setIn(
      ["distro", "release"],
      /^\d+$/.test(opts.release) ? Number(opts.release) : opts.release,
    );
  }
  if (opts.channel) doc.setIn(["distro", "channel"], opts.channel);
  if (opts.repoUrl) doc.setIn(["distro", "repo", "url"], opts.repoUrl);

  const runtime = opts.runtimeName ?? "dev";
  const runtimes = doc.get("runtimes") as YAMLMap;
  (runtimes.items[0].key as Scalar).value = runtime;
  for (const e of opts.extraExtensions ?? []) {
    doc.addIn(["runtimes", runtime, "extensions"], e);
  }
  return doc.toString();
}

/**
 * Parse avocado.yaml, throwing a single, consistent error on malformed input.
 * The *throwing* helpers (addExtension/addRuntime/addPackageToExtension/
 * listExtensions) all route through this, so they share one message prefix
 * (previously the read path diverged with "Cannot read…"). `validateAvocadoYaml`
 * is deliberately NOT one of them — it returns a structured `{ok:false, errors}`
 * result rather than throwing, so a caller inspects `errors`, not a prefix.
 */
function parseOrThrow(yamlText: string): ReturnType<typeof parseDocument> {
  const doc = parseDocument(yamlText);
  if (doc.errors.length > 0) {
    // "parse", not "edit": this backs read-only entry points (listExtensions)
    // as well as the mutations, so a neutral verb is accurate for both.
    throw new Error(`Cannot parse malformed YAML: ${doc.errors[0].message}`);
  }
  return doc;
}

/** The `source:` forms of the schema's `extensionSource`. */
export type ExtensionSource =
  | { type: "package"; version: string; package?: string }
  | { type: "git"; url: string; ref?: string }
  | { type: "path"; path: string };

/**
 * Add a new extension definition to an existing avocado.yaml. Preserves
 * existing formatting; appends the new entry under `extensions:`.
 */
export function addExtension(
  yamlText: string,
  opts: {
    name: string;
    types?: ("sysext" | "confext")[];
    version?: string;
    packages?: Record<string, string>;
    overlay?: string;
    enableServices?: string[];
    /** Extensions this one depends on (`depends_on`). */
    dependsOn?: string[];
    /** Remote source. Without it the extension is local to this file. */
    source?: ExtensionSource;
  },
): string {
  const doc = parseOrThrow(yamlText);
  let extensions = doc.get("extensions");
  if (!isMap(extensions)) {
    extensions = doc.createNode({}, { flow: false }) as YAMLMap;
    doc.set("extensions", extensions);
  }
  const extMap = extensions as YAMLMap;
  if (extMap.has(opts.name)) {
    throw new Error(
      `Extension "${opts.name}" already exists. Edit it directly or pick another name.`,
    );
  }

  const ext: Record<string, unknown> = {};
  if (opts.source) ext.source = opts.source;
  if (opts.types && opts.types.length > 0) ext.types = opts.types;
  if (opts.version) ext.version = opts.version;
  if (opts.packages && Object.keys(opts.packages).length > 0)
    ext.packages = opts.packages;
  if (opts.overlay) ext.overlay = opts.overlay;
  if (opts.enableServices && opts.enableServices.length > 0)
    ext.enable_services = opts.enableServices;
  if (opts.dependsOn && opts.dependsOn.length > 0)
    ext.depends_on = opts.dependsOn;

  extMap.set(opts.name, doc.createNode(ext));
  return doc.toString();
}

/**
 * Add a new runtime (or overwrite if `replace: true`) to avocado.yaml.
 */
export function addRuntime(
  yamlText: string,
  opts: {
    name: string;
    extensions: string[];
    packages?: Record<string, string>;
    replace?: boolean;
  },
): string {
  const doc = parseOrThrow(yamlText);
  let runtimes = doc.get("runtimes");
  if (!isMap(runtimes)) {
    runtimes = doc.createNode({}, { flow: false }) as YAMLMap;
    doc.set("runtimes", runtimes);
  }
  const runMap = runtimes as YAMLMap;
  if (runMap.has(opts.name) && !opts.replace) {
    throw new Error(
      `Runtime "${opts.name}" already exists. Pass replace=true to overwrite, or pick another name.`,
    );
  }

  const runtime: Record<string, unknown> = { extensions: opts.extensions };
  if (opts.packages && Object.keys(opts.packages).length > 0)
    runtime.packages = opts.packages;

  runMap.set(opts.name, doc.createNode(runtime));
  return doc.toString();
}

/**
 * Add a single package to an existing extension's `packages` map.
 */
export function addPackageToExtension(
  yamlText: string,
  opts: { extension: string; packageName: string; version?: string },
): string {
  const doc = parseOrThrow(yamlText);
  const extensions = doc.get("extensions");
  if (!isMap(extensions)) {
    throw new Error(
      `No \`extensions:\` block in this YAML. Add the extension first with add-extension.`,
    );
  }
  const extNode = (extensions as YAMLMap).get(opts.extension);
  if (!isMap(extNode)) {
    throw new Error(
      `Extension "${opts.extension}" not found. Use add-extension first, or list existing extensions.`,
    );
  }
  const ext = extNode as YAMLMap;

  let packages = ext.get("packages");
  if (!isMap(packages)) {
    packages = doc.createNode({}, { flow: false }) as YAMLMap;
    ext.set("packages", packages);
  }
  const pkgMap = packages as YAMLMap;

  pkgMap.set(opts.packageName, opts.version ?? "*");
  return doc.toString();
}

/** Convenience: list extensions defined in a YAML, plus their types. */
export function listExtensions(
  yamlText: string,
): { name: string; types: string[] }[] {
  // Surface malformed YAML rather than reporting zero extensions — a broken
  // file must not look like an empty (extension-less) one.
  const doc = parseOrThrow(yamlText);
  const ext = doc.get("extensions");
  if (!isMap(ext)) return [];
  const out: { name: string; types: string[] }[] = [];
  for (const item of (ext as YAMLMap).items) {
    const key = (item.key as Scalar).value as string;
    let types: string[] = [];
    if (isMap(item.value)) {
      const t = (item.value as YAMLMap).get("types");
      if (isSeq(t)) {
        types = (t as YAMLSeq).items.map((s) => (s as Scalar).value as string);
      }
    }
    out.push({ name: key, types });
  }
  return out;
}
