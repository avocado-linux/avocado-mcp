import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerLayerAnalysisTools } from "../src/tools/layer-analysis.js";
import { registerRecipeTools } from "../src/tools/recipe.js";
import { RepoClient } from "../src/lib/repo-client.js";

type ToolResult = {
  structuredContent?: Record<string, unknown>;
  content?: Array<{ type: string; text?: string }>;
  isError?: boolean;
};

interface Finding {
  file: string;
  kind: string;
  target: string;
  satisfied_by_layer?: string;
}

let client: Client;

beforeEach(async () => {
  const server = new McpServer({ name: "test-layer", version: "0.0.0" });
  registerLayerAnalysisTools(server);

  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();

  client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);
});

afterEach(async () => {
  await client.close();
});

async function callTool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await client.callTool({
    name,
    arguments: args,
  })) as ToolResult;
}

/** Write a file, creating parent directories as needed. */
function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, "utf8");
}

/**
 * Create a layer directory with a conf/layer.conf carrying the given
 * BBFILE_COLLECTIONS name. Returns the layer dir path.
 */
function makeLayer(root: string, name: string, collection: string): string {
  const dir = join(root, name);
  write(
    join(dir, "conf", "layer.conf"),
    `BBFILE_COLLECTIONS += "${collection}"\n`,
  );
  return dir;
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "layer-analysis-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

/**
 * Build a minimal workspace with a meta-avocado parent holding one audited
 * layer, plus optional sibling layers. The composition lists meta-avocado and
 * any present sibling layers.
 */
describe("check-layer-coverage", () => {
  it("reports a dangling bbappend whose base recipe is absent and names the absent layer that provides it", async () => {
    // meta-avocado/meta-avocado-distro has a foo bbappend; no present layer
    // provides foo. A sibling absent layer (meta-vendor) contains foo_1.0.bb.
    const audited = join(tmp, "meta-avocado", "meta-avocado-distro");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-distro"\n`,
    );
    write(
      join(audited, "recipes-x", "foo", "foo_%.bbappend"),
      `# extend foo\n`,
    );
    // Absent vendor layer that DOES provide foo.
    makeLayer(tmp, "meta-vendor", "vendor");
    write(join(tmp, "meta-vendor", "recipes-x", "foo", "foo_1.0.bb"), "");

    // Composition: only meta-avocado present.
    write(
      join(tmp, "comp.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-distro:",
        "",
      ].join("\n"),
    );

    const result = await callTool("check-layer-coverage", {
      composition: "comp.yml",
      workspace_root: tmp,
    });

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.error).toBeUndefined();
    const findings = (out.findings ?? []) as Finding[];
    const dangling = findings.find(
      (f) => f.kind === "dangling_append" && f.target === "foo",
    );
    expect(dangling).toBeDefined();
    expect(dangling?.satisfied_by_layer).toBe("meta-vendor");
    expect(out.clean).toBe(false);
  });

  it("does not flag a bbappend whose base recipe is provided by a present layer", async () => {
    const audited = join(tmp, "meta-avocado", "meta-avocado-distro");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-distro"\n`,
    );
    write(join(audited, "recipes-x", "foo", "foo_%.bbappend"), `# extend foo\n`);
    // Present base layer providing foo.
    const base = makeLayer(tmp, "meta-base", "base");
    write(join(base, "recipes-x", "foo", "foo_1.0.bb"), "");

    write(
      join(tmp, "comp.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-distro:",
        "  meta-base:",
        "    path: meta-base",
        "    layers:",
        '        ".":',
        "",
      ].join("\n"),
    );

    const result = await callTool("check-layer-coverage", {
      composition: "comp.yml",
      workspace_root: tmp,
    });

    const out = result.structuredContent ?? {};
    const findings = (out.findings ?? []) as Finding[];
    expect(
      findings.find(
        (f) => f.kind === "dangling_append" && f.target === "foo",
      ),
    ).toBeUndefined();
  });

  it("flags a missing inherited bbclass but not a class provided by a present layer", async () => {
    const audited = join(tmp, "meta-avocado", "meta-avocado-sdk");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-sdk"\n`,
    );
    // qmake5 is not provided by any present layer; packagegroup is.
    write(
      join(audited, "recipes-x", "thing", "thing_1.0.bb"),
      `inherit qmake5 packagegroup\n`,
    );
    // Present layer providing packagegroup.bbclass.
    const core = makeLayer(tmp, "meta-core", "core");
    write(join(core, "classes", "packagegroup.bbclass"), "# core class\n");
    // Absent layer providing qmake5.bbclass.
    const qt = makeLayer(tmp, "meta-qt5", "qt5-layer");
    write(join(qt, "classes", "qmake5.bbclass"), "# qmake5\n");

    write(
      join(tmp, "comp.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-sdk:",
        "  meta-core:",
        "    path: meta-core",
        "    layers:",
        '        ".":',
        "",
      ].join("\n"),
    );

    const result = await callTool("check-layer-coverage", {
      composition: "comp.yml",
      workspace_root: tmp,
    });

    const out = result.structuredContent ?? {};
    const findings = (out.findings ?? []) as Finding[];
    const missing = findings.find(
      (f) => f.kind === "missing_class" && f.target === "qmake5",
    );
    expect(missing).toBeDefined();
    expect(missing?.satisfied_by_layer).toBe("meta-qt5");
    // packagegroup is present, so it must NOT be flagged.
    expect(
      findings.find(
        (f) => f.kind === "missing_class" && f.target === "packagegroup",
      ),
    ).toBeUndefined();
  });

  it("skips a dynamic-layers recipe when its gating collection is absent and audits it when present", async () => {
    const audited = join(tmp, "meta-avocado", "meta-avocado-sdk");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-sdk"\n`,
    );
    write(
      join(
        audited,
        "dynamic-layers",
        "qt5-layer",
        "recipes-x",
        "x",
        "x_git.bb",
      ),
      `inherit qmake5\n`,
    );
    // qmake5 class lives in an absent layer.
    const qt = makeLayer(tmp, "meta-qt5", "qt5-layer");
    write(join(qt, "classes", "qmake5.bbclass"), "# qmake5\n");

    const compAbsent = join(tmp, "comp.yml");
    write(
      compAbsent,
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-sdk:",
        "",
      ].join("\n"),
    );

    const absent = await callTool("check-layer-coverage", {
      composition: "comp.yml",
      workspace_root: tmp,
    });
    const absentFindings = ((absent.structuredContent ?? {}).findings ??
      []) as Finding[];
    // Gated out: no finding for the dynamic-layers recipe.
    expect(
      absentFindings.find((f) => f.target === "qmake5"),
    ).toBeUndefined();

    // Now make a PRESENT layer declare the qt5-layer collection so the recipe
    // is audited normally.
    const present = makeLayer(tmp, "meta-present-qt", "qt5-layer");
    void present;
    write(
      join(tmp, "comp2.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-sdk:",
        "  meta-present-qt:",
        "    path: meta-present-qt",
        "    layers:",
        '        ".":',
        "",
      ].join("\n"),
    );

    const presentRun = await callTool("check-layer-coverage", {
      composition: "comp2.yml",
      workspace_root: tmp,
    });
    const presentFindings = ((presentRun.structuredContent ?? {}).findings ??
      []) as Finding[];
    // qmake5 class is still absent (only meta-qt5 has it, which is not present),
    // so now the recipe IS audited and the missing class IS reported.
    expect(
      presentFindings.find(
        (f) => f.kind === "missing_class" && f.target === "qmake5",
      ),
    ).toBeDefined();
  });
});

