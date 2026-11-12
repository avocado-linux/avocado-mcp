import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  classifyBuildPath,
  imageClassOf,
  type ChangeInput,
  type PackageInfo,
  type PublishedState,
  type RecipeMap,
  type Verdict,
  type Workspace,
} from "../lib/build-path.js";
import {
  cliVersionWarning,
  createWorkspace,
  findDelta,
  loadDeltaPackages,
  loadPublishedState,
  mirrorDirFrom,
  projectBuildTarget,
  readRecipeMap,
  verdictFeeds,
  type PublishedClient,
} from "../lib/build-path-io.js";
import type { RepoClient } from "../lib/repo-client.js";
import { feedContextFrom } from "./feed-args.js";

export interface CheckBuildPathInput {
  project_dir: string;
  workspace_dir?: string;
  change?: ChangeInput;
  mirror_dir?: string;
}

export type CheckBuildPathResult =
  | { ok: true; verdict: Verdict }
  | { ok: false; error: string };

const errText = (e: unknown) => String((e as Error)?.message ?? e);

/**
 * Decide whether a change is served by the published feed, the project's
 * local delta, or needs an image build. A remote that cannot be read yields
 * a verdict that says so; only an unusable request is an error.
 */
export async function checkBuildPath(
  client: PublishedClient,
  input: CheckBuildPathInput,
  env: Record<string, string | undefined> = process.env,
): Promise<CheckBuildPathResult> {
  const ctx = feedContextFrom({ projectDir: input.project_dir });
  const configPath = ctx.base.configPath;
  if (!configPath) {
    return {
      ok: false,
      error: `no avocado.yaml found at ${input.project_dir}; pass the project directory`,
    };
  }
  const target = projectBuildTarget(configPath, env);
  if (!target) {
    return {
      ok: false,
      error: `no build target: set default_target in ${configPath} or AVOCADO_TARGET`,
    };
  }

  const feed = ctx.forTarget(target);
  const warnings: string[] = [];

  // An image-level path wins over every recipe, so the answer needs no
  // delta, workspace, published feed or CLI query: return before any of them.
  if ((input.change?.paths ?? []).some((p) => imageClassOf(p) !== null)) {
    return classifyBuildPath({
      target,
      release: feed.release ?? "",
      channel: feed.channel ?? "",
      change: input.change,
      recipeMap: null,
      delta: null,
      workspace: null,
      published: null,
      feeds: verdictFeeds(feed, null, null),
    });
  }

  // Delta: path feeds of the project that sit below a delta.json.
  const feedDirs = (feed.extraFeeds ?? [])
    .map((f) => f.path)
    .filter((p): p is string => typeof p === "string");
  const { found, warnings: deltaWarnings } = findDelta(feedDirs);
  warnings.push(...deltaWarnings);
  let recipeMap: RecipeMap | null = null;
  let deltaPackages: PackageInfo[] = [];
  if (found) {
    const rm = readRecipeMap(found.root);
    recipeMap = rm.map;
    warnings.push(...rm.warnings);
    const loaded = await loadDeltaPackages(client, found.feedDirs);
    deltaPackages = loaded.packages;
    warnings.push(...loaded.warnings);
  }

  let workspace: Workspace | null = null;
  let workspaceFailures: string[] = [];
  if (input.workspace_dir) {
    const handle = createWorkspace(input.workspace_dir);
    workspace = handle.workspace;
    // The workspace runs git lazily, while the classifier asks. Keep the
    // list itself and read it after classification, not a copy taken now.
    workspaceFailures = handle.failures;
  }

  const mirrorDir = mirrorDirFrom(input.mirror_dir, env);
  let published: PublishedState | null = null;
  let mirrorConfigured = Boolean(mirrorDir);
  let commit: string | null = null;
  try {
    const loaded = await loadPublishedState({
      client,
      feed,
      target,
      mirrorDir,
    });
    published = loaded.published;
    mirrorConfigured = loaded.mirrorConfigured;
    commit = loaded.commit;
    warnings.push(...loaded.warnings);
  } catch (e) {
    // The remote failing is a verdict input, not an error of the request.
    published = {
      reachable: false,
      snapshotId: null,
      packages: [],
      buildManifest: null,
    };
    warnings.push(`the published feed could not be read: ${errText(e)}`);
  }

  const cliWarning = await cliVersionWarning(undefined, env);
  if (cliWarning) warnings.push(cliWarning);

  const result = classifyBuildPath({
    target,
    release: feed.release ?? "",
    channel: feed.channel ?? "",
    change: input.change,
    recipeMap,
    delta: found ? { manifest: found.manifest, packages: deltaPackages } : null,
    workspace,
    published,
    mirrorConfigured,
    feeds: verdictFeeds(feed, published.snapshotId, commit),
  });
  if (!result.ok) return result;
  warnings.push(...workspaceFailures);
  for (const w of warnings) {
    if (!result.verdict.warnings.includes(w)) result.verdict.warnings.push(w);
  }
  return result;
}

