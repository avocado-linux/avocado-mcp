import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listReferences,
  searchReferences,
  getReferenceEntry,
  fetchReferenceProject,
  fetchReferenceFile,
  referenceUrl,
  type ReferenceEntry,
  type ReferenceProject,
} from "../lib/references-client.js";

export function registerReferenceTools(server: McpServer): void {
  server.tool(
    "list-references",
    "List the catalog of Avocado OS reference projects (working starter projects in C, Python, Rust, Node, Elixir, etc.). Returns slug + title + language + a one-line summary for each. Use this when the user wants to see what examples exist or pick one to copy from.",
    {},
    async () => {
      const all = listReferences();
      return {
        content: [
          { type: "text", text: renderList(all) },
          {
            type: "text",
            text: `\n\`\`\`json\n${JSON.stringify(all, null, 2)}\n\`\`\``,
          },
        ],
      };
    },
  );

  server.tool(
    "search-references",
    "Search the reference catalog by free text (matches against slug, title, language, summary, and tags). Optionally filter to references known to work on a specific target.",
    {
      query: z
        .string()
        .describe(
          "Free-text search. Examples: 'python', 'gpio', 'gstreamer', 'kiosk'.",
        ),
      target: z
        .string()
        .optional()
        .describe(
          "Optional target to filter by (e.g. 'raspberrypi5'). Only matches references whose 'hardware' list either contains this target or is empty (generic).",
        ),
    },
    async ({ query, target }) => {
      const matches = searchReferences(query, target);
      return {
        content: [
          {
            type: "text",
            text: `# search-references\n\n**Query:** \`${query}\`${target ? `  •  **Target:** \`${target}\`` : ""}\n**Matches:** ${matches.length}\n\n${renderList(matches)}`,
          },
          {
            type: "text",
            text: `\n\`\`\`json\n${JSON.stringify(matches, null, 2)}\n\`\`\``,
          },
        ],
      };
    },
  );

  server.tool(
    "get-reference",
    "Fetch the full project bundle for a reference: file tree, `avocado.yaml`, README, getting-started guide, and a summary of build hooks and overlay layout. Use this after the user picks a reference via list-references or search-references. Files large or specific to a single concern (e.g. `app/server.js`) are NOT included by default — fetch them with `get-reference-file` if needed.",
    {
      slug: z
        .string()
        .describe(
          "Reference slug from the catalog. Examples: 'python-flask', 'rust-vitals', 'c-gpio', 'nodejs-dashboard'.",
        ),
    },
    async ({ slug }) => {
      try {
        const entry = getReferenceEntry(slug);
        if (!entry) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown reference "${slug}". Run \`list-references\` to see the catalog.`,
              },
            ],
          };
        }
        const project = await fetchReferenceProject(slug);
        return { content: [{ type: "text", text: renderProject(project) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# get-reference failed\n\n❌ ${error}\n\nTry again or verify the slug with \`list-references\`.`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get-reference-file",
    "Fetch a single file from a reference project by relative path. Use this to read app source, overlay files (systemd units, configs), or build scripts after `get-reference` has shown you the file tree. Bounded to 1 MB per file.",
    {
      slug: z
        .string()
        .describe(
          "Reference slug (e.g. 'nodejs-dashboard'). Must match an entry from list-references.",
        ),
      path: z
        .string()
        .describe(
          "Path within the reference, relative to its root. Examples: 'app/server.js', 'app/overlay/usr/lib/systemd/system/app.service', 'app-install.sh'.",
        ),
    },
    async ({ slug, path }) => {
      try {
        const entry = getReferenceEntry(slug);
        if (!entry) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown reference "${slug}". Run \`list-references\` to see the catalog.`,
              },
            ],
          };
        }
        const content = await fetchReferenceFile(slug, path);
        return {
          content: [
            {
              type: "text",
              text: `# ${slug}/${path}\n\n**Source:** https://github.com/avocado-linux/references/blob/main/${slug}/${path}\n\n\`\`\`\n${content}\n\`\`\``,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# get-reference-file failed\n\n❌ ${error}\n\nUse \`get-reference\` first to see what files exist for this slug.`,
            },
          ],
        };
      }
    },
  );
}

function renderList(entries: ReferenceEntry[]): string {
  if (entries.length === 0) return "_No references match._";
  let out = `| Slug | Title | Language | Hardware | Summary |\n`;
  out += `|------|-------|----------|----------|---------|\n`;
  for (const r of entries) {
    const hw = r.hardware.length ? r.hardware.join(", ") : "—";
    out += `| \`${r.slug}\` | ${r.title} | ${r.language} | ${hw} | ${r.summary} |\n`;
  }
  return out;
}

function renderProject(p: ReferenceProject): string {
  const e = p.entry;
  let out = `# ${e.title}\n\n`;
  out += `**Slug:** \`${e.slug}\`  •  **Language:** ${e.language}  •  **Hardware:** ${e.hardware.length ? e.hardware.join(", ") : "generic"}\n`;
  out += `**Source:** ${p.sourceUrl}\n\n`;
  out += `${e.summary}\n\n`;

  // File tree
  out += `## File tree\n\n\`\`\`\n${e.slug}/\n`;
  for (const f of p.files) out += `  ${f}\n`;
  out += `\`\`\`\n\n`;

  // avocado.yaml (most important file)
  if (p.avocadoYaml !== null) {
    out += `## \`avocado.yaml\`\n\n\`\`\`yaml\n${p.avocadoYaml}\n\`\`\`\n\n`;
  } else {
    out += `## \`avocado.yaml\`\n\n_(could not fetch — file may be missing or repo is unreachable)_\n\n`;
  }

  // Overlay summary
  if (p.overlayPaths.length > 0) {
    out += `## Overlay layout\n\n`;
    out += `The \`app/overlay/\` directory is layered into the extension image. Its contents map directly onto the target's root filesystem at boot. Files in this reference:\n\n`;
    out += `\`\`\`\n`;
    for (const f of p.overlayPaths) out += `/${f}\n`;
    out += `\`\`\`\n\n`;
    const services = p.overlayPaths.filter((f) =>
      f.includes("systemd/system/"),
    );
    if (services.length > 0) {
      out += `**systemd units shipped:** ${services
        .map((s) => `\`${s.split("/").pop()}\``)
        .join(", ")}\n\n`;
    }
  } else {
    out += `## Overlay layout\n\n_No \`app/overlay/\` directory. The reference doesn't ship pre-built files into the extension._\n\n`;
  }

  // Build hooks
  if (p.buildHooks.length > 0) {
    out += `## Build hooks\n\nShell scripts the SDK runs at the named stages:\n\n`;
    for (const h of p.buildHooks) out += `- \`${h}\`\n`;
    out += `\nUse \`get-reference-file\` to read any of these.\n\n`;
  }

  // README + getting_started
  if (p.readme) {
    out += `## README.md\n\n${p.readme}\n\n`;
  }
  if (p.gettingStarted) {
    out += `## getting_started.md\n\n${p.gettingStarted}\n\n`;
  }

  out += `---\n\n_To inspect any source file (app code, overlay configs, build scripts), call \`get-reference-file({ slug: "${e.slug}", path: "<path-from-tree-above>" })\`._\n`;
  return out;
}
