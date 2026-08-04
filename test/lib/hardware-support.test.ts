import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  filterSelectable,
  getSelectableSlugs,
  clearSelectableCache,
} from "../../src/lib/hardware-support.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearSelectableCache();
});

// Squashed selectable slugs, as getSelectableSlugs would produce them.
const SELECTABLE = new Set([
  "imx93evk",
  "imx93frdm",
  "jetsonorinnano", // matrix slug — feed has jetson-orin-nano-devkit
  "jetsonagxorin",
  "qemuarm64",
  "raspberrypi5",
  "fr201",
]);

test("filterSelectable keeps real boards and drops arch/tune pseudo-targets", () => {
  const feed = [
    "imx93-evk",
    "imx93-frdm",
    "cortexa55_mx93",
    "cortexa53_crypto_mx8mp",
    "x86_64_v2",
    "armv8_2a",
    "noarch",
    "raspberrypi5",
    "qemuarm64",
  ];
  assert.deepEqual(filterSelectable(feed, SELECTABLE).sort(), [
    "imx93-evk",
    "imx93-frdm",
    "qemuarm64",
    "raspberrypi5",
  ]);
});

test("filterSelectable reconciles the feed's -devkit suffix against the matrix slug", () => {
  const feed = ["jetson-orin-nano-devkit", "jetson-agx-orin-devkit"];
  assert.deepEqual(filterSelectable(feed, SELECTABLE).sort(), [
    "jetson-agx-orin-devkit",
    "jetson-orin-nano-devkit",
  ]);
});

function stub(bodies: Record<string, unknown | "500">) {
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const key = String(url).endsWith("virtual-environment.json") ? "ve" : "sup";
    if (bodies[key] === "500") return new Response("", { status: 500 });
    return new Response(JSON.stringify(bodies[key]), { status: 200 });
  }) as typeof fetch;
}

test("getSelectableSlugs parses the {devices:[...]} shape across both files", async () => {
  stub({
    sup: {
      category: "Supported",
      devices: [
        { name: "NXP i.MX 93 EVK", target: "imx93-evk", board: "" },
        {
          name: "Advantech ICAM-540",
          target: "jetson-orin-nx",
          board: "icam-540",
        },
      ],
    },
    ve: {
      category: "Virtual",
      devices: [{ name: "QEMU ARM", target: "qemuarm64", board: "" }],
    },
  });
  const set = await getSelectableSlugs();
  assert.ok(set);
  for (const s of ["imx93evk", "jetsonorinnx", "icam540", "qemuarm64"]) {
    assert.ok(set!.has(s), `missing ${s}`);
  }
});

test("a docs fetch failure degrades to null so callers fall back to the full feed", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  assert.equal(await getSelectableSlugs(), null);
});

test("an HTTP error degrades to null", async () => {
  stub({ sup: "500", ve: "500" });
  assert.equal(await getSelectableSlugs(), null);
});
