import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyName, editDistance } from "../../src/lib/name-match.js";

test("editDistance: identical strings cost 0", () => {
  assert.equal(editDistance("openssl", "openssl"), 0);
});

test("editDistance: one substitution costs 1", () => {
  assert.equal(editDistance("cat", "cut"), 1);
});

test("editDistance: one insertion costs 1", () => {
  assert.equal(editDistance("cat", "cart"), 1);
});

test("editDistance: one deletion costs 1", () => {
  assert.equal(editDistance("cart", "cat"), 1);
});

test("editDistance: a transposition costs 2", () => {
  assert.equal(editDistance("ab", "ba"), 2);
  assert.equal(editDistance("openssl", "opnessl"), 2);
});

test("editDistance: empty strings", () => {
  assert.equal(editDistance("", ""), 0);
  assert.equal(editDistance("", "abc"), 3);
  assert.equal(editDistance("abc", ""), 3);
});

test("editDistance: case-sensitive", () => {
  assert.equal(editDistance("Abc", "abc"), 1);
});

test("classifyName: exact match is returned and excluded from near", () => {
  const r = classifyName("curl", ["curl", "curls", "wget"]);
  assert.deepEqual(r, { exact: "curl", near: ["curls"] });
});

test("classifyName: no exact match gives null", () => {
  const r = classifyName("curl", ["curls", "wget"]);
  assert.deepEqual(r, { exact: null, near: ["curls"] });
});

test("classifyName: a name equal only ignoring case is near, not exact", () => {
  const r = classifyName("OpenSSL", ["openssl", "zlib"]);
  assert.deepEqual(r, { exact: null, near: ["openssl"] });
});

test("classifyName: exact and a case-variant coexist", () => {
  const r = classifyName("openssl", ["OpenSSL", "openssl"]);
  assert.deepEqual(r, { exact: "openssl", near: ["OpenSSL"] });
});

test("classifyName: distance is measured ignoring case", () => {
  const r = classifyName("CURL", ["curls"]);
  assert.deepEqual(r, { exact: null, near: ["curls"] });
});

test("classifyName: default maxDistance is 1 for a query of up to 5 characters", () => {
  const r = classifyName("curl", ["curls", "cups", "perl", "curlxx"]);
  assert.deepEqual(r.near, ["curls"]);
  assert.deepEqual(classifyName("abcde", ["abcxx", "abcdx"]).near, ["abcdx"]);
});

test("classifyName: default maxDistance is 2 for a longer query", () => {
  const r = classifyName("abcdef", ["abcdxx", "abcxxx", "abcdex"]);
  assert.deepEqual(r.near, ["abcdex", "abcdxx"]);
});

test("classifyName: maxDistance option widens and narrows", () => {
  assert.deepEqual(classifyName("abcd", ["abxxx"], { maxDistance: 3 }).near, [
    "abxxx",
  ]);
  assert.deepEqual(classifyName("abcd", ["abxd"], { maxDistance: 0 }).near, []);
});

test("classifyName: orders by distance then name", () => {
  const r = classifyName("abc", ["abz", "abd", "abcd", "ab", "abcde"], {
    maxDistance: 2,
  });
  assert.deepEqual(r.near, ["ab", "abcd", "abd", "abz", "abcde"]);
});

test("classifyName: limit caps near after ordering", () => {
  const r = classifyName("abc", ["abz", "abd", "abcd", "ab"], { limit: 2 });
  assert.deepEqual(r.near, ["ab", "abcd"]);
});

test("classifyName: empty query and empty names", () => {
  assert.deepEqual(classifyName("", []), { exact: null, near: [] });
  assert.deepEqual(classifyName("", ["", "a", "abc"]), {
    exact: "",
    near: ["a"],
  });
});
