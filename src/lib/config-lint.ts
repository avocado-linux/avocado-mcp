/**
 * Warnings for keys in `avocado.yaml` that the CLI ignores.
 *
 * A port of `avocado-cli/src/utils/config_lint.rs`. The CLI never fails on an
 * unknown key. It walks the file against the schema and prints one warning per
 * key the schema does not describe, plus the `x-avocado-warning` text for keys
 * that parse but do nothing. We do the same so validate-yaml reports these as
 * warnings, with the same wording, and not as errors.
 *
 * One addition: a key marked `deprecated` in the schema without its own
 * `x-avocado-warning` also gives a warning here. The CLI accepts these keys
 * silently, but the model must not write them into new YAML.
 *
 * Keep this file close to the Rust source. When the CLI walker changes, port
 * the change here.
 */

interface Spec {
  $ref?: string;
  anyOf?: Spec[];
  oneOf?: Spec[];
  properties?: Record<string, Spec>;
  patternProperties?: Record<string, Spec>;
  additionalProperties?: boolean | Spec;
  items?: Spec;
  type?: string | string[];
  enum?: unknown[];
  deprecated?: boolean;
  description?: string;
  "x-avocado-warning"?: string;
  "x-avocado-target-overrides"?: boolean;
}

type Mapping = Record<string, unknown>;
type Fields = Record<string, Spec>;

