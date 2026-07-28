import { test } from "node:test";
import assert from "node:assert/strict";
import {
  getDeviceConnectionInfo,
  buildTmuxSnippet,
  emulatorInvocation,
  SUPPORTED_EMULATORS,
} from "../../src/lib/device-info.js";

test("unknown targets fall back to 115200 8N1 rather than throwing", () => {
  const info = getDeviceConnectionInfo("brand-new-board-9000");
  assert.equal(info.serial.baud, 115200);
  assert.equal(info.serial.dataBits, 8);
  assert.equal(info.serial.stopBits, 1);
  assert.equal(info.serial.parity, "none");
  assert.deepEqual(info.caveats, []);
});

test("targets with wiring hazards always carry a caveat", () => {
  for (const t of [
    "jetson-orin-nano-devkit",
    "raspberrypi5",
    "imx8mp-evk",
    "fr201",
    "qemux86-64",
  ]) {
    assert.ok(getDeviceConnectionInfo(t).caveats.length > 0, t);
  }
});

test("boards where a 3.3V TTL adapter is the wrong tool say so", () => {
  const info = getDeviceConnectionInfo("fr201");
  assert.match(info.caveats.join(" "), /RS-232|±12V/);
});

test("targets warning against VCC do so unambiguously", () => {
  for (const t of ["jetson-orin-nano-devkit", "raspberrypi5"]) {
    assert.match(
      getDeviceConnectionInfo(t).caveats.join(" "),
      /Do NOT connect VCC/,
    );
  }
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

test("a session name sanitized to empty falls back to the default", () => {
  const snip = buildTmuxSnippet("/dev/ttyUSB0", 115200, "tio", "!!!");
  assert.match(snip, /new-session -d -s avocado-uart\b/);
});