describe("missing_require resolution", () => {
  it("resolves a bare require against the requiring file's own directory and does not flag it", async () => {
    // A recipe does `require thing.inc` with thing.inc co-located in the same
    // directory; bitbake searches the requiring file's dir first, so this must
    // NOT be reported as missing.
    const audited = join(tmp, "meta-avocado", "meta-avocado-distro");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-distro"\n`,
    );
    const recipeDir = join(audited, "recipes-x", "thing");
    write(join(recipeDir, "thing_1.0.bb"), `require thing.inc\n`);
    write(join(recipeDir, "thing.inc"), `# co-located include\n`);

    write(
      join(tmp, "comp.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-distro:",
        "",
      ].join("\n"),
    );

    const result = await callTool("check-layer-coverage", {
      composition: "comp.yml",
      workspace_root: tmp,
    });
    const out = result.structuredContent ?? {};
    const findings = (out.findings ?? []) as Finding[];
    expect(findings.find((f) => f.kind === "missing_require")).toBeUndefined();
  });

  it("flags a require that resolves against neither the file's dir nor a present layer root", async () => {
    const audited = join(tmp, "meta-avocado", "meta-avocado-distro");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-distro"\n`,
    );
    write(
      join(audited, "recipes-x", "thing", "thing_1.0.bb"),
      `require recipes-x/absent.inc\n`,
    );

    write(
      join(tmp, "comp.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "    layers:",
        "      meta-avocado-distro:",
        "",
      ].join("\n"),
    );

    const result = await callTool("check-layer-coverage", {
      composition: "comp.yml",
      workspace_root: tmp,
    });
    const out = result.structuredContent ?? {};
    const findings = (out.findings ?? []) as Finding[];
    expect(
      findings.find(
        (f) =>
          f.kind === "missing_require" &&
          f.target === "recipes-x/absent.inc",
      ),
    ).toBeDefined();
  });
});

