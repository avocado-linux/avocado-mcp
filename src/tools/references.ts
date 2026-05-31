import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listReferences,
  searchReferences,
  fetchReferenceProject,
  fetchReferenceFile,
  type ReferenceEntry,
  type ReferenceProject,
} from "../lib/references-client.js";

const referenceEntrySchema = z.object({
  slug: z.string(),
  title: z.string(),
  language: z.string(),
  summary: z.string(),
  hardware: z.array(z.string()),
  tags: z.array(z.string()),
});

export function registerReferenceTools(server: McpServer): void {
  server.registerTool(
    "search-references",
    {
      title: "Browse or search Avocado references",
      description:
        "Browse or search the catalog of Avocado OS reference projects (working starter projects in C, Python, Rust, Node, Elixir, etc.). With NO `query`, returns the full catalog as a browseable list. With `query`, returns ranked matches against slug, title, language, summary, and tags. Optionally filter by target. Use this whenever the user wants to see what examples exist, find one matching their task, or copy from one.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text search. Omit to list the full catalog. Examples: 'python', 'gpio', 'gstreamer', 'kiosk', 'mqtt'.",
          ),
        target: z
          .string()
          .optional()
          .describe(
            "Optional target to filter by (e.g. 'raspberrypi5'). Only matches references whose 'hardware' list either contains this target or is empty (generic).",
          ),
      },
      outputSchema: {
        mode: z
          .enum(["browse", "search"])
          .describe("'browse' if no query, 'search' if query supplied."),
        query: z.string().optional(),
        target: z.string().optional(),
        total: z.number().int(),
        references: z.array(referenceEntrySchema),
      },
      annotations: {
        title: "Browse or search Avocado references",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ query, target }) => {
      const q = query?.trim() ?? "";
      try {
        if (q.length === 0) {
          // Catalog-browse mode
          const all = await (target
            ? searchReferences("", target)
            : listReferences());
          let out = `# search-references — catalog\n\n`;
          out += `**Total:** ${all.length}${target ? `  •  **Target filter:** \`${target}\`` : ""}\n\n`;
          out += renderList(all);
          return {
            content: [{ type: "text", text: out }],
            structuredContent: {
              mode: "browse" as const,
              target,
              total: all.length,
              references: all,
            },
          };
        }

        // Ranked-search mode
        const matches = await searchReferences(q, target);
        return {
          content: [
            {
              type: "text",
              text: `# search-references\n\n**Query:** \`${q}\`${target ? `  •  **Target:** \`${target}\`` : ""}\n**Matches:** ${matches.length}\n\n${renderList(matches)}`,
            },
          ],
          structuredContent: {
            mode: "search" as const,
            query: q,
            target,
            total: matches.length,
            references: matches,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# search-references failed\n\n❌ ${error}\n\nThe reference catalog is read live from github.com/avocado-linux/references; this usually means GitHub was briefly unreachable or rate-limited. Try again.`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get-reference",
    {
      title: "Get full reference project bundle",
      description:
        "Fetch the full project bundle for a reference: file tree, `avocado.yaml`, README, getting-started guide, and a summary of build hooks and overlay layout. Use this after the user picks a reference via `search-references`. Files large or specific to a single concern (e.g. `app/server.js`) are NOT included by default — fetch them with `get-reference-file` if needed.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "Reference slug from the catalog. Examples: 'python-flask', 'rust-vitals', 'c-gpio', 'nodejs-dashboard'.",
          ),
      },
      annotations: {
        title: "Get full reference project bundle",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug }) => {
      try {
        const project = await fetchReferenceProject(slug);
        return { content: [{ type: "text", text: renderProject(project) }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# get-reference failed\n\n❌ ${error}\n\nTry again or verify the slug with \`search-references\`.`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get-reference-file",
    {
      title: "Get a single file from a reference",
      description:
        "Fetch a single file from a reference project by relative path. Use this to read app source, overlay files (systemd units, configs), or build scripts after `get-reference` has shown you the file tree. Bounded to 1 MB per file.",
      inputSchema: {
        slug: z
          .string()
          .describe(
            "Reference slug (e.g. 'nodejs-dashboard'). Must match an entry from search-references.",
          ),
        path: z
          .string()
          .describe(
            "Path within the reference, relative to its root. Examples: 'app/server.js', 'app/overlay/usr/lib/systemd/system/app.service', 'app-install.sh'.",
          ),
      },
      annotations: {
        title: "Get a single file from a reference",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug, path }) => {
      try {
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
          isError: true,
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
