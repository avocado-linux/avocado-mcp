import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "fs";
import { parse } from "yaml";
import { ignoredKeys } from "../../src/lib/config-lint.js";

// The vendored schema, so these tests never touch the network. The cases are
// the tests of avocado-cli/src/utils/config_lint.rs, so the MCP warns exactly
// where the CLI does.
const SCHEMA = JSON.parse(
  readFileSync(
    new URL("../../src/lib/schema/avocado-config.json", import.meta.url),
    "utf8",
  ),
);
const warnings = (yaml: string) => ignoredKeys(SCHEMA, parse(yaml));

test("the CLI template has no warnings", () => {
  const template = readFileSync(
    new URL("../../src/lib/schema/default.yaml", import.meta.url),
    "utf8",
  ).replaceAll("{target}", "qemux86-64");
  assert.deepEqual(warnings(template), []);
});

test("a clean config has no warnings", () => {
  const yaml = `
default_target: qemux86-64
supported_targets: ["qemux86-64"]
distro: { release: 2024, channel: edge }
runtimes:
  dev:
    extensions: [app, { avocado-ext-dev: { enabled: false } }]
    packages: { avocado-runtime: "*" }
    target-qemux86-64:
      packages: { extra: "*" }
extensions:
  app:
    types: [sysext]
    version: "0.1.0"
    overlay: { dir: overlay, mode: opaque }
    packages:
      my-app: { compile: my-app, install: install.sh }
  "avocado-bsp-{{ avocado.target.board }}":
    source: { type: package, version: "*" }
  remote:
    source: { type: git, url: "https://example.com/x.git", ref: main }
rootfs: { permissions: dev }
permissions:
  dev:
    users: { root: { password: "" } }
sdk:
  image: "docker.io/avocadolinux/sdk:{{ config.distro.release }}"
  container_args: "--privileged"
  packages: { "libstdc++": "*" }
`;
  assert.deepEqual(warnings(yaml), []);
});

test("flags unknown keys with suggestions", () => {
  assert.deepEqual(
    warnings("sdkk: {}\nruntimes:\n  dev:\n    extentions: [app]\n"),
    [
      "unknown key 'sdkk' is ignored; did you mean 'sdk'?",
      "unknown key 'runtimes.dev.extentions' is ignored; did you mean 'extensions'?",
    ],
  );
});

test("names the replacement for renamed keys", () => {
  assert.deepEqual(
    warnings("ext: {}\nextensions:\n  app: { sysext: true }\n"),
    [
      "'ext' is an old name for 'extensions' and is no longer read; rename it to 'extensions'",
      "'extensions.app.sysext' is no longer read; list the image types under 'types', e.g. 'types: [sysext]'",
    ],
  );
});

test("offers no suggestion when nothing is close", () => {
  assert.deepEqual(warnings("extensions:\n  app: { files: [a] }\n"), [
    "unknown key 'extensions.app.files' is ignored",
  ]);
});

test("flags a misspelled singleton read as a named entry", () => {
  assert.deepEqual(
    warnings(
      'rootfs:\n  pakages: { curl: "*" }\npermissions:\n  usres: { root: {} }\n',
    ),
    [
      "'rootfs.pakages' sets no rootfs fields, so it is read as a named rootfs entry; did you mean the field 'packages'?",
      "'permissions.usres' sets no permissions fields, so it is read as a named permissions entry; did you mean the field 'users'?",
    ],
  );
});

test("a real named entry is fine", () => {
  assert.deepEqual(
    warnings(
      'kernel:\n  yocto-6-6: { package: kernel, version: "6.6.*" }\nrootfs:\n  empty: {}\n',
    ),
    [],
  );
});

test("a misspelled field beside a real one is flagged in place", () => {
  assert.deepEqual(
    warnings("rootfs:\n  permissions: dev\n  filesytem: erofs\n"),
    ["unknown key 'rootfs.filesytem' is ignored; did you mean 'filesystem'?"],
  );
});

test("picks the source branch by type", () => {
  assert.deepEqual(
    warnings(
      "extensions:\n  a:\n    source: { type: path, path: ../a, url: x }\n",
    ),
    ["unknown key 'extensions.a.source.url' is ignored"],
  );
});

