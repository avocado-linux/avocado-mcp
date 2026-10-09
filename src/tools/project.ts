import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  validateAvocadoYaml,
  buildStarterYaml,
  addExtension,
  addRuntime,
  addPackageToExtension,
  listExtensions,
} from "../lib/yaml-ops.js";
import { RepoClient, isSafeSegment, validateFeed } from "../lib/repo-client.js";
import {
  searchReferencesScored,
  type ScoredReference,
} from "../lib/references-client.js";
import { resolveTarget } from "../lib/target-resolver.js";
import { qemuArchAdvisory } from "./discovery.js";
import { feedArgsShape, feedContextFrom } from "./feed-args.js";

export function registerProjectTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.registerTool(
    "init-project",
    {
      title: "Scaffold a new Avocado project",
      description:
        "Scaffold a new Avocado OS project. ALWAYS searches the reference catalog first. References are pre-built, verified, working projects that dramatically beat starting from scratch. If a reference matches the user's task, returns the `avocado init --reference` CLI command to clone it. When no reference fits, or when `forceFromScratch: true`, returns the `avocado init --target` command and the edits to make after it. Set `cliAvailable: false` only when the avocado CLI cannot be used. The tool then returns a starter YAML copied from the CLI template. Pass the user's task in their own words via `task`.",
      inputSchema: {
        target: z
          .string()
          .describe(
            "Target name (must match an entry from list-targets, e.g. 'raspberrypi5').",
          ),
        task: z
          .string()
          .optional()
          .describe(
            "Free-text description of what the user wants to build — their own words ('python web app', 'mqtt sensor', 'kiosk dashboard', 'qemu trial run'). Used to search the reference catalog. Strongly recommended; leave blank only if you genuinely have no description to give.",
          ),
        forceFromScratch: z
          .boolean()
          .optional()
          .describe(
            "Skip the reference search and start from the CLI's default template. Use only when the user explicitly wants a from-scratch project or no reference can serve their use case.",
          ),
        board: z
          .string()
          .optional()
          .describe(
            "Board variant within the target, for modules that ship on more than one carrier board (e.g. 'mic-712-ox-16gb' on jetson-orin-nx, 'variscite-sonata' on imx8mp-var-dart). Written as `default_target_board`. It selects `avocado-bsp-{{ avocado.target.board }}`. Omit when the target has one board.",
          ),
        cliAvailable: z
          .boolean()
          .optional()
          .describe(
            "From-scratch path only. Defaults to true: the tool tells you to run `avocado init`. Set false only when the avocado CLI is not installed and cannot be installed. The tool then returns a starter avocado.yaml copied from the CLI template.",
          ),
        runtimeName: z
          .string()
          .optional()
          .describe(
            "Name for the initial runtime (from-scratch path only). Defaults to 'dev'.",
          ),
        extraExtensions: z
          .array(z.string())
          .optional()
          .describe(
            "Extra extension names to include in the runtime (from-scratch path only).",
          ),
        release: feedArgsShape.release,
        channel: feedArgsShape.channel,
        repoUrl: feedArgsShape.repoUrl,
      },
      annotations: {
        title: "Scaffold a new Avocado project",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({
      target,
      task,
      forceFromScratch,
      runtimeName,
      extraExtensions,
      board,
      cliAvailable,
      ...feedArgs
    }) => {
      const feed = feedContextFrom(feedArgs);
      // The feed values are written into the generated avocado.yaml, so an
      // invalid feed must stop here rather than fall through to the starter.
      let repoHref: string;
      try {
        repoHref = validateFeed(feed.base);
        for (const v of [feed.base.release, feed.base.channel]) {
          if (v !== undefined && !isSafeSegment(v)) {
            throw new Error(`Invalid release/channel: ${JSON.stringify(v)}`);
          }
        }
        // These land in avocado.yaml and in shell commands we print. The
        // feed support check cannot stand in for this: it is skipped when
        // targets.json is unreachable.
        if (!isSafeSegment(target)) {
          throw new Error(`Invalid target: ${JSON.stringify(target)}`);
        }
        if (runtimeName !== undefined && !isSafeSegment(runtimeName)) {
          throw new Error(
            `Invalid runtimeName: ${JSON.stringify(runtimeName)}`,
          );
        }
        if (board !== undefined && !isSafeSegment(board)) {
          throw new Error(`Invalid board: ${JSON.stringify(board)}`);
        }
        for (const e of extraExtensions ?? []) {
          // YAML 1.1 (avocado-cli's parser) also breaks lines on U+0085,
          // U+2028 and U+2029.
          if (!e.trim() || /[\x00-\x1f\x7f-\x9f\u2028\u2029]/.test(e)) {
            throw new Error(`Invalid extension name: ${JSON.stringify(e)}`);
          }
        }
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# init-project failed\n\n❌ ${(e as Error).message}\n\n${feed.describe()}`,
            },
          ],
        };
      }
      let validTargets;
      try {
        validTargets = await repoClient.getTargetsConfig(feed.base);
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# init-project failed\n\n❌ ${(e as Error).message}\n\n${feed.describe()}`,
            },
          ],
        };
      }
      if (validTargets && !validTargets[target]) {
        const allTargets = Object.keys(validTargets);
        const fuzzy = resolveTarget(target, allTargets).slice(0, 5);
        let body = `# init-project failed\n\n❌ \`${target}\` is **not a supported Avocado OS target**. The MCP only operates on targets that exist in the feed.\n\n${feed.describe()}\n`;
        if (fuzzy.length > 0) {
          body += `**Did you mean:** ${fuzzy.map((t) => `\`${t}\``).join(", ")}?\n\n`;
        }
        body += `**Supported targets (${allTargets.length}):** ${allTargets
          .sort()
          .map((t) => `\`${t}\``)
          .join(", ")}\n\n`;
        body += `If the user's hardware isn't on this list, **tell them it's not currently supported** — don't try to substitute a "close enough" target without their explicit confirmation. Use \`list-targets({ query: "..." })\` to search by user-supplied hardware names.`;
        return { content: [{ type: "text", text: body }] };
      }

      // Reference path — try this first unless explicitly skipped. The
      // reference catalog is read live from GitHub; if that's unreachable,
      // fall through to the from-scratch path rather than failing.
      if (!forceFromScratch) {
        const matches = await searchReferencesScored(task ?? "", target).catch(
          () => [],
        );
        if (matches.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: `${renderReferenceMatch(target, task, matches)}${board ? `\nAfter the scaffold, add \`default_target_board: ${board}\` below \`default_target\` in \`avocado.yaml\`.\n` : ""}\n\n${feed.describe()}`,
              },
            ],
          };
        }
      }

      // From-scratch path. `avocado init` writes the CLI's own template, so
      // it always matches the installed CLI. The vendored copy of that
      // template is only for a host without the CLI.
      const repoUrl = feedArgs.repoUrl?.trim() ? repoHref : undefined;
      let out = `# init-project — \`${target}\` (from scratch)\n\n`;
      if (forceFromScratch) {
        out += `_From-scratch path requested explicitly._\n\n`;
      } else {
        out += `_No reference matched ${task ? `task "${task}"` : "the target"}. Falling back to a minimal starter._\n\n`;
      }
      const archWarning = qemuArchAdvisory(target);
      if (archWarning) {
        out += `${archWarning}\n\n`;
      }

      let yaml: string | undefined;
      if (cliAvailable === false) {
        yaml = buildStarterYaml({
          target,
          runtimeName,
          extraExtensions,
          board,
          release: feed.base.release,
          channel: feed.base.channel,
          // The parsed URL, not the raw argument: it is what was validated.
          repoUrl,
        });
        const validation = await validateAvocadoYaml(yaml);
        if (validation.ok) {
          out += `✅ This YAML is the avocado CLI template (\`configs/default.yaml\`) and validates against the schema.\n\n`;
        } else {
          out += `⚠️  Generated YAML did NOT validate. Schema may have moved; please report this.\n`;
          out += validation.errors
            .map((e) => `- \`${e.instancePath}\`: ${e.message}`)
            .join("\n");
          out += `\n\n`;
        }
        out += `Save the YAML below as \`avocado.yaml\` at your project root.\n\n`;
        if (extraExtensions?.length) {
          out += `The runtime lists ${extraExtensions.map((e) => `\`${e}\``).join(", ")}, but the YAML does not define ${extraExtensions.length === 1 ? "it" : "them"} yet. Before \`avocado install\`, define each one with \`add-extension\` (a package, git or path source), or remove it from the runtime. Install fails on a runtime extension with no definition.\n\n`;
        }
        out += `Then:\n\n`;
      } else {
        out += renderInitSteps({
          target,
          runtimeName,
          extraExtensions,
          board,
          release: feedArgs.release?.trim() || undefined,
          channel: feedArgs.channel?.trim() || undefined,
          repoUrl,
        });
        out += `Then:\n\n`;
      }
      const rt = runtimeName ?? "dev";
      out += `**For a HUMAN running these in their own terminal:**\n\n`;
      out += "```bash\n";
      out += `avocado install\n`;
      out += `avocado build\n`;
      out += `avocado provision ${rt}\n`;
      out += "```\n\n";
      out += `**For an LLM running via the Bash tool (no TTY):** use \`--no-tui\` + redirect-to-file in \`.avocado/logs/\`. Set \`AVOCADO_NONINTERACTIVE=1\` for \`avocado provision\` so it never waits for an answer. No TTY wrapper is needed.\n\n`;
      out += "```bash\n";
      out += `mkdir -p .avocado/logs\n`;
      out += `avocado install --no-tui > .avocado/logs/install.log 2>&1\n`;
      out += `avocado build --no-tui > .avocado/logs/build.log 2>&1\n`;
      out += `AVOCADO_NONINTERACTIVE=1 avocado provision ${rt} --no-tui > .avocado/logs/provision.log 2>&1\n`;
      out += "```\n\n";
      out += `${feed.describe()}`;
      if (yaml) out += `\n\n## avocado.yaml\n\n\`\`\`yaml\n${yaml}\`\`\``;

      return { content: [{ type: "text", text: out }] };
    },
  );

  server.registerTool(
    "validate-yaml",
    {
      title: "Validate an avocado.yaml",
      description:
        "Validate an avocado.yaml against the JSON Schema the avocado CLI ships. Returns pass/fail, every schema error with its path, and warnings. Warnings match the CLI: an unknown key is ignored (with a 'did you mean' hint), and some keys are deprecated or have no effect. Warnings do not fail validation, but fix them. Use this before recommending `avocado build` to the user. It catches structural problems early.",
      inputSchema: {
        yaml: z.string().describe("Full avocado.yaml content as a string."),
      },
      outputSchema: {
        ok: z.boolean(),
        errors: z.array(
          z.object({
            instancePath: z
              .string()
              .describe("JSON pointer path of the failing node."),
            message: z.string(),
          }),
        ),
        warnings: z
          .array(z.string())
          .describe(
            "Keys the CLI ignores or deprecates. The CLI prints a warning for each and keeps going.",
          ),
        schemaSource: z.string(),
      },
      annotations: {
        title: "Validate an avocado.yaml",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ yaml }) => {
      const result = await validateAvocadoYaml(yaml);
      let out = `# validate-yaml\n\n**Schema:** ${result.schemaSource}\n\n`;
      if (result.ok) {
        out += `✅ Valid.\n`;
      } else {
        out += `❌ ${result.errors.length} error(s):\n\n`;
        for (const e of result.errors) {
          out += `- \`${e.instancePath}\`: ${e.message}\n`;
        }
      }
      out += renderWarnings(result.warnings);
      return {
        content: [{ type: "text", text: out }],
        structuredContent: {
          ok: result.ok,
          errors: result.errors,
          warnings: result.warnings,
          schemaSource: result.schemaSource,
        },
      };
    },
  );

  server.registerTool(
    "add-extension",
    {
      title: "Add an extension to avocado.yaml",
      description:
        "Add a new extension definition to an existing avocado.yaml. Use this when the user wants to define an app/config/library extension, or to pull an extension from a package feed, a git repository or a local path (`source`). Returns the modified YAML; the schema is checked before returning.",
      inputSchema: {
        yaml: z.string().describe("Current avocado.yaml content."),
        name: z
          .string()
          .describe("Extension name (e.g. 'my-app', 'monitoring-confext')."),
        types: z
          .array(z.enum(["sysext", "confext"]))
          .min(1)
          .optional()
          .describe(
            "Extension types. 'sysext' extends /usr; 'confext' extends /etc. Most app extensions are both. Required for a local extension (no `source`).",
          ),
        version: z
          .string()
          .optional()
          .describe(
            "Version string for a local extension. Defaults to '0.1.0'. Not used with `source`.",
          ),
        source: z
          .discriminatedUnion("type", [
            z.object({
              type: z.literal("package"),
              version: z.string().describe("Version requirement, e.g. '*'."),
              package: z
                .string()
                .optional()
                .describe("RPM name, when it differs from the extension name."),
            }),
            z.object({
              type: z.literal("git"),
              url: z.string().describe("Git repository URL."),
              ref: z.string().optional().describe("Branch, tag or commit."),
            }),
            z.object({
              type: z.literal("path"),
              path: z
                .string()
                .describe(
                  "Extension directory, relative to the project (or src_dir), or absolute.",
                ),
            }),
          ])
          .optional()
          .describe(
            "Remote source. Omit for a local extension defined in this file. A source extension gets its definition (types, packages) from that source.",
          ),
        dependsOn: z
          .array(z.string())
          .optional()
          .describe(
            "Extensions this one depends on (`depends_on`). Each item is a name or '<name>: <version requirement>'.",
          ),
        packages: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Map of package name → version requirement (e.g. { curl: '*', openssl: '>=3.0' }). Verify package names via search-packages before adding.",
          ),
        overlay: z
          .string()
          .optional()
          .describe(
            "Path to an overlay directory containing files to layer into the extension (relative to project root, e.g. 'overlays/my-app').",
          ),
        enableServices: z
          .array(z.string())
          .optional()
          .describe(
            "systemd unit names to enable on boot (e.g. ['my-app.service']).",
          ),
      },
      annotations: {
        title: "Add an extension to avocado.yaml",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({
      yaml,
      name,
      types,
      version,
      packages,
      overlay,
      enableServices,
      source,
      dependsOn,
    }) => {
      try {
        if (!source && !types) {
          throw new Error(
            "Pass `types` for a local extension, or a `source` for a remote one.",
          );
        }
        const newYaml = addExtension(yaml, {
          name,
          types,
          version: source ? version : (version ?? "0.1.0"),
          packages,
          overlay,
          enableServices,
          source,
          dependsOn,
        });
        const validation = await validateAvocadoYaml(newYaml);
        return {
          content: [
            {
              type: "text",
              text: renderMutationResult("add-extension", newYaml, validation),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# add-extension failed\n\n❌ ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "add-runtime",
    {
      title: "Add a runtime to avocado.yaml",
      description:
        "Add a new runtime (named composition of extensions) to an existing avocado.yaml. Use this when the user wants e.g. a 'prod' runtime alongside their existing 'dev' runtime.",
      inputSchema: {
        yaml: z.string().describe("Current avocado.yaml content."),
        name: z
          .string()
          .describe("Runtime name (e.g. 'prod', 'factory', 'staging')."),
        extensions: z
          .array(z.string())
          .min(1)
          .describe(
            "Extensions to include in this runtime, in order. Must reference extensions that exist either in this YAML or in the package repo.",
          ),
        packages: z
          .record(z.string(), z.string())
          .optional()
          .describe(
            "Optional map of runtime-level packages (typically just { 'avocado-runtime': '*' }).",
          ),
        replace: z
          .boolean()
          .optional()
          .describe(
            "If a runtime with this name exists, set replace=true to overwrite it. Default false.",
          ),
      },
      annotations: {
        title: "Add a runtime to avocado.yaml",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ yaml, name, extensions, packages, replace }) => {
      try {
        const newYaml = addRuntime(yaml, {
          name,
          extensions,
          packages,
          replace,
        });
        const validation = await validateAvocadoYaml(newYaml);
        return {
          content: [
            {
              type: "text",
              text: renderMutationResult("add-runtime", newYaml, validation),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# add-runtime failed\n\n❌ ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );

  server.registerTool(
    "add-package-to-extension",
    {
      title: "Add a feed package to an extension",
      description:
        "Add a single feed package to an existing extension's packages map. **Use this as the default path for adding ANY library or dependency** — feed packages beat vendored / pip-installed / npm-installed deps on every axis (versioning, security updates, image size, dependency resolution). Verifies the package exists — in the feed the YAML is configured for (distro.release / distro.channel / distro.repo.url, AVOCADO_* env overrides, and the lock file's snapshot pin when `projectDir` is given) — for one of the project's targets before adding; rejects unknown packages with a 'did you mean' list. If `search-packages` shows the user's library isn't in the feed, THEN consider vendoring (see `avocado://skills/app-development`).",
      inputSchema: {
        yaml: z.string().describe("Current avocado.yaml content."),
        extension: z
          .string()
          .describe("Name of the extension to modify (must already exist)."),
        packageName: z
          .string()
          .describe(
            "Exact package name. Verify via search-packages or describe-package first.",
          ),
        version: z
          .string()
          .optional()
          .describe(
            "Optional version requirement (e.g. '>=1.0.0', '^2', '*'). Defaults to '*'.",
          ),
        targets: z
          .array(z.string())
          .min(1)
          .describe(
            "Targets to verify the package against. Usually the project's default_target. Pass at least one.",
          ),
        projectDir: feedArgsShape.projectDir.describe(
          "Absolute path to the project directory. Optional — the feed is read from the `yaml` you pass either way; `projectDir` adds the lock file's snapshot pin and resolves relative `distro.repo.ca` paths.",
        ),
      },
      annotations: {
        title: "Add a feed package to an extension",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ yaml, extension, packageName, version, targets, projectDir }) => {
      // Verify against the feed THIS yaml is configured for.
      const feed = feedContextFrom({ projectDir }, yaml);
      try {
        // Verify the package exists for the user's targets
        const { results } = await repoClient.searchPackages(
          targets,
          packageName,
          5,
          (t) => feed.forTarget(t),
        );
        const exactMatch = results.find((r) => r.name === packageName);
        if (!exactMatch) {
          return {
            content: [
              {
                type: "text",
                text: `# add-package-to-extension failed\n\n${feed.describe(targets)}\nNo package named \`${packageName}\` found in this feed for any of [${targets.map((t) => `\`${t}\``).join(", ")}].\n\n${
                  results.length > 0
                    ? `Did you mean one of: ${results
                        .slice(0, 5)
                        .map((r) => `\`${r.name}\``)
                        .join(", ")}?`
                    : "Use search-packages to find the right package name."
                }`,
              },
            ],
          };
        }

        const newYaml = addPackageToExtension(yaml, {
          extension,
          packageName,
          version,
        });
        const validation = await validateAvocadoYaml(newYaml);
        return {
          content: [
            {
              type: "text",
              text: renderMutationResult(
                "add-package-to-extension",
                newYaml,
                validation,
                `✅ Verified \`${packageName}\` (v${exactMatch.version}) exists in repo \`${exactMatch.repo}\` for the queried target(s).\n\n${feed.describe(targets)}`,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# add-package-to-extension failed\n\n❌ ${(e as Error).message}\n\n${feed.describe(targets)}`,
            },
          ],
        };
      }
    },
  );

  // Bonus tool kept here for cohesion with project authoring: surface what
  // the current YAML defines, so the LLM can reason without re-parsing.
  server.registerTool(
    "list-yaml-extensions",
    {
      title: "List extensions in an avocado.yaml",
      description:
        "List extensions defined in an avocado.yaml, with their types. Handy when the LLM has the YAML and needs to know what's already there before suggesting changes.",
      inputSchema: {
        yaml: z.string().describe("Current avocado.yaml content."),
      },
      outputSchema: {
        extensions: z.array(
          z.object({
            name: z.string(),
            types: z.array(z.string()),
          }),
        ),
      },
      annotations: {
        title: "List extensions in an avocado.yaml",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ yaml }) => {
      try {
        const extensions = listExtensions(yaml);
        let out = `# list-yaml-extensions\n\n`;
        if (extensions.length === 0) {
          out += `_No extensions defined._`;
        } else {
          out += `| Name | Types |\n|------|-------|\n`;
          for (const e of extensions) {
            out += `| \`${e.name}\` | ${e.types.join(", ") || "—"} |\n`;
          }
        }
        return {
          content: [{ type: "text", text: out }],
          structuredContent: { extensions },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# list-yaml-extensions failed\n\n❌ ${(e as Error).message}`,
            },
          ],
          structuredContent: { extensions: [] },
          isError: true,
        };
      }
    },
  );
}

/**
 * The from-scratch steps when the avocado CLI is available: run `avocado init`
 * (it has no board, runtime or feed flags), then edit the YAML it writes.
 */
function renderInitSteps(opts: {
  target: string;
  runtimeName?: string;
  extraExtensions?: string[];
  board?: string;
  release?: string;
  channel?: string;
  repoUrl?: string;
}): string {
  const rt = opts.runtimeName ?? "dev";
  let out = `## Create the project with the avocado CLI\n\n`;
  out += `Run \`avocado init\`. It writes \`avocado.yaml\` from the template of the installed CLI, so the file always matches that CLI. Replace \`<project-dir>\` with the directory for the new project. The commands after this step run inside that directory. To use the current directory, omit both \`<project-dir>\` and the \`cd\`.\n\n`;
  out += "```bash\n";
  out += `avocado init --target ${opts.target} <project-dir> && cd <project-dir>\n`;
  out += "```\n\n";
  out += `\`avocado init\` stops if \`avocado.yaml\` already exists. Add \`--name <name>\` to create the project in \`<project-dir>/<name>/\`, and \`cd\` into that directory instead.\n\n`;

  const edits: string[] = [];
  if (opts.board) {
    edits.push(
      `Add \`default_target_board: ${opts.board}\` below \`default_target\`. The BSP extension \`avocado-bsp-{{ avocado.target.board }}\` then resolves to \`avocado-bsp-${opts.board}\`.`,
    );
  }
  if (rt !== "dev") {
    edits.push(`Rename the runtime \`runtimes.dev\` to \`runtimes.${rt}\`.`);
  }
  if (opts.extraExtensions && opts.extraExtensions.length > 0) {
    edits.push(
      `Add ${opts.extraExtensions.map((e) => `\`${e}\``).join(", ")} to \`runtimes.${rt}.extensions\`. Define each one under \`extensions:\` (use \`add-extension\`).`,
    );
  }
  const distro: string[] = [];
  if (opts.release) distro.push(`\`distro.release: ${opts.release}\``);
  if (opts.channel) distro.push(`\`distro.channel: ${opts.channel}\``);
  if (opts.repoUrl) distro.push(`\`distro.repo.url: ${opts.repoUrl}\``);
  if (distro.length > 0) edits.push(`Set ${distro.join(", ")}.`);

  if (edits.length > 0) {
    out += `## Then edit avocado.yaml\n\n`;
    out += edits.map((e, i) => `${i + 1}. ${e}`).join("\n");
    out += `\n\nRun \`validate-yaml\` on the edited file.\n\n`;
  }
  return out;
}

function renderReferenceMatch(
  target: string,
  task: string | undefined,
  matches: ScoredReference[],
): string {
  function compatibilityBadge(c: ScoredReference["compatibility"]): string {
    if (c === "listed") return `✅ listed for \`${target}\``;
    if (c === "generic") return "🟢 generic (any target)";
    return `⚠️ unlisted for \`${target}\``;
  }

  const candidates = matches.slice(0, 8);

  let out = `# init-project — \`${target}\` (reference candidates)\n\n`;
  out += task
    ? `Task: _"${task}"_\n\n`
    : `(No task provided — listing references with summaries.)\n\n`;
  const archWarning = qemuArchAdvisory(target);
  if (archWarning) {
    out += `${archWarning}\n\n`;
  }
  out += `Found **${matches.length}** candidate reference${matches.length === 1 ? "" : "s"} matching the query. **Do NOT auto-pick the first one.** The MCP ranks by query-token relevance only — it does NOT know which candidate is the best fit for the user's actual task. **You must read each candidate's getting_started.md before picking** — that's where authors document what the reference actually does, what hardware they've tested it on, and what trade-offs they made.\n\n`;

  out += `## Selection workflow\n\n`;
  out += `1. Review the candidates below (title + summary + compatibility tag).\n`;
  out += `2. For each plausible candidate, call \`get-reference-file({ slug: "<slug>", path: "getting_started.md" })\` and read it.\n`;
  out += `3. Pick the candidate that best matches the user's task. **Compatibility tags are informational, not prescriptive** — an unlisted reference may still work after BSP edits; a listed one may be over-specialised for the task. Use the getting_started content to decide.\n`;
  out += `4. Tell the user which one you picked and why before running the scaffold command.\n\n`;

  out += `## Candidates\n\n`;
  out += `| Slug | Title | Language | Compatibility | Summary |\n|------|-------|----------|---------------|---------|\n`;
  for (const c of candidates) {
    out += `| \`${c.entry.slug}\` | ${c.entry.title} | ${c.entry.language} | ${compatibilityBadge(c.compatibility)} | ${c.entry.summary} |\n`;
  }
  out += `\n`;

  out += `## Compatibility tag meanings\n\n`;
  out += `- **✅ listed** — reference authors tested it on this target. Lowest risk.\n`;
  out += `- **🟢 generic** — reference has no hardware list; works on any target with a valid BSP.\n`;
  out += `- **⚠️ unlisted** — reference targets *other* hardware, not this one. May still work but isn't tested for \`${target}\`. **Tell the user up front** if you pick one of these.\n\n`;

  out += `## Once you've picked a candidate\n\n`;
  out += `Replace \`<slug>\` with your chosen reference's slug from the table:\n\n`;
  out += "```bash\n";
  out += `avocado init --target ${target} --reference <slug> <slug> && cd <slug>\n`;
  out += `avocado install\n`;
  out += `avocado build\n`;
  out += "```\n\n";
  out += `The first command clones the reference project into \`./<slug>/\` and sets \`default_target\` to \`${target}\` in its \`avocado.yaml\`.\n\n`;

  out += `_If after reading getting_started.md none of these fit, call \`init-project\` again with \`forceFromScratch: true\`. It returns the \`avocado init --target\` command and the edits to make after it._\n`;
  return out;
}

function renderMutationResult(
  toolName: string,
  newYaml: string,
  validation: {
    ok: boolean;
    errors: { instancePath: string; message: string }[];
    warnings: string[];
  },
  prefixNote?: string,
): string {
  let out = `# ${toolName}\n\n`;
  if (prefixNote) out += `${prefixNote}\n\n`;
  if (validation.ok) {
    out += `✅ Modified YAML validates against the schema.\n\n`;
  } else {
    out += `⚠️  Modified YAML did NOT validate:\n`;
    for (const e of validation.errors) {
      out += `- \`${e.instancePath}\`: ${e.message}\n`;
    }
    out += `\n`;
  }
  out += renderWarnings(validation.warnings);
  out += "```yaml\n" + newYaml + "```\n";
  out += `\n**Next:** this YAML edit added/changed packages or extensions, so \`avocado install\` IS needed before the next \`avocado build\`. \`build\` won't pick the new package set up on its own. Run \`avocado install --no-tui && avocado build --no-tui\`.\n`;
  out += `\n**Fast iteration option:** if the user's device is already running and on the network, you can push these changes without reflashing media. After install + build, run \`avocado deploy <runtime> -d <device-ip> --no-tui\` to OTA the update in seconds. The \`/build-and-deploy\` prompt automates the whole sequence. Pass \`runInstall: true\` because you know install IS needed for this edit. See \`avocado://skills/iterative-deployment\` for the full flow. **Offer this proactively.** Most users don't know it exists.\n`;
  return out;
}

/** The CLI's ignored-key warnings, as a list the model can act on. */
function renderWarnings(warnings: string[]): string {
  if (warnings.length === 0) return "";
  let out = `\n⚠️  ${warnings.length} warning(s). The CLI prints these and keeps going:\n\n`;
  for (const w of warnings) out += `- ${w}\n`;
  return out + `\n`;
}