describe("find-recipe-providers", () => {
  it("finds the layer providing a recipe and a class, and reports found=false when nothing matches", async () => {
    const vendor = makeLayer(tmp, "meta-vendor", "vendor");
    write(join(vendor, "recipes-x", "foo", "foo_1.0.bb"), "");
    write(join(vendor, "classes", "qmake5.bbclass"), "# qmake5\n");

    const recipe = await callTool("find-recipe-providers", {
      name: "foo",
      kind: "recipe",
      workspace_root: tmp,
    });
    const rOut = recipe.structuredContent ?? {};
    expect(rOut.found).toBe(true);
    const rProviders = (rOut.providers ?? []) as Array<{ layer: string }>;
    expect(rProviders.some((p) => p.layer === "meta-vendor")).toBe(true);

    const klass = await callTool("find-recipe-providers", {
      name: "qmake5",
      kind: "class",
      workspace_root: tmp,
    });
    const cOut = klass.structuredContent ?? {};
    expect(cOut.found).toBe(true);
    const cProviders = (cOut.providers ?? []) as Array<{ layer: string }>;
    expect(cProviders.some((p) => p.layer === "meta-vendor")).toBe(true);

    const none = await callTool("find-recipe-providers", {
      name: "no-such-thing-xyz",
      kind: "recipe",
      workspace_root: tmp,
    });
    expect((none.structuredContent ?? {}).found).toBe(false);
  });

describe("find-recipe-providers PROVIDES/RPROVIDES/BBCLASSEXTEND resolution", () => {
  it("finds a layer via a PROVIDES assignment, not just the filename PN", async () => {
    // A kernel recipe whose filename PN is linux-avocado but which provides
    // virtual/kernel via a PROVIDES line.
    const vendor = makeLayer(tmp, "meta-bsp", "bsp");
    write(
      join(vendor, "recipes-kernel", "linux", "linux-avocado_6.6.bb"),
      `SUMMARY = "kernel"\nPROVIDES = "virtual/kernel"\n`,
    );

    const result = await callTool("find-recipe-providers", {
      name: "virtual/kernel",
      kind: "recipe",
      workspace_root: tmp,
    });
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(true);
    const providers = (out.providers ?? []) as Array<{ layer: string }>;
    expect(providers.some((p) => p.layer === "meta-bsp")).toBe(true);
  });

  it("finds a layer via an RPROVIDES assignment", async () => {
    const vendor = makeLayer(tmp, "meta-rprov", "rprov");
    write(
      join(vendor, "recipes-x", "thing", "thing_1.0.bb"),
      `RPROVIDES:\${PN} = "thing-runtime"\n`,
    );

    const result = await callTool("find-recipe-providers", {
      name: "thing-runtime",
      kind: "recipe",
      workspace_root: tmp,
    });
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(true);
    const providers = (out.providers ?? []) as Array<{ layer: string }>;
    expect(providers.some((p) => p.layer === "meta-rprov")).toBe(true);
  });

  it("finds the native variant derived from BBCLASSEXTEND", async () => {
    const vendor = makeLayer(tmp, "meta-tools", "tools");
    write(
      join(vendor, "recipes-devtools", "flatbuffers", "flatbuffers_2.0.bb"),
      `SUMMARY = "flatbuffers"\nBBCLASSEXTEND = "native nativesdk"\n`,
    );

    const nativeResult = await callTool("find-recipe-providers", {
      name: "flatbuffers-native",
      kind: "recipe",
      workspace_root: tmp,
    });
    const nativeOut = nativeResult.structuredContent ?? {};
    expect(nativeOut.found).toBe(true);
    const nativeProviders = (nativeOut.providers ?? []) as Array<{
      layer: string;
    }>;
    expect(nativeProviders.some((p) => p.layer === "meta-tools")).toBe(true);

    const sdkResult = await callTool("find-recipe-providers", {
      name: "flatbuffers-nativesdk",
      kind: "recipe",
      workspace_root: tmp,
    });
    expect((sdkResult.structuredContent ?? {}).found).toBe(true);

    // The base PN is still found.
    const baseResult = await callTool("find-recipe-providers", {
      name: "flatbuffers",
      kind: "recipe",
      workspace_root: tmp,
    });
    expect((baseResult.structuredContent ?? {}).found).toBe(true);
  });

  it("still finds a recipe by filename PN when it has no PROVIDES line", async () => {
    const vendor = makeLayer(tmp, "meta-core", "core");
    write(join(vendor, "recipes-core", "zlib", "zlib_1.3.bb"), `SUMMARY = "zlib"\n`);

    const result = await callTool("find-recipe-providers", {
      name: "zlib",
      kind: "recipe",
      workspace_root: tmp,
    });
    const out = result.structuredContent ?? {};
    expect(out.found).toBe(true);
    const providers = (out.providers ?? []) as Array<{ layer: string }>;
    expect(providers.some((p) => p.layer === "meta-core")).toBe(true);
  });
});
});

