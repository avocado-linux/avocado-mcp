import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addExtension,
  addRuntime,
  addPackageToExtension,
  listExtensions,
  buildStarterYaml,
  validateAvocadoYaml,
} from "../../src/lib/yaml-ops.js";

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
    assert.throws(fn, /Cannot edit malformed YAML/);
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
    /Cannot edit malformed YAML/,
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
  }
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
