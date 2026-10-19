import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { parse } from "yaml";
import {
  addExtension,
  addRuntime,
  addPackageToExtension,
  listExtensions,
  buildStarterYaml,
  validateAvocadoYaml,
  stoneManifests,
} from "../../src/lib/yaml-ops.js";
import { fakeAvocado } from "./fake-cli.js";

// A fake CLI for the schema and validation. The CLI tests what it reports.
process.env.AVOCADO_BINARY = fakeAvocado();

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

const TEMPLATE = readFileSync(
  new URL("../../src/lib/schema/default.yaml", import.meta.url),
  "utf8",
);

/** Comment lines with their indentation, in order. */
const comments = (yaml: string) =>
  yaml.split("\n").filter((line) => /^\s*#/.test(line));

test("the default starter is the CLI template with the target filled in", () => {
  const out = buildStarterYaml({ target: "raspberrypi5" });
  // Text, not only data: every comment stays where the template has it.
  assert.equal(out, TEMPLATE.replaceAll("{target}", "raspberrypi5"));
  assert.match(
    out,
    /^# yaml-language-server: \$schema=https:\/\/docs\.peridio\.com\/schemas\/avocado-config\.json/,
  );
  assert.match(out, /NOT FOR PRODUCTION/);
  assert.match(out, /\n\n##\n## Images\n##\n\nrootfs:/);
});

test("starter options land where the CLI reads them", () => {
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
  assert.deepEqual(comments(out), comments(TEMPLATE));
});

test("a starter value with YAML syntax stays one string", () => {
  const evil = "x\nruntimes:\n  pwned: {}";
  const y = parse(
    buildStarterYaml({ target: "qemux86-64", extraExtensions: [evil] }),
  );
  assert.equal(y.runtimes.dev.extensions.at(-1), evil);
  assert.deepEqual(Object.keys(y.runtimes), ["dev"]);
});

const BASE =
  "distro: {release: 2024, channel: edge}\nruntimes:\n  dev:\n    extensions: [app]\n";

test("add-extension writes git and path sources and depends_on", () => {
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
});

test("stone_manifest must be a relative path inside the project", async () => {
  for (const [value, re] of [
    ["/home/me/stone.json", /is an absolute path/],
    ["../shared/stone.json", /points outside the project directory/],
  ] as const) {
    const res = await validateAvocadoYaml(
      `runtimes:\n  dev:\n    stone_manifest: ${value}\n`,
    );
    assert.equal(res.ok, true);
    assert.ok(
      res.warnings.some((w) => re.test(w)),
      JSON.stringify(res.warnings),
    );
  }
});

test("with a projectDir, a missing stone_manifest file is a warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "avocado-mcp-stone-"));
  try {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "stone-a.json"), "{}");
    writeFileSync(join(dir, "src", "stone-b.json"), "{}");
    const missing = (yaml: string, projectDir?: string) =>
      validateAvocadoYaml(yaml, projectDir).then((r) =>
        r.warnings.filter((w) => w.includes("does not exist")),
      );
    const yaml =
      "runtimes:\n  dev:\n    stone_manifest: stone-a.json\n  prod:\n    stone_manifest: stone-b.json\n";
    const out = await missing(yaml, dir);
    assert.equal(out.length, 1, JSON.stringify(out));
    assert.match(
      out[0]!,
      /'runtimes\.prod\.stone_manifest' is 'stone-b\.json'/,
    );
    // Paths are relative to src_dir when it is set.
    assert.deepEqual(
      await missing("src_dir: src\n" + yaml.replace("stone-a", "stone-b"), dir),
      [],
    );
    // A templated src_dir is not resolved here, so the file is not checked.
    // With SOURCE_ROOT=src, the CLI finds src/stone.json.
    writeFileSync(join(dir, "src", "stone.json"), "{}");
    assert.deepEqual(
      await missing(
        'src_dir: "{{ env.SOURCE_ROOT }}"\nruntimes:\n  dev:\n    stone_manifest: stone.json\n',
        dir,
      ),
      [],
    );
    // Without a projectDir, the file is not checked.
    assert.deepEqual(await missing(yaml), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a custom stone manifest adds a note about the profile tools", async () => {
  const note = (yaml: string) =>
    validateAvocadoYaml(yaml).then((r) =>
      r.warnings.filter((w) => w.includes("custom stone manifest")),
    );
  assert.deepEqual(await note("runtimes:\n  dev:\n    packages: {}\n"), []);
  const [one] = await note(
    "runtimes:\n  dev:\n    raspberrypi5:\n      stone_manifest: stone-rpi5.json\n",
  );
  assert.match(one!, /'runtimes\.dev\.raspberrypi5\.stone_manifest'/);
  assert.match(one!, /avocado provision --list/);
  assert.match(one!, /list-provision-profiles/);
});

test("stoneManifests reads one runtime or all of them", () => {
  const doc = parse(
    "runtimes:\n  dev:\n    stone_manifest: a.json\n  prod:\n    target-imx93-frdm:\n      stone_manifest: b.json\n",
  );
  assert.deepEqual(
    stoneManifests(doc).map((m) => m.key),
    [
      "runtimes.dev.stone_manifest",
      "runtimes.prod.target-imx93-frdm.stone_manifest",
    ],
  );
  assert.deepEqual(
    stoneManifests(doc, "prod").map((m) => m.value),
    ["b.json"],
  );
  assert.deepEqual(stoneManifests(doc, "test"), []);
});

test("without a CLI, validation reports why and still returns", async () => {
  const real = process.env.AVOCADO_BINARY;
  process.env.AVOCADO_BINARY = join(tmpdir(), "no-such-avocado");
  try {
    const res = await validateAvocadoYaml("runtimes: {}\n");
    assert.equal(res.ok, false);
    assert.equal(res.schemaSource, "none");
    assert.match(res.errors[0].message, /not installed or not on PATH/);
  } finally {
    process.env.AVOCADO_BINARY = real;
  }
});

// ---------------------------------------------------------------------------
// Validation is the CLI's (`avocado config validate`). The MCP passes the YAML
// through, shows the report, and adds the stone checks.
// ---------------------------------------------------------------------------

/** Run `fn` with the fake CLI printing `report`. */
async function withReport<T>(report: object, fn: () => Promise<T>) {
  process.env.FAKE_AVOCADO_REPORT = JSON.stringify(report);
  try {
    return await fn();
  } finally {
    delete process.env.FAKE_AVOCADO_REPORT;
  }
}

test("the YAML goes to the CLI unchanged on stdin", async () => {
  const yaml = "# keep me\nruntimes:\n  dev: {}\n";
  await validateAvocadoYaml(yaml);
  const stdin = join(dirname(process.env.AVOCADO_BINARY!), "stdin.yaml");
  assert.equal(readFileSync(stdin, "utf8"), yaml);
});

test("the CLI report is the result, with the stone checks added", async () => {
  const res = await withReport(
    {
      ok: false,
      errors: [
        {
          path: "/runtimes/dev/extensions",
          message: '5 is not of type "array"',
        },
        { path: "", message: "YAML parse error: bad" },
      ],
      warnings: ["unknown key 'rutimes' is ignored; did you mean 'runtimes'?"],
    },
    () =>
      validateAvocadoYaml("runtimes:\n  dev:\n    stone_manifest: /abs.json\n"),
  );
  assert.equal(res.ok, false);
  assert.deepEqual(res.errors, [
    {
      instancePath: "/runtimes/dev/extensions",
      message: '5 is not of type "array"',
    },
    { instancePath: "(root)", message: "YAML parse error: bad" },
  ]);
  assert.equal(
    res.warnings[0],
    "unknown key 'rutimes' is ignored; did you mean 'runtimes'?",
  );
  assert.ok(
    res.warnings.some((w) => /is an absolute path/.test(w)),
    JSON.stringify(res.warnings),
  );
  assert.equal(res.schemaSource, "`avocado config validate`");
});