describe("kas composition resolution", () => {
  it("resolves present layer dirs from a composition with repos + object-form header.includes", async () => {
    // meta-avocado holds an include file that declares the audited layer; the
    // top-level composition only points at the include via {repo, file}.
    const audited = join(tmp, "meta-avocado", "meta-avocado-distro");
    write(
      join(audited, "conf", "layer.conf"),
      `BBFILE_COLLECTIONS += "avocado-distro"\n`,
    );
    // Include file under meta-avocado/kas declaring the distro layer.
    write(
      join(tmp, "meta-avocado", "kas", "base.yml"),
      [
        "header:",
        "  version: 14",
        "repos:",
        "  meta-avocado:",
        "    layers:",
        "      meta-avocado-distro:",
        "",
      ].join("\n"),
    );
    // Top composition: declares meta-avocado repo, includes the base file.
    write(
      join(tmp, "machine.yml"),
      [
        "header:",
        "  version: 14",
        "  includes:",
        "    - repo: meta-avocado",
        "      file: kas/base.yml",
        "repos:",
        "  meta-avocado:",
        "    path: meta-avocado",
        "",
      ].join("\n"),
    );

    // A dangling bbappend in the audited layer proves the layer was resolved
    // present (the audit ran over it).
    write(
      join(audited, "recipes-x", "foo", "foo_%.bbappend"),
      `# extend foo\n`,
    );

    const result = await callTool("check-layer-coverage", {
      composition: "machine.yml",
      workspace_root: tmp,
    });
    const out = result.structuredContent ?? {};
    expect(out.error).toBeUndefined();
    const present = (out.present_layers ?? []) as string[];
    expect(
      present.some((p) => p.includes("meta-avocado/meta-avocado-distro")),
    ).toBe(true);
    const findings = (out.findings ?? []) as Finding[];
    expect(
      findings.find((f) => f.kind === "dangling_append" && f.target === "foo"),
    ).toBeDefined();
  });
});

