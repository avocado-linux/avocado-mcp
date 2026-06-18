import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DocEntry } from "../src/lib/docs-client.js";

// searchDocs builds its index from listDocs() + fetchDocContent() in
// docs-client. Mock that module so the test exercises the search/source-tag
// path without any GitHub fetch. The mock returns one peridio-docs entry.
const PERIDIO_ENTRY: DocEntry = {
  repoPath: "src/docs-guides/seeding-var.md",
  sitePath: "developer-reference/seeding-var",
  url: "https://docs.peridio.com/developer-reference/seeding-var",
  section: "guides",
  title: "Seeding the var partition",
  description: "How to seed the var partition on first boot.",
  sha: "deadbeef",
  source: "peridio-docs",
};

vi.mock("../src/lib/docs-client.js", () => ({
  listDocs: vi.fn(async () => [PERIDIO_ENTRY]),
  fetchDocContent: vi.fn(
    async () =>
      "# Seeding the var partition\n\nThe var partition is seeded on first boot.",
  ),
}));

import {
  searchDocs,
  clearSearchIndex,
  loadYoctoRefsEntries,
} from "../src/lib/docs-search.js";

describe("searchDocs source tagging", () => {
  beforeEach(() => {
    clearSearchIndex();
  });
  afterEach(() => {
    clearSearchIndex();
    vi.clearAllMocks();
  });

  it("carries source: 'peridio-docs' on the entry of a peridio doc hit", async () => {
    const hits = await searchDocs("seeding var partition");

    expect(hits.length).toBeGreaterThan(0);
    const hit = hits[0];
    // The source discriminator must survive the search path on the matched
    // entry, so callers can distinguish Peridio docs from the yocto-refs corpus.
    expect(hit.entry.source).toBe("peridio-docs");
    // Confirm we matched the seeded entry, not some unrelated default.
    expect(hit.entry.sitePath).toBe("developer-reference/seeding-var");
  });
});

describe("loadYoctoRefsEntries", () => {
  // loadYoctoRefsEntries reads the vendored corpus from local files only —
  // never GitHub. Unset every token the docs-client would use so a stray
  // network call would surface as a thrown error rather than a silent fetch.
  const savedToken = process.env.GITHUB_TOKEN;
  const savedAlt = process.env.AVOCADO_MCP_GITHUB_TOKEN;
  beforeEach(() => {
    delete process.env.GITHUB_TOKEN;
    delete process.env.AVOCADO_MCP_GITHUB_TOKEN;
  });
  afterEach(() => {
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
    if (savedAlt === undefined) delete process.env.AVOCADO_MCP_GITHUB_TOKEN;
    else process.env.AVOCADO_MCP_GITHUB_TOKEN = savedAlt;
  });

  it("loads the vendored corpus from local files with GITHUB_TOKEN unset", () => {
    expect(process.env.GITHUB_TOKEN).toBeUndefined();

    // Must not throw a network error: the function is pure local-file I/O.
    const entries = loadYoctoRefsEntries();

    // The vendored corpus is present in-repo, so the result is non-empty.
    expect(entries.length).toBeGreaterThan(0);
    // Every entry is tagged with the yocto-refs source discriminator.
    for (const e of entries) {
      expect(e.entry.source).toBe("yocto-refs");
    }
    // The variables glossary contributes a recognizable BitBake variable as a
    // section title, confirming the :term: split actually ran.
    const titles = entries.map((e) => e.entry.title);
    expect(titles).toContain("SRC_URI");
    // Each entry carries a non-empty body so the index can score it without a
    // network fetch.
    const srcUri = entries.find((e) => e.entry.title === "SRC_URI");
    expect(srcUri).toBeDefined();
    expect(srcUri!.body.length).toBeGreaterThan(0);
  });
});
