import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../../src/lib/target-resolver.js";

const TARGETS = [
  "raspberrypi3",
  "raspberrypi4",
  "raspberrypi5",
  "jetson-orin-nano-devkit",
  "jetson-agx-orin-devkit",
  "imx8mp-evk",
  "qemux86-64",
  "qemuarm64",
  "icam-540",
  "fr201",
];

test("exact slug wins outright", () => {
  assert.equal(resolveTarget("raspberrypi4", TARGETS)[0], "raspberrypi4");
});

test("exact match is case-insensitive", () => {
  assert.equal(resolveTarget("RaspberryPi4", TARGETS)[0], "raspberrypi4");
});

test("colloquial aliases resolve to the right generation", () => {
  for (const [query, expected] of [
    ["rpi5", "raspberrypi5"],
    ["pi 4", "raspberrypi4"],
    ["raspberry pi 3", "raspberrypi3"],
    ["jetson orin nano", "jetson-orin-nano-devkit"],
    ["agx", "jetson-agx-orin-devkit"],
    ["x86_64", "qemux86-64"],
    ["aarch64", "qemuarm64"],
  ] as const) {
    assert.equal(resolveTarget(query, TARGETS)[0], expected, `query: ${query}`);
  }
});

test("the generation digit is decisive — a sibling never appears", () => {
  const gens = ["raspberrypi3", "raspberrypi4", "raspberrypi5"];
  for (const [query, expected] of [
    ["rpi3", "raspberrypi3"],
    ["rpi4", "raspberrypi4"],
    ["rpi5", "raspberrypi5"],
  ] as const) {
    const hits = resolveTarget(query, TARGETS);
    assert.equal(hits[0], expected, query);
    for (const sibling of gens.filter((g) => g !== expected)) {
      assert.ok(
        !hits.includes(sibling),
        `${query} must not surface ${sibling}`,
      );
    }
  }
});

// A slice of real slugs from the live matrix. The imx93/imx91 boards here have
// NO entry in the SYNONYMS table, so their matching must come from the slug
// alone — exactly the case the earlier length-gate regression dropped (a
// supported board vanished from suggestions and the user was told it wasn't
// supported). imx8mp-evk does have synonyms; it's included only for the 8M-Plus
// ranking check below.
const MATRIX_SLICE = [
  "imx93-evk",
  "imx93-frdm",
  "imx91-evk",
  "imx91-frdm",
  "cortexa55_mx93",
  "cortexa55_mx91",
  "cortexa53_crypto_mx8mp",
  "imx8mp-evk",
  "ucm-imx8m-plus",
];

test("a spelled-out model name ranks its board above SoC-arch entries", () => {
  const hits = resolveTarget("i.MX 93", MATRIX_SLICE);
  assert.deepEqual(hits.slice(0, 2), ["imx93-evk", "imx93-frdm"]);
  assert.ok(
    hits.indexOf("imx93-evk") < hits.indexOf("cortexa55_mx93"),
    "the board must outrank the SoC-arch entry that merely contains '93'",
  );
});

// The raw resolver ranks by slug similarity ONLY, so for a terse query a
// SoC-arch target like `cortexa55_mx93` (which contains `mx93` as a whole
// token) can outrank the board — the resolver can't tell a board from an
// arch/tune string. The tools don't rely on it to: `hardware-support`
// filters the catalog to the support-matrix selectable set BEFORE the resolver
// sees it, so `cortexa55_mx93` etc. are never candidates (see
// hardware-support.test). This test pins the resolver's own guarantee — the
// board is always *present* (never dropped) even in a raw, unfiltered set.
test("terse model numbers still surface the board (present, not necessarily #1)", () => {
  assert.ok(resolveTarget("i.MX 91", MATRIX_SLICE).includes("imx91-evk"));
  assert.ok(
    resolveTarget("93", MATRIX_SLICE).some((t) => t.startsWith("imx93")),
    "'93' must still surface the imx93 boards",
  );
  assert.ok(resolveTarget("mx93", MATRIX_SLICE).includes("imx93-evk"));
  assert.ok(resolveTarget("i.MX 8M Plus", MATRIX_SLICE).includes("imx8mp-evk"));
});