describe("find-recipe-examples multi-layer workspace scan", () => {
  // find-recipe-examples has no workspace_root override; its `.bb` scan walks
  // defaultWorkspaceRoot() = the parent of avocado-mcp (resolve(cwd, "..")).
  // To exercise the broadened multi-layer scan deterministically we plant a
  // uniquely-named temp fixture UNDER that real root holding two distinct
  // layers, each with a conf/layer.conf and a `.bb` that inherits the same
  // unique class. The class string is unique per run so no real workspace
  // recipe can match the needle, making the result set exactly our two recipes
  // regardless of what real layers sit alongside the fixture.
  let exClient: Client;
  let fixtureRoot: string;
  let uniqueClass: string;

  beforeEach(async () => {
    // Mirror recipe.ts defaultWorkspaceRoot(): parent of the avocado-mcp repo.
    const workspaceRoot = resolve(process.cwd(), "..");
    fixtureRoot = mkdtempSync(join(workspaceRoot, "frex-fixture-"));
    uniqueClass = `frexclass${Math.random().toString(36).slice(2, 10)}`;

    // Layer A: a meta-avocado-like layer.
    const layerA = makeLayer(fixtureRoot, "meta-avocado", "avocado");
    write(
      join(layerA, "recipes-x", "alpha", "alpha_1.0.bb"),
      `SUMMARY = "alpha"\ninherit ${uniqueClass}\n`,
    );
    // Layer B: a sibling layer (e.g. meta-openembedded-style).
    const layerB = makeLayer(fixtureRoot, "meta-extra", "extra");
    write(
      join(layerB, "recipes-y", "beta", "beta_2.0.bb"),
      `SUMMARY = "beta"\ninherit ${uniqueClass}\n`,
    );

    const server = new McpServer({ name: "test-recipe", version: "0.0.0" });
    registerRecipeTools(server, new RepoClient());
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();
    exClient = new Client({ name: "test-client", version: "0.0.0" });
    await Promise.all([
      server.connect(serverTransport),
      exClient.connect(clientTransport),
    ]);
  });

  afterEach(async () => {
    await exClient.close();
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it("returns inherit-matching .bb examples from BOTH workspace layers, not just one", async () => {
    const result = (await exClient.callTool({
      name: "find-recipe-examples",
      arguments: { intent: uniqueClass, inherit: uniqueClass, limit: 50 },
    })) as ToolResult;

    expect(result.isError).not.toBe(true);
    const out = result.structuredContent ?? {};
    expect(out.error).toBeUndefined();
    expect(out.found).toBe(true);

    const examples = (out.examples ?? []) as Array<{ path: string }>;
    // Exactly the two fixture recipes match the unique inherit class.
    expect(examples.length).toBe(2);
    const paths = examples.map((e) => e.path);
    expect(
      paths.some((p) => p.includes("meta-avocado") && p.endsWith("alpha_1.0.bb")),
    ).toBe(true);
    expect(
      paths.some((p) => p.includes("meta-extra") && p.endsWith("beta_2.0.bb")),
    ).toBe(true);
  });
});
