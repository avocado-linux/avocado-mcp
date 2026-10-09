import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveSitePath,
  isUnpublishedPath,
  parseFrontmatter,
  parseRedirects,
  resolveDoc,
  toDocEntry,
  type DocEntry,
} from "../../src/lib/docs-client.js";

test("deriveSitePath serves index pages without a trailing slash", () => {
  assert.equal(
    deriveSitePath("src/docs-hardware/raspberry-pi/raspberry-pi-5/index.mdx"),
    "hardware/raspberry-pi/raspberry-pi-5",
  );
  assert.equal(
    deriveSitePath("src/docs-guides/security/index.md"),
    "developer-reference/security",
  );
  assert.equal(
    deriveSitePath("src/docs-guides/seeding-var.md"),
    "developer-reference/seeding-var",
  );
  assert.equal(
    deriveSitePath("src/docs-changelog/march-2026/0.30.0.md"),
    "changelog/march-2026/0.30.0",
  );
});

test("deriveSitePath applies an absolute slug inside the section route", () => {
  assert.equal(
    deriveSitePath("src/docs-overview/cra.mdx", "/avocado-os/cra"),
    "avocado-os/cra",
  );
  assert.equal(
    deriveSitePath(
      "src/docs-overview/security/hardware-backed-encryption.md",
      "/avocado-os/security/encryption",
    ),
    "avocado-os/security/encryption",
  );
  assert.equal(deriveSitePath("src/docs-overview/resources.mdx", "/"), "");
  assert.equal(
    deriveSitePath("src/docs-guides/ota.md", "/updates/"),
    "developer-reference/updates",
  );
});

test("deriveSitePath resolves a relative slug against the doc directory", () => {
  assert.equal(
    deriveSitePath("src/docs-overview/policies/terms.md", "terms"),
    "policies/terms",
  );
  assert.equal(
    deriveSitePath("src/docs-guides/security/verity.md", "dm-verity"),
    "developer-reference/security/dm-verity",
  );
  assert.equal(
    deriveSitePath("src/docs-overview/about.mdx", "about-us"),
    "about-us",
  );
});

test("deriveSitePath maps dated field notes to the blog route", () => {
  assert.equal(
    deriveSitePath("src/field-notes/2026-06-24-hardened-boot-imx93.mdx"),
    "field-notes/2026/06/24/hardened-boot-imx93",
  );
});

test("isUnpublishedPath skips partials and excluded files", () => {
  assert.equal(
    isUnpublishedPath("src/docs-hardware/nvidia/_jetson-security.mdx"),
    true,
  );
  assert.equal(isUnpublishedPath("src/field-notes/_template.mdx"), true);
  assert.equal(isUnpublishedPath("src/docs-guides/_shared/note.md"), true);
  assert.equal(isUnpublishedPath("src/field-notes/CONTRIBUTING.md"), true);
  assert.equal(
    isUnpublishedPath("src/docs-hardware/nvidia/jetson-orin-nx/index.mdx"),
    false,
  );
});

test("parseFrontmatter reads draft with a trailing comment", () => {
  const { meta } = parseFrontmatter(
    "---\ntitle: 'A # title'\ndraft: true # until verified\nslug: /avocado-os/cra\n---\nbody\n",
  );
  assert.equal(meta.title, "A # title");
  assert.equal(meta.draft, "true");
  assert.equal(meta.slug, "/avocado-os/cra");
});

test("parseRedirects reads from/to pairs from the site config", () => {
  const src = `
    redirects: [
      { from: '/about', to: '/avocado-os/about' },
      {
        from: '/hardware/qualcomm/rubik-pi',
        to: "/hardware/qualcomm/rubik-pi-3",
      },
    ],`;
  assert.deepEqual(parseRedirects(src), {
    about: "avocado-os/about",
    "hardware/qualcomm/rubik-pi": "hardware/qualcomm/rubik-pi-3",
  });
});

test("toDocEntry skips drafts and applies the frontmatter slug", () => {
  const sha = "0".repeat(40);
  assert.equal(
    toDocEntry(
      "src/field-notes/2026-06-15-power-pull-orin-nx.mdx",
      sha,
      "---\ntitle: Power pull\ndraft: true # not ready\n---\nbody\n",
    ),
    null,
  );
  for (const spelling of ["True", "TRUE"]) {
    assert.equal(
      toDocEntry(
        "src/docs-guides/wip.md",
        sha,
        `---\ntitle: WIP\ndraft: ${spelling}\n---\nbody\n`,
      ),
      null,
    );
  }
  const cra = toDocEntry(
    "src/docs-overview/cra.mdx",
    sha,
    "---\ntitle: CRA\nslug: /avocado-os/cra\n---\nbody\n",
  );
  assert.equal(cra?.sitePath, "avocado-os/cra");
  assert.equal(cra?.url, "https://docs.peridio.com/avocado-os/cra");
  assert.equal(cra?.section, "overview");
  const note = toDocEntry(
    "src/field-notes/2026-07-08-imx8mp-npu-pose.mdx",
    sha,
    "---\ndraft: false\n---\nbody\n",
  );
  assert.equal(note?.sitePath, "field-notes/2026/07/08/imx8mp-npu-pose");
  assert.equal(note?.section, "field-notes");
});

function entry(repoPath: string, sitePath: string): DocEntry {
  return {
    repoPath,
    sitePath,
    url: `https://docs.peridio.com/${sitePath}`,
    section: "hardware",
    title: sitePath,
    description: "",
    sha: "0".repeat(40),
  };
}

test("resolveDoc matches site paths, URLs, repo paths and redirects", () => {
  const pi5 = entry(
    "src/docs-hardware/raspberry-pi/raspberry-pi-5/index.mdx",
    "hardware/raspberry-pi/raspberry-pi-5",
  );
  const about = entry("src/docs-overview/about.mdx", "avocado-os/about");
  const entries = [pi5, about];
  const redirects = { about: "avocado-os/about" };

  for (const q of [
    "hardware/raspberry-pi/raspberry-pi-5",
    "/hardware/raspberry-pi/raspberry-pi-5/",
    "https://docs.peridio.com/hardware/raspberry-pi/raspberry-pi-5",
    "https://docs.peridio.com/hardware/raspberry-pi/raspberry-pi-5/#provision",
    "src/docs-hardware/raspberry-pi/raspberry-pi-5/index.mdx",
  ]) {
    assert.equal(resolveDoc(entries, redirects, q), pi5, q);
  }
  assert.equal(resolveDoc(entries, redirects, "/about"), about);
  assert.equal(resolveDoc(entries, redirects, "hardware/nope"), null);
});
