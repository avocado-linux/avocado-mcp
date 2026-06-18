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
  const docEntrySchema = z.object({
    title: z.string(),
    url: z.string(),
    sitePath: z.string(),
    repoPath: z.string(),
    section: SECTION_ENUM,
    description: z.string().optional(),
    source: z
      .enum(["peridio-docs", "yocto-refs"])
      .optional()
      .describe(
        "Which corpus the result came from: 'peridio-docs' (docs.peridio.com) or 'yocto-refs' (vendored Yocto/BitBake reference).",
      ),
  });

  server.registerTool(
    "search-docs",
    {
      title: "Browse or search Peridio + Avocado docs",
      description:
        "Browse or search the canonical Peridio + Avocado OS docs site (docs.peridio.com). With NO `query`, returns the full catalog grouped by section — use this to see what's available before drilling in. With `query`, returns ranked hits with title, URL, and an excerpt around the match. Use this whenever the user asks 'how do I X' / 'what is Y' / 'what docs exist on Z' — it's faster and more accurate than guessing from training data, and gives you a citable URL.",
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe(
            "Free-text search. Omit to browse the full catalog grouped by section. Examples: 'seeding the var partition', 'cross compile python', 'hardware in the loop'.",
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
          .describe(
            "Top-N hits to return when `query` is supplied (default 5). Ignored in catalog-browse mode.",
          ),
      },
      outputSchema: {
        mode: z
          .enum(["browse", "search"])
          .describe("'browse' if no query, 'search' if query supplied."),
        query: z.string().optional(),
        section: SECTION_ENUM.optional(),
        total: z
          .number()
          .int()
          .describe("Total pages (browse) or total hits (search)."),
        hits: z
          .array(
            z.object({
              entry: docEntrySchema,
              score: z
                .number()
                .describe(
                  "BM25 score; higher = more relevant. 0 in browse mode.",
                ),
              excerpt: z.string().optional(),
            }),
          )
          .describe(
            "Always populated. In browse mode each entry has score=0 and no excerpt.",
          ),
      },
      annotations: {
        title: "Browse or search Peridio + Avocado docs",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ query, section, max_results }) => {
      try {
        const q = query?.trim() ?? "";
        if (q.length === 0) {
          // Catalog-browse mode
          const all = await listDocs(section ? { section } : undefined);
          if (all.length === 0) {
            return {
              content: [{ type: "text", text: "_No docs indexed yet._" }],
              structuredContent: {
                mode: "browse" as const,
                section,
                total: 0,
                hits: [],
              },
            };
          }
          const grouped = groupBySection(all);
          let out = `# search-docs — catalog\n\n${all.length} pages indexed${section ? ` (section: \`${section}\`)` : ""}.\n\n`;
          for (const [sec, items] of grouped) {
            out += `## ${sec} (${items.length})\n\n`;
            for (const e of items) {
              out += `- [${e.title}](${e.url})`;
              if (e.description) out += ` — ${e.description}`;
              out += `\n`;
            }
            out += `\n`;
          }
          out += `_To search instead of browse, call with a \`query\` arg._\n`;
          return {
            content: [{ type: "text", text: out }],
            structuredContent: {
              mode: "browse" as const,
              section,
              total: all.length,
              hits: all.map((entry) => ({ entry, score: 0 })),
            },
          };
        }

        // Ranked-search mode
        const hits = await searchDocs(q, {
          section,
          maxResults: max_results ?? 5,
        });
        if (hits.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `# search-docs\n\n**Query:** \`${q}\`${section ? `  •  **Section:** \`${section}\`` : ""}\n\n_No matches._ Try a broader query, or call \`search-docs\` with no \`query\` arg to browse the catalog.`,
              },
            ],
            structuredContent: {
              mode: "search" as const,
              query: q,
              section,
              total: 0,
              hits: [],
            },
          };
        }
        let out = `# search-docs\n\n**Query:** \`${q}\`${section ? `  •  **Section:** \`${section}\`` : ""}  •  **Hits:** ${hits.length}\n\n`;
        for (const h of hits) {
          out += `### ${h.entry.title}\n`;
          out += `${h.entry.url}  •  section: \`${h.entry.section}\`  •  score: ${h.score.toFixed(2)}\n\n`;
          if (h.entry.description) out += `_${h.entry.description}_\n\n`;
          if (h.excerpt) out += `> ${h.excerpt}\n\n`;
          if (h.entry.source === "yocto-refs") {
            // Vendored Yocto reference sections are search-only; get-doc serves
            // peridio-docs slugs, so point at the upstream page instead.
            out += `Vendored Yocto reference; see ${h.entry.url}.\n\n`;
          } else {
            out += `Fetch full content with \`get-doc({ slug: "${h.entry.sitePath}" })\`.\n\n`;
          }
        }
        return {
          content: [{ type: "text", text: out }],
          structuredContent: {
            mode: "search" as const,
            query: q,
            section,
            total: hits.length,
            hits: hits.map((h) => ({
              entry: h.entry,
              score: h.score,
              excerpt: h.excerpt,
            })),
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# search-docs failed\n\n❌ ${(error as Error).message}\n\nDocs are fetched from github.com/peridio/docs; check network and (if set) \`GITHUB_TOKEN\`.`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "get-doc",
    {
      title: "Fetch a docs page",
      description:
        "Fetch the full content of one documentation page. Accepts a site slug (e.g. `developer-reference/seeding-var`), a full docs.peridio.com URL, or the repo path (`src/docs-guides/seeding-var.md`). Use this after `search-docs` returns a hit you want to read in full.",
      inputSchema: {
        slug: z
          .string()
          .min(1)
          .describe(
            "Site slug, full URL, or repo path. Examples: 'developer-reference/seeding-var', 'hardware/raspberrypi5', 'https://docs.peridio.com/developer-reference/seeding-var'.",
          ),
      },
      annotations: {
        title: "Fetch a docs page",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ slug }) => {
      try {
        const entry = await findDoc(slug);
        if (!entry) {
          return {
            content: [
              {
                type: "text",
                text: `# get-doc\n\n❌ Unknown doc: \`${slug}\`\n\nUse \`search-docs\` (with or without a query) to find a valid slug.`,
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
