import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  targetInfoText,
  lookupTarget,
  minDiskGB,
  diskRequirement,
  provisionCommand,
  runProvisionCommand,
  getHardwareData,
  clearHardwareDataCache,
  type HardwareData,
} from "../../src/lib/hardware-data.js";
import { TARGETS, DEVICES } from "./hardware-fixture.js";

const DATA: HardwareData = { targets: TARGETS, devices: DEVICES };

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  clearHardwareDataCache();
});

test("Jetson Orin Nano: tegraflash, macOS supported, FC REC jumper, 16 GB", () => {
  const out = targetInfoText(DATA, "jetson-orin-nano-devkit", undefined);
  assert.match(out, /avocado provision dev --profile tegraflash/);
  assert.match(out, /\*\*Host OS:\*\* macOS, Linux/);
  assert.match(out, /Avocado Desktop/);
  assert.match(out, /short the FC REC pin to GND/);
  assert.match(out, /\*\*Free disk space:\*\* 16 GB/);
  assert.match(out, /3\.3V TTL/);
  assert.match(
    out,
    /https:\/\/docs\.peridio\.com\/hardware\/nvidia\/jetson-orin-nano-developer-kit\n/,
  );
  assert.match(out, /2024: supported, 2026: in-progress/);
});

test("the FC REC recovery strap is not listed as serial wiring", () => {
  const out = targetInfoText(DATA, "jetson-orin-nano-devkit", undefined);
  assert.doesNotMatch(out, /Wire `FC REC`/);
  assert.match(
    out,
    /Recovery mode only, not part of the serial wiring: connect `FC REC` to GND[^\n]*Remove this connection before a normal boot/,
  );
  assert.match(out, /Wire `UART TXD` to adapter UART RX/);
});

test("Jetson AGX Orin uses buttons, not the FC REC jumper", () => {
  const out = targetInfoText(DATA, "jetson-agx-orin-devkit", undefined);
  assert.match(out, /Force Recovery button/);
  assert.doesNotMatch(out, /FC REC/);
  assert.match(out, /onboard USB/);
  assert.match(out, /\/dev\/serial\/by-id/);
  // The MIC-733 boards share the target but not the dev kit's steps.
  assert.match(out, /`mic-733-ao5a1`: Advantech MIC-733-AO5A1/);
  assert.match(out, /pass `board`/);
});

test("a MIC-733 board does not get the dev kit's recovery steps", () => {
  const out = targetInfoText(DATA, "jetson-agx-orin-devkit", "mic-733-ao5a1");
  assert.doesNotMatch(out, /Force Recovery/);
  assert.match(out, /no provisioning details for board `mic-733-ao5a1`/);
  assert.match(out, /```bash\navocado provision dev\n```/);
  assert.match(
    out,
    /https:\/\/docs\.peridio\.com\/hardware\/advantech\/mic-733-ao/,
  );
});

test("RB3 Gen 2: ufs profile, EDL, hypervisor note, kit boards", () => {
  const out = targetInfoText(DATA, "rb3gen2", undefined, "rt-vms");
  assert.match(out, /avocado provision rt-vms --profile ufs\n/);
  assert.match(out, /05c6:9008/);
  assert.match(
    out,
    /avocado provision rt-vms --profile ufs --env AVOCADO_HYPERVISOR=kvm/,
  );
  assert.match(out, /default_target_board: rb3gen2-vision/);
  assert.match(out, /2024: none, 2026: supported/);
  assert.match(out, /does not describe a serial console/);
  // A kit board is covered by the target's own steps.
  const vision = targetInfoText(DATA, "rb3gen2", "rb3gen2-vision");
  assert.match(vision, /--profile ufs/);
});

test("Rubik Pi 3: ufs profile and an onboard console", () => {
  const out = targetInfoText(DATA, "rubikpi3", undefined);
  assert.match(out, /avocado provision dev --profile ufs/);
  assert.match(out, /EDL button/);
  assert.match(out, /AVOCADO_HYPERVISOR=kvm/);
  assert.match(out, /onboard USB/);
});

test("Variscite needs a board and offers sd and uuu-emmc", () => {
  const out = targetInfoText(DATA, "imx8mp-var-dart", undefined);
  assert.match(out, /This target needs a board/);
  assert.match(out, /--profile sd\n/);
  assert.match(out, /--profile uuu-emmc\n/);
  assert.match(out, /has 2 options/);
  assert.match(out, /linux-auto-mounting/);
});

test("QEMU: provision writes an image, then sdk run boots it", () => {
  const out = targetInfoText(DATA, "qemux86-64", undefined);
  assert.match(out, /avocado provision dev\navocado sdk run -iE vm dev\n/);
  assert.match(out, /--host-fwd/);
  assert.match(out, /Linux only/);
  assert.doesNotMatch(out, /brew install qemu/);
  assert.doesNotMatch(out, /Free disk space/);
  assert.match(
    out,
    /https:\/\/docs\.peridio\.com\/developer-reference\/getting-started\/qemu/,
  );
});

test("an unknown target says so and invents nothing", () => {
  const out = targetInfoText(DATA, "brand-new-board-9000", undefined);
  assert.match(out, /no entry for `brand-new-board-9000`/);
  assert.match(out, /list-targets/);
  assert.doesNotMatch(out, /avocado provision/);
});

