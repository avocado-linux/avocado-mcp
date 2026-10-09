import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  filterSelectable,
  getSelectableSlugs,
  clearSelectableCache,
} from "../../src/lib/hardware-support.js";
import { DEVICES, FEED_2024_EDGE, FEED_2026_NEXT } from "./hardware-fixture.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearSelectableCache();
});

// Selectable slugs, as getSelectableSlugs would produce them.
const SELECTABLE = new Set([
  "imx93-evk",
  "imx93-frdm",
  "jetson-orin-nano-devkit",
  "jetson-agx-orin-devkit",
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

test("filterSelectable accepts the 2026 feed names without the -devkit suffix", () => {
  const feed = [
    "jetson-orin-nano-devkit",
    "jetson-agx-orin-devkit",
    "jetson-orin-nano",
    "jetson-agx-orin",
  ];
  assert.deepEqual(filterSelectable(feed, SELECTABLE).sort(), [
    "jetson-agx-orin",
    "jetson-agx-orin-devkit",
    "jetson-orin-nano",
    "jetson-orin-nano-devkit",
  ]);
});

// The selectable set exactly as getSelectableSlugs builds it from the real
// supported.json and virtual-environment.json.
const REAL_SELECTABLE = new Set(
  DEVICES.flatMap((d) => [d.target, d.board]).filter((s): s is string => !!s),
);

test("filterSelectable on the real docs data and the live 2024/edge feed", () => {
  // fr202, qcm6490 and imx95-frdm are real feed targets with no docs entry,
  // so they are hidden. The docs list fr201, which no feed carries.
  assert.deepEqual(filterSelectable(FEED_2024_EDGE, REAL_SELECTABLE), [
    "grinn-astra-1680-sbc",
    "icam-540",
    "imx8mp-evk",
    "imx8mp-var-dart",
    "imx91-frdm",
    "imx93-evk",
    "imx93-frdm",
    "intel-x86-64-v2",
    "intel-x86-64-v3",
    "jetson-agx-orin-devkit",
    "jetson-orin-nano-devkit",
    "jetson-orin-nx",
    "qemuarm64",
    "qemux86-64",
    "raspberrypi0-2w",
    "raspberrypi4",
    "raspberrypi5",
    "reterminal",
    "reterminal-dm",
    "rubikpi3",
    "rzv2n-sr-som",
    "ucm-imx8m-plus",
  ]);
});

test("filterSelectable on the real docs data and the live 2026/next feed", () => {
  assert.deepEqual(filterSelectable(FEED_2026_NEXT, REAL_SELECTABLE), [
    "imx8mp-evk",
    "imx91-frdm",
    "imx93-evk",
    "imx93-frdm",
    "jetson-agx-orin",
    "jetson-agx-thor",
    "jetson-orin-nano",
    "jetson-orin-nx",
    "qemuarm64",
    "qemux86-64",
    "raspberrypi4",
    "raspberrypi5",
    "rb3gen2",
    "rubikpi3",
  ]);
});

test("a docs slug that only shares a prefix with a feed slug does not admit it", () => {
  // The old prefix rule kept all of these: a docs `reterminal` admitted any
  // `reterminal*` feed slug, and a short feed slug matched every longer one.
  const selectable = new Set(["reterminal", "jetson-agx-orin-devkit", "fr201"]);
  assert.deepEqual(
    filterSelectable(
      ["reterminal-x", "jetson", "jetson-agx", "fr2010"],
      selectable,
    ),
    [],
  );
});

test("the feed and docs slugs must match exactly, except for -devkit", () => {
  const selectable = new Set(["fr201", "jetson-orin-nano-devkit"]);
  assert.deepEqual(
    filterSelectable(
      ["fr-201", "FR201", "Jetson-Orin-Nano", "jetson-orin-nano-dev-kit"],
      selectable,
    ),
    [],
  );
  assert.deepEqual(
    filterSelectable(["fr201", "jetson-orin-nano"], selectable),
    ["fr201", "jetson-orin-nano"],
  );
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
  for (const s of ["imx93-evk", "jetson-orin-nx", "icam-540", "qemuarm64"]) {
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

test("supported targets and name resolution never use the feed's arch entries", async () => {
  const { supportedTargets, resolveFeedTarget } =
    await import("../../src/lib/hardware-support.js");
  stub({
    sup: {
      category: "Supported",
      devices: [
        { name: "Raspberry Pi 5", target: "raspberrypi5", board: "" },
        { name: "Intel x86-64 v3", target: "intel-x86-64-v3", board: "" },
      ],
    },
    ve: {
      category: "Virtual",
      devices: [{ name: "QEMU x86-64", target: "qemux86-64", board: "" }],
    },
  });
  const feed = [
    "armv8a",
    "cortexa53",
    "noarch",
    "x86_64_v3",
    "raspberrypi5",
    "intel-x86-64-v3",
    "qemux86-64",
    "fr202",
  ];
  const { targets, fromMatrix } = await supportedTargets(feed);
  assert.equal(fromMatrix, true);
  assert.deepEqual(targets.sort(), [
    "intel-x86-64-v3",
    "qemux86-64",
    "raspberrypi5",
  ]);

  // A user's name resolves against real boards only.
  const rpi = await resolveFeedTarget("rpi5", feed);
  assert.equal(rpi.target, "raspberrypi5");
  const x86 = await resolveFeedTarget("x86", feed);
  assert.ok(!x86.candidates.includes("x86_64_v3"));
  // An exact feed slug is still accepted, so a real slug is never blocked.
  assert.equal((await resolveFeedTarget("fr202", feed)).target, "fr202");
});

test("supported targets fall back to the whole feed when the matrix is down", async () => {
  const { supportedTargets } =
    await import("../../src/lib/hardware-support.js");
  stub({ sup: "500", ve: "500" });
  const feed = ["armv8a", "raspberrypi5"];
  assert.deepEqual(await supportedTargets(feed), {
    targets: feed,
    fromMatrix: false,
  });
});
