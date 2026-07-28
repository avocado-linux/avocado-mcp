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

// The false-positive guards above must not cost the true positives sitting next
// to them — these are the phrasings real tools emit for these two failures.
// Both regressed once when the guards were first tightened.

test("every phrasing of a missing target device is diagnosed", () => {
  for (const log of [
    "dd: failed to open '/dev/sdb': No such file or directory",
    "cannot open /dev/sdb: No such file or directory",
    "bmaptool: unable to open /dev/disk4: No such file or directory",
    "No such device",
    "device not found",
  ]) {
    assert.deepEqual(
      labels(diagnoseProvisionLog(log)),
      ["Target storage not detected"],
      log,
    );
  }
});

test("every tense of automount is diagnosed", () => {
  for (const log of [
    "automount detected on /dev/sdb",
    "udev automounting target",
    "the device was auto-mounted",
    "gvfs mounted /dev/sdb1",
  ]) {
    assert.deepEqual(
      labels(diagnoseProvisionLog(log)),
      ["Device auto-mounted by host OS"],
      log,
    );
  }
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

test("a tally is never mistaken for an exit code", () => {
  // What makes the test above pass: the tally is excluded by the pattern, not
  // by scan order. Assert that directly, or a future ordering change looks safe.
  for (const log of [
    "returned 0 warnings",
    "exited with 3 errors",
    "returned 12 packages",
  ]) {
    assert.equal(extractLogShape(log).exitCode, null, log);
  }
});

test("the final exit report wins over intermediate ones", () => {
  // A retried step's code is not the process's code...
  assert.equal(
    extractLogShape(
      "curl returned 22 (retrying)\nRetry ok.\nBuild finished, exited with 0",
    ).exitCode,
    0,
  );
  // ...and when several steps fail, the last report is the real one.
  assert.equal(
    extractLogShape("step A exited with 1\nrecovered\nfinal: exited with 2")
      .exitCode,
    2,
  );
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