test("accepts bare target overrides only where the CLI reads them", () => {
  assert.deepEqual(
    warnings(
      "extensions:\n  app:\n    raspberrypi4: { packages: {} }\nrepos:\n  acme:\n    raspberrypi4: {}\n",
    ),
    ["unknown key 'repos.acme.raspberrypi4' is ignored"],
  );
});

test("reports keys that parse but misbehave", () => {
  assert.deepEqual(warnings('sdk:\n  dependencies: { gcc: "*" }\n'), [
    "'sdk.dependencies' is an old name for 'packages', and 'avocado sdk install' only installs 'packages'; rename it to 'packages'",
  ]);
});

test("flags fields read only on the top-level block", () => {
  assert.deepEqual(
    warnings(
      "kernel:\n  lts: { package: k, source: { type: path, path: k } }\nrootfs:\n  default: { packages: {}, overlay: o }\nruntimes:\n  dev:\n    rootfs: { permissions: dev, packages: {} }\n",
    ),
    [
      "unknown key 'kernel.lts.source' is ignored",
      "unknown key 'rootfs.default.overlay' is ignored",
      "unknown key 'runtimes.dev.rootfs.packages' is ignored",
    ],
  );
});

test("a templated source type is not guessed", () => {
  assert.deepEqual(
    warnings(
      'source_kind: git\nextensions:\n  app:\n    source:\n      type: "{{ config.source_kind }}"\n      url: https://example.com/app.git\n',
    ),
    [],
  );
});

test("source is a path source only with type path", () => {
  assert.deepEqual(
    warnings("kernel:\n  source: { compile: linux, install: install.sh }\n"),
    [],
  );
  assert.deepEqual(
    warnings("rootfs:\n  source: { type: path, path: fragments/rootfs }\n"),
    [],
  );
});

test("a bare override for a custom target is recognised by shape", () => {
  assert.deepEqual(
    warnings(
      'default_target: "{{ env.PROJECT_TARGET }}"\nsdk:\n  acme-board: { image: x, imgae: y }\nruntimes:\n  dev:\n    pakages: { curl: "*" }\n',
    ),
    [
      "unknown key 'sdk.acme-board.imgae' is ignored; did you mean 'image'?",
      "unknown key 'runtimes.dev.pakages' is ignored; did you mean 'packages'?",
    ],
  );
});

test("flags image fields a target override does not take", () => {
  assert.deepEqual(
    warnings(
      'rootfs:\n  packages: {}\n  target-qemux86-64:\n    post_install: a.sh\n    packages: { curl: "*" }\n',
    ),
    ["unknown key 'rootfs.target-qemux86-64.packages' is ignored"],
  );
});

test("allows top-level keys used as interpolation variables", () => {
  assert.deepEqual(
    warnings(
      'base_image: foo\nunused: 1\nsdk:\n  image: "{{ config.base_image }}"\n',
    ),
    ["unknown key 'unused' is ignored"],
  );
});

test("indexes sequence paths", () => {
  assert.deepEqual(
    warnings(
      'extensions:\n  app:\n    docker_images:\n      - { image: redis, tag: "7", digest: x }\n',
    ),
    ["unknown key 'extensions.app.docker_images[0].digest' is ignored"],
  );
});

test("templated keys are names, not fields", () => {
  assert.deepEqual(
    warnings('runtimes:\n  dev:\n    "{{ avocado.target }}-thing": {}\n'),
    [],
  );
});

// MCP addition: the CLI accepts these silently, but new YAML must not use them.
test("deprecated keys without their own warning are reported", () => {
  assert.deepEqual(
    warnings(
      'distro: { version: 2024 }\nextensions:\n  app:\n    users: { root: { password: "" } }\n',
    ),
    [
      "'distro.version' is deprecated. Old name for 'release', still accepted.",
      "'extensions.app.users' is deprecated. Define users in a top-level 'permissions' profile instead.",
    ],
  );
});

test("a key named like an Object prototype member is still unknown", () => {
  assert.deepEqual(warnings("constructor: 1\n"), [
    "unknown key 'constructor' is ignored",
  ]);
});
