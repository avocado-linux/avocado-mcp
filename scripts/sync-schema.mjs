#!/usr/bin/env node

// Refreshes the avocado.yaml schema and starter template vendored in
// src/lib/schema/. The MCP fetches the live schema from docs.peridio.com and
// uses the vendored copy only offline, so the copy comes from that same URL.
// The template comes from avocado-cli main.
//
//   npm run sync-schema           write the current files
//   npm run sync-schema -- --check  exit 1 when a vendored file differs (CI)

import { readFileSync, writeFileSync } from "node:fs";

const CLI = "https://raw.githubusercontent.com/avocado-linux/avocado-cli/main";
const FILES = {
  "https://docs.peridio.com/schemas/avocado-config.json":
    "src/lib/schema/avocado-config.json",
  [`${CLI}/configs/default.yaml`]: "src/lib/schema/default.yaml",
};
const check = process.argv.includes("--check");

let drift = false;
for (const [remote, local] of Object.entries(FILES)) {
  const res = await fetch(remote);
  if (!res.ok) throw new Error(`${remote}: HTTP ${res.status}`);
  const text = await res.text();
  if (remote.endsWith(".json")) JSON.parse(text);
  if (readFileSync(local, "utf8") === text) {
    console.log(`up to date: ${local}`);
  } else if (check) {
    console.error(`drift: ${local} differs from ${remote}`);
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
