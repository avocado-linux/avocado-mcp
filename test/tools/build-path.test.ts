import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { RepoClient } from "../../src/lib/repo-client.js";
import { checkBuildPath } from "../../src/tools/build-path.js";

class UnreachableRepo extends RepoClient {
  override async getTargetManifest() {
    return null;
  }
  override async fetchSnapshotPointer() {
    return null;
  }
}

class ThrowingRepo extends UnreachableRepo {
  override async getTargetManifest(): Promise<never> {
    throw new Error("connection reset");
  }
}

function project(yaml: string): { dir: string; done: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "build-path-tool-"));
  writeFileSync(join(dir, "avocado.yaml"), yaml);
  return { dir, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const NO_ENV = {};

test("unreachable remote returns verdict", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new UnreachableRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.equal(r.verdict.target, "qemux86-64");
    assert.ok(r.verdict.missing.length > 0);
    assert.ok(
      r.verdict.missing.every((m) => m.reason === "feed-unreachable"),
      JSON.stringify(r.verdict.missing),
    );
    assert.ok(
      r.verdict.warnings.some((w) =>
        /published feed could not be read/.test(w),
      ),
      JSON.stringify(r.verdict.warnings),
    );
  } finally {
    p.done();
  }
});

test("a throwing remote returns a verdict, not an exception", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new ThrowingRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "package_miss");
    assert.ok(r.verdict.missing.every((m) => m.reason === "feed-unreachable"));
  } finally {
    p.done();
  }
});

test("an image-level path is an image_miss without reading the remote", async () => {
  const p = project("default_target: qemux86-64\n");
  try {
    const r = await checkBuildPath(
      new ThrowingRepo(),
      {
        project_dir: p.dir,
        change: { paths: ["meta-avocado/conf/machine/qemux86-64.conf"] },
      },
      NO_ENV,
    );
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.verdict.verdict, "image_miss");
    assert.match(r.verdict.reasons[0], /machine configuration/);
  } finally {
    p.done();
  }
});

test("a project without a target is an error", async () => {
  const p = project("distro:\n  release: '2026'\n");
  try {
    const r = await checkBuildPath(
      new UnreachableRepo(),
      { project_dir: p.dir, change: { recipes: ["hello"] } },
      NO_ENV,
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.match(r.error, /no build target/);
  } finally {
    p.done();
  }
});

test("a missing project directory is an error", async () => {
  const r = await checkBuildPath(
    new UnreachableRepo(),
    { project_dir: join(tmpdir(), "no-such-avocado-project-dir") },
    NO_ENV,
  );
  assert.equal(r.ok, false);
  if (r.ok) return;
  assert.match(r.error, /no avocado\.yaml/);
});
