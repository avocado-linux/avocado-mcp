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

// A slice of real slugs from the live matrix — NONE are in the SYNONYMS table,
// so matching must come from the slug alone. This is the case the earlier
// length-gate regression dropped: a supported board vanished from suggestions
// and the user was told it wasn't supported.
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

test("model numbers resolve from the slug with no synonym-table entry", () => {
  assert.ok(resolveTarget("i.MX 91", MATRIX_SLICE).includes("imx91-evk"));
  assert.ok(
    resolveTarget("93", MATRIX_SLICE).some((t) => t.startsWith("imx93")),
    "'93' must still surface the imx93 boards",
  );
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