function isMapping(v: unknown): v is Mapping {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** Own-property lookup, so a key like `constructor` never hits the prototype. */
function own<T>(
  obj: Record<string, T> | undefined,
  key: string,
): T | undefined {
  return obj && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

/** Describe every key in `doc` that the CLI ignores, one message per key. */
export function ignoredKeys(root: object, doc: unknown): string[] {
  const walker = new Walker(root as Spec, doc);
  walker.walk(root as Spec, doc, []);
  return walker.warnings;
}

class Walker {
  readonly warnings: string[] = [];
  private readonly targets: Set<string>;
  private readonly configRefs: Set<string>;

  constructor(
    private readonly root: Spec,
    doc: unknown,
  ) {
    this.targets = knownTargets(root, doc);
    this.configRefs = configRefs(doc);
  }

  walk(schema: Spec, value: unknown, path: string[]): void {
    schema = this.resolve(schema);
    const branches = schema.anyOf ?? schema.oneOf;
    if (branches) {
      const picked = this.pickBranch(
        branches.map((b) => this.resolve(b)),
        value,
      );
      if (picked) {
        const [branch, entryFields] = picked;
        if (isMapping(value) && !isUnion(branch)) {
          this.checkMapping(branch, value, path, entryFields);
        } else {
          this.walk(branch, value, path);
        }
      }
      return;
    }
    if (isMapping(value)) {
      this.checkMapping(schema, value, path, undefined);
    } else if (Array.isArray(value) && schema.items) {
      value.forEach((item, i) => {
        const last = path.pop() ?? "";
        path.push(`${last}[${i}]`);
        this.walk(schema.items!, item, path);
        path.pop();
        path.push(last);
      });
    }
  }

  /**
   * Choose the branch the CLI would read `value` as: a branch whose `enum`
   * field matches (the tagged extension `source`), then a branch that declares
   * one of the mapping's keys (the singleton form of `rootfs`, `kernel`), then
   * a map branch (their named-entry form). When the named-entry form wins over
   * a singleton, the singleton's fields come back too.
   */
  private pickBranch(
    branches: Spec[],
    value: unknown,
  ): [Spec, Fields | undefined] | undefined {
    const kind = kindOf(value);
    const fits = branches.filter((b) => acceptsKind(b, kind));
    if (!isMapping(value)) return fits[0] ? [fits[0], undefined] : undefined;

    // A templated tag only resolves at interpolation, so the shape is unknown.
    if (fits.some((b) => tag(b, value) === Tag.Templated)) return undefined;
    const matched = fits.find((b) => tag(b, value) === Tag.Matches);
    if (matched) return [matched, undefined];

    const singleton = fits.find((b) => b.properties);
    if (singleton) {
      const claims = Object.entries(value).some(([k, v]) => {
        const spec = own(singleton.properties, k);
        return (
          spec !== undefined && tag(this.resolve(spec), v) !== Tag.Mismatch
        );
      });
      if (claims) return [singleton, undefined];
    }
    const named = fits.find(
      (b) => !b.properties && isMapping(b.additionalProperties),
    );
    if (named) return [named, singleton?.properties];
    if (singleton) return [singleton, undefined];
    return fits[0] ? [fits[0], undefined] : undefined;
  }

  private checkMapping(
    schema: Spec,
    map: Mapping,
    path: string[],
    entryFields: Fields | undefined,
  ): void {
    schema = this.resolve(schema);
    const props = schema.properties;
    const additional = schema.additionalProperties;
    const targetOverrides = schema["x-avocado-target-overrides"] === true;

    for (const [key, value] of Object.entries(map)) {
      path.push(key);
      const spec = own(props, key);
      const pattern = spec ? undefined : matchingPattern(schema, key);
      if (spec || pattern) {
        const s = (spec ?? pattern)!;
        const message = s["x-avocado-warning"];
        if (typeof message === "string") {
          this.warnings.push(`'${path.join(".")}' ${message}`);
        } else {
          if (s.deprecated === true) this.warnDeprecated(path, s);
          this.walk(s, value, path);
        }
      } else if (
        targetOverrides &&
        (this.targets.has(key) || setsAField(value, props))
      ) {
        this.walk(schema, value, path);
      } else if (isMapping(additional)) {
        if (entryFields && setsNoField(value, entryFields)) {
          this.warnNamedEntry(path, key, entryFields);
        } else {
          this.walk(additional, value, path);
        }
      } else if (
        additional === false &&
        !key.includes("{{") &&
        !(path.length === 1 && this.configRefs.has(key))
      ) {
        const s = suggest(key, Object.keys(props ?? {}));
        const hint = s ? `; did you mean '${s}'?` : "";
        this.warnings.push(`unknown key '${path.join(".")}' is ignored${hint}`);
      }
      path.pop();
    }
  }

  private warnDeprecated(path: string[], spec: Spec): void {
    const text = (spec.description ?? "").replace(/^Deprecated:\s*/, "");
    const why = text.charAt(0).toUpperCase() + text.slice(1);
    this.warnings.push(
      `'${path.join(".")}' is deprecated${why ? `. ${why}` : ""}`,
    );
  }

  private warnNamedEntry(path: string[], key: string, fields: Fields): void {
    const section = path.slice(0, -1).join(".");
    const s = suggest(key, Object.keys(fields));
    const hint = s ? `; did you mean the field '${s}'?` : "";
    this.warnings.push(
      `'${path.join(".")}' sets no ${section} fields, so it is read as a named ${section} entry${hint}`,
    );
  }

  /** Follow local `$ref`s. The hop limit guards a looping fetched schema. */
  private resolve(schema: Spec): Spec {
    for (let hops = 0; hops < 32 && typeof schema.$ref === "string"; hops++) {
      if (!schema.$ref.startsWith("#")) break;
      let target: unknown = this.root;
      for (const part of schema.$ref.slice(1).split("/").slice(1)) {
        const k = part.replace(/~1/g, "/").replace(/~0/g, "~");
        target = isMapping(target) ? own(target, k) : undefined;
      }
      if (!isMapping(target)) break;
      schema = target as Spec;
    }
    return schema;
  }
}

/**
 * Whether `value` is a mapping that sets one of `fields`: the shape of a
 * bare-name per-target override.
 */
function setsAField(value: unknown, fields: Fields | undefined): boolean {
  if (!isMapping(value) || !fields) return false;
  return Object.keys(value).some((k) => Object.hasOwn(fields, k));
}

/**
 * Whether an entry of a named-entry section looks like a misspelled field of
 * the singleton form: a non-empty value that sets none of its fields.
 */
function setsNoField(value: unknown, fields: Fields): boolean {
  if (value === null || value === undefined) return false;
  if (!isMapping(value)) return true;
  const keys = Object.keys(value);
  return (
    keys.length > 0 &&
    !keys.some((k) => Object.hasOwn(fields, k) || k.startsWith("target-"))
  );
}

enum Tag {
  /** The schema has no `enum` field to discriminate on. */
  Untagged,
  Matches,
  /** Missing, or not one of the allowed values. */
  Mismatch,
  Templated,
}

/** How `value` fares against a schema's `enum` fields, such as `type: path`. */
function tag(schema: Spec, value: unknown): Tag {
  let result = Tag.Untagged;
  for (const [field, spec] of Object.entries(schema.properties ?? {})) {
    if (!Array.isArray(spec.enum)) continue;
    const actual = isMapping(value) ? own(value, field) : undefined;
    if (typeof actual === "string" && actual.includes("{{")) {
      return Tag.Templated;
    }
    if (typeof actual === "string" && spec.enum.includes(actual)) {
      result = Tag.Matches;
    } else if (result === Tag.Untagged) {
      result = Tag.Mismatch;
    }
  }
  return result;
}

function isUnion(schema: Spec): boolean {
  return schema.anyOf !== undefined || schema.oneOf !== undefined;
}

type Kind = "object" | "array" | "other";

function kindOf(value: unknown): Kind {
  if (isMapping(value)) return "object";
  return Array.isArray(value) ? "array" : "other";
}

/** Whether a (resolved) branch could describe a value of this kind. */
function acceptsKind(branch: Spec, kind: Kind): boolean {
  const t = branch.type;
  if (t === undefined) return true;
  const types = (Array.isArray(t) ? t : [t]).filter(
    (x) => typeof x === "string",
  );
  if (kind === "other") {
    return !types.every((x) => x === "object" || x === "array");
  }
  return types.includes(kind);
}

function matchingPattern(schema: Spec, key: string): Spec | undefined {
  for (const [pattern, spec] of Object.entries(
    schema.patternProperties ?? {},
  )) {
    try {
      if (new RegExp(pattern).test(key)) return spec;
    } catch {
      // A pattern JS cannot parse never matches, as in the CLI.
    }
  }
  return undefined;
}

/** The closest known key within a small, case-insensitive edit distance. */
export function suggest(key: string, known: string[]): string | undefined {
  const limit = Math.max(Math.floor([...key].length / 3), 1);
  let best: [number, string] | undefined;
  for (const candidate of known) {
    const d = osaDistance(key.toLowerCase(), candidate.toLowerCase());
    if (d > limit) continue;
    if (!best || d < best[0] || (d === best[0] && candidate < best[1])) {
      best = [d, candidate];
    }
  }
  return best?.[1];
}

/** Optimal string alignment distance, as `strsim::osa_distance`. */
function osaDistance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const d: number[][] = Array.from({ length: x.length + 1 }, (_, i) =>
    Array.from({ length: y.length + 1 }, (_, j) =>
      i === 0 ? j : j === 0 ? i : 0,
    ),
  );
  for (let i = 1; i <= x.length; i++) {
    for (let j = 1; j <= y.length; j++) {
      const cost = x[i - 1] === y[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[x.length][y.length];
}

/**
 * Target names a bare-key override may use: the ones Avocado OS ships (the
 * schema's `target` enum) plus any the file itself declares.
 */
function knownTargets(root: Spec, doc: unknown): Set<string> {
  const defs = (root as { definitions?: Record<string, Spec> }).definitions;
  const shipped = own(defs, "target")?.anyOf?.[0]?.enum ?? [];
  const targets = new Set(
    shipped.filter((t): t is string => typeof t === "string"),
  );
  const add = (v: unknown) => {
    if (typeof v === "string") targets.add(v);
    else if (Array.isArray(v)) {
      for (const t of v) if (typeof t === "string") targets.add(t);
    }
  };
  if (!isMapping(doc)) return targets;
  add(own(doc, "default_target"));
  add(own(doc, "supported_targets"));
  const runtimes = own(doc, "runtimes");
  if (isMapping(runtimes)) {
    for (const rt of Object.values(runtimes)) {
      if (!isMapping(rt)) continue;
      add(own(rt, "target"));
      add(own(rt, "targets"));
    }
  }
  return targets;
}

/** Top-level keys named by a `{{ config.<key>... }}` template anywhere. */
function configRefs(doc: unknown): Set<string> {
  const re = /\{\{\s*config\.([A-Za-z0-9_-]+)/g;
  const out = new Set<string>();
  const visit = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(re)) out.add(m[1]);
    } else if (Array.isArray(v)) {
      v.forEach(visit);
    } else if (isMapping(v)) {
      for (const [k, val] of Object.entries(v)) {
        visit(k);
        visit(val);
      }
    }
  };
  visit(doc);
  return out;
}
