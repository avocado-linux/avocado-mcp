import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseProvisionList,
  renderProvisionList,
} from "../../src/tools/hardware.js";

// The shapes `avocado provision --list --output json` prints (profiles.rs).
const AVAILABLE = JSON.stringify({
  available: true,
  target: "rubikpi3",
  default: "ufs",
  profiles: [
    { name: "ufs", script: "stone-provision-ufs.sh", fields: [] },
    {
      name: "noop",
      script: "stone-provision-noop.sh",
      fields: [
        {
          name: "AVOCADO_HYPERVISOR",
          type: "string",
          label: "Hypervisor",
          description: null,
          required: false,
          default: "gunyah",
        },
      ],
    },
  ],
});

const UNAVAILABLE = JSON.stringify({
  available: false,
  target: "rubikpi3",
  reason:
    "SDK not yet installed for this project. Run `avocado install` first.",
});

test("parses the result after an update banner", () => {
  const list = parseProvisionList(
    `[UPDATE] avocado 1.0.0 is available\n${AVAILABLE}\n`,
  );
  assert.equal(list?.available, true);
  assert.equal(list?.default, "ufs");
  assert.deepEqual(
    list?.profiles?.map((p) => p.name),
    ["ufs", "noop"],
  );
});

test("parses the unavailable envelope with its reason", () => {
  const list = parseProvisionList(UNAVAILABLE);
  assert.equal(list?.available, false);
  assert.match(list?.reason ?? "", /avocado install/);
});

test("returns null when there is no JSON result", () => {
  assert.equal(parseProvisionList("error: something broke\n"), null);
  assert.equal(parseProvisionList('{"event":"log"}'), null);
});

test("renders positional-runtime commands and --env settings", () => {
  const out = renderProvisionList(parseProvisionList(AVAILABLE)!, "rt-vms");
  assert.match(out, /`avocado provision rt-vms --profile ufs`/);
  assert.match(out, /\*\*Default profile:\*\* `ufs`/);
  assert.match(out, /`AVOCADO_HYPERVISOR` \(string, optional\): Hypervisor/);
  assert.match(out, /--env NAME=<value>/);
});
