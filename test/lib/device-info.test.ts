import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getDeviceConnectionInfo,
  buildTmuxSnippet,
  emulatorInvocation,
  SUPPORTED_EMULATORS,
} from "../../src/lib/device-info.js";
import type { HardwareData } from "../../src/lib/hardware-data.js";
import { TARGETS, DEVICES } from "./hardware-fixture.js";

const DATA: HardwareData = { targets: TARGETS, devices: DEVICES };

test("unknown targets fall back to 115200 8N1 and say the data has no entry", () => {
  const info = getDeviceConnectionInfo("brand-new-board-9000", DATA);
  assert.equal(info.serial.baud, 115200);
  assert.equal(info.serial.dataBits, 8);
  assert.equal(info.serial.stopBits, 1);
  assert.equal(info.serial.parity, "none");
  assert.match(info.caveats.join(" "), /no entry for `brand-new-board-9000`/);
});

test("without board data the result says the values are defaults", () => {
  const info = getDeviceConnectionInfo("rubikpi3", null);
  assert.equal(info.serial.baud, 115200);
  assert.match(info.caveats.join(" "), /Board data unavailable/);
});

test("a serial console is recommended, not required", () => {
  for (const t of ["rubikpi3", "jetson-orin-nano-devkit", "rb3gen2"]) {
    const text = getDeviceConnectionInfo(t, DATA).caveats.join(" ");
    assert.match(text, /recommended, not required/, t);
  }
});

test("an onboard USB console is reported with the by-id hint", () => {
  const info = getDeviceConnectionInfo("rubikpi3", DATA);
  assert.equal(info.onboardConsole, true);
  assert.match(info.caveats.join(" "), /\/dev\/serial\/by-id/);
  assert.equal(
    info.docsUrl,
    "https://docs.peridio.com/hardware/qualcomm/rubik-pi-3",
  );
});

test("a MIC-733 board does not get the NVIDIA dev kit console", () => {
  const devkit = getDeviceConnectionInfo("jetson-agx-orin-devkit", DATA);
  assert.equal(devkit.onboardConsole, true);
  const mic = getDeviceConnectionInfo(
    "jetson-agx-orin-devkit",
    DATA,
    "mic-733-ao5a1",
  );
  assert.equal(mic.onboardConsole, false);
  assert.doesNotMatch(mic.caveats.join(" "), /\/dev\/serial\/by-id/);
  assert.match(mic.caveats.join(" "), /does not describe a serial console/);
  assert.equal(
    mic.docsUrl,
    "https://docs.peridio.com/hardware/advantech/mic-733-ao",
  );
});

test("an adapter board gets its voltage and wiring from the data", () => {
  const info = getDeviceConnectionInfo("jetson-orin-nano-devkit", DATA);
  assert.equal(info.onboardConsole, false);
  assert.equal(info.serial.voltage, "3.3V");
  assert.match(info.caveats.join(" "), /`UART TXD` to adapter UART RX/);
});

test("QEMU has no physical serial port", () => {
  const info = getDeviceConnectionInfo("qemux86-64", DATA);
  assert.match(info.caveats.join(" "), /no physical serial port/);
  assert.match(info.caveats.join(" "), /avocado provision dev/);
});

test("every emulator invocation sets the baud rate and names the port", () => {
  for (const e of SUPPORTED_EMULATORS) {
    const cmd = emulatorInvocation(e, "/dev/ttyUSB0", 115200);
    assert.match(cmd, /115200/, e);
    assert.match(cmd, /\/dev\/ttyUSB0/, e);
    assert.ok(cmd.startsWith(e), e);
  }
});

test("the tmux snippet is self-consistent across all four commands", () => {
  const snip = buildTmuxSnippet("/dev/ttyUSB0", 115200, "tio", "my-session");
  for (const cmd of [
    "new-session -d -s my-session",
    "send-keys -t my-session",
    "capture-pane -t my-session",
  ]) {
    assert.ok(snip.includes(cmd), `missing: ${cmd}`);
  }
  assert.doesNotMatch(
    snip,
    /avocado-uart/,
    "default session name leaked into a custom session",
  );
});

test("send-keys passes Enter as a separate argument", () => {
  // Embedding '\n' inside the quoted string is the classic mistake; the target
  // receives a literal backslash-n and never executes the command.
  const snip = buildTmuxSnippet("/dev/ttyUSB0", 115200);
  assert.match(snip, /send-keys -t \S+ '[^']*' Enter/);
  assert.doesNotMatch(snip, /send-keys[^\n]*\\n/);
});

test("a port path with a quote is rejected, not sanitized into a phantom device", () => {
  // Rejecting (rather than stripping to a different device) makes injection
  // structurally impossible and keeps the tool's header + snippet consistent.
  assert.throws(
    () => buildTmuxSnippet("/dev/tty'; rm -rf ~; '", 115200),
    /not a usable device path/,
  );
});

test("a port path with no usable characters is rejected, not silently emptied", () => {
  assert.throws(
    () => buildTmuxSnippet("';'", 115200),
    /not a usable device path/,
  );
});

test("a real serial path passes through unchanged", () => {
  for (const p of [
    "/dev/ttyUSB0",
    "/dev/cu.usbserial-1420",
    "/dev/serial/by-id/usb-FTDI_FT232R-if00-port0",
    // by-path is the stable name users are pointed at, and it contains ':'.
    "/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0",
  ]) {
    const snip = buildTmuxSnippet(p, 115200);
    assert.ok(snip.includes(p), p);
  }
});

test("a port path that sanitizes to a flag-like token is rejected", () => {
  // A leading '-' would be read as an option by tio/picocom — reject rather
  // than let it become `tio -b 115200 -oEvil`.
  assert.throws(
    () => buildTmuxSnippet("-oProxyCommand=evil", 115200),
    /not a usable device path/,
  );
});

test("emulatorInvocation rejects an unsafe port instead of silently rewriting it", () => {
  // The exported function must not hand back a command aimed at a device that
  // doesn't exist — it's the point where the port becomes a command argument.
  for (const e of SUPPORTED_EMULATORS) {
    assert.throws(
      () => emulatorInvocation(e, "/dev/ttyUSB0; reboot", 115200),
      /not a usable device path/,
      e,
    );
  }
  // ...and a valid by-path port (with ':') passes through verbatim.
  const cmd = emulatorInvocation(
    "minicom",
    "/dev/serial/by-path/pci-0000:00:14.0-usb-0:2:1.0-port0",
    115200,
  );
  assert.match(cmd, /pci-0000:00:14\.0-usb-0:2:1\.0-port0/);
});

test("a session name that sanitizes to empty or a flag falls back to the default", () => {
  for (const bad of ["!!!", "-X"]) {
    const snip = buildTmuxSnippet("/dev/ttyUSB0", 115200, "tio", bad);
    assert.match(snip, /new-session -d -s avocado-uart\b/, bad);
  }
});

test("tmux addressing characters are stripped from a session name", () => {
  // ':' and '.' are session:window.pane syntax — "uart.2" must not reach
  // `-t uart.2`, which tmux reads as window+pane against the current session.
  const snip = buildTmuxSnippet("/dev/ttyUSB0", 115200, "tio", "uart.2");
  assert.match(snip, /-s uart2\b/);
  assert.doesNotMatch(snip, /uart[.:]2/);
});
