/**
 * avocado.yaml helpers: parse / validate / safe-mutate.
 *
 * Validation uses Ajv against the CLI's JSON Schema (see schema-client.ts),
 * and reports keys the CLI ignores as warnings (see config-lint.ts).
 * Mutations preserve formatting and comments by using the `yaml` package's
 * Document API rather than parse + stringify.
 */

import { existsSync, readFileSync } from "fs";
import * as path from "path";
import {
  parseDocument,
  stringify,
  isMap,
  isSeq,
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
  /**
   * Keys the CLI ignores or deprecates (the CLI warns and keeps going), and
   * the stone checks of `stoneManifestWarnings`.
   */
  warnings: string[];
  schemaSource: string;
}

export async function validateAvocadoYaml(
  yamlText: string,
  /** The project directory. When set, the stone manifest file must exist. */
  projectDir?: string,
): Promise<YamlValidationResult> {
  let loaded;
  try {
    loaded = await loadSchema();
  } catch (e) {
    // No CLI to read the schema from. Report it as the result, so the tools
    // that edit YAML still return the YAML.
    return {
      ok: false,
      errors: [{ instancePath: "", message: (e as Error).message }],
      warnings: [],
      schemaSource: "none",
    };
  }
  const { schema, source, validate } = loaded;

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
        const path = e.instancePath || "(root)";
        // The schema uses `false` for keys that exclude each other, such as
        // kernel `cmdline` and `cmdline_extra`.
        if (e.keyword === "false schema") {
          return {
            instancePath: path,
            message: "must not be set together with another key in this block",
          };
        }
        // The validator keeps the unknown-key rule only on the one-block
        // form of rootfs, initramfs, kernel and permissions (schema-client.ts).
        if (e.keyword === "additionalProperties") {
          const key = String(e.params?.additionalProperty);
          return {
            instancePath: path,
            message: `is not one block, because '${key}' is not a field. A block that sets a field cannot also hold named entries`,
          };
        }
        const params =
          e.params && Object.keys(e.params).length > 0
            ? `: ${JSON.stringify(e.params)}`
            : "";
        return {
          instancePath: path,
          message: (e.message ?? "(no message)") + params,
        };
      });

  return {
    ok: !!ok,
    errors,
    warnings: [
      ...ignoredKeys(schema, parsed),
      ...stoneManifestWarnings(parsed, projectDir),
    ],
    schemaSource: source,
  };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Every `stone_manifest` in the runtimes, with its key path. A target
 * override (`runtimes.<r>.<target>:`) can set one too. Pass `runtime` to read
 * only that runtime.
 */
export function stoneManifests(
  doc: unknown,
  runtime?: string,
): { key: string; value: unknown }[] {
  const out: { key: string; value: unknown }[] = [];
  const runtimes = isRecord(doc) ? doc.runtimes : undefined;
  if (!isRecord(runtimes)) return out;
  for (const [name, rt] of Object.entries(runtimes)) {
    if ((runtime !== undefined && name !== runtime) || !isRecord(rt)) continue;
    if (Object.hasOwn(rt, "stone_manifest")) {
      out.push({
        key: `runtimes.${name}.stone_manifest`,
        value: rt.stone_manifest,
      });
    }
    for (const [k, sub] of Object.entries(rt)) {
      if (isRecord(sub) && Object.hasOwn(sub, "stone_manifest")) {
        out.push({
          key: `runtimes.${name}.${k}.stone_manifest`,
          value: sub.stone_manifest,
        });
      }
    }
  }
  return out;
}

/**
 * Checks for `runtimes.<r>.stone_manifest`. The CLI passes it to the SDK
 * container as `/opt/src/<value>` (avocado-cli `get_stone_manifest_for_runtime`),
 * so it must be relative to the source directory. `provision --list` reads
 * only the BSP manifest (avocado-cli `commands/profiles.rs`).
 */
