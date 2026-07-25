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

test("generation digit is not swallowed by a sibling", () => {
  const hits = resolveTarget("rpi5", TARGETS);
  assert.equal(hits[0], "raspberrypi5");
  const siblings = hits.filter(
    (h) => h === "raspberrypi3" || h === "raspberrypi4",
  );
  assert.ok(
    siblings.length === 0 ||
      hits.indexOf("raspberrypi5") < hits.indexOf(siblings[0]!),
    "pi5 must outrank its siblings for 'rpi5'",
  );
});

test("empty query returns the full catalog", () => {
  assert.deepEqual(resolveTarget("", TARGETS), TARGETS);
  assert.deepEqual(resolveTarget("   ", TARGETS), TARGETS);
});

test(
  "nonsense query returns nothing rather than everything",
  {
    todo: "single-char tokens score via hay.includes(); 'a' in 'not-a-board' matches 8/10 targets",
  },
  () => {
    assert.deepEqual(resolveTarget("zzzz-not-a-board", TARGETS), []);
  },
);

test(
  "a one-letter token does not match the whole catalog",
  { todo: "same root cause: substring scoring has no minimum token length" },
  () => {
    assert.ok(resolveTarget("a", TARGETS).length < TARGETS.length);
    assert.ok(
      resolveTarget("my board is a potato", TARGETS).length < TARGETS.length,
    );
  },
);

test("punctuation-only query does not return the full catalog", () => {
  assert.deepEqual(resolveTarget("!!!", TARGETS), []);
});

test("results are deterministic across calls", () => {
  assert.deepEqual(resolveTarget("pi", TARGETS), resolveTarget("pi", TARGETS));
});
