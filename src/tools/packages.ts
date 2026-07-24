import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  RepoClient,
  rankMatches,
  scoreToConfidence,
  normalizeStream,
  type SearchResult,
} from "../lib/repo-client.js";
import { resolveTarget } from "../lib/target-resolver.js";

/**
 * Validate target names against the manifest for a SPECIFIC release/channel.
 * Targets differ per stream (e.g. NVIDIA Thor exists in 2026 but not 2024),
 * so validation must use the same stream the caller will query — otherwise a
 * legitimate 2026-only target gets rejected against the 2024 manifest.
 */
async function validateTargets(
  repoClient: RepoClient,
  targets: string[],
  release?: string,
  channel?: string,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const { rel, chan } = normalizeStream(release, channel);
  const config = await repoClient.getTargetsConfig(rel, chan);
  if (!config) {
    return {
      ok: false,
      message: `Could not fetch targets.json for \`${rel}/${chan}\` from repo.avocadolinux.org to validate target names. Check the release/channel and network, then try again.`,
    };
  }
  const all = Object.keys(config);
  const unknown = targets.filter((t) => !config[t]);
  if (unknown.length === 0) return { ok: true };
  const lines: string[] = [];
  for (const u of unknown) {
    const fuzzy = resolveTarget(u, all).slice(0, 3);
    if (fuzzy.length > 0) {
      lines.push(
        `- \`${u}\` is not available in \`${rel}/${chan}\`. Did you mean: ${fuzzy.map((t) => `\`${t}\``).join(", ")}?`,
      );
    } else {
      lines.push(`- \`${u}\` is not available in \`${rel}/${chan}\`.`);
    }
  }
  return {
    ok: false,
    message: [
      `❌ Unsupported target(s) for stream \`${rel}/${chan}\`:`,
      ``,
      ...lines,
      ``,
      `**Targets in \`${rel}/${chan}\` (${all.length}):** ${all
        .sort()
        .map((t) => `\`${t}\``)
        .join(", ")}`,
      ``,
      `Only these are valid for this stream. A target missing here may exist in another release — some hardware ships only on newer releases (e.g. NVIDIA Thor on 2026, not 2024). Use \`list-targets({ query: "...", release, channel })\` to check other streams, or the docs support matrix at https://docs.peridio.com/hardware/support-matrix#supported.`,
    ].join("\n"),
  };
}

