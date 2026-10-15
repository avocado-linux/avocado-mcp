import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT, DESCRIPTION } from "../src/resources/stone.js";
import { INSTRUCTIONS } from "../src/instructions.js";

// Offline routing checks, with no model call: the text a model sees lists
// each request that needs stone, and each look-alike that does not.

// The "not stone" requests and the avocado.yaml key for each.
const NOT_STONE_KEYS = [
  "kernel.cmdline_extra",
  "device_tree_overlays",
  "overlay",
  "avocado-ext-dev",
];

test("the server instructions route stone requests to the stone skill", () => {
  const text = INSTRUCTIONS.replace(/\s+/g, " ");
  assert.match(text, /Read `avocado:\/\/skills\/stone` first/);
  for (const intent of [
    /partitions/,
    /disk or image size/,
    /eMMC, NVMe, USB/,
    /config\.txt, U-Boot, GRUB/,
    /device certs or IDs/,
    /factory provisioning/,
  ]) {
    assert.match(text, intent);
  }
  for (const key of NOT_STONE_KEYS) assert.ok(text.includes(key), key);
});

test("the stone skill table lists each request and each not-stone key", () => {
  const start = CONTENT.indexOf("## What do you want to do?");
  assert.ok(start >= 0);
  const table = CONTENT.slice(start, CONTENT.indexOf("\n## ", start + 1));
  for (const intent of [
    /rootfs bigger/,
    /data partition/,
    /config\.txt/,
    /eMMC, NVMe or USB/,
    /device cert or ID/,
    /factory provisioning/,
    /what gets written/,
    /A\/B updates/,
    /kernel arguments/,
    /device-tree overlay/,
    /space in \/var/,
    /root filesystem/,
  ]) {
    assert.match(table, intent);
  }
  for (const key of NOT_STONE_KEYS) assert.ok(table.includes(key), key);
});

test("the stone skill description uses the words of the user", () => {
  for (const words of [
    "partitions",
    "rootfs",
    "image bigger",
    "eMMC, NVMe or USB",
    "boot files",
    "config.txt",
    "factory provisioning",
    "device certs",
  ]) {
    assert.ok(DESCRIPTION.includes(words), words);
  }
});

test("the stone skill reads profiles from the raw JSON, not describe-manifest", () => {
  // stone 2.5.0 `describe-manifest` prints devices, images and partitions only.
  assert.doesNotMatch(CONTENT, /describe-manifest` prints[^.]*profiles/);
  assert.match(CONTENT, /\.provision\.profiles/);
  assert.match(CONTENT, /\.runtime\.provision_default/);
});

test("the neighbor skills point to the stone skill", async () => {
  for (const [mod, re] of [
    [
      "filesystem-model",
      /new partition or a bigger rootfs partition is a stone change/,
    ],
    ["extensions-and-runtimes", /Boot firmware files.*\`stone_include_paths\`/],
    [
      "iterative-deployment",
      /The deploy succeeds, but these changes do not reach the device/,
    ],
  ] as const) {
    const { CONTENT: text } = await import(`../src/resources/${mod}.js`);
    assert.match(text, re, mod);
    assert.ok(text.includes("avocado://skills/stone"), mod);
  }
});