export function stoneManifestWarnings(
  doc: unknown,
  projectDir?: string,
): string[] {
  const found = stoneManifests(doc);
  if (found.length === 0) return [];
  const warnings: string[] = [];
  const srcDir = isRecord(doc) ? doc.src_dir : undefined;
  for (const { key, value } of found) {
    if (typeof value !== "string") continue;
    if (path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
      warnings.push(
        `'${key}' is an absolute path. The CLI puts '/opt/src/' in front of it, so the build cannot find the manifest. Use a path relative to the project directory.`,
      );
      continue;
    }
    if (path.posix.normalize(value).startsWith("../")) {
      warnings.push(
        `'${key}' points outside the project directory. The SDK container sees only the project directory (at '/opt/src'), so the build cannot find the manifest. Copy the manifest into the project.`,
      );
      continue;
    }
    // The CLI resolves a template, so the file path is not known here. This
    // applies to a templated `src_dir` too.
    if (!projectDir || value.includes("{{")) continue;
    if (typeof srcDir === "string" && srcDir.includes("{{")) continue;
    const base =
      typeof srcDir === "string" && srcDir
        ? path.resolve(projectDir, srcDir)
        : path.resolve(projectDir);
    const file = path.resolve(base, value);
    if (!existsSync(file)) {
      warnings.push(
        `'${key}' is '${value}', but ${file} does not exist. The build fails until the file is there.`,
      );
    }
  }
  const keys = found.map(({ key }) => `'${key}'`).join(", ");
  warnings.push(
    `A custom stone manifest is set (${keys}). 'avocado provision --list', the list-provision-profiles tool and the docs board data show the profiles of the BSP manifest, not of this file. Read the profiles in the file itself.`,
  );
  return warnings;
}

const DEFAULT_TEMPLATE = readFileSync(
  new URL("./schema/default.yaml", import.meta.url),
  "utf8",
);

/**
 * Starter avocado.yaml for when the avocado CLI is not available. It is the
 * CLI's own `configs/default.yaml` (vendored in `src/lib/schema/`), with the
 * caller's values written into the template text at the place of each node.
 * Re-serializing the whole document would move the template's comments, so
 * only the edited values are written, each quoted by the `yaml` package.
 * When the CLI is available, `avocado init` is the better path.
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
  const text = DEFAULT_TEMPLATE;
  const doc = parseDocument(text);
  const edits: { at: number; end: number; text: string }[] = [];
  const range = (path: (string | number)[]) => {
    const node = doc.getIn(path, true) as { range?: number[] } | undefined;
    if (!node?.range)
      throw new Error(`starter template has no ${path.join(".")}`);
    return node.range;
  };
  // Keep the template's quote style, so an unchanged value reads the same.
  const replace = (path: (string | number)[], value: unknown) => {
    const [at, end] = range(path);
    const quoted = (doc.getIn(path, true) as Scalar).type === "QUOTE_DOUBLE";
    edits.push({ at, end, text: scalar(value, quoted) });
  };
  // New lines after the node at `path`, indented like that node's line.
  const insertAfter = (path: (string | number)[], ...lines: string[]) => {
    const [start, end] = range(path);
    const lineStart = text.lastIndexOf("\n", start) + 1;
    const indent = /^\s*/.exec(text.slice(lineStart, start))![0];
    const added = lines.map((line) => `\n${indent}${line}`).join("");
    edits.push({ at: end, end, text: added });
  };

  replace(["default_target"], opts.target);
  replace(["supported_targets", 0], opts.target);
  if (opts.board) {
    insertAfter(
      ["default_target"],
      `default_target_board: ${scalar(opts.board)}`,
    );
  }
  if (opts.release) {
    replace(
      ["distro", "release"],
      /^\d+$/.test(opts.release) ? Number(opts.release) : opts.release,
    );
  }
  if (opts.channel) replace(["distro", "channel"], opts.channel);
  if (opts.repoUrl) {
    insertAfter(
      ["distro", "channel"],
      "repo:",
      `  url: ${scalar(opts.repoUrl)}`,
    );
  }

  const runtimes = doc.get("runtimes") as YAMLMap;
  const runtime = runtimes.items[0];
  if (opts.runtimeName) {
    const [at, end] = (runtime.key as Scalar).range!;
    edits.push({ at, end, text: scalar(opts.runtimeName) });
  }
  const name = (runtime.key as Scalar).value as string;
  const extensions = doc.getIn(["runtimes", name, "extensions"]) as YAMLSeq;
  for (const e of opts.extraExtensions ?? []) {
    insertAfter(
      ["runtimes", name, "extensions", extensions.items.length - 1],
      `- ${scalar(e)}`,
    );
  }

  // Apply from the end, so earlier offsets stay valid. Insertions at one
  // place keep their order.
  let out = text;
  for (const e of edits.reverse().sort((x, y) => y.at - x.at)) {
    out = out.slice(0, e.at) + e.text + out.slice(e.end);
  }
  return out;
}

/**
 * One YAML scalar on one line. It is quoted when the value needs it, or
 * always in double quotes with `quoted`.
 */
function scalar(value: unknown, quoted = false): string {
  return stringify(value, {
    lineWidth: 0,
    blockQuote: false,
    defaultStringType: quoted ? "QUOTE_DOUBLE" : "PLAIN",
  }).trimEnd();
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
