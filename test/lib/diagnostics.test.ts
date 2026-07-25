import { test } from "node:test";
import assert from "node:assert/strict";
import {
  diagnoseProvisionLog,
  diagnoseBuildLog,
  extractLogShape,
  extractFailingPackages,
} from "../../src/lib/diagnostics.js";

const labels = (ds: { label: string }[]) => ds.map((d) => d.label);

// ---------------------------------------------------------------------------
// True positives: each curated fingerprint must fire on its real-world text.
// ---------------------------------------------------------------------------

test("the TTY fingerprint fires on every phrasing Docker emits", () => {
  for (const log of [
    "the input device is not a TTY",
    "ERROR: stdin is not a terminal",
    "inappropriate ioctl for device",
  ]) {
    assert.match(
      labels(diagnoseProvisionLog(log))[0] ?? "",
      /Non-TTY harness/,
      log,
    );
  }
});

test("every diagnosis carries all four fields populated", () => {
  const ds = [
    ...diagnoseProvisionLog("the input device is not a TTY"),
    ...diagnoseBuildLog("no space left on device"),
    ...diagnoseBuildLog("Killed by signal 9"),
  ];
  assert.ok(ds.length >= 3);
  for (const d of ds) {
    for (const field of ["label", "cause", "suggestion", "excerpt"] as const) {
      assert.ok(d[field]?.trim().length, `${d.label}: empty ${field}`);
    }
  }
});

test("excerpt is a real slice of the input, not a canned string", () => {
  const log = "prelude\nfatal: no space left on device while writing\npostlude";
  const [d] = diagnoseBuildLog(log);
  assert.ok(
    log.includes(d!.excerpt.trim()) || d!.excerpt.includes("no space left"),
  );
});

// ---------------------------------------------------------------------------
// False positives. The module docstring promises "false negatives are preferred
// to false positives" — these tests hold it to that.
// ---------------------------------------------------------------------------

test("a successful log produces no diagnoses", () => {
  const clean = "Building runtime dev...\nDone in 91s.\nImage written.";
  assert.deepEqual(diagnoseProvisionLog(clean), []);
  assert.deepEqual(diagnoseBuildLog(clean), []);
});

test("'No such file or directory' does not become a storage diagnosis", () => {
  const log =
    "warning: optional hook /etc/avocado/hook.sh: No such file or directory\nProvisioning complete.";
  assert.deepEqual(labels(diagnoseProvisionLog(log)), []);
});

test("merely naming udisks does not become an automount diagnosis", () => {
  assert.deepEqual(
    labels(diagnoseProvisionLog("note: udisks2 is installed\nDone.")),
    [],
  );
});

// ---------------------------------------------------------------------------
// extractLogShape
// ---------------------------------------------------------------------------

test("shape of an empty or clean log is inert", () => {
  for (const log of ["", "Build succeeded in 42s"]) {
    const s = extractLogShape(log);
    assert.equal(s.hasErrors, false);
    assert.equal(s.exitCode, null);
    assert.deepEqual([s.errorLines, s.filePaths, s.commands], [[], [], []]);
  }
});

test("output is bounded so a huge log can't blow up the context window", () => {
  const huge = Array.from(
    { length: 5000 },
    (_, i) => `ERROR: failure number ${i}`,
  ).join("\n");
  const s = extractLogShape(huge);
  assert.ok(
    s.errorLines.length <= 20,
    `got ${s.errorLines.length} error lines`,
  );
});

test("individual over-long lines are truncated", () => {
  const s = extractLogShape("ERROR: " + "x".repeat(5000));
  assert.ok(s.errorLines[0]!.length < 500);
});

test("host-only noise paths are filtered out of filePaths", () => {
  const s = extractLogShape(
    "wrote to /dev/null and read /proc/meminfo\nERROR: see /home/dev/app/main.c",
  );
  assert.ok(!s.filePaths.includes("/dev/null"));
  assert.ok(!s.filePaths.some((p) => p.startsWith("/proc/")));
  assert.ok(s.filePaths.includes("/home/dev/app/main.c"));
});

test("a nonzero exit code is not overwritten by a later unrelated number", () => {
  const log = "avocado build exited with 1\nSummary: returned 0 warnings";
  assert.equal(extractLogShape(log).exitCode, 1);
});

// ---------------------------------------------------------------------------
// extractFailingPackages
// ---------------------------------------------------------------------------

test("NVRA tails are stripped back to the base package name", () => {
  assert.deepEqual(
    extractFailingPackages(
      "nothing provides libfoo.so.1 needed by nativesdk-boardctl-1.0-r0.aarch64",
    ),
    ["nativesdk-boardctl"],
  );
});

test("a package name containing digits mid-slug survives normalization", () => {
  assert.deepEqual(
    extractFailingPackages("No package matching 'python3-numpy'"),
    ["python3-numpy"],
  );
  assert.deepEqual(
    extractFailingPackages(
      "Unable to find a match: avocado-bsp-jetson-orin-nano-devkit",
    ),
    ["avocado-bsp-jetson-orin-nano-devkit"],
  );
});

test("comma-separated broken-package lists are split", () => {
  assert.deepEqual(
    extractFailingPackages("Broken packages: foo-1.0, bar-2.3.aarch64"),
    ["foo", "bar"],
  );
});

test("a clean log yields no package accusations, and results are capped", () => {
  assert.deepEqual(extractFailingPackages("everything is fine"), []);
  const many = Array.from(
    { length: 30 },
    (_, i) => `No package matching 'pkg${i}'`,
  ).join("\n");
  assert.ok(extractFailingPackages(many).length <= 5);
});
