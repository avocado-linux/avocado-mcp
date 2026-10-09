import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  targetInfoText,
  lookupTarget,
  minDiskGB,
  diskRequirement,
  provisionCommand,
  boardDocsUrl,
  runProvisionCommands,
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
  assert.match(out, /- \*\*Voltage:\*\* 3\.3V\n/);
  assert.doesNotMatch(out, /TTL/);
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
  assert.match(out, /`--host-fwd` on Linux hosts only/);
  // The VM runs on both host OSes. Only `--host-fwd` is Linux only.
  assert.match(out, /\*\*Host OS:\*\* macOS, Linux\n/);
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

test("a device name on a shared target gives that device only", () => {
  const out = targetInfoText(DATA, "CompuLab IOT-GATE-iMX8PLUS", undefined);
  assert.match(out, /\*\*Name:\*\* CompuLab IOT-GATE-iMX8PLUS\n/);
  assert.match(
    out,
    /\*\*Docs:\*\* https:\/\/docs\.peridio\.com\/hardware\/compulab\/iot-gate-imx8plus\n/,
  );
  assert.doesNotMatch(out, /compulab\/ucm-imx8m-plus/);
  assert.doesNotMatch(out, /## CompuLab UCM-i\.MX8M-Plus/);
  assert.equal(
    lookupTarget(DATA, "CompuLab IOT-GATE-iMX8PLUS")?.entries.length,
    1,
  );
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

test("getHardwareData does not cache when one device file parses empty", async () => {
  let supported: unknown = { devices: [] };
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    const body = u.endsWith("targets.json")
      ? TARGETS
      : u.endsWith("virtual-environment.json")
        ? { devices: DEVICES.slice(-2) }
        : supported;
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  // Only the QEMU rows: the physical boards are missing, so no data.
  assert.equal(await getHardwareData(), null);
  // Nothing was cached, so the next call reads the fixed file.
  supported = { devices: DEVICES.slice(0, -2) };
  assert.equal((await getHardwareData())?.devices.length, DEVICES.length);
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
  assert.deepEqual(runProvisionCommands(ucm, "dev"), [
    "avocado provision dev --profile sd",
  ]);
  // sd and uuu-emmc: one full command per profile, no placeholder.
  assert.deepEqual(
    runProvisionCommands(lookupTarget(DATA, "imx8mp-var-dart")!, "dev"),
    [
      "avocado provision dev --profile sd",
      "avocado provision dev --profile uuu-emmc",
    ],
  );
  // No options: the CLI default.
  const none = { ...ucm, entries: [{ ...ucm.entries[0], provisioning: {} }] };
  assert.deepEqual(runProvisionCommands(none, "dev"), [
    "avocado provision dev",
  ]);
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

test("board data lookups accept a user's name for the board", () => {
  const info = lookupTarget(DATA, "rpi5");
  assert.equal(info?.target, "raspberrypi5");
  assert.equal(info?.requested, "rpi5");
  const text = targetInfoText(DATA, "Raspberry Pi 5", undefined);
  assert.match(text, /Resolved `Raspberry Pi 5` to target `raspberrypi5`/);
  assert.match(text, /raspberry-pi-5/);
  // An exact slug is not marked as resolved.
  assert.equal(lookupTarget(DATA, "raspberrypi5")?.requested, undefined);
  // Ambiguous: no entry, and a "did you mean" list.
  assert.equal(lookupTarget(DATA, "jetson"), null);
  assert.match(targetInfoText(DATA, "jetson", undefined), /Did you mean/);
});

test("board data lookups accept the docs names for a board", () => {
  // The `advantech` in the name must not pick icam-540.
  const mic = lookupTarget(DATA, "Advantech MIC-712-OX");
  assert.equal(mic?.target, "jetson-orin-nx");
  assert.equal(mic?.board, "mic-712-ox-16gb");
  assert.equal(mic?.resolvedBoard, "mic-712-ox-16gb");
  assert.match(
    targetInfoText(DATA, "Advantech MIC-712-OX", undefined),
    /Resolved `Advantech MIC-712-OX` to target `jetson-orin-nx` with board `mic-712-ox-16gb`/,
  );
  // A board the caller passes wins over the board in the name.
  assert.equal(
    lookupTarget(DATA, "Advantech MIC-712-OX", "other")?.board,
    "other",
  );
  assert.equal(
    lookupTarget(DATA, "Thundercomm Rubik Pi 3")?.target,
    "rubikpi3",
  );
  const vision = lookupTarget(DATA, "RB3 Gen 2 Vision Kit");
  assert.equal(vision?.target, "rb3gen2");
  assert.equal(vision?.board, "rb3gen2-vision");
  // The core kit name gives the target and no board.
  const core = lookupTarget(DATA, "Qualcomm RB3 Gen 2");
  assert.equal(core?.target, "rb3gen2");
  assert.equal(core?.board, undefined);
  assert.equal(lookupTarget(DATA, "rpi5")?.target, "raspberrypi5");
  assert.equal(lookupTarget(DATA, "jetson"), null);
  // Two MIC-733 boards share a target. Do not guess the board.
  assert.equal(lookupTarget(DATA, "Advantech MIC-733"), null);
});

test("with no board, the plain module is named and linked, not a carrier board", () => {
  // supported.json lists the MIC-712-OX before the plain Orin NX.
  const out = targetInfoText(DATA, "jetson-orin-nx", undefined);
  assert.match(out, /\*\*Name:\*\* NVIDIA Jetson Orin NX\n/);
  assert.match(
    out,
    /\*\*Docs:\*\* https:\/\/docs\.peridio\.com\/hardware\/nvidia\/jetson-orin-nx\n/,
  );
  assert.match(
    out,
    /Follow the board page: [^\n]*\/hardware\/nvidia\/jetson-orin-nx\./,
  );
  assert.doesNotMatch(out, /\*\*Name:\*\* Advantech/);
  assert.equal(
    boardDocsUrl(lookupTarget(DATA, "jetson-orin-nx")!),
    "https://docs.peridio.com/hardware/nvidia/jetson-orin-nx",
  );
});

test("a board the data does not list gets no other board's name or page", () => {
  const out = targetInfoText(DATA, "jetson-agx-orin-devkit", "mic-999");
  assert.match(out, /Board `mic-999` is not in the docs data/);
  assert.doesNotMatch(out, /\*\*Name:\*\*/);
  assert.doesNotMatch(out, /\*\*Docs:\*\*/);
  assert.doesNotMatch(out, /Follow the board page:/);
  assert.equal(
    boardDocsUrl(lookupTarget(DATA, "jetson-orin-nx", "mic-999")!),
    undefined,
  );
});

test("an adapter console gets the VCC and TX/RX rule and the docs voltage as written", () => {
  const out = targetInfoText(DATA, "raspberrypi4", undefined);
  assert.match(
    out,
    /- \*\*Console:\*\* a USB-to-UART adapter on the debug UART\.\n/,
  );
  assert.match(out, /- \*\*Voltage:\*\* 3\.3V\n/);
  assert.match(out, /Leave the adapter's VCC pin disconnected/);
  assert.match(out, /board TX to adapter RX, and board RX to adapter TX/);
  assert.match(out, /Confirm the console voltage on the board page/);
  assert.doesNotMatch(out, /TTL/);
});

test("FR201 gets the RS-232 warning, not a 3.3 V adapter", () => {
  const out = targetInfoText(DATA, "fr201", undefined);
  const serial = out.slice(out.indexOf("## Serial console"));
  assert.match(serial, /RS-232 serial port\. Use a USB-to-RS-232 adapter/);
  assert.match(serial, /5-pin RS-232\/422\/485 terminal block/);
  assert.match(serial, /±12 V/);
  assert.match(serial, /Do not connect a 3\.3 V USB-to-UART adapter/);
  assert.doesNotMatch(out, /TTL/);
  assert.doesNotMatch(serial, /\*\*Voltage:\*\* 3\.3V/);
  assert.doesNotMatch(serial, /a USB-to-UART adapter on the debug UART/);
  assert.doesNotMatch(serial, /VCC/);
});

test("Intel x86-64 has no console data but keeps the RS-232 warning", () => {
  const out = targetInfoText(DATA, "intel-x86-64-v3", undefined);
  assert.match(out, /does not describe a serial console/);
  assert.match(out, /DB9 or RJ45 RS-232 port/);
  assert.match(out, /±12 V/);
});

test("a voltage in the data that says RS-232 is not a USB-to-UART adapter", () => {
  const data: HardwareData = {
    targets: {
      ...TARGETS,
      raspberrypi4: {
        ...TARGETS.raspberrypi4,
        serial: { baud: 115200, voltage: "RS-232" },
      },
    },
    devices: DEVICES,
  };
  const out = targetInfoText(data, "raspberrypi4", undefined);
  assert.match(out, /RS-232 serial port\. Use a USB-to-RS-232 adapter/);
  assert.match(out, /- \*\*Voltage:\*\* RS-232\n/);
  assert.doesNotMatch(out, /USB-to-UART adapter on the debug UART/);
  assert.doesNotMatch(out, /RS-232 TTL/);
});