test("empty query returns the full catalog", () => {
  assert.deepEqual(resolveTarget("", TARGETS), TARGETS);
  assert.deepEqual(resolveTarget("   ", TARGETS), TARGETS);
});

test("nonsense query returns nothing rather than everything", () => {
  assert.deepEqual(resolveTarget("zzzz-not-a-board", TARGETS), []);
});

test("a one-letter token does not match the whole catalog", () => {
  assert.ok(resolveTarget("a", TARGETS).length < TARGETS.length);
  assert.ok(
    resolveTarget("my board is a potato", TARGETS).length < TARGETS.length,
  );
});

test("a 2-char token does not pull an unrelated board in via mid-substring", () => {
  // "64" is inside qemuarm64 but only mid-token; an x86_64 query must not
  // surface an arm board. Substring credit at length 2 requires a *prefix*.
  const hits = resolveTarget("x86_64", TARGETS);
  assert.ok(hits.includes("qemux86-64"));
  assert.ok(
    !hits.includes("qemuarm64"),
    `arm board leaked: ${hits.join(", ")}`,
  );
});

test("vendor product names with short numeric tokens resolve", () => {
  // NXP's own name for the board is "i.MX 8M Plus", so the 2-char "8m" token
  // has to earn credit. This is the case a bare length gate on substring
  // credit silently breaks — it regressed once already.
  for (const [query, expected] of [
    ["i.MX 8M Plus", "imx8mp-evk"],
    ["imx 8m plus", "imx8mp-evk"],
    ["8m", "imx8mp-evk"],
    ["fr", "fr201"],
  ] as const) {
    assert.equal(resolveTarget(query, TARGETS)[0], expected, `query: ${query}`);
  }
});

test("punctuation-only query does not return the full catalog", () => {
  assert.deepEqual(resolveTarget("!!!", TARGETS), []);
});

test("results are deterministic across calls", () => {
  assert.deepEqual(resolveTarget("pi", TARGETS), resolveTarget("pi", TARGETS));
});

test("an Intel query does not return the QEMU x86 target", () => {
  // `intel` was a synonym of qemux86-64, so "intel" matched the VM target.
  const hits = resolveTarget("intel", [
    ...TARGETS,
    "intel-x86-64-v2",
    "intel-x86-64-v3",
  ]);
  assert.deepEqual(hits, ["intel-x86-64-v2", "intel-x86-64-v3"]);
});

test("resolveTargetInput turns what users type into one slug", async () => {
  const { resolveTargetInput } =
    await import("../../src/lib/target-resolver.js");
  const slugs = [
    "raspberrypi4",
    "raspberrypi5",
    "jetson-orin-nano-devkit",
    "jetson-agx-orin-devkit",
    "qemux86-64",
    "imx93-evk",
    "imx93-frdm",
  ];
  for (const input of ["rpi5", "Raspberry Pi 5", "RaspberryPi5", "pi 5"]) {
    assert.equal(
      resolveTargetInput(input, slugs).target,
      "raspberrypi5",
      input,
    );
  }
  assert.equal(
    resolveTargetInput("raspberrypi4", slugs).target,
    "raspberrypi4",
  );
  assert.equal(
    resolveTargetInput("jetson orin nano", slugs).target,
    "jetson-orin-nano-devkit",
  );
  // Ties are ambiguous: no guess, only candidates.
  for (const input of ["jetson", "pi", "imx93"]) {
    const m = resolveTargetInput(input, slugs);
    assert.equal(m.target, undefined, input);
    assert.ok(m.candidates.length >= 2, input);
  }
  assert.deepEqual(resolveTargetInput("toaster", slugs), { candidates: [] });
});

