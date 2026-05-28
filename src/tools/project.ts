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
import { RepoClient } from "../lib/repo-client.js";
import {
  searchReferencesScored,
  type ScoredReference,
} from "../lib/references-client.js";
import { resolveTarget } from "../lib/target-resolver.js";
import { qemuArchAdvisory } from "./discovery.js";

export function registerProjectTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.registerTool(
    "init-project",
    {
      title: "Scaffold a new Avocado project",
      description:
        "Scaffold a new Avocado OS project. ALWAYS searches the reference catalog first — references are pre-built, verified, working projects that dramatically beat starting from scratch. If a reference matches the user's task, returns the `avocado init --reference` CLI command to clone it. Falls back to a minimal from-scratch starter YAML only when no reference fits, or when `forceFromScratch: true`. Pass the user's task in their own words via `task`.",
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
            "Skip the reference search and return a blank starter YAML. Use only when the user explicitly wants a from-scratch project or no reference can serve their use case.",
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
    }) => {
      const validTargets = await repoClient.getTargetsConfig();
      if (validTargets && !validTargets[target]) {
        const allTargets = Object.keys(validTargets);
        const fuzzy = resolveTarget(target, allTargets).slice(0, 5);
        let body = `# init-project failed\n\n❌ \`${target}\` is **not a supported Avocado OS target**. The MCP only operates on targets that exist in the live feed.\n\n`;
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

      // Reference path — try this first unless explicitly skipped.
      if (!forceFromScratch) {
        const matches = searchReferencesScored(task ?? "", target);
        if (matches.length > 0) {
          return {
            content: [
              {
                type: "text",
                text: renderReferenceMatch(target, task, matches),
              },
            ],
          };
        }
      }

      // From-scratch path.
      const yaml = buildStarterYaml({ target, runtimeName, extraExtensions });
      const validation = await validateAvocadoYaml(yaml);

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
      if (validation.ok) {
        out += `✅ Generated YAML validates against the current schema (v ${validation.schemaVersion}).\n\n`;
      } else {
        out += `⚠️  Generated YAML did NOT validate. Schema may have moved; please report this.\n`;
        out += validation.errors
          .map((e) => `- \`${e.instancePath}\`: ${e.message}`)
          .join("\n");
        out += `\n\n`;
      }
      const rt = runtimeName ?? "dev";
      out += `Save the YAML below as \`avocado.yaml\` at your project root, then:\n\n`;
      out += `**For a HUMAN running these in their own terminal:**\n\n`;
      out += "```bash\n";
      out += `avocado install -f\n`;
      out += `avocado build\n`;
      out += `avocado provision -r ${rt}\n`;
      out += "```\n\n";
      out += `**For an LLM running via the Bash tool (no TTY):** use \`--no-tui\` + redirect-to-file for build/install, and wrap \`avocado provision\` with \`script\` to give it a pseudo-TTY (it shells out to \`docker run -it\`).\n\n`;
      out += "```bash\n";
      out += `avocado install -f --no-tui > /tmp/avocado-install.log 2>&1\n`;
      out += `avocado build --no-tui > /tmp/avocado-build.log 2>&1\n`;
      out += `script -q /dev/null avocado provision -r ${rt} --no-tui > /tmp/avocado-provision.log 2>&1\n`;
      out += "```\n\n";
      out += `## avocado.yaml\n\n\`\`\`yaml\n${yaml}\`\`\``;

      return { content: [{ type: "text", text: out }] };
    },
  );

  server.registerTool(
    "validate-yaml",
    {
      title: "Validate an avocado.yaml",
      description:
        "Validate an avocado.yaml against the current JSON Schema. Returns a pass/fail plus a list of every schema violation with its path. Use this before recommending a `avocado build` to the user — it catches structural problems early.",
      inputSchema: {
        yaml: z.string().describe("Full avocado.yaml content as a string."),
        schemaVersion: z
          .string()
          .optional()
          .describe(
            "Optional schema git ref to validate against (e.g. 'v1.0.0'). Defaults to 'main'.",
          ),
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
        schemaSource: z.string(),
        schemaVersion: z.string(),
      },
      annotations: {
        title: "Validate an avocado.yaml",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ yaml, schemaVersion }) => {
      const result = await validateAvocadoYaml(yaml, schemaVersion);
      let out = `# validate-yaml\n\n**Schema:** ${result.schemaVersion} (${result.schemaSource})\n\n`;
      if (result.ok) {
        out += `✅ Valid.\n`;
      } else {
        out += `❌ ${result.errors.length} error(s):\n\n`;
        for (const e of result.errors) {
          out += `- \`${e.instancePath}\`: ${e.message}\n`;
        }
      }
      return {
        content: [{ type: "text", text: out }],
        structuredContent: {
          ok: result.ok,
          errors: result.errors,
          schemaSource: result.schemaSource,
          schemaVersion: result.schemaVersion,
        },
      };
    },
  );

  server.registerTool(
    "add-extension",
    {
      title: "Add an extension to avocado.yaml",
      description:
        "Add a new extension definition to an existing avocado.yaml. Use this when the user wants to define an app/config/library extension. Returns the modified YAML; the schema is checked before returning.",
      inputSchema: {
        yaml: z.string().describe("Current avocado.yaml content."),
        name: z
          .string()
          .describe("Extension name (e.g. 'my-app', 'monitoring-confext')."),
        types: z
          .array(z.enum(["sysext", "confext"]))
          .min(1)
          .describe(
            "Extension types. 'sysext' extends /usr; 'confext' extends /etc. Most app extensions are both.",
          ),
        version: z
          .string()
          .optional()
          .describe("Version string for this extension. Defaults to '0.1.0'."),
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
    }) => {
      try {
        const newYaml = addExtension(yaml, {
          name,
          types,
          version: version ?? "0.1.0",
          packages,
          overlay,
          enableServices,
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
        "Add a single feed package to an existing extension's packages map. **Use this as the default path for adding ANY library or dependency** — feed packages beat vendored / pip-installed / npm-installed deps on every axis (versioning, security updates, image size, dependency resolution). Verifies the package exists in the live feed for one of the project's targets before adding; rejects unknown packages with a 'did you mean' list. If `search-packages` shows the user's library isn't in the feed, THEN consider vendoring (see `avocado://skills/app-development`).",
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
      },
      annotations: {
        title: "Add a feed package to an extension",
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ yaml, extension, packageName, version, targets }) => {
      try {
        // Verify the package exists for the user's targets
        const { results } = await repoClient.searchPackages(
          targets,
          packageName,
          5,
        );
        const exactMatch = results.find((r) => r.name === packageName);
        if (!exactMatch) {
          return {
            content: [
              {
                type: "text",
                text: `# add-package-to-extension failed\n\nNo package named \`${packageName}\` found in the repo for any of [${targets.map((t) => `\`${t}\``).join(", ")}].\n\n${
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
                `✅ Verified \`${packageName}\` (v${exactMatch.version}) exists in repo \`${exactMatch.repo}\` for the queried target(s).`,
              ),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# add-package-to-extension failed\n\n❌ ${(e as Error).message}`,
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
  out += `avocado install -f\n`;
  out += `avocado build\n`;
  out += "```\n\n";
  out += `The first command clones the reference project into \`./<slug>/\` and sets \`default_target\` to \`${target}\` in its \`avocado.yaml\`.\n\n`;

  out += `_If after reading getting_started.md none of these fit, call \`init-project\` again with \`forceFromScratch: true\` to get a blank starter YAML._\n`;
  return out;
}

function renderMutationResult(
  toolName: string,
  newYaml: string,
  validation: {
    ok: boolean;
    errors: { instancePath: string; message: string }[];
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
  out += "```yaml\n" + newYaml + "```\n";
  out += `\n**Next:** this YAML edit added/changed packages or extensions, so \`avocado install -f\` IS needed before the next \`avocado build\` — \`build\` won't pick the new package set up on its own. Run \`avocado install -f --no-tui && avocado build --no-tui\`.\n`;
  out += `\n**Fast iteration option:** if the user's device is already running and on the network, you can push these changes without reflashing media. After install + build, run \`avocado deploy -r <runtime> -d <device-ip> --no-tui\` to OTA the update in seconds. The \`/build-and-deploy\` prompt automates the whole sequence — pass \`forceInstall: true\` since you know install IS needed for this edit. See \`avocado://skills/iterative-deployment\` for the full flow. **Offer this proactively** — most users don't know it exists.\n`;
  return out;
}
