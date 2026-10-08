import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { parse } from "yaml";
import {
  addExtension,
  addRuntime,
  addPackageToExtension,
  listExtensions,
  buildStarterYaml,
  validateAvocadoYaml,
} from "../../src/lib/yaml-ops.js";

// Validate against the vendored schema: no network in tests.
process.env.AVOCADO_MCP_SCHEMA_OFFLINE = "1";

const WITH_COMMENTS = `# my avocado project
sdk:
  image: avocado-sdk   # pinned deliberately

extensions:
  app:
    # the application extension
    types: [sysext]
    packages:
      curl: "*"
`;

// ---------------------------------------------------------------------------
// The whole point of using the Document API is comment + format preservation.
// ---------------------------------------------------------------------------

test("user comments survive a mutation", () => {
  const out = addPackageToExtension(WITH_COMMENTS, {
    extension: "app",
    packageName: "jq",
  });
  assert.match(out, /# my avocado project/);
  assert.match(out, /# the application extension/);
  assert.match(out, /# pinned deliberately/);
  assert.match(out, /jq: "\*"/);
});

test("mutation is additive — nothing pre-existing is dropped", () => {
  const out = addPackageToExtension(WITH_COMMENTS, {
    extension: "app",
    packageName: "jq",
  });
  assert.match(out, /curl: "\*"/);
  assert.match(out, /image: avocado-sdk/);
});

test("a mutation round-trips: the output is re-editable", () => {
  let y = addExtension("", { name: "app", types: ["sysext"] });
  y = addPackageToExtension(y, { extension: "app", packageName: "curl" });
  y = addRuntime(y, { name: "dev", extensions: ["app"] });
  y = addPackageToExtension(y, {
    extension: "app",
    packageName: "jq",
    version: "1.7",
  });
  assert.deepEqual(listExtensions(y), [{ name: "app", types: ["sysext"] }]);
  assert.match(y, /jq: 1.7|jq: "1.7"/);
});

test("adding N packages in sequence yields N packages", () => {
  let y = addExtension("", { name: "app" });
  for (const p of ["curl", "jq", "vim", "git"]) {
    y = addPackageToExtension(y, { extension: "app", packageName: p });
  }
  assert.equal((y.match(/: "\*"/g) ?? []).length, 4);
});

// ---------------------------------------------------------------------------
// Failure modes. These functions take LLM-generated arguments; the error
// messages are what the model reads to recover, so they are part of the API.
// ---------------------------------------------------------------------------

test("malformed input YAML is refused rather than silently rewritten", () => {
  const broken = "extensions:\n  app:\n   - [unclosed\n";
  for (const fn of [
    () => addExtension(broken, { name: "x" }),
    () => addRuntime(broken, { name: "x", extensions: [] }),
    () =>
      addPackageToExtension(broken, { extension: "app", packageName: "curl" }),
  ]) {
    assert.throws(fn, /Cannot parse malformed YAML/);
  }
});

test("duplicate names are refused with an actionable message", () => {
  const y = addExtension("", { name: "app" });
  assert.throws(() => addExtension(y, { name: "app" }), /already exists/);
  const r = addRuntime(y, { name: "dev", extensions: ["app"] });
  assert.throws(
    () => addRuntime(r, { name: "dev", extensions: ["app"] }),
    /replace=true/,
  );
});

test("addRuntime with replace=true overwrites in place", () => {
  let y = addRuntime("", { name: "dev", extensions: ["a"] });
  y = addRuntime(y, { name: "dev", extensions: ["b", "c"], replace: true });
  assert.doesNotMatch(y, /- a\b/);
  assert.match(y, /- b/);
  assert.equal(
    (y.match(/dev:/g) ?? []).length,
    1,
    "runtime must not be duplicated",
  );
});

test("adding a package to a nonexistent extension names the fix", () => {
  assert.throws(
    () =>
      addPackageToExtension("extensions:\n  other: {}\n", {
        extension: "app",
        packageName: "curl",
      }),
    /add-extension/,
  );
  assert.throws(
    () =>
      addPackageToExtension("sdk:\n  image: x\n", {
        extension: "app",
        packageName: "curl",
      }),
    /No `extensions:` block/,
  );
});

test("a package name with YAML metacharacters cannot inject structure", () => {
  const evil = "foo: bar\nruntimes:\n  pwned:\n    extensions: [x]";
  const out = addPackageToExtension(WITH_COMMENTS, {
    extension: "app",
    packageName: evil,
  });
  const exts = listExtensions(out);
  assert.deepEqual(
    exts.map((e) => e.name),
    ["app"],
    "no new top-level keys",
  );
  assert.doesNotMatch(
    out,
    /^runtimes:/m,
    "injected block must be quoted, not parsed",
  );
});

test("listExtensions surfaces malformed YAML instead of reporting zero extensions", () => {
  // Pin the message: it must match the same prefix the mutation helpers throw,
  // so a client can key on one string to choose a recovery path.
  assert.throws(
    () => listExtensions("extensions:\n  app:\n   - [unclosed\n"),
    /Cannot parse malformed YAML/,
  );
});

// ---------------------------------------------------------------------------
// The generated starter must satisfy the schema we validate against. If these
// two ever drift, init-project hands the user a file its own validator rejects.
// ---------------------------------------------------------------------------

test("every starter YAML validates against the bundled schema", async () => {
  for (const target of [
    "raspberrypi5",
    "qemux86-64",
    "jetson-orin-nano-devkit",
  ]) {
    const res = await validateAvocadoYaml(buildStarterYaml({ target }));
    assert.equal(res.ok, true, `${target}: ${JSON.stringify(res.errors)}`);
    assert.deepEqual(res.warnings, [], target);
  }
});

const TEMPLATE = readFileSync(
  new URL("../../src/lib/schema/default.yaml", import.meta.url),
  "utf8",
);

test("the default starter is the CLI template with the target filled in", () => {
  const out = buildStarterYaml({ target: "raspberrypi5" });
  assert.deepEqual(
    parse(out),
    parse(TEMPLATE.replaceAll("{target}", "raspberrypi5")),
  );
  // The editor modeline and the comments survive.
  assert.match(
    out,
    /^# yaml-language-server: \$schema=https:\/\/docs\.peridio\.com\/schemas\/avocado-config\.json/,
  );
  assert.match(out, /NOT FOR PRODUCTION/);
});

test("starter options land where the CLI reads them", async () => {
  const out = buildStarterYaml({
    target: "jetson-orin-nx",
    board: "mic-712-ox-16gb",
    runtimeName: "prod",
    extraExtensions: ["avocado-ext-docker"],
    release: "2026",
    channel: "stable",
    repoUrl: "https://mirror.example/avocado",
  });
  const y = parse(out);
  assert.equal(y.default_target, "jetson-orin-nx");
  assert.deepEqual(y.supported_targets, ["jetson-orin-nx"]);
  assert.equal(y.default_target_board, "mic-712-ox-16gb");
  assert.deepEqual(Object.keys(y).slice(0, 3), [
    "cli_requirement",
    "default_target",
    "default_target_board",
  ]);
  assert.deepEqual(Object.keys(y.runtimes), ["prod"]);
  assert.equal(y.runtimes.prod.extensions.at(-1), "avocado-ext-docker");
  assert.deepEqual(y.distro, {
    release: 2026,
    channel: "stable",
    repo: { url: "https://mirror.example/avocado" },
  });
  const res = await validateAvocadoYaml(out);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
});

test("a starter value with YAML syntax stays one string", () => {
  const evil = "x\nruntimes:\n  pwned: {}";
  const y = parse(
    buildStarterYaml({ target: "qemux86-64", extraExtensions: [evil] }),
  );
  assert.equal(y.runtimes.dev.extensions.at(-1), evil);
  assert.deepEqual(Object.keys(y.runtimes), ["dev"]);
});

test("validation of the starter makes no network call", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("network access during validate-yaml");
  }) as typeof fetch;
  try {
    assert.equal(
      (await validateAvocadoYaml(buildStarterYaml({ target: "raspberrypi5" })))
        .ok,
      true,
    );
  } finally {
    globalThis.fetch = real;
  }
});