const missingSchema = z.object({
  recipe: z.string().nullable(),
  package: z.string(),
  reason: z.enum([
    "stale-delta",
    "version-differs",
    "no-cache-key",
    "feed-unreachable",
    "unknown-recipe",
  ]),
});

const feedSchema = z.object({
  name: z.string(),
  kind: z.string(),
  url_or_path: z.string(),
  release: z.string(),
  channel: z.string(),
  snapshot_id: z.string().nullable(),
  commit: z.string().nullable(),
});

export function registerBuildPathTool(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.registerTool(
    "check-build-path",
    {
      title: "Check whether a change needs an image build",
      description:
        "Decide the build path for a change before building anything. Returns `feed_hit` (every package is served by the published feed or the project's local delta: use `avocado install` and `avocado build`, no Yocto), `package_miss` (named packages are not served: build those recipes with bakar into the delta feed) or `image_miss` (the change touches machine, kernel, board-support, layer, distro, package-group or image paths: a full image build is needed). Pass `change.recipes` and/or `change.paths` (paths changed in the layer workspace). `workspace_dir` is the layers checkout, used to prove a delta or published package was built from the current recipe commits. `mirror_dir` (or AVOCADO_FEED_MIRROR_DIR) names a local feed mirror used for package metadata only when it matches the remote head. A changed path that maps to no recipe (a bbclass, a shared include the workspace cannot place) and is not documentation or a test file gives `package_miss` with no entry in `missing` and the path named in `reasons`; image and kernel classes give `image_miss`. An unreachable remote still returns a verdict, with reason `feed-unreachable`. Read-only: it never builds, writes a feed or touches a device.",
      inputSchema: {
        project_dir: z
          .string()
          .describe(
            "Absolute path to the Avocado project directory (or its avocado.yaml). The build target comes from AVOCADO_TARGET or `default_target`.",
          ),
        workspace_dir: z
          .string()
          .optional()
          .describe(
            "Absolute path to the layers workspace (a git repository, or a directory of them).",
          ),
        change: z
          .object({
            recipes: z.array(z.string()).optional(),
            paths: z.array(z.string()).optional(),
          })
          .optional()
          .describe("What changed: recipe names and/or changed layer paths."),
        mirror_dir: z
          .string()
          .optional()
          .describe(
            "Local feed mirror directory. Overrides AVOCADO_FEED_MIRROR_DIR.",
          ),
      },
      outputSchema: {
        schema_version: z.number(),
        verdict: z.enum(["feed_hit", "package_miss", "image_miss"]),
        missing: z.array(missingSchema),
        reasons: z.array(z.string()),
        feeds: z.array(feedSchema),
        cache_keys: z.object({
          published: z.record(z.string()),
          local: z.record(z.string()),
        }),
        warnings: z.array(z.string()),
        target: z.string(),
        generated_at: z.string(),
      },
      annotations: {
        title: "Check whether a change needs an image build",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        const r = await checkBuildPath(repoClient, args);
        if (!r.ok) {
          return {
            content: [
              { type: "text", text: `# check-build-path\n\n❌ ${r.error}` },
            ],
            isError: true,
          };
        }
        const v = r.verdict;
        let text = `# check-build-path: \`${v.verdict}\`\n\nTarget \`${v.target}\`.\n`;
        if (v.reasons.length > 0)
          text += `\n## Reasons\n\n${v.reasons.map((x) => `- ${x}`).join("\n")}\n`;
        if (v.missing.length > 0)
          text += `\n## Missing\n\n${v.missing
            .map(
              (m) =>
                `- \`${m.package}\`${m.recipe ? ` (recipe \`${m.recipe}\`)` : ""}: ${m.reason}`,
            )
            .join("\n")}\n`;
        if (v.warnings.length > 0)
          text += `\n## Warnings\n\n${v.warnings.map((x) => `- ${x}`).join("\n")}\n`;
        return {
          content: [{ type: "text", text }],
          structuredContent: v as unknown as Record<string, unknown>,
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# check-build-path failed\n\n❌ ${errText(error)}`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
