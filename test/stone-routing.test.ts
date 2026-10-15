import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTENT } from "../src/resources/stone.js";

test("the stone skill reads profiles from the raw JSON, not describe-manifest", () => {
  // stone 2.5.0 `describe-manifest` prints devices, images and partitions only.
  assert.doesNotMatch(CONTENT, /describe-manifest` prints[^.]*profiles/);
  assert.match(CONTENT, /\.provision\.profiles/);
  assert.match(CONTENT, /\.runtime\.provision_default/);
});