export function registerPackageTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.registerTool(
    "describe-package",
    {
      title: "Describe one Avocado package",
      description:
        "Show detail for a single package by exact name across one or more targets: version, arch, summary, description, and which repo provides it. Use this to confirm a package exists before referencing it in avocado.yaml, OR to answer 'does package X exist for target Y?' as a standalone question — no project required.",
      inputSchema: {
        targets: z
          .array(z.string())
          .min(1)
          .describe("Target names to look up the package in."),
        name: z.string().describe("Exact package name."),
        release: z
          .string()
          .optional()
          .describe(
            "Release year. Defaults to '2024'. Valid: '2024', '2026'. Newer hardware may exist only on '2026'.",
          ),
        channel: z
          .string()
          .optional()
          .describe(
            "Release channel. Defaults to 'edge'. Valid: 'next' (nightly, may break), 'edge' (dev/RC), 'stable' (pre-prod/prod, behind edge).",
          ),
      },
      outputSchema: {
        name: z.string(),
        found: z.boolean(),
        results: z.array(
          z.object({
            repo: z.string(),
            version: z.string(),
            release: z.string().optional(),
            arch: z.string(),
            summary: z.string(),
            description: z.string().optional(),
          }),
        ),
        nearest: z
          .array(z.string())
          .optional()
          .describe("If no exact match, top-N near package names."),
      },
      annotations: {
        title: "Describe one Avocado package",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ targets, name, release, channel }) => {
      const { rel, chan } = normalizeStream(release, channel);
      const targetCheck = await validateTargets(repoClient, targets, rel, chan);
      if (!targetCheck.ok) {
        return {
          content: [
            {
              type: "text",
              text: `# describe-package failed\n\n${targetCheck.message}`,
            },
          ],
          structuredContent: { name, found: false, results: [] },
          isError: true,
        };
      }
      try {
        const { results } = await repoClient.searchPackages(
          targets,
          name,
          200,
          rel,
          chan,
        );
        const exact = results.filter((r) => r.name === name);
        if (exact.length === 0) {
          const near = results.slice(0, 5);
          return {
            content: [
              {
                type: "text",
                text: `# describe-package\n\nNo exact match for \`${name}\` in ${targets.map((t) => `\`${t}\``).join(", ")}.${
                  near.length
                    ? `\n\nNearest matches: ${near.map((r) => `\`${r.name}\``).join(", ")}.`
                    : ""
                }`,
              },
            ],
            structuredContent: {
              name,
              found: false,
              results: [],
              nearest: near.map((r) => r.name),
            },
          };
        }
        let out = `# describe-package — \`${name}\`\n\n`;
        for (const p of exact) {
          out += `## \`${p.repo}\`\n\n`;
          out += `- **Version:** ${p.version}${p.release ? `-${p.release}` : ""}\n`;
          out += `- **Arch:** \`${p.arch}\`\n`;
          out += `- **Summary:** ${p.summary || "_(none)_"}\n`;
          if (p.description) {
            out += `\n${p.description}\n`;
          }
          out += `\n`;
        }
        return {
          content: [{ type: "text", text: out }],
          structuredContent: {
            name,
            found: true,
            results: exact.map((p) => ({
              repo: p.repo,
              version: p.version,
              release: p.release,
              arch: p.arch,
              summary: p.summary,
              description: p.description,
            })),
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# describe-package failed\n\n❌ ${error}`,
            },
          ],
          structuredContent: { name, found: false, results: [] },
          isError: true,
        };
      }
    },
  );

  const packageResultSchema = z.object({
    name: z.string(),
    version: z.string(),
    release: z.string(),
    arch: z.string(),
    repo: z.string(),
    summary: z.string(),
  });

  server.registerTool(
    "search-packages",
    {
      title: "Search Avocado package feed",
      description:
        "Search the live Avocado OS package feed for one or more targets. **This is the first move when the user wants to add ANY library / dependency / system package.** Always check the feed before suggesting `pip install`, `npm install`, `cargo add`, `apt install`, or vendoring — feed packages are version-tracked, dependency-resolved, security-updatable via OTA, and don't bloat the extension image. Matches package name and summary (case-insensitive), ranked by where the hit lands — same default behaviour as `avocado sdk dnf search`. **No avocado.yaml or local project required**: pass a target name and a query and you get live results from repo.avocadolinux.org. Description matching is NOT included — use `describe-package` for full-text details on a specific name. See `avocado://skills/app-development` for the feed-first workflow.",
      inputSchema: {
        targets: z
          .array(z.string())
          .min(1)
          .describe(
            "Target names (e.g. ['raspberrypi5', 'jetson-orin-nano-devkit']). Must match entries from list-targets. Pass one or more.",
          ),
        query: z
          .string()
          .min(1)
          .describe(
            "Free-text search. Matches packages whose name or summary contains this text (case-insensitive). Examples: 'openssh', 'kernel-module-gpio', 'gstreamer', 'python3'.",
          ),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Maximum results to return. Default 50."),
        release: z
          .string()
          .optional()
          .describe(
            "Release year. Defaults to '2024'. Valid: '2024', '2026'. Newer hardware may exist only on '2026'.",
          ),
        channel: z
          .string()
          .optional()
          .describe(
            "Release channel. Defaults to 'edge'. Valid: 'next' (nightly, may break), 'edge' (dev/RC), 'stable' (pre-prod/prod, behind edge).",
          ),
      },
      outputSchema: {
        query: z.string(),
        targets: z.array(z.string()),
        release: z.string(),
        channel: z.string(),
        totalMatches: z.number().int(),
        shown: z.number().int(),
        results: z.array(packageResultSchema),
        errors: z.array(
          z.object({
            target: z.string(),
            messages: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        title: "Search Avocado package feed",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ targets, query, limit, release, channel }) => {
      const { rel, chan } = normalizeStream(release, channel);
      const targetCheck = await validateTargets(repoClient, targets, rel, chan);
      if (!targetCheck.ok) {
        return {
          content: [
            {
              type: "text",
              text: `# search-packages failed\n\n${targetCheck.message}`,
            },
          ],
          structuredContent: {
            query,
            targets,
            release: rel,
            channel: chan,
            totalMatches: 0,
            shown: 0,
            results: [],
            errors: [],
          },
          isError: true,
        };
      }
      try {
        const { totalMatches, results, errors } =
          await repoClient.searchPackages(
            targets,
            query,
            limit ?? 50,
            rel,
            chan,
          );
        const trimmed = results.map((r) => ({
          name: r.name,
          version: r.version,
          release: r.release,
          arch: r.arch,
          repo: r.repo,
          summary: r.summary,
        }));
        return {
          content: [
            {
              type: "text",
              text: renderHeader(
                query,
                targets,
                totalMatches,
                results.length,
                errors,
                rel,
                chan,
              ),
            },
            {
              type: "text",
              text: `\n\`\`\`json\n${JSON.stringify(trimmed, null, 2)}\n\`\`\`\n\n_Per-result \`description\` is omitted to save context. Use \`describe-package\` for full details on a specific name._`,
            },
          ],
          structuredContent: {
            query,
            targets,
            release: rel,
            channel: chan,
            totalMatches,
            shown: results.length,
            results: trimmed,
            errors,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# search-packages failed\n\n❌ ${error}\n\n## Troubleshooting\n\n1. **Check the target name.** It must match an entry in https://repo.avocadolinux.org/2024/edge/targets.json.\n2. **Check connectivity.** The server must reach repo.avocadolinux.org.\n3. **Try a simpler query.** The search is a plain substring match against name + summary.`,
            },
          ],
          structuredContent: {
            query,
            targets,
            release: rel,
            channel: chan,
            totalMatches: 0,
            shown: 0,
            results: [],
            errors: [],
          },
          isError: true,
        };
      }
    },
  );

  const coverageMatchSchema = z.object({
    name: z.string(),
    version: z.string(),
    release: z.string(),
    arch: z.string(),
    repo: z.string(),
    summary: z.string(),
  });

  server.registerTool(
    "check-package-coverage",
    {
      title: "Batch-check dependencies against the Avocado feed",
      description:
        'Check a WHOLE LIST of dependencies against one target\'s package feed in a SINGLE call — the batch engine behind the `/package-coverage` report. For each dependency you pass a display name plus one or more candidate feed search terms (`queries`); the tool warms the target\'s feed once and returns a present/missing verdict per dependency with a match-confidence tier (`exact`/`strong`/`fuzzy`), the best-matching feed package, and near-miss alternatives, plus an overall coverage summary. **Use this instead of calling `search-packages` once per dependency** — it collapses N round-trips into one and shares the exact `dnf search` scoring. YOU do the name normalization (Debian/Alpine/pip/npm → RPM/Yocto): put every plausible variant for a dependency in its `queries` array (e.g. for `libssl-dev`: `["openssl", "libssl", "ssl"]`). Matching is optimistic — any hit (including a summary-only hit) counts as present, flagged `fuzzy` so a maintainer can verify. See `avocado://skills/package-coverage`.',
      inputSchema: {
        target: z
          .string()
          .describe(
            "Single Avocado target slug the coverage is evaluated against (e.g. 'jetson-orin-nano-devkit'). Must exist in the given release/channel — targets differ per stream.",
          ),
        dependencies: z
          .array(
            z.object({
              name: z
                .string()
                .describe(
                  "Display/source name of the dependency as it appears in the Dockerfile/SBOM (e.g. 'libssl-dev', 'paho-mqtt').",
                ),
              ecosystem: z
                .string()
                .optional()
                .describe(
                  "Where it came from: 'system-apt' | 'system-apk' | 'pip' | 'npm' | 'cargo' | 'rpm' | ... Carried through to the report unchanged.",
                ),
              queries: z
                .array(z.string().min(1))
                .min(1)
                .describe(
                  "Ordered candidate feed search terms to try for this dependency — YOUR normalized name variants. The best hit across all of them wins. Match summaries too, so a keyword like 'mqtt' can surface 'paho-mqtt'.",
                ),
            }),
          )
          .min(1)
          .describe("The dependencies to check. One entry per library."),
        release: z
          .string()
          .optional()
          .describe(
            "Release year. Defaults to '2024'. Newer hardware may only exist on '2026'.",
          ),
        channel: z
          .string()
          .optional()
          .describe(
            "Release channel. Defaults to 'edge'. Valid: 'next' (nightly, may break), 'edge' (dev/RC), 'stable' (pre-prod/prod, behind edge).",
          ),
        maxAlternatives: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "How many near-miss alternative package names to surface per dependency (for maintainer review). Default 3.",
          ),
      },
      outputSchema: {
        target: z.string(),
        release: z.string(),
        channel: z.string(),
        targetAvailable: z
          .boolean()
          .nullable()
          .describe(
            "true = target exists in this stream; false = target genuinely not in this stream (re-resolve to a release that supports it); null = the manifest couldn't be fetched (invalid stream / network) so availability is unknown. When false or null, `isError` is set.",
          ),
        summary: z.object({
          total: z.number().int(),
          present: z.number().int(),
          missing: z.number().int(),
          coveragePercent: z.number().int(),
          exact: z.number().int(),
          strong: z.number().int(),
          fuzzy: z.number().int(),
        }),
        results: z.array(
          z.object({
            name: z.string(),
            ecosystem: z.string().optional(),
            status: z.enum(["present", "missing"]),
            confidence: z.enum(["exact", "strong", "fuzzy"]).nullable(),
            match: coverageMatchSchema.nullable(),
            matchedQuery: z.string().nullable(),
            alternatives: z.array(z.string()),
          }),
        ),
        feedErrors: z.array(z.string()),
      },
      annotations: {
        title: "Batch-check dependencies against the Avocado feed",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ target, dependencies, release, channel, maxAlternatives }) => {
      const { rel, chan } = normalizeStream(release, channel);
      const maxAlt = maxAlternatives ?? 3;

      // All-zero: used only on early-return / error paths where nothing was
      // analyzed, so results is [] and the summary must agree (isError signals
      // the failure separately).
      const emptySummary = {
        total: 0,
        present: 0,
        missing: 0,
        coveragePercent: 0,
        exact: 0,
        strong: 0,
        fuzzy: 0,
      };

      // Validate the target against THIS stream — the Thor-on-2024 case.
      const manifest = await repoClient.getTargetsConfig(rel, chan);
      if (!manifest) {
        return {
          content: [
            {
              type: "text",
              text: `# check-package-coverage failed\n\nCould not fetch \`targets.json\` for \`${rel}/${chan}\` from repo.avocadolinux.org. Check the release/channel and network.`,
            },
          ],
          structuredContent: {
            target,
            release: rel,
            channel: chan,
            targetAvailable: null,
            summary: emptySummary,
            results: [],
            feedErrors: [],
          },
          isError: true,
        };
      }
      if (!manifest[target]) {
        const fuzzy = resolveTarget(target, Object.keys(manifest)).slice(0, 3);
        return {
          content: [
            {
              type: "text",
              text: [
                `# check-package-coverage — target not in \`${rel}/${chan}\``,
                ``,
                `\`${target}\` is not available in the \`${rel}/${chan}\` stream.${
                  fuzzy.length
                    ? ` Did you mean: ${fuzzy.map((t) => `\`${t}\``).join(", ")}?`
                    : ""
                }`,
                ``,
                `Some hardware ships only on newer releases (e.g. NVIDIA Thor on 2026, not 2024). Check the docs support matrix (https://docs.peridio.com/hardware/support-matrix#supported) or \`list-targets({ query: "${target}", release, channel })\` against another stream, then re-run with the release/channel that supports this target.`,
              ].join("\n"),
            },
          ],
          structuredContent: {
            target,
            release: rel,
            channel: chan,
            targetAvailable: false,
            summary: emptySummary,
            results: [],
            feedErrors: [],
          },
          isError: true,
        };
      }

      try {
        // One feed warm-up for the whole batch; cached process-wide after this.
        const { packages, errors } = await repoClient.fetchTargetPackages(
          target,
          rel,
          chan,
        );

        const results = dependencies.map((dep) => {
          let best: SearchResult | null = null;
          let matchedQuery: string | null = null;
          const altNames = new Set<string>();
          for (const q of dep.queries) {
            const ranked = rankMatches(packages, q);
            if (ranked.length > 0) {
              if (!best || ranked[0].score > best.score) {
                best = ranked[0];
                matchedQuery = q;
              }
              for (const r of ranked.slice(0, maxAlt + 1)) altNames.add(r.name);
            }
          }
          if (best) altNames.delete(best.name);
          return {
            name: dep.name,
            ecosystem: dep.ecosystem,
            status: (best ? "present" : "missing") as "present" | "missing",
            confidence: best ? scoreToConfidence(best.score) : null,
            match: best
              ? {
                  name: best.name,
                  version: best.version,
                  release: best.release,
                  arch: best.arch,
                  repo: best.repo,
                  summary: best.summary,
                }
              : null,
            matchedQuery,
            alternatives: Array.from(altNames).slice(0, maxAlt),
          };
        });

        const present = results.filter((r) => r.status === "present").length;
        const summary = {
          total: results.length,
          present,
          missing: results.length - present,
          coveragePercent: results.length
            ? Math.round((present / results.length) * 100)
            : 0,
          exact: results.filter((r) => r.confidence === "exact").length,
          strong: results.filter((r) => r.confidence === "strong").length,
          fuzzy: results.filter((r) => r.confidence === "fuzzy").length,
        };

        return {
          content: [
            {
              type: "text",
              text: renderCoverage(target, rel, chan, summary, results, errors),
            },
          ],
          structuredContent: {
            target,
            release: rel,
            channel: chan,
            targetAvailable: true,
            summary,
            results,
            feedErrors: errors,
          },
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# check-package-coverage failed\n\n❌ ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          structuredContent: {
            target,
            release: rel,
            channel: chan,
            targetAvailable: true,
            summary: emptySummary,
            results: [],
            feedErrors: [],
          },
          isError: true,
        };
      }
    },
  );
}

