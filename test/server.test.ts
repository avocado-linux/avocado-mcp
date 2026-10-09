import { test } from "node:test";
import assert from "node:assert/strict";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  chmodSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join, relative } from "path";

import { RepoClient } from "../src/lib/repo-client.js";
import { registerConfigTools } from "../src/tools/config.js";
import { registerPackageTools } from "../src/tools/packages.js";
import { registerDiscoveryTools } from "../src/tools/discovery.js";
import { registerReferenceTools } from "../src/tools/references.js";
import { registerProjectTools } from "../src/tools/project.js";
import { registerDiagnosticsTools } from "../src/tools/diagnostics.js";
import { registerDebuggingTools } from "../src/tools/debugging.js";
import { registerDocsTools } from "../src/tools/docs.js";
import { registerConnectTools } from "../src/tools/connect.js";
import { registerHardwareTools } from "../src/tools/hardware.js";
import { registerSkillResources } from "../src/tools/resources.js";
import { registerPrompts } from "../src/tools/prompts.js";
import { clearHardwareDataCache } from "../src/lib/hardware-data.js";
import { TARGETS, DEVICES } from "./lib/hardware-fixture.js";

// Validate against the vendored schema: no network in tests.
process.env.AVOCADO_MCP_SCHEMA_OFFLINE = "1";

async function connect(repoClient = new RepoClient()) {
  const server = new McpServer({ name: "avocado-os", version: "test" });
  registerSkillResources(server);
  registerPrompts(server);
  registerDiscoveryTools(server, repoClient);
  registerReferenceTools(server);
  registerConfigTools(server);
  registerPackageTools(server, repoClient);
  registerProjectTools(server, repoClient);
  registerDiagnosticsTools(server, repoClient);
  registerDebuggingTools(server);
  registerDocsTools(server);
  registerConnectTools(server);
  registerHardwareTools(server);

  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(c), server.connect(s)]);
  return { client, server };
}

test("every tool/resource/prompt registers without collision", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.equal(new Set(names).size, names.length, "duplicate tool names");
  // Exact counts, not floors: a `>=` below actual lets a small drop pass
  // silently. Bump these deliberately when adding a tool/resource/prompt —
  // the change is the point where you confirm the registration is intended.
  assert.equal(names.length, 28, `tool count changed: ${names.join(", ")}`);
  console.log(`  ${names.length} tools:`, names.join(", "));

  const { resources } = await client.listResources();
  assert.equal(resources.length, 18, "resource count changed");
  console.log(`  ${resources.length} resources`);
  const { prompts } = await client.listPrompts();
  assert.equal(prompts.length, 8, "prompt count changed");
  console.log(
    `  ${prompts.length} prompts:`,
    prompts.map((p) => p.name).join(", "),
  );
});

test("tool contract: every tool has description + object schema", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  for (const t of tools) {
    assert.ok(
      t.description && t.description.length > 30,
      `${t.name}: thin description`,
    );
    assert.equal(t.inputSchema.type, "object", `${t.name}: bad schema`);
  }
});

test("connect-init is marked destructive", async () => {
  // It overwrites the device config and mints a new claim token, so hosts
  // that gate on annotations must ask before they run it.
  const { client } = await connect();
  const { tools } = await client.listTools();
  const init = tools.find((t) => t.name === "connect-init");
  assert.equal(init?.annotations?.destructiveHint, true);
});

test("offline tool round-trips through the protocol", async () => {
  const { client } = await connect();
  // A schema-VALID fixture, so this exercises the happy path it's named for.
  // (A minimal extensions-only doc fails validation — the tool would report
  // errors, which isn't an isError, so the round-trip would pass vacuously.)
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: {
      yaml: "distro:\n  release: 2024\n  channel: edge\nruntimes:\n  dev:\n    extensions: [app]\nextensions:\n  app:\n    types: [sysext]\n",
    },
  });
  // Success may omit isError OR set it false, per the MCP spec — assert it's
  // simply not an error rather than coupling to one representation...
  assert.notEqual(res.isError, true);
  // ...and assert it actually reports success, not just "didn't error".
  const structured = res.structuredContent as { ok?: boolean } | undefined;
  assert.equal(structured?.ok, true, JSON.stringify(res.content));
  console.log("  ->", JSON.stringify(res.content).slice(0, 200));
});