test("no data: board data unavailable, with the docs URL", () => {
  const out = targetInfoText(null, "rb3gen2", undefined);
  assert.match(out, /Board data unavailable/);
  assert.match(out, /https:\/\/docs\.peridio\.com\/hardware\/support-matrix/);
  assert.doesNotMatch(out, /avocado provision/);
});

test("no rendered command uses the deprecated -r flag from the data", () => {
  for (const t of Object.keys(TARGETS)) {
    assert.doesNotMatch(targetInfoText(DATA, t, undefined), /provision -r/, t);
  }
});

test("the 2026 feed slug without -devkit finds the docs entry", () => {
  const info = lookupTarget(DATA, "jetson-orin-nano");
  assert.equal(info?.target, "jetson-orin-nano-devkit");
});

test("targets that share a slug return every entry", () => {
  const info = lookupTarget(DATA, "ucm-imx8m-plus");
  assert.equal(info?.entries.length, 2);
  assert.equal(info?.devices.length, 2);
});

test("minDiskGB reads a larger docs number and keeps 8 GB otherwise", () => {
  assert.equal(minDiskGB(lookupTarget(DATA, "jetson-agx-orin-devkit")), 16);
  assert.equal(minDiskGB(lookupTarget(DATA, "rubikpi3")), 8);
  assert.equal(minDiskGB(null), 8);
});

test("getHardwareData returns null on a fetch failure", async () => {
  globalThis.fetch = (async () => {
    throw new Error("ECONNREFUSED");
  }) as typeof fetch;
  assert.equal(await getHardwareData(), null);
});

test("getHardwareData joins the three files", async () => {
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    const body = u.endsWith("targets.json")
      ? TARGETS
      : u.endsWith("virtual-environment.json")
        ? { devices: DEVICES.slice(-2) }
        : { devices: DEVICES.slice(0, -2) };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  const data = await getHardwareData();
  assert.equal(data?.devices.length, DEVICES.length);
  assert.ok(data?.targets.rb3gen2);
});

test("option steps from the board page are kept (Variscite SW7 back to internal)", () => {
  const out = targetInfoText(DATA, "imx8mp-var-dart", undefined);
  assert.match(out, /set SW7 back to internal/);
  assert.match(
    targetInfoText(DATA, "rubikpi3", undefined),
    /```text\n\[SUCCESS\] Successfully provisioned runtime 'dev'\n```/,
  );
});

test("a board must match a board name exactly, not text in the YAML", () => {
  for (const board of ["vision", "r"]) {
    const info = lookupTarget(DATA, "rb3gen2", board);
    assert.equal(info?.entries.length, 0, board);
    const out = targetInfoText(DATA, "rb3gen2", board);
    assert.match(out, new RegExp(`Board \`${board}\` is not in the docs data`));
    assert.doesNotMatch(out, /05c6:9008/, board);
  }
  assert.equal(
    lookupTarget(DATA, "rb3gen2", "rb3gen2-vision")?.entries.length,
    1,
  );
});

test("provisionCommand refuses an unsafe runtime or profile", () => {
  assert.throws(() => provisionCommand("dev; rm -rf ~"));
  assert.throws(() => provisionCommand("dev", "sd && curl evil"));
  assert.equal(provisionCommand("dev", null), "avocado provision dev");
});

test("an unsafe profile from the data is skipped and named", () => {
  const targets = structuredClone(TARGETS);
  targets["rubikpi3"].provisioning!.options![0].profile = "ufs; reboot";
  const out = targetInfoText(
    { targets, devices: DEVICES },
    "rubikpi3",
    undefined,
  );
  assert.doesNotMatch(out, /avocado provision dev --profile ufs; reboot/);
  assert.match(
    out,
    /Skipped profile "ufs; reboot": the name is not a safe CLI value/,
  );
});

test("the run command counts distinct profiles", () => {
  // Two entries, both `sd`: the exact profile is known.
  const ucm = lookupTarget(DATA, "ucm-imx8m-plus")!;
  assert.equal(ucm.entries.length, 2);
  assert.equal(
    runProvisionCommand(ucm, "dev"),
    "avocado provision dev --profile sd",
  );
  // sd and uuu-emmc: the user picks.
  assert.equal(
    runProvisionCommand(lookupTarget(DATA, "imx8mp-var-dart")!, "dev"),
    "avocado provision dev --profile <profile>",
  );
  // No options: the CLI default.
  const none = { ...ucm, entries: [{ ...ucm.entries[0], provisioning: {} }] };
  assert.equal(runProvisionCommand(none, "dev"), "avocado provision dev");
});

test("diskRequirement says when it falls back to the generic 8 GB", () => {
  assert.deepEqual(diskRequirement(DATA, "jetson-agx-orin-devkit"), {
    minGB: 16,
  });
  const unknown = diskRequirement(DATA, "brand-new-board-9000");
  assert.equal(unknown.minGB, 8);
  assert.match(
    unknown.note ?? "",
    /no provisioning entry for `brand-new-board-9000`.*generic 8 GB/,
  );
  const offline = diskRequirement(null, "jetson-agx-orin-devkit");
  assert.equal(offline.minGB, 8);
  assert.match(offline.note ?? "", /Board data unavailable.*generic 8 GB/);
});
