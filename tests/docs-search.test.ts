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

import { searchDocs, clearSearchIndex } from "../src/lib/docs-search.js";

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
