#!/usr/bin/env node

import { readFileSync, writeFileSync, existsSync, unlinkSync } from "fs";
import { exec } from "child_process";
import { promisify } from "util";
// @ts-ignore - bzip2 doesn't have types
import bzip2 from "bzip2";

const execAsync = promisify(exec);

async function test() {
  const testContent =
    "Hello World! This is test data for bzip2 compression.\nMultiple lines for testing.";

  // Clean up any existing files
  ["test.txt", "test.txt.bz2"].forEach((file) => {
    if (existsSync(file)) unlinkSync(file);
  });

  // Create test file
  writeFileSync("test.txt", testContent);

  // Compress with system bzip2
  await execAsync("bzip2 -k test.txt");

  // Read compressed file and decompress with bzip2 library
  const compressed = readFileSync("test.txt.bz2");
  const uint8Array = new Uint8Array(compressed);
  const bitstream = bzip2.array(uint8Array);
  const result = bzip2.simple(bitstream);
  const decompressed = Buffer.from(result).toString("utf8");

  // Compare
  if (decompressed === testContent) {
    console.log("PASS: bzip2 compression roundtrip");
  } else {
    console.log("FAIL: content mismatch");
    process.exit(1);
  }

  // Clean up
  unlinkSync("test.txt");
  unlinkSync("test.txt.bz2");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  test().catch((error) => {
    console.error("Test failed:", error.message);
    process.exit(1);
  });
}
