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
  // The excerpt must be an actual substring of the log. (The old `||` rescued
  // any string containing "no space left", so a canned constant passed.)
  assert.ok(log.includes(d!.excerpt.trim()), d!.excerpt);
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

test("the tegraflash fix points to the board's own recovery steps", () => {
  const d = diagnoseProvisionLog(
    "tegraflash.py: error: failed to read rcm_state",
  ).find((x) => x.label === "USB / tegraflash failure");
  assert.ok(d);
  // Only the Orin Nano dev kit uses the FC REC jumper. AGX Orin and Thor
  // use buttons, so the fix must not tell every user to short FC REC.
  assert.doesNotMatch(d.suggestion, /FC REC pin shorted/);
  assert.match(d.suggestion, /`get-target-info` or `get-provisioning-steps`/);
  assert.match(d.suggestion, /Orin Nano dev kit uses a jumper/);
  assert.match(d.suggestion, /AGX Orin dev kit uses the Reset and Force/);
  assert.match(d.suggestion, /AGX Thor uses a timed button sequence/);
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

test("a nonzero exit code alone counts as an error", () => {
  const log = "Deploying runtime 'dev'\nStarting HTTP server\nexit code: 1";
  assert.equal(extractLogShape(log).hasErrors, true);
  assert.equal(extractLogShape("Done\nexit code: 0").hasErrors, false);
});

test("an HTTP status is not an exit code", () => {
  for (const log of [
    "health check returned 200 OK",
    "GET https://repo.example/x returned 404",
  ]) {
    const s = extractLogShape(log);
    assert.equal(s.exitCode, null, log);
    assert.equal(s.hasErrors, false, log);
  }
  assert.equal(extractLogShape("exited with code 2").exitCode, 2);
  assert.equal(extractLogShape("returned non-zero exit status 3").exitCode, 3);
});

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

test("investigatePackages drops alternate streams that lack the target and keeps unread feeds", async () => {
  const { investigatePackages } = await import("../../src/lib/diagnostics.js");
  const { NO_TARGET_REPOS } = await import("../../src/lib/repo-client.js");
  const lookup = {
    async searchPackages(_t: string[], _q: string, _l: number, feed?: unknown) {
      if (feed === "configured") {
        return {
          results: [],
          errors: [],
          notChecked: [{ target: "x", feed: "acme", reason: "private" }],
        };
      }
      if (feed === "missing") {
        return {
          results: [],
          errors: [
            { target: "x", messages: [`${NO_TARGET_REPOS} "x" in ...`] },
          ],
        };
      }
      return { results: [{ name: "pkg", repo: "target/x", version: "1" }] };
    },
  };
  const [inv] = await investigatePackages(
    lookup,
    ["pkg"],
    ["x"],
    [
      {
        release: "2026",
        channel: "edge",
        configured: true,
        feed: "configured" as never,
      },
      {
        release: "2026",
        channel: "stable",
        configured: false,
        feed: "missing" as never,
      },
      {
        release: "2026",
        channel: "next",
        configured: false,
        feed: "has" as never,
      },
    ],
  );
  assert.deepEqual(
    inv.streams.map((s) => s.channel),
    ["edge", "next"],
  );
  assert.deepEqual(inv.streams[0].notChecked, [
    { feed: "acme", reason: "private" },
  ]);
});

test("an unread configured feed makes the package's availability there unknown", async () => {
  const { renderDiagnoses } = await import("../../src/lib/diagnostics.js");
  const out = renderDiagnoses(
    "build",
    [],
    [
      {
        name: "pkg",
        streams: [
          {
            release: "2026",
            channel: "edge",
            configured: true,
            hits: [],
            notChecked: [{ feed: "acme", reason: "private" }],
          },
          {
            release: "2026",
            channel: "next",
            configured: false,
            hits: [{ repo: "target/x", version: "1" }],
          },
        ],
      },
    ],
    { targets: ["x"] },
  );
  assert.match(out, /availability there is unknown/);
  assert.match(out, /`acme` \(private\)/);
  assert.doesNotMatch(out, /Not on your configured stream/);
  assert.doesNotMatch(out, /Set `distro.release`/);
});

test("investigatePackages keeps an alternate stream whose targets.json failed to load", async () => {
  const { investigatePackages } = await import("../../src/lib/diagnostics.js");
  const { DEFAULT_FEED, RepoClient } =
    await import("../../src/lib/repo-client.js");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response("down", { status: 503 })) as typeof fetch;
  try {
    const [inv] = await investigatePackages(
      new RepoClient(),
      ["pkg"],
      ["x"],
      [
        {
          release: "2026",
          channel: "next",
          configured: false,
          feed: DEFAULT_FEED,
        },
      ],
    );
    assert.equal(inv.streams.length, 1);
    assert.match(inv.streams[0].error ?? "", /Could not read targets\.json/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("investigatePackages lists an unread feed once for a project with two targets", async () => {
  const { investigatePackages } = await import("../../src/lib/diagnostics.js");
  const lookup = {
    async searchPackages() {
      return {
        results: [],
        notChecked: [
          { target: "a", feed: "acme", reason: "private" },
          { target: "b", feed: "acme", reason: "private" },
        ],
      };
    },
  };
  const [inv] = await investigatePackages(
    lookup,
    ["pkg"],
    ["a", "b"],
    [
      {
        release: "2026",
        channel: "edge",
        configured: true,
        feed: "x" as never,
      },
    ],
  );
  assert.deepEqual(inv.streams[0].notChecked, [
    { feed: "acme", reason: "private" },
  ]);
});

test("unread configured feeds are listed when the configured stream also has an error", async () => {
  const { renderDiagnoses } = await import("../../src/lib/diagnostics.js");
  const out = renderDiagnoses(
    "build",
    [],
    [
      {
        name: "pkg",
        streams: [
          {
            release: "2026",
            channel: "edge",
            configured: true,
            hits: [],
            error: "target/x: fetch failed",
            notChecked: [{ feed: "acme", reason: "private" }],
          },
          {
            release: "2026",
            channel: "next",
            configured: false,
            hits: [{ repo: "target/x", version: "1" }],
          },
        ],
      },
    ],
    { targets: ["x"] },
  );
  assert.match(out, /Could not query your configured stream/);
  assert.match(out, /`acme` \(private\)/);
});

// ---------------------------------------------------------------------------
// CLI and provision-script messages. Each log line is copied from the source
// that prints it (avocado-cli, or meta-avocado for the provision scripts), with
// the format arguments filled in.
// ---------------------------------------------------------------------------

const BUILD_CASES: { label: string; log: string }[] = [
  {
    label: "Build step prerequisites not met",
    log: "[ERROR] Cannot build runtime 'dev' - dependencies not satisfied\n[INFO] Missing steps:\n[INFO]   - SDK install (sdk/install.json)",
  },
  {
    label: "Stamps from an older CLI",
    log: "  - SDK install (sdk/install.json: stamp format changed (v3 → v4); re-run the step to refresh it)",
  },
  {
    label: "Connect login missing or expired",
    log: "Error: repos.acme: `org: acme` is a private feed and you are not logged in.\nRun `avocado login`, or set AVOCADO_CONNECT_TOKEN for CI.",
  },
  {
    label: "Connect login missing or expired",
    log: "Error: repos.acme: feed-token request returned 401 Unauthorized — the stored credential was rejected. Run `avocado login` to refresh it.",
  },
  {
    label: "Connect login missing or expired",
    log: "Error: repos.acme: no Connect profile for org 'acme'.\nRun `avocado login --org acme`.",
  },
  {
    label: "Connect signing needs a saved login",
    log: "Error: --connect-sign requires an active Connect session. Run `avocado connect auth login` first.",
  },
  {
    label: "Not entitled to a private feed",
    log: "Error: repos.acme: feed-token request returned 403 Forbidden — this account is not entitled to that org's private feed",
  },
  {
    label: "Connect serves no feed tokens",
    log: "Error: repos.acme: feed-token request returned 404 Not Found — this Connect deployment does not serve feed tokens yet",
  },
  {
    label: "Rootfs verity needs a FIT signing key",
    log: "ERROR: rootfs.image.verity is on, which needs the boot FIT rebuilt with the root hash, but no FIT signing key is configured. Set runtimes.<name>.signing.fit_key to an RSA key in the signing-key registry, or signing.fit_unsigned: true if this machine's U-Boot enforces no key.",
  },
  {
    label: "Feed has no bootloader rekey tool",
    log: "ERROR: signing.fit_key_in_bootloader is on but this feed ships no imx-boot-tools/rekey-imx-boot.sh for imx93-frdm. Set signing.fit_key_in_bootloader: false to keep the distro bootloader.",
  },
  {
    label: "Deploy refuses extension verity",
    log: "ERROR: this runtime has extensions with image.verity: true; deploy does not publish their dm-verity hash trees yet, so the device would refuse them. Provision instead, or build without verity.",
  },
  {
    label: "No root.json in the runtime",
    log: "ERROR: No root.json found at /opt/_avocado/x/var-staging/lib/avocado/metadata/root.json\n       The runtime has no update-authority (root.json) baked into its build.",
  },
  {
    label: "Unresolved depends_on closure",
    log: "Error: Cannot install with an unresolved dependency closure: Extension 'base' is not defined in `extensions:` and could not be resolved from the target's feed.\nRequired by: app -> base\nFix the depends_on declaration (or fetch the missing extension) and re-run.",
  },
  {
    label: "Unresolved depends_on closure",
    log: "Error: Extension 'base' declares `source: { type: git }` but its configuration has not been merged, so its dependencies are unknown.\nRun `avocado ext fetch` to fetch it before resolving dependencies.",
  },
  {
    label: "avocado.lock drift under --locked",
    log: "Error: avocado.lock does not pin declared extension(s):\n  app\n--locked forbids resolving them. Re-run without --locked to update the lock.",
  },
  {
    label: "avocado.lock drift under --locked",
    log: "Error: avocado.lock is out of date; --locked forbids updating it:\n  app: 1.0.0 -> 1.1.0\nRe-run without --locked to update the lock.",
  },
  {
    label: "avocado.lock drift under --locked",
    log: "Error: avocado.lock pins dependency versions that cannot satisfy the current requirements.\nRe-run without --locked to update the lock, or align the declared versions.",
  },
  {
    label: "Lockfile from another distro release",
    log: "[WARNING] Lock file was created with distro.release '2024' but config has '2026'. This may indicate an incompatible feed year change. Run 'avocado unlock' and reinstall to update.",
  },
  {
    label: "avocado.yaml keys ignored",
    log: "[WARNING] avocado.yaml: unknown key 'runtimes.dev.pakages' is ignored; did you mean 'packages'?",
  },
  {
    label: "avocado.yaml keys ignored",
    log: "[WARNING] avocado.yaml: 'ext' is an old name for 'extensions' and is no longer read; rename it to 'extensions'",
  },
  {
    label: "avocado.yaml keys ignored",
    log: "[WARNING] avocado.yaml: 'runtime' is an old spelling of 'runtimes', and most commands only read 'runtimes'; rename it to 'runtimes'",
  },
  {
    label: "avocado.yaml keys ignored",
    log: "[WARNING] avocado.yaml: 'extensions.app.sysext' is no longer read; list the image types under 'types', e.g. 'types: [sysext]'",
  },
  {
    label: "avocado.yaml keys ignored",
    log: "[WARNING] avocado.yaml: 'sdk.host_uid' has no effect; set AVOCADO_HOST_UID instead",
  },
  {
    label: "avocado.yaml keys ignored",
    log: "[WARNING] avocado.yaml: 'rootfs.pakages' sets no rootfs fields, so it is read as a named rootfs entry; did you mean the field 'packages'?",
  },
  {
    label: "CLI version does not meet cli_requirement",
    log: "Error: This project requires avocado CLI version '>=2.0.0', but you are running version 1.0.0-rc.5.\n\nPlease update your avocado CLI.",
  },
  {
    label: "Invalid cli_requirement",
    log: "Error: Invalid cli_requirement 'latest'. Expected a semver requirement (e.g., '>=0.25.0', '^0.25')",
  },
  {
    label: "Encrypted /var config error",
    log: "Error: runtimes.dev.var.hardware: 'none' needs var.recovery - without a hardware keyslot or an operator recovery key /var would be unrecoverable",
  },
  {
    label: "Encrypted /var config error",
    log: "Error: runtimes.dev.var.recovery is set but var.encrypt is not true - there is no encrypted /var to enrol a recovery key on",
  },
  {
    label: "Encrypted /var config error",
    log: "Error: runtimes.dev.var.hardware: 'tmp2' is not one of auto, caam, tpm2, none",
  },
  {
    label: "Encrypted /var config error",
    log: "Error: Runtime 'dev' sets var.encrypt but is scoped to [\"imx93-frdm\"], and is being built for 'qemux86-64'. No encrypt marker is written outside that scope, so /var would come up plaintext despite the opt-in.",
  },
  {
    label: "Encrypted /var config error",
    log: "Error: Runtime 'dev' opts in to var.encrypt for 'qemux86-64' (a `target-qemux86-64:` override), but the runtime is scoped to [\"imx93-frdm\"], which does not include it.",
  },
  {
    label: "Encrypted /var config error",
    log: "Error: runtimes.dev.targets is empty - that scopes the runtime to no target at all, so anything scoped to it (var.encrypt) would be silently skipped. Omit `targets:` to mean every target, or list the targets it is for",
  },
  {
    label: "Stale build volume",
    log: "ERROR: rootfs staging at /opt/_avocado/qemux86-64/rootfs-work is missing /etc/passwd. The build volume looks half-populated or stale.",
  },
  {
    label: "Stale build volume",
    log: "grep: /opt/_avocado/qemux86-64/runtimes/dev/rootfs-work/etc/passwd: No such file or directory",
  },
];

test("each CLI build, install and deploy message gets its diagnosis", () => {
  for (const { label, log } of BUILD_CASES) {
    assert.ok(
      labels(diagnoseBuildLog(log)).includes(label),
      `${label}: ${log}`,
    );
  }
});

test("the depends_on closure error is not read as a DNF dependency failure", () => {
  const log = BUILD_CASES.find((c) =>
    c.log.includes("unresolved dependency closure"),
  )!.log;
  assert.ok(!labels(diagnoseBuildLog(log)).includes("Unresolved dependency"));
});

const PROVISION_CASES: { label: string; log: string }[] = [
  {
    label: "Build step prerequisites not met",
    log: "[ERROR] Cannot provision runtime 'dev' - dependencies not satisfied",
  },
  {
    label: "Qualcomm board not in EDL mode",
    log: "Waiting for QDL device...\nERROR: QDL device not found after 30 seconds, aborting",
  },
  {
    label: "Qualcomm board not in EDL mode",
    log: "Bus 001 Device 012: ID 05c6:900e Qualcomm, Inc. QUSB_BULK_CID",
  },
  {
    label: "Jetson not in recovery mode",
    log: "Please put device into recovery mode (hold recovery button, press reset)...\nERROR: Device did not enter RCM mode (waited 60s)",
  },
  {
    label: "Jetson not in recovery mode",
    log: "ERR: No Jetson device in recovery mode found on USB",
  },
];

test("each provision script message gets its diagnosis", () => {
  for (const { label, log } of PROVISION_CASES) {
    assert.ok(
      labels(diagnoseProvisionLog(log)).includes(label),
      `${label}: ${log}`,
    );
  }
});

test("new patterns stay quiet on a clean CLI run", () => {
  const clean = [
    "[INFO] Using config: avocado.yaml",
    "[INFO] Resolving feeds for target 'qemux86-64'",
    "[SUCCESS] Installed SDK packages.",
    "[INFO] Building extension 'app'.",
    "Copying /etc/passwd, /etc/shadow, and /etc/group from /opt/_avocado/qemux86-64/rootfs/etc to /opt/_avocado/qemux86-64/rootfs-work/etc",
    "Assembling boot FIT from /opt/_avocado/qemux86-64/runtimes/dev/fit-image.its...",
    "Built boot FIT: /opt/_avocado/qemux86-64/runtimes/dev/fitImage (signed)",
    "Phase 2: Generating signed TUF metadata...",
    "Waiting for QDL device...",
    "QDL device found",
    "Device in RCM mode",
    "[SUCCESS] Successfully built runtime 'dev'.",
  ].join("\n");
  assert.deepEqual(labels(diagnoseBuildLog(clean)), []);
  assert.deepEqual(labels(diagnoseProvisionLog(clean)), []);
});

test("the QDL wait timeout is not read as missing target storage", () => {
  assert.deepEqual(
    labels(
      diagnoseProvisionLog(
        "ERROR: QDL device not found after 30 seconds, aborting",
      ),
    ),
    ["Qualcomm board not in EDL mode"],
  );
});

test("a log with no error signals names the command that ran", async () => {
  const { renderDiagnoses } = await import("../../src/lib/diagnostics.js");
  const out = renderDiagnoses("deploy", [], undefined, {
    targets: [],
    rawLog: "Deploying runtime 'dev'\nStarting HTTP server",
  });
  assert.match(out, /`avocado deploy` command actually succeeded/);
  assert.doesNotMatch(out, /build\/provision/);
});

test("a specific RCM diagnosis replaces the generic tegraflash one", () => {
  const log =
    "Running tegraflash.py ...\nERROR: Device did not enter RCM mode (waited 60s)";
  assert.deepEqual(labels(diagnoseProvisionLog(log)), [
    "Jetson not in recovery mode",
  ]);
  // Without the RCM signature, the generic tegraflash diagnosis stays.
  assert.deepEqual(labels(diagnoseProvisionLog("tegraflash.py failed")), [
    "USB / tegraflash failure",
  ]);
});

test("an invalid cli_requirement is fixed in avocado.yaml, not by an upgrade", () => {
  // avocado-cli src/utils/version.rs check_cli_requirement
  const invalid = diagnoseBuildLog(
    "Error: Invalid cli_requirement 'latest'. Expected a semver requirement (e.g., '>=0.25.0', '^0.25')",
  );
  assert.deepEqual(labels(invalid), ["Invalid cli_requirement"]);
  assert.doesNotMatch(invalid[0]!.suggestion, /avocado upgrade/);
  assert.match(invalid[0]!.suggestion, /avocado\.yaml/);

  const unmet = diagnoseBuildLog(
    "Error: This project requires avocado CLI version '>=2.0.0', but you are running version 1.0.0-rc.5.",
  );
  assert.deepEqual(labels(unmet), [
    "CLI version does not meet cli_requirement",
  ]);
  assert.match(unmet[0]!.suggestion, /avocado upgrade/);
});

test("the fallback warning names the command that wrote the log", async () => {
  const { renderDiagnoses } = await import("../../src/lib/diagnostics.js");
  const out = renderDiagnoses("install", [], undefined, {
    targets: [],
    rawLog: "ERROR: something new went wrong",
  });
  assert.match(out, /"the install is fine\."/);
  assert.doesNotMatch(out, /the build is fine/);
});

test("stale stamps go to avocado install, not the sorted To fix list", async () => {
  const { renderDiagnoses, diagnoseBuildLog } =
    await import("../../src/lib/diagnostics.js");
  const out = renderDiagnoses("deploy", [], undefined, {
    targets: [],
    rawLog: "ERROR: something new went wrong",
  });
  assert.match(
    out,
    /build stamps \(run `avocado install`, then `avocado build`/,
  );
  // The CLI sorts the To fix list by name (stamps.rs fix_commands), so it is
  // not an install order. No advice may say to follow it in order.
  for (const d of diagnoseBuildLog(
    "[ERROR] Cannot build runtime 'dev' - dependencies not satisfied\nTo fix:\n  avocado ext install app\n  avocado sdk install",
  )) {
    assert.doesNotMatch(d.suggestion, /in the order shown|in order\)/);
    assert.match(d.suggestion, /avocado install/);
  }
  assert.doesNotMatch(out, /lists under `To fix:`, in order/);
});

test("--connect-sign gets login advice, and only feed auth gets the env var", () => {
  const sign = diagnoseBuildLog(
    "Error: --connect-sign requires an active Connect session. Run `avocado connect auth login` first.",
  );
  assert.deepEqual(labels(sign), ["Connect signing needs a saved login"]);
  assert.match(sign[0]!.suggestion, /avocado login --token <token>/);
  assert.doesNotMatch(sign[0]!.suggestion, /set `AVOCADO_CONNECT_TOKEN`/);

  // avocado-cli src/utils/feeds.rs: the feed path reads the env var.
  const feed = diagnoseBuildLog(
    "Error: repos.acme: `org: acme` is a private feed and you are not logged in.\nRun `avocado login`, or set AVOCADO_CONNECT_TOKEN for CI.",
  );
  assert.deepEqual(labels(feed), ["Connect login missing or expired"]);
  assert.match(feed[0]!.suggestion, /AVOCADO_CONNECT_TOKEN/);
});

test("warning-only matches still show the error that failed the run", async () => {
  const { renderDiagnoses } = await import("../../src/lib/diagnostics.js");
  // avocado-cli config_lint.rs warning, then runtime/deploy.rs repo server error.
  const log = [
    "[WARNING] avocado.yaml: unknown key 'runtimes.dev.pakages' is ignored; did you mean 'packages'?",
    "ERROR: repo server did not become reachable on port 8080 within 30s",
  ].join("\n");
  const ds = diagnoseBuildLog(log);
  assert.deepEqual(labels(ds), ["avocado.yaml keys ignored"]);
  assert.equal(ds[0]!.warningOnly, true);
  const out = renderDiagnoses("deploy", ds, undefined, {
    targets: [],
    rawLog: log,
  });
  assert.match(out, /## avocado\.yaml keys ignored/);
  assert.match(out, /repo server did not become reachable on port 8080/);
  assert.match(out, /Check SSH and the network/);

  // A warning on a run with no errors gets no fallback.
  const clean = renderDiagnoses("build", ds, undefined, {
    targets: [],
    rawLog: log.split("\n")[0]!,
  });
  assert.doesNotMatch(clean, /No known failure pattern matched/);

  // A real diagnosis next to the warning is enough. No fallback.
  const lockLog =
    log +
    "\n[WARNING] Lock file was created with distro.release '2024' but config has '2026'.";
  assert.ok(diagnoseBuildLog(lockLog).every((d) => d.warningOnly));
  const both = diagnoseBuildLog(
    log + "\nERROR: No root.json found at /opt/x/root.json",
  );
  const rendered = renderDiagnoses("deploy", both, undefined, {
    targets: [],
    rawLog: log,
  });
  assert.doesNotMatch(rendered, /No known failure pattern matched/);
});

test("a closure error from a cycle or a version conflict is not a missing extension", () => {
  // avocado-cli ext/install.rs wraps these from src/utils/ext_deps.rs.
  for (const log of [
    "Error: Cannot install with an unresolved dependency closure: Dependency cycle between extensions: app -> base -> app.\nExtensions cannot depend on each other in a loop — factor the shared part into a separate `class: platform` extension.\nFix the depends_on declaration (or fetch the missing extension) and re-run.",
    "Error: Cannot install with an unresolved dependency closure: Extension 'app' requires 'base' ^2.0, but 'base' declares version 1.0.0.\nRelax the `depends_on` constraint or update the dependency.\nFix the depends_on declaration (or fetch the missing extension) and re-run.",
  ]) {
    assert.ok(
      !labels(diagnoseBuildLog(log)).includes("Unresolved depends_on closure"),
      log,
    );
  }
});

test("an echoed script line from --verbose does not match", () => {
  // With --verbose the CLI prints the container script, so the `echo` source
  // lines of rootfs/image.rs, runtime/build.rs and runtime/deploy.rs appear
  // in the log although the branch did not run.
  const echoed = [
    `    if [ ! -f "$ROOTFS_WORK/etc/passwd" ]; then`,
    `        echo "ERROR: rootfs staging at $ROOTFS_WORK is missing /etc/passwd. The build volume looks half-populated or stale." >&2`,
    `            echo "ERROR: rootfs.image.verity is on, which needs the boot FIT rebuilt with the root hash, but no FIT signing key is configured." >&2`,
    `                echo "ERROR: signing.fit_key_in_bootloader is on but this feed ships no imx-boot-tools/rekey-imx-boot.sh for $TARGET_ARCH." >&2`,
    `        echo "ERROR: this runtime has extensions with image.verity: true; deploy does not publish their dm-verity hash trees yet, so the device would refuse them." >&2`,
    `    echo "ERROR: No root.json found at $ROOT_JSON_FILE" >&2`,
    `echo "ERROR: No root.json found at $ROOT_JSON_FILE" >&2`,
  ].join("\n");
  assert.deepEqual(labels(diagnoseBuildLog(echoed)), []);
  // The emitted line still matches, also after a one-word prefix.
  assert.deepEqual(
    labels(diagnoseBuildLog("[ERROR] ERROR: No root.json found at /opt/x")),
    ["No root.json in the runtime"],
  );
});

test("a bare 'returned N' below 100 is an exit code", () => {
  assert.equal(extractLogShape("Command returned 1").exitCode, 1);
  assert.equal(extractLogShape("Command returned 1").hasErrors, true);
  assert.equal(extractLogShape("script returned 0").exitCode, 0);
  for (const log of [
    "health check returned 200 OK",
    "returned 100 Continue",
    "returned 0 warnings",
  ]) {
    assert.equal(extractLogShape(log).exitCode, null, log);
  }
});
