/**
 * Shared tool arguments for choosing which package feed to query. Every
 * feed-touching tool takes these so results match the project's configured
 * feed (see `lib/feed-config.ts` for the precedence).
 */

import { z } from "zod";
import { FeedContext } from "../lib/feed-config.js";

export const feedArgsShape = {
  projectDir: z
    .string()
    .optional()
    .describe(
      "Absolute path to the Avocado project directory (or its avocado.yaml). **Pass this whenever you're working in a project.** The tool then reads `distro.release`, `distro.channel`, `distro.repo`, `repos:` and `distro.feeds` from avocado.yaml, honours AVOCADO_* feed env vars, and applies the snapshot pin from avocado.lock, so results match what `avocado install` resolves. Omit only for project-less questions (defaults to repo.avocadolinux.org 2024/edge).",
    ),
  release: z
    .string()
    .optional()
    .describe(
      "Override the feed release. Valid: '2024', '2026'; newer hardware may exist only on '2026'. Normally leave unset and pass `projectDir` instead — the project's configured release is used. Without either, '2024'.",
    ),
  channel: z
    .string()
    .optional()
    .describe(
      "Override the feed channel. Valid: 'next' (nightly, may break), 'edge' (dev/RC), 'stable' (pre-prod/prod, behind edge). Normally leave unset and pass `projectDir` instead — the project's configured channel is used. Without either, 'edge'.",
    ),
  repoUrl: z
    .string()
    .optional()
    .describe(
      "Override the feed base URL (http/https). Normally leave unset — `projectDir` picks up `distro.repo.url` / AVOCADO_REPO_URL.",
    ),
};

export interface FeedArgs {
  projectDir?: string;
  release?: string;
  channel?: string;
  repoUrl?: string;
}

/** Blank or whitespace-only tool args mean "not set", not an empty override. */
function arg(v: string | undefined): string | undefined {
  const t = v?.trim();
  return t ? t : undefined;
}

export function feedContextFrom(args: FeedArgs, yaml?: string): FeedContext {
  return FeedContext.load({
    projectDir: arg(args.projectDir),
    yaml,
    release: arg(args.release),
    channel: arg(args.channel),
    repoUrl: arg(args.repoUrl),
  });
}

/**
 * Short `release/channel` name for the feed, for prose ("not available in
 * `2026/edge`"). Falls back to the raw releasever when it was set directly
 * (AVOCADO_RELEASEVER / distro.repo.releasever) rather than derived.
 */
export function streamLabel(feed: FeedContext): string {
  const base = feed.base;
  return base.release && base.channel
    ? `${base.release}/${base.channel}`
    : base.releasever;
}

export const feedSummarySchema = z
  .object({
    repoUrl: z.string().describe("Effective repo base URL."),
    repoUrlOverridden: z
      .boolean()
      .describe(
        "True when `repoUrl` came from a tool argument, AVOCADO_REPO_URL / AVOCADO_SDK_REPO_URL, or avocado.yaml rather than the default. `sources.repoUrl` says which.",
      ),
    defaultRepoUrl: z.string(),
    releasever: z.string(),
    release: z.string().optional(),
    channel: z.string().optional(),
    configPath: z.string().optional(),
    sources: z.object({
      repoUrl: z.string(),
      releasever: z.string(),
      release: z.string().optional(),
      channel: z.string().optional(),
      ca: z.string().optional(),
      insecure: z.string().optional(),
    }),
    snapshots: z
      .record(z.string())
      .describe("Per-target lock-file snapshot pins that were applied."),
    notes: z.array(z.string()),
    feeds: z
      .array(
        z.object({
          target: z.string(),
          name: z.string(),
          kind: z.enum(["distro", "url", "path", "org"]),
          priority: z.number().int(),
          location: z
            .string()
            .describe("Redacted URL, the path as written, or `org:<org>`."),
          stages: z.array(z.string()).optional(),
          status: z.enum(["queried", "not-checked", "excluded"]),
          reason: z.string().optional(),
        }),
      )
      .optional()
      .describe(
        "The project's feed set per target from `repos:` and `distro.feeds`, in dnf priority order. Present only when the project declares named feeds.",
      ),
  })
  .describe(
    "The effective package feed queried, and where each value came from.",
  );

export const notCheckedSchema = z
  .array(
    z.object({
      target: z.string(),
      feed: z.string(),
      reason: z.string(),
    }),
  )
  .describe(
    "Enabled feeds the MCP could not read (private `org:` feeds, auth failures, unresolved templates). A package missing from the results may still be in one of these.",
  );

/** Markdown block for feeds the lookup skipped. Empty when there are none. */
export function renderNotChecked(
  list: { target: string; feed: string; reason: string }[],
): string {
  if (list.length === 0) return "";
  let out = `\n**Not checked** (a package missing here may be in these feeds):\n`;
  for (const n of list) {
    out += `- \`${n.feed}\` for \`${n.target}\`: ${n.reason}\n`;
  }
  return out;
}
