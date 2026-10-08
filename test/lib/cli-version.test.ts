import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareVersions,
  isCliOutdated,
  parseCliVersion,
} from "../../src/lib/cli-version.js";

test("parses the version from both --version output shapes", () => {
  assert.equal(
    parseCliVersion("avocado 1.0.0-rc.5 (abc1234 2026-03-05)"),
    "1.0.0-rc.5",
  );
  assert.equal(parseCliVersion("avocado 1.0.0-rc.5"), "1.0.0-rc.5");
  assert.equal(parseCliVersion("avocado 0.41.0\n"), "0.41.0");
  assert.equal(parseCliVersion("avocado 1.2.0"), "1.2.0");
  assert.equal(parseCliVersion("not on PATH"), null);
});

test("compares semver with numeric prerelease identifiers", () => {
  const sorted = [
    "0.9.0",
    "0.41.0",
    "1.0.0-rc.2",
    "1.0.0-rc.4",
    "1.0.0-rc.9",
    "1.0.0-rc.10",
    "1.0.0",
    "1.0.1",
    "1.1.0",
  ];
  for (let i = 0; i < sorted.length - 1; i++) {
    assert.ok(
      compareVersions(sorted[i], sorted[i + 1]) < 0,
      `${sorted[i]} < ${sorted[i + 1]}`,
    );
    assert.ok(
      compareVersions(sorted[i + 1], sorted[i]) > 0,
      `${sorted[i + 1]} > ${sorted[i]}`,
    );
  }
  assert.equal(compareVersions("1.0.0-rc.4", "1.0.0-rc.4"), 0);
  // A shorter prerelease sorts first when the shared prefix is equal.
  assert.ok(compareVersions("1.0.0-rc", "1.0.0-rc.1") < 0);
  // Numeric identifiers sort before alphanumeric ones.
  assert.ok(compareVersions("1.0.0-1", "1.0.0-rc") < 0);
});

test("flags CLIs older than 1.0.0-rc.4 and nothing else", () => {
  for (const out of [
    "avocado 0.41.0",
    "avocado 0.99.9 (abc1234 2026-01-01)",
    "avocado 1.0.0-rc.3",
    "avocado 1.0.0-beta.9",
  ]) {
    assert.equal(isCliOutdated(out), true, out);
  }
  for (const out of [
    "avocado 1.0.0-rc.4",
    "avocado 1.0.0-rc.5 (abc1234 2026-03-05)",
    "avocado 1.0.0-rc.10",
    "avocado 1.0.0",
    "avocado 2.3.1",
    "unparseable",
  ]) {
    assert.equal(isCliOutdated(out), false, out);
  }
});