interface CoverageRow {
  name: string;
  ecosystem?: string;
  status: "present" | "missing";
  confidence: "exact" | "strong" | "fuzzy" | null;
  match: { name: string; version: string } | null;
  matchedQuery: string | null;
  alternatives: string[];
}

function renderCoverage(
  target: string,
  release: string,
  channel: string,
  summary: {
    total: number;
    present: number;
    missing: number;
    coveragePercent: number;
    exact: number;
    strong: number;
    fuzzy: number;
  },
  results: CoverageRow[],
  errors: string[],
): string {
  let out = `# check-package-coverage\n\n`;
  out += `**Target:** \`${target}\`  •  **Stream:** \`${release}/${channel}\`\n`;
  out += `**Coverage:** ${summary.coveragePercent}% (${summary.present}/${summary.total} present)`;
  if (summary.fuzzy > 0) {
    out += ` — of which ${summary.exact} exact, ${summary.strong} strong, **${summary.fuzzy} fuzzy** (verify before relying on the number)`;
  }
  out += `\n**Missing:** ${summary.missing}\n`;

  if (errors.length > 0) {
    out += `\n> ⚠️ Some repos failed to fetch (results may be incomplete): ${errors.join("; ")}\n`;
  }

  // Dependency name / ecosystem are input-derived; escape pipes and collapse
  // newlines so a stray `|` or line break can't break the markdown table.
  const cell = (s: string): string =>
    s.replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  out += `\n| Dependency | Ecosystem | Status | Feed package | Version | Confidence | Alternatives |\n`;
  out += `|---|---|---|---|---|---|---|\n`;
  for (const r of results) {
    const status = r.status === "present" ? "✅" : "❌";
    const pkg = r.match ? `\`${r.match.name}\`` : "—";
    const ver = r.match ? r.match.version : "—";
    const conf = r.confidence ?? "—";
    const alts =
      r.alternatives.length > 0
        ? r.alternatives.map((a) => `\`${a}\``).join(", ")
        : "—";
    out += `| ${cell(r.name)} | ${r.ecosystem ? cell(r.ecosystem) : "—"} | ${status} | ${pkg} | ${ver} | ${conf} | ${alts} |\n`;
  }
  out += `\n_\`fuzzy\` = summary-only hit, optimistically counted as present — a maintainer should confirm. Missing rows need upstream research (see the \`/package-coverage\` flow)._`;
  return out;
}

function renderHeader(
  query: string,
  targets: string[],
  totalMatches: number,
  shown: number,
  errors: { target: string; messages: string[] }[],
  release?: string,
  channel?: string,
): string {
  let out = `# search-packages\n\n`;
  out += `**Query:** \`${query}\`\n`;
  out += `**Targets:** ${targets.map((t) => `\`${t}\``).join(", ")}\n`;
  out += `**Stream:** \`${release ?? "2024"}/${channel ?? "edge"}\`\n`;
  out += `**Total matches:** ${totalMatches}${shown < totalMatches ? ` (showing first ${shown})` : ""}\n`;

  if (errors.length > 0) {
    out += `\n## Repo errors (non-fatal)\n\n`;
    for (const e of errors) {
      out += `- **${e.target}**: ${e.messages.join("; ")}\n`;
    }
  }

  if (shown === 0) {
    out += `\nNo packages matched. Confirm the target name exists in targets.json and try a broader query.\n`;
  }
  return out;
}
