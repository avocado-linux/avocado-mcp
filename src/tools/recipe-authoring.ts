import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const URI = "avocado://recipe-authoring/guide";
const NAME = "recipe-authoring-guide";
const DESCRIPTION =
  "Cheat-sheet for authoring Avocado OS / Yocto BitBake recipes: when to write a new recipe, the minimum required variables, build-system and QA classes, and how to add a recipe to a feed.";

const CONTENT = `# Avocado OS / Yocto Recipe Authoring Guide

A prose cheat-sheet for the recipe-authoring workflow. Read this before writing
a \`.bb\` recipe so you reach for an existing recipe when one already exists and
get the required scaffolding right on the first build.

## When to author a new recipe

Do not write a recipe until you have confirmed one does not already exist.
Search the layer index first (the \`search-layer-index\` tool) for the package
name and for likely aliases — many upstream projects already ship a recipe in
\`openembedded-core\`, \`meta-openembedded\`, or an Avocado layer, and the right
move is to consume or \`.bbappend\` that recipe rather than fork it. Author a new
recipe only when the search comes back empty, when the existing recipe targets
an incompatible version, or when the source is a project with no upstream recipe
at all. A new recipe is a maintenance liability; an existing one is free.

## Minimum required BitBake variables

Every recipe needs this scaffolding. Leave any of it out and the build either
refuses to parse or fails a QA gate:

- \`DESCRIPTION\` — a one-line human summary of what the package provides.
- \`LICENSE\` — the SPDX license identifier (e.g. \`MIT\`, \`Apache-2.0\`,
  \`GPL-2.0-only\`). It must match the project's actual license.
- \`LIC_FILES_CHKSUM\` — a checksum of the license file in the source tree, in
  the form \`file://COPYING;md5=<hash>\`. BitBake recomputes this on every build
  and fails loudly if the license text changes, which is your early warning that
  the upstream license shifted.
- \`SRC_URI\` — where the source comes from (a release tarball URL, a
  \`git://\` URL, a PyPI fetch, etc.).
- \`SRCREV\` — for git-fetched sources, the exact commit SHA to build. Pin a real
  SHA for anything you ship. \`AUTOREV\` (which floats to the branch tip) is a
  development-only convenience — never commit \`AUTOREV\` to a recipe destined for
  a feed, because the build stops being reproducible.

## Build-system classes

\`inherit\`-ing a build-system class injects the standard \`do_configure\`,
\`do_compile\`, and \`do_install\` task implementations so you do not hand-write
them. Pick the one matching the project's build system:

- \`cmake\` — for CMake projects; runs the CMake configure/build/install dance.
- \`meson\` — for Meson projects; drives \`meson\` + \`ninja\`.
- \`setuptools3\` — for Python projects with a \`setup.py\` / \`pyproject.toml\`;
  builds and installs the package against Python 3.

## QA and packaging classes

- \`inherit python3-dir\` — pulls in the correct Python 3 site-packages paths so
  a Python package installs to the directory the QA checks expect. Use it for
  any Python recipe that places files under the Python library tree.
- \`BBCLASSEXTEND = "native nativesdk"\` — generates extra variants of the recipe
  for the build host. \`native\` builds a copy that runs on the build machine (so
  other recipes can use it as a build-time tool), and \`nativesdk\` builds a copy
  for the cross-SDK. Add this when something the package provides is needed
  during the build of other recipes, not just on the target.

## Adding the recipe to a feed

Once the recipe builds in isolation, wire it into the Avocado feed:

1. Copy the recipe into the meta layer under
   \`meta-avocado/recipes-<subsystem>/<name>/\`, choosing \`<subsystem>\` to match
   the package's domain (e.g. \`recipes-connectivity\`, \`recipes-python\`) and
   \`<name>\` as the recipe's base name.
2. From inside a kas shell, run \`devtool build <name>\` to build it within the
   full layer context and confirm it resolves against the feed's dependencies
   and configuration — not just standalone.
`;

export function registerRecipeAuthoringResource(server: McpServer): void {
  server.resource(
    NAME,
    URI,
    { description: DESCRIPTION, mimeType: "text/markdown" },
    async () => ({
      contents: [
        {
          uri: URI,
          text: CONTENT,
          mimeType: "text/markdown",
        },
      ],
    }),
  );
}