test("bad arguments are rejected as isError, not coerced or crashed", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: { yaml: 42 },
  });
  assert.equal(res.isError, true, "wrong-typed arg should be an error result");
});

test("unknown tool name is an error result, not a hang", async () => {
  const { client } = await connect();
  const res = await client.callTool({ name: "no-such-tool", arguments: {} });
  assert.equal(res.isError, true);
});

test("an unknown deploy log gets deploy next steps, not build ones", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "explain-build-error",
    arguments: {
      log: "Error: something new went wrong on the device\nexit code: 1",
      command: "deploy",
      targets: ["raspberrypi5"],
    },
  });
  assert.notEqual(res.isError, true);
  const text = (res.content as { text: string }[])[0].text;
  assert.match(text, /deploy failures/);
  assert.match(text, /avocadoctl status/);
  assert.match(text, /journalctl/);
  assert.doesNotMatch(text, /build failures|validate-yaml|search-packages/);
  // Device checks must return on their own in an automated run.
  assert.match(text, /BatchMode=yes/);
  assert.doesNotMatch(text, /ssh root@|ping <device-ip>/);
  // No package lookup for a deploy log.
  const sc = res.structuredContent as { investigations?: unknown };
  assert.equal(sc.investigations, undefined);
});

/** Serve the board data fixture in place of the docs site. */
function serveHardwareFixture(): () => void {
  const realFetch = globalThis.fetch;
  clearHardwareDataCache();
  globalThis.fetch = (async (url: RequestInfo | URL) => {
    const u = String(url);
    const body = u.endsWith("targets.json") ? TARGETS : { devices: DEVICES };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = realFetch;
    clearHardwareDataCache();
  };
}

test("get-tmux-uart-snippet sends a QEMU board name to the VM console", async () => {
  const restore = serveHardwareFixture();
  try {
    const { client } = await connect();
    const res = await client.callTool({
      name: "get-tmux-uart-snippet",
      arguments: { portPath: "/dev/ttyUSB0", target: "QEMU x86-64" },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /`qemux86-64` is a virtual target/);
    assert.doesNotMatch(text, /tmux new-session/);
  } finally {
    restore();
  }
});

test("a flag-like serial port is rejected by the tool's input schema", async () => {
  // The port pattern lives on the zod field, so the SDK rejects it before the
  // handler — the LLM is told the constraint rather than getting a bare throw.
  const { client } = await connect();
  const res = await client.callTool({
    name: "get-tmux-uart-snippet",
    arguments: { portPath: "-oProxyCommand=evil", target: "raspberrypi5" },
  });
  assert.equal(res.isError, true, "schema-invalid portPath must be an error");
  // Pin the SCHEMA constraint itself. The handler's assertSafePortPath throws
  // "is not a usable device path", which also contains "device path" — so match
  // the schema's UNIQUE phrasing ("must be a device path"). Deleting
  // `.regex(SAFE_PORT_RE)` would fall through to the handler message and fail.
  assert.match(
    JSON.stringify(res.content),
    /must be a device path/,
    JSON.stringify(res.content),
  );
});

test("init-project refuses feed args that would inject into avocado.yaml", async () => {
  const { client } = await connect();
  for (const args of [
    { release: "2026\n  repo:\n    url: https://evil.example" },
    { repoUrl: "https://a.example/x\n    tls_verify: false" },
    { repoUrl: "https://a.example/x\u0085tls_verify:\u0085" },
    { repoUrl: "https://ci:s3cr3t@mirror.example/avocado" },
  ]) {
    const res = await client.callTool({
      name: "init-project",
      arguments: { target: "qemux86-64", forceFromScratch: true, ...args },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /^# init-project failed/, JSON.stringify(args));
    assert.doesNotMatch(text, /```yaml|s3cr3t/, JSON.stringify(args));
  }
});

test("init-project refuses runtime, board and extension values that would inject", async () => {
  const { client } = await connect();
  for (const args of [
    { runtimeName: "dev; rm -rf ~" },
    { board: "a\nb" },
    { extraExtensions: ["ok", "x\u0085evil: 1"] },
  ]) {
    const res = await client.callTool({
      name: "init-project",
      arguments: { target: "qemux86-64", forceFromScratch: true, ...args },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /^# init-project failed/, JSON.stringify(args));
  }
});

test("init-project refuses an unsafe target when targets.json is unreachable", async () => {
  // Offline: the feed support check is skipped, so only the input check
  // stands between the target and the printed shell commands.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const { client } = await connect();
    const res = await client.callTool({
      name: "init-project",
      arguments: { target: "qemux86-64; rm -rf ~", forceFromScratch: true },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /^# init-project failed/);
    assert.doesNotMatch(text, /rm -rf ~[^"]/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("init-project from scratch tells the model to run avocado init", async () => {
  // No network: the feed's target list is unavailable, so the target is not
  // checked, and the from-scratch path runs.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const { client } = await connect();
    const call = async (extra: Record<string, unknown>) => {
      const res = await client.callTool({
        name: "init-project",
        arguments: {
          target: "jetson-orin-nx",
          forceFromScratch: true,
          board: "mic-712-ox-16gb",
          ...extra,
        },
      });
      return (res.content as { text: string }[])[0].text;
    };

    const withCli = await call({});
    assert.match(
      withCli,
      /avocado init --target jetson-orin-nx <project-dir> && cd <project-dir>/,
    );
    assert.match(withCli, /default_target_board: mic-712-ox-16gb/);
    assert.doesNotMatch(withCli, /```yaml/);

    const noCli = await call({ cliAvailable: false });
    assert.doesNotMatch(noCli, /avocado init --target/);
    assert.match(noCli, /```yaml\n# yaml-language-server/);
    assert.match(noCli, /default_target_board: mic-712-ox-16gb/);
    assert.match(noCli, /validates against the schema/);

    const noCliExtra = await call({
      cliAvailable: false,
      extraExtensions: ["my-app"],
    });
    assert.match(noCliExtra, /does not define it yet/);
    assert.match(noCliExtra, /add-extension/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("an exact match still lists the feeds the MCP could not read", async () => {
  // One feed has the package, another enabled feed was not read. It can
  // serve another version at a higher priority, so the warning stays.
  class StubRepo extends RepoClient {
    override async getTargetsConfig() {
      return { qemuarm64: ["target/armv8a"] };
    }
    override async searchPackages() {
      return {
        totalMatches: 1,
        results: [
          {
            name: "curl",
            summary: "",
            description: "",
            version: "8.0",
            release: "r0",
            arch: "armv8a",
            repo: "target/armv8a",
            href: "",
            feed: "avocado",
            score: 100,
          },
        ],
        errors: [],
        notChecked: [
          { target: "qemuarm64", feed: "acme", reason: "private feed" },
        ],
      };
    }
  }
  const { client } = await connect(new StubRepo());

  const described = await client.callTool({
    name: "describe-package",
    arguments: { targets: ["qemuarm64"], name: "curl" },
  });
  const sc = described.structuredContent as {
    found: boolean;
    notChecked?: { feed: string }[];
  };
  assert.equal(sc.found, true);
  assert.deepEqual(
    sc.notChecked?.map((n) => n.feed),
    ["acme"],
  );
  assert.match(
    (described.content as { text: string }[])[0].text,
    /Not checked[\s\S]*`acme` for `qemuarm64`/,
  );

  const added = await client.callTool({
    name: "add-package-to-extension",
    arguments: {
      yaml: "extensions:\n  app:\n    types: [sysext]\n",
      extension: "app",
      packageName: "curl",
      targets: ["qemuarm64"],
    },
  });
  const text = (added.content as { text: string }[])[0].text;
  assert.match(text, /Verified `curl`/);
  assert.match(text, /Not checked[\s\S]*`acme` for `qemuarm64`/);
});

test("validate-yaml reports ignored keys as warnings, not errors", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "validate-yaml",
    arguments: { yaml: "runtimes:\n  dev:\n    extentions: [app]\n" },
  });
  const s = res.structuredContent as { ok: boolean; warnings: string[] };
  assert.equal(s.ok, true);
  assert.deepEqual(s.warnings, [
    "unknown key 'runtimes.dev.extentions' is ignored; did you mean 'extensions'?",
  ]);
});

test("add-extension does not write version for a source extension", async () => {
  const { client } = await connect();
  const res = await client.callTool({
    name: "add-extension",
    arguments: {
      yaml: "extensions:\n  base:\n    types: [sysext]\n",
      name: "app",
      version: "1.2.3",
      source: { type: "git", url: "https://x/y.git" },
    },
  });
  const text = (res.content as { text: string }[])[0].text;
  assert.match(text, /app:\n {4}source:/);
  assert.doesNotMatch(text, /1\.2\.3/);
});

test("add-package-to-extension treats a feed that failed to load as unread", async () => {
  let hit = false;
  class StubRepo extends RepoClient {
    override async searchPackages() {
      return {
        totalMatches: hit ? 1 : 0,
        results: hit
          ? [
              {
                name: "curl",
                summary: "",
                description: "",
                version: "8.0",
                release: "r0",
                arch: "armv8a",
                repo: "target/armv8a",
                href: "",
                feed: "avocado",
                score: 100,
              },
            ]
          : [],
        errors: [
          {
            target: "qemuarm64",
            messages: ["vendor: https://vendor.example returned 500"],
          },
        ],
        notChecked: [],
      };
    }
  }
  const { client } = await connect(new StubRepo());
  const add = async () => {
    const res = await client.callTool({
      name: "add-package-to-extension",
      arguments: {
        yaml: "extensions:\n  app:\n    types: [sysext]\n",
        extension: "app",
        packageName: "curl",
        targets: ["qemuarm64"],
      },
    });
    return (res.content as { text: string }[])[0].text;
  };

  const missing = await add();
  assert.doesNotMatch(missing, /add-package-to-extension failed/);
  assert.match(missing, /Could not verify `curl`/);
  assert.match(
    missing,
    /Failed to load[\s\S]*vendor: https:\/\/vendor\.example returned 500/,
  );

  hit = true;
  const found = await add();
  assert.match(found, /Verified `curl`/);
  assert.match(found, /Failed to load[\s\S]*returned 500/);
});

test("describe-package surfaces feeds that failed to load", async () => {
  class StubRepo extends RepoClient {
    override async getTargetsConfig() {
      return { qemuarm64: ["target/armv8a"] };
    }
    override async searchPackages() {
      return {
        totalMatches: 0,
        results: [],
        errors: [
          {
            target: "qemuarm64",
            messages: ["vendor: https://vendor.example returned 500"],
          },
        ],
        notChecked: [],
      };
    }
  }
  const { client } = await connect(new StubRepo());
  const res = await client.callTool({
    name: "describe-package",
    arguments: { targets: ["qemuarm64"], name: "curl" },
  });
  const text = (res.content as { text: string }[])[0].text;
  assert.match(text, /No exact match .* in the feeds checked/);
  assert.match(text, /Failed to load[\s\S]*vendor\.example returned 500/);
  assert.deepEqual((res.structuredContent as { errors: unknown }).errors, [
    {
      target: "qemuarm64",
      message: "vendor: https://vendor.example returned 500",
    },
  ]);
});

test("check-package-coverage marks a failed feed's misses not checked and counts only confirmed rows in the percentage", async () => {
  const pkg = (name: string) => ({
    name,
    summary: "",
    description: "",
    version: "1",
    release: "r0",
    arch: "armv8a",
    repo: "target/armv8a",
    href: "",
    feed: "avocado",
  });
  class StubRepo extends RepoClient {
    override async getTargetsConfig() {
      return { qemuarm64: ["target/armv8a"] };
    }
    override async fetchTargetPackages() {
      return {
        packages: [pkg("curl"), pkg("jq"), pkg("zlib")],
        errors: ["vendor: https://vendor.example returned 500"],
        notChecked: [],
      };
    }
  }
  const { client } = await connect(new StubRepo());
  const res = await client.callTool({
    name: "check-package-coverage",
    arguments: {
      target: "qemuarm64",
      dependencies: [
        "curl",
        "jq",
        "zlib",
        ...[1, 2, 3, 4, 5, 6, 7].map((i) => `zzz${i}`),
      ].map((name) => ({ name, queries: [name] })),
    },
  });
  const sc = res.structuredContent as {
    summary: {
      present: number;
      missing: number;
      notChecked: number;
      coveragePercent: number;
    };
    results: { status: string }[];
  };
  assert.deepEqual(
    sc.results.map((r) => r.status),
    [...Array(3).fill("present"), ...Array(7).fill("not-checked")],
  );
  assert.equal(sc.summary.present, 3);
  assert.equal(sc.summary.missing, 0);
  assert.equal(sc.summary.notChecked, 7);
  assert.equal(sc.summary.coveragePercent, 30);
  assert.match(
    (res.content as { text: string }[])[0].text,
    /Coverage:\*\* 30% confirmed \(3\/10 present\), 7 not checked because 1 feed was not read/,
  );
});

test("provisioning tools refuse a runtime that would inject into a command", async () => {
  const { client } = await connect();
  for (const [name, args] of [
    ["get-provisioning-steps", { target: "rubikpi3" }],
    ["list-provision-profiles", { projectDir: "." }],
  ] as const) {
    const res = await client.callTool({
      name,
      arguments: { ...args, runtime: "dev; rm -rf ~" },
    });
    assert.equal(res.isError, true, name);
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /Invalid runtime/, name);
  }
});

test("list-provision-profiles resolves a relative projectDir once", async () => {
  const realFetch = globalThis.fetch;
  const realBinary = process.env.AVOCADO_BINARY;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "avocado-mcp-list-"));
  writeFileSync(join(dir, "avocado.yaml"), "default_target: rubikpi3\n");
  // A fake CLI that reports its working directory and its --config value.
  const bin = join(dir, "fake-avocado");
  writeFileSync(
    bin,
    `#!/bin/sh\nprintf '{"available":false,"reason":"cwd=%s %s"}\\n' "$(pwd -P)" "$5"\n`,
  );
  chmodSync(bin, 0o755);
  process.env.AVOCADO_BINARY = bin;
  try {
    const { client } = await connect();
    const res = await client.callTool({
      name: "list-provision-profiles",
      arguments: { projectDir: relative(process.cwd(), dir) },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.ok(text.includes(`cwd=${realpathSync(dir)} `), text);
    assert.ok(text.includes(`--config=${join(dir, "avocado.yaml")}`), text);
  } finally {
    globalThis.fetch = realFetch;
    rmSync(dir, { recursive: true, force: true });
    if (realBinary === undefined) delete process.env.AVOCADO_BINARY;
    else process.env.AVOCADO_BINARY = realBinary;
  }
});

test("list-provision-profiles docs fallback uses the board in avocado.yaml", async () => {
  const restore = serveHardwareFixture();
  const realBinary = process.env.AVOCADO_BINARY;
  const dir = mkdtempSync(join(tmpdir(), "avocado-mcp-board-"));
  writeFileSync(
    join(dir, "avocado.yaml"),
    "default_target: jetson-agx-orin-devkit\ndefault_target_board: mic-733-ao5a1\n",
  );
  // A fake CLI for a project that is not installed yet.
  const bin = join(dir, "fake-avocado");
  writeFileSync(
    bin,
    `#!/bin/sh\necho '{"available":false,"reason":"not installed","target":"jetson-agx-orin-devkit"}'\n`,
  );
  chmodSync(bin, 0o755);
  process.env.AVOCADO_BINARY = bin;
  try {
    const { client } = await connect();
    const res = await client.callTool({
      name: "list-provision-profiles",
      arguments: { projectDir: dir },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(text, /`jetson-agx-orin-devkit` board `mic-733-ao5a1`/);
    assert.doesNotMatch(text, /tegraflash/);
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
    if (realBinary === undefined) delete process.env.AVOCADO_BINARY;
    else process.env.AVOCADO_BINARY = realBinary;
  }
});

test("environment-check says when the disk check fell back to 8 GB", async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("offline");
  }) as typeof fetch;
  try {
    const { client } = await connect();
    const res = await client.callTool({
      name: "environment-check",
      arguments: { target: "jetson-agx-orin-devkit" },
    });
    const text = (res.content as { text: string }[])[0].text;
    assert.match(
      text,
      /\*\*Disk check:\*\* Board data unavailable.*generic 8 GB/,
    );
    const s = res.structuredContent as {
      disk: { minGB: number; note?: string };
    };
    assert.equal(s.disk.minGB, 8);
    assert.match(s.disk.note ?? "", /generic 8 GB/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("/provision-device rechecks the disk for the target and passes the runtime", async () => {
  const { client } = await connect();
  const res = await client.getPrompt({
    name: "provision-device",
    arguments: { target: "jetson-orin-nano-devkit", runtime: "prod" },
  });
  const text = (res.messages[0].content as { text: string }).text;
  assert.match(
    text,
    /Call `environment-check` again with `target` set to the chosen target/,
  );
  assert.match(
    text,
    /call `get-provisioning-steps` with the chosen target and `runtime: "prod"`/,
  );
});
