import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  listDocs,
  findDoc,
  fetchDocContent,
  type DocEntry,
} from "../lib/docs-client.js";
import { searchDocs } from "../lib/docs-search.js";

const SECTION_ENUM = z.enum(["overview", "hardware", "guides", "changelog"]);

export function registerDocsTools(server: McpServer): void {
  server.tool(
    "search-docs",
    "Full-text search across the canonical Peridio + Avocado OS docs site (docs.peridio.com). Returns ranked hits with title, URL, and an excerpt around the match. Use this whenever the user asks 'how do I X' / 'what is Y' — it's faster and more accurate than guessing from training data, and gives you a citable URL.",
    {
      query: z
        .string()
        .min(1)
        .describe(
          "Free-text search. Examples: 'seeding the var partition', 'cross compile python', 'hardware in the loop'.",
        ),
      section: SECTION_ENUM.optional().describe(
        "Optional filter: 'overview' (about, getting started), 'hardware' (support matrix, board guides), 'guides' (developer reference), 'changelog' (release notes).",
      ),
      max_results: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Top-N hits to return (default 5)."),
    },
    async ({ query, section, max_results }) => {
      try {
        const hits = await searchDocs(query, {
          section,
          maxResults: max_results ?? 5,
        });
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `# search-docs\n\n**Query:** \`${query}\`${section ? `  •  **Section:** \`${section}\`` : ""}\n\n_No matches._ Try a broader query or use \`list-docs\` to browse the catalog.`,
              },
            ],
          };
        }
        let out = `# search-docs\n\n**Query:** \`${query}\`${section ? `  •  **Section:** \`${section}\`` : ""}  •  **Hits:** ${hits.length}\n\n`;
        for (const h of hits) {
          out += `### ${h.entry.title}\n`;
          out += `${h.entry.url}  •  section: \`${h.entry.section}\`  •  score: ${h.score.toFixed(2)}\n\n`;
          if (h.entry.description) out += `_${h.entry.description}_\n\n`;
          if (h.excerpt) out += `> ${h.excerpt}\n\n`;
          out += `Fetch full content with \`get-doc({ slug: "${h.entry.sitePath}" })\`.\n\n`;
        }
        return { content: [{ type: "text", text: out }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# search-docs failed\n\n❌ ${(error as Error).message}\n\nDocs are fetched from github.com/peridio/docs; check network and (if set) \`GITHUB_TOKEN\`.`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "get-doc",
    "Fetch the full content of one documentation page. Accepts a site slug (e.g. `developer-reference/seeding-var`), a full docs.peridio.com URL, or the repo path (`src/docs-guides/seeding-var.md`). Use this after `search-docs` returns a hit you want to read in full.",
    {
      slug: z
        .string()
        .min(1)
        .describe(
          "Site slug, full URL, or repo path. Examples: 'developer-reference/seeding-var', 'hardware/raspberrypi5', 'https://docs.peridio.com/developer-reference/seeding-var'.",
        ),
    },
    async ({ slug }) => {
      try {
        const entry = await findDoc(slug);
        if (!entry) {
          return {
            content: [
              {
                type: "text",
                text: `# get-doc\n\n❌ Unknown doc: \`${slug}\`\n\nUse \`search-docs\` or \`list-docs\` to find a valid slug.`,
              },
            ],
          };
        }
        const content = await fetchDocContent(entry);
        return {
          content: [
            {
              type: "text",
              text: renderDoc(entry, content),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# get-doc failed\n\n❌ ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list-docs",
    "List the catalog of every Peridio + Avocado docs page (title + URL + section), optionally filtered by section. Use this when you want to browse what's available before searching, or to confirm that a page exists.",
    {
      section: SECTION_ENUM.optional().describe(
        "Optional section filter: 'overview', 'hardware', 'guides', or 'changelog'.",
      ),
    },
    async ({ section }) => {
      try {
        const all = await listDocs(section ? { section } : undefined);
        if (all.length === 0) {
          return {
            content: [{ type: "text", text: "_No docs indexed yet._" }],
          };
        }
        const grouped = groupBySection(all);
        let out = `# list-docs\n\n${all.length} pages indexed${section ? ` (section: \`${section}\`)` : ""}.\n\n`;
        for (const [sec, items] of grouped) {
          out += `## ${sec} (${items.length})\n\n`;
          for (const e of items) {
            out += `- [${e.title}](${e.url})`;
            if (e.description) out += ` — ${e.description}`;
            out += `\n`;
          }
          out += `\n`;
        }
        return { content: [{ type: "text", text: out }] };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# list-docs failed\n\n❌ ${(error as Error).message}`,
            },
          ],
        };
      }
    },
  );
}

function renderDoc(entry: DocEntry, content: string): string {
  let out = `# ${entry.title}\n\n`;
  out += `**URL:** ${entry.url}\n`;
  out += `**Section:** \`${entry.section}\`  •  **Repo path:** \`${entry.repoPath}\`\n`;
  if (entry.description) out += `\n_${entry.description}_\n`;
  out += `\n---\n\n${content}`;
  return out;
}

function groupBySection(
  entries: DocEntry[],
): Map<DocEntry["section"], DocEntry[]> {
  const order: DocEntry["section"][] = [
    "overview",
    "hardware",
    "guides",
    "changelog",
  ];
  const out = new Map<DocEntry["section"], DocEntry[]>();
  for (const s of order) out.set(s, []);
  for (const e of entries) out.get(e.section)?.push(e);
  // Drop empty sections.
  for (const s of order) {
    if (out.get(s)!.length === 0) out.delete(s);
  }
  return out;
}
