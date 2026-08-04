/**
 * avocado.yaml helpers: parse / validate / safe-mutate.
 *
 * Validation uses Ajv against the live JSON Schema fetched from
 * github.com/avocado-linux/avocado-config. Mutations preserve formatting and
 * comments by using the `yaml` package's Document API rather than parse +
 * stringify.
 */

import { parseDocument, isMap, isSeq, YAMLMap, YAMLSeq, Scalar } from "yaml";
import { createRequire } from "module";
import { fetchSchema } from "./schema-client.js";

// Ajv 8 / ajv-formats are CJS modules; reach for them via createRequire to
// avoid TypeScript Node16-ESM default-interop awkwardness.
const cjsRequire = createRequire(import.meta.url);
type AjvErrorObject = {
  instancePath: string;
  message?: string;
  params?: unknown;
};
type AjvCtor = new (opts?: unknown) => {
  compile: (schema: object) => ((data: unknown) => boolean) & {
    errors?: AjvErrorObject[] | null;
  };
};
const Ajv = cjsRequire("ajv/dist/2020").default as AjvCtor;
const addFormats = cjsRequire("ajv-formats").default as (
  ajv: InstanceType<AjvCtor>,
) => InstanceType<AjvCtor>;

export interface YamlValidationResult {
  ok: boolean;
  errors: { instancePath: string; message: string }[];
  schemaSource: string;
  schemaVersion: string;
}

export async function validateAvocadoYaml(
  yamlText: string,
  schemaVersion?: string,
): Promise<YamlValidationResult> {
  const { schema, version, source } = await fetchSchema(schemaVersion);

  let parsed: unknown;
  try {
    const doc = parseDocument(yamlText);
    if (doc.errors.length > 0) {
      return {
        ok: false,
        errors: doc.errors.map((e) => ({
          instancePath: "",
          message: `YAML parse error: ${e.message}`,
        })),
        schemaSource: source,
        schemaVersion: version,
      };
    }
    parsed = doc.toJS();
  } catch (e) {
    return {
      ok: false,
      errors: [
        {
          instancePath: "",
          message: `YAML parse error: ${(e as Error).message}`,
        },
      ],
      schemaSource: source,
      schemaVersion: version,
    };
  }

  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const validate = ajv.compile(schema as object);
  const ok = validate(parsed);
  const errors: { instancePath: string; message: string }[] = ok
    ? []
    : (validate.errors ?? []).map((e) => ({
        instancePath: e.instancePath || "(root)",
        message: `${e.message ?? "(no message)"}${e.params ? " — " + JSON.stringify(e.params) : ""}`,
      }));

  return { ok: !!ok, errors, schemaSource: source, schemaVersion: version };
}

/**
 * Generate a starter avocado.yaml for a given target.
 * Mirrors the avocado-cli's default template.
 */
export function buildStarterYaml(opts: {
  target: string;
  runtimeName?: string;
  extraExtensions?: string[];
}): string {
  const target = opts.target;
  const runtime = opts.runtimeName ?? "dev";
  const extraExt = opts.extraExtensions ?? [];
  const lines: string[] = [];

  lines.push(`cli_requirement: ">=0.26.0"`);
  lines.push(``);
  lines.push(`default_target: ${target}`);
  lines.push(``);
  lines.push(`supported_targets:`);
  lines.push(`  - ${target}`);
  lines.push(``);
  lines.push(`distro:`);
  lines.push(`  release: 2024`);
  lines.push(`  channel: edge`);
  lines.push(``);
  lines.push(`runtimes:`);
  lines.push(`  ${runtime}:`);
  lines.push(`    extensions:`);
  lines.push(`      - avocado-ext-dev`);
  lines.push(`      - avocado-ext-sshd-dev`);
  // BSP extension uses Jinja templating so a single avocado.yaml works for
  // every target in `supported_targets`. `{{ avocado.target }}` resolves at
  // build time to the active target slug (e.g. `avocado-bsp-raspberrypi5`).
  lines.push(`      - avocado-bsp-{{ avocado.target }}`);
  lines.push(`      - config`);
  lines.push(`      - app`);
  for (const e of extraExt) lines.push(`      - ${e}`);
  lines.push(`    packages:`);
  lines.push(`      avocado-runtime: "*"`);
  lines.push(``);
  lines.push(`extensions:`);
  lines.push(`  avocado-ext-dev:`);
  lines.push(`    source:`);
  lines.push(`      type: package`);
  lines.push(`      version: "*"`);
  lines.push(``);
  lines.push(`  avocado-ext-sshd-dev:`);
  lines.push(`    source:`);
  lines.push(`      type: package`);
  lines.push(`      version: "*"`);
  lines.push(``);
  // Same templating as in the runtime extension list — the extension key
  // must match the entry above.
  lines.push(`  avocado-bsp-{{ avocado.target }}:`);
  lines.push(`    source:`);
  lines.push(`      type: package`);
  lines.push(`      version: "*"`);
  lines.push(``);
  lines.push(
    `  # Your application extension — drop binaries, configs, services here.`,
  );
  lines.push(`  app:`);
  lines.push(`    types:`);
  lines.push(`      - sysext`);
  lines.push(`      - confext`);
  lines.push(`    version: "0.1.0"`);
  lines.push(`    # packages:`);
  lines.push(`    #   curl: "*"`);
  lines.push(``);
  lines.push(`  # Configuration extension — passwords, users, network config.`);
  lines.push(`  config:`);
  lines.push(`    types:`);
  lines.push(`      - confext`);
  lines.push(`    version: "0.1.0"`);
  lines.push(
    `    # NOT FOR PRODUCTION: empty root password for dev convenience.`,
  );
  lines.push(`    users:`);
  lines.push(`      root:`);
  lines.push(`        password: ""`);
  lines.push(``);
  lines.push(`sdk:`);
  lines.push(
    `  image: "docker.io/avocadolinux/sdk:{{ config.distro.release }}-{{ config.distro.channel }}"`,
  );
  lines.push(`  container_args:`);
  lines.push(`    - --privileged`);
  lines.push(`    - --network=host`);
  lines.push(`    - -v /dev:/dev`);
  lines.push(`    - -v /sys:/sys`);
  lines.push(`  packages:`);
  lines.push(`    avocado-sdk-toolchain: "*"`);
  lines.push(``);

  return lines.join("\n");
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
  if (opts.types && opts.types.length > 0) ext.types = opts.types;
  if (opts.version) ext.version = opts.version;
  if (opts.packages && Object.keys(opts.packages).length > 0)
    ext.packages = opts.packages;
  if (opts.overlay) ext.overlay = opts.overlay;
  if (opts.enableServices && opts.enableServices.length > 0)
    ext.enable_services = opts.enableServices;

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
