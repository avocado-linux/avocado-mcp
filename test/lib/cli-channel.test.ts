import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertWorkstationChannel,
  hostChannelMessage,
} from "../../src/lib/cli-channel.js";

const PROFILES = {
  operation: "Listing provision profiles",
  command: "avocado provision --list --output json",
};

test("the Connect tools keep their host-tool channel message", () => {
  const msg = hostChannelMessage();
  assert.match(msg, /^Avocado Connect tools run `avocado` locally/);
  assert.match(msg, /Run `avocado connect …` through the host channel/);
});

test("list-provision-profiles gets its own host-tool channel message", () => {
  const msg = hostChannelMessage(PROFILES);
  assert.match(msg, /^Listing provision profiles runs `avocado` locally/);
  assert.match(
    msg,
    /Run `avocado provision --list --output json` yourself through the host channel/,
  );
  assert.doesNotMatch(msg, /Connect|avocado connect/);
});

test("a host-tool session rejects with the message for the operation", async () => {
  const realFetch = globalThis.fetch;
  // The probe sees a host MCP that can run the CLI. The probe result is
  // memoized for the process, so both calls below use this one.
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        result: {
          tools: [{ name: "run_avocado_cli" }, { name: "avocado_cli_status" }],
        },
      }),
      { status: 200 },
    )) as typeof fetch;
  try {
    await assert.rejects(assertWorkstationChannel(PROFILES), {
      message: hostChannelMessage(PROFILES),
    });
    await assert.rejects(assertWorkstationChannel(), {
      message: hostChannelMessage(),
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});