test("a YAML parse error is returned as a result, not thrown", async () => {
  const res = await validateAvocadoYaml(
    "extensions:\n  app:\n   - [unclosed\n",
  );
  assert.equal(res.ok, false);
  assert.match(res.errors[0]!.message, /YAML parse error/);
});

test("schema errors carry an instancePath the model can act on", async () => {
  const res = await validateAvocadoYaml(
    "extensions:\n  app:\n    types: not-a-list\n",
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.every(
      (e) => typeof e.instancePath === "string" && e.instancePath.length,
    ),
  );
});

// ---------------------------------------------------------------------------
// The CLI schema. These configs come from the audit probe: the old
// hand-written schema got each of them wrong.
// ---------------------------------------------------------------------------

const BASE =
  "distro: {release: 2024, channel: edge}\nruntimes:\n  dev:\n    extensions: [app]\n";

for (const [name, yaml] of Object.entries({
  "git source": `${BASE}extensions:\n  app:\n    source: {type: git, url: https://x/y.git, ref: main}\n`,
  "path source": `${BASE}extensions:\n  app:\n    source: {type: path, path: ../app}\n`,
  "version from a file": `${BASE}extensions:\n  app:\n    types: [sysext]\n    version: {file: Cargo.toml, key: package.version, format: toml}\n`,
  "runtime extension in object form":
    "distro: {release: 2024, channel: edge}\nruntimes:\n  dev:\n    extensions:\n      - app: {enabled: false}\n",
  "distro.repo as a repos: name":
    "distro: {release: 2024, channel: edge, repo: mirror, feeds: [acme]}\nrepos:\n  mirror: {url: https://m}\n  acme: {org: acme}\nruntimes: {dev: {extensions: [a]}}\n",
  "extension-only config":
    "supported_targets: '*'\nextensions:\n  foo: {types: [sysext], version: \"1.0.0\"}\n",
  "new keys (depends_on, verity, var encryption, cmdline_extra)":
    'distro: {release: 2024, channel: edge}\nkernel: {cmdline_extra: earlycon}\nextensions:\n  app:\n    types: [sysext]\n    version: "1"\n    depends_on: [base]\n    image: {verity: true}\nruntimes:\n  dev:\n    extensions: [app]\n    var: {encrypt: true, hardware: tpm2, recovery: rk}\n    signing: {fit_key: fk}\n',
})) {
  test(`valid: ${name}`, async () => {
    const res = await validateAvocadoYaml(yaml);
    assert.equal(res.ok, true, JSON.stringify(res.errors));
    assert.deepEqual(res.warnings, []);
  });
}