test("resolveTargetInput uses docs names as aliases", async () => {
  const { resolveTargetInput } =
    await import("../../src/lib/target-resolver.js");
  const slugs = ["icam-540", "jetson-orin-nx", "jetson-agx-orin-devkit"];
  const aliases = [
    { name: "Advantech ICAM-540", target: "icam-540" },
    {
      name: "Advantech MIC-712-OX",
      target: "jetson-orin-nx",
      board: "mic-712-ox-16gb",
    },
    { name: "NVIDIA Jetson Orin NX", target: "jetson-orin-nx" },
    {
      name: "Advantech MIC-733-AO5A1",
      target: "jetson-agx-orin-devkit",
      board: "mic-733-ao5a1",
    },
    {
      name: "Advantech MIC-733-AO6A1",
      target: "jetson-agx-orin-devkit",
      board: "mic-733-ao6a1",
    },
    { name: "Thundercomm Rubik Pi 3", target: "rubikpi3" },
  ];
  assert.deepEqual(
    resolveTargetInput("Advantech MIC-712-OX", slugs, aliases).board,
    "mic-712-ox-16gb",
  );
  assert.equal(
    resolveTargetInput("mic-712-ox-16gb", slugs, aliases).target,
    "jetson-orin-nx",
  );
  assert.equal(
    resolveTargetInput("NVIDIA Jetson Orin NX", slugs, aliases).board,
    undefined,
  );
  assert.equal(
    resolveTargetInput("MIC-733-AO6A1", slugs, aliases).board,
    "mic-733-ao6a1",
  );
  // Two boards tie: no target, so no silent wrong board.
  assert.equal(resolveTargetInput("MIC-733", slugs, aliases).target, undefined);
  // The name matches a target that is not in the list: no other target wins.
  const m = resolveTargetInput("Thundercomm Rubik Pi 3", slugs, aliases);
  assert.equal(m.target, undefined);
  assert.ok(!m.candidates.includes("rubikpi3"));
  // Without aliases, `advantech` alone does not pick icam-540.
  assert.equal(
    resolveTargetInput("Advantech MIC-712-OX", slugs).target,
    undefined,
  );
});

test("resolveTargetInput does not resolve on one shared word", async () => {
  const { resolveTargetInput } =
    await import("../../src/lib/target-resolver.js");
  const slugs = [
    "raspberrypi5",
    "rubikpi3",
    "fr201",
    "jetson-orin-nano-devkit",
    "jetson-orin-nx",
    "jetson-agx-orin-devkit",
    "ucm-imx8m-plus",
  ];
  const aliases = [
    { name: "Thundercomm Rubik Pi 3", target: "rubikpi3" },
    { name: "OnLogic FR201", target: "fr201" },
    {
      name: "Advantech MIC-712-OX",
      target: "jetson-orin-nx",
      board: "mic-712-ox-16gb",
    },
    { name: "CompuLab IOT-GATE-iMX8PLUS", target: "ucm-imx8m-plus" },
  ];
  // Hardware with no target shares only the vendor word: candidates only.
  for (const input of ["Thundercomm DragonBoard 410c", "OnLogic FR999"]) {
    const m = resolveTargetInput(input, slugs, aliases);
    assert.equal(m.target, undefined, input);
    assert.ok(m.candidates.length > 0, input);
  }
  for (const [input, target] of [
    ["rpi5", "raspberrypi5"],
    ["RaspberryPi5", "raspberrypi5"],
    ["Raspberry Pi 5", "raspberrypi5"],
    ["pi 5", "raspberrypi5"],
    ["Advantech MIC-712-OX", "jetson-orin-nx"],
    ["Thundercomm Rubik Pi 3", "rubikpi3"],
    ["CompuLab IOT-GATE-iMX8PLUS", "ucm-imx8m-plus"],
    ["OnLogic FR201", "fr201"],
    ["jetson orin nano", "jetson-orin-nano-devkit"],
  ] as const) {
    assert.equal(
      resolveTargetInput(input, slugs, aliases).target,
      target,
      input,
    );
  }
  assert.equal(
    resolveTargetInput("Advantech MIC-712-OX", slugs, aliases).board,
    "mic-712-ox-16gb",
  );
  assert.equal(resolveTargetInput("jetson", slugs, aliases).target, undefined);
});
