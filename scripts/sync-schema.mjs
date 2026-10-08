#!/usr/bin/env node

// Refreshes the avocado.yaml schema and starter template vendored in
// src/lib/schema/ from avocado-cli main. The MCP fetches the live schema from
// docs.peridio.com and uses these copies only offline, so they must not drift.
//
//   npm run sync-schema           write the current files
//   npm run sync-schema -- --check  exit 1 when a vendored file differs (CI)

import { readFileSync, writeFileSync } from "node:fs";

const BASE = "https://raw.githubusercontent.com/avocado-linux/avocado-cli/main";
const FILES = {
  "schemas/avocado-config.json": "src/lib/schema/avocado-config.json",
  "configs/default.yaml": "src/lib/schema/default.yaml",
};
const check = process.argv.includes("--check");

let drift = false;
for (const [remote, local] of Object.entries(FILES)) {
  const res = await fetch(`${BASE}/${remote}`);
  if (!res.ok) throw new Error(`${BASE}/${remote}: HTTP ${res.status}`);
  const text = await res.text();
  if (remote.endsWith(".json")) JSON.parse(text);
  if (readFileSync(local, "utf8") === text) {
    console.log(`up to date: ${local}`);
  } else if (check) {
    console.error(`drift: ${local} differs from avocado-cli ${remote}`);
    drift = true;
  } else {
    writeFileSync(local, text);
    console.log(`updated: ${local}`);
  }
}
if (drift) {
  console.error("Run `npm run sync-schema` and commit the result.");
  process.exit(1);
}