test("a typo key is a warning, as in the CLI, not an error", async () => {
  const res = await validateAvocadoYaml(
    `${BASE}extensions:\n  app:\n    types: [sysext]\n    version: "1"\n    enable_service: [x.service]\nrutimes: {}\n`,
  );
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.warnings, [
    "unknown key 'extensions.app.enable_service' is ignored; did you mean 'enable_services'?",
    "unknown key 'rutimes' is ignored; did you mean 'runtimes'?",
  ]);
});

test("kernel cmdline with cmdline_extra is an error", async () => {
  const res = await validateAvocadoYaml(
    "kernel: {cmdline: a, cmdline_extra: b}\n",
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some(
      (e) =>
        e.instancePath === "/kernel/cmdline_extra" &&
        /must not be set together/.test(e.message),
    ),
    JSON.stringify(res.errors),
  );
});

test("an unknown var.hardware value is an error", async () => {
  const res = await validateAvocadoYaml(
    "runtimes:\n  dev:\n    extensions: [a]\n    var: {encrypt: true, hardware: bogus}\n",
  );
  assert.equal(res.ok, false);
  assert.ok(
    res.errors.some((e) => e.instancePath === "/runtimes/dev/var/hardware"),
    JSON.stringify(res.errors),
  );
});

test("add-extension writes git and path sources and depends_on", async () => {
  let y = addExtension(BASE, {
    name: "app",
    source: { type: "git", url: "https://x/y.git", ref: "main" },
    dependsOn: ["base"],
  });
  y = addExtension(y, {
    name: "base",
    source: { type: "path", path: "../base" },
  });
  const parsed = parse(y);
  assert.deepEqual(parsed.extensions.app, {
    source: { type: "git", url: "https://x/y.git", ref: "main" },
    depends_on: ["base"],
  });
  assert.deepEqual(parsed.extensions.base, {
    source: { type: "path", path: "../base" },
  });
  const res = await validateAvocadoYaml(y);
  assert.equal(res.ok, true, JSON.stringify(res.errors));
  assert.deepEqual(res.warnings, []);
});
