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
  searchReferences,
  type ReferenceEntry,
} from "../lib/references-client.js";

export function registerProjectTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.tool(
    "init-project",
    "Scaffold a new Avocado OS project. ALWAYS searches the reference catalog first — references are pre-built, verified, working projects that dramatically beat starting from scratch. If a reference matches the user's task, returns the `avocado init --reference` CLI command to clone it. Falls back to a minimal from-scratch starter YAML only when no reference fits, or when `forceFromScratch: true`. Pass the user's task in their own words via `task`.",
    {
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
    async ({
      target,
      task,
      forceFromScratch,
      runtimeName,
      extraExtensions,
    }) => {
      const validTargets = await repoClient.getTargetsConfig();
      if (validTargets && !validTargets[target]) {
        const sample = Object.keys(validTargets).slice(0, 8).join(", ");
        return {
          content: [
            {
              type: "text",
              text: `# init-project failed\n\nTarget \`${target}\` is not in targets.json. Examples of valid targets: ${sample}. Run \`list-targets\` for the full list.`,
            },
          ],
        };
      }

      // Reference path — try this first unless explicitly skipped.
      if (!forceFromScratch) {
        const matches = task
          ? searchReferences(task, target)
          : searchReferences("", target);
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
      if (validation.ok) {
        out += `✅ Generated YAML validates against the current schema (v ${validation.schemaVersion}).\n\n`;
      } else {
        out += `⚠️  Generated YAML did NOT validate. Schema may have moved; please report this.\n`;
        out += validation.errors
          .map((e) => `- \`${e.instancePath}\`: ${e.message}`)
          .join("\n");
        out += `\n\n`;
      }
      out += `Save the YAML below as \`avocado.yaml\` at your project root, then:\n\n`;
      out +=
        "```bash\navocado install\navocado build\navocado provision -r " +
        (runtimeName ?? "dev") +
        "\n```\n\n";
      out += `## avocado.yaml\n\n\`\`\`yaml\n${yaml}\`\`\``;

      return { content: [{ type: "text", text: out }] };
    },
  );

  server.tool(
    "validate-yaml",
    "Validate an avocado.yaml against the current JSON Schema. Returns a pass/fail plus a list of every schema violation with its path. Use this before recommending a `avocado build` to the user — it catches structural problems early.",
    {
      yaml: z.string().describe("Full avocado.yaml content as a string."),
      schemaVersion: z
        .string()
        .optional()
        .describe(
          "Optional schema git ref to validate against (e.g. 'v1.0.0'). Defaults to 'main'.",
        ),
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
      return { content: [{ type: "text", text: out }] };
    },
  );

  server.tool(
    "add-extension",
    "Add a new extension definition to an existing avocado.yaml. Use this when the user wants to define an app/config/library extension. Returns the modified YAML; the schema is checked before returning.",
    {
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

  server.tool(
    "add-runtime",
    "Add a new runtime (named composition of extensions) to an existing avocado.yaml. Use this when the user wants e.g. a 'prod' runtime alongside their existing 'dev' runtime.",
    {
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

  server.tool(
    "add-package-to-extension",
    "Add a single package to an existing extension's packages map. Verifies the package exists in the repo for one of the project's targets before adding (rejects unknown packages).",
    {
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
  server.tool(
    "list-yaml-extensions",
    "List extensions defined in an avocado.yaml, with their types. Handy when the LLM has the YAML and needs to know what's already there before suggesting changes.",
    {
      yaml: z.string().describe("Current avocado.yaml content."),
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
        return { content: [{ type: "text", text: out }] };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `# list-yaml-extensions failed\n\n❌ ${(e as Error).message}`,
            },
          ],
        };
      }
    },
  );
}

function renderReferenceMatch(
  target: string,
  task: string | undefined,
  matches: ReferenceEntry[],
): string {
  const top = matches[0];
  const rest = matches.slice(1, 5);

  let out = `# init-project — \`${target}\` (reference match)\n\n`;
  out += task
    ? `Task: _"${task}"_\n\n`
    : `(No task provided — listing references compatible with \`${target}\`.)\n\n`;
  out += `✅ Found ${matches.length} matching reference${matches.length === 1 ? "" : "s"}. References are pre-built and verified; use one instead of scaffolding from scratch unless the user has a strong reason not to.\n\n`;

  out += `## Best fit: \`${top.slug}\`\n\n`;
  out += `**Title:** ${top.title}  •  **Language:** ${top.language}  •  **Hardware:** ${top.hardware.length ? top.hardware.join(", ") : "generic"}\n\n`;
  out += `${top.summary}\n\n`;
  out += `### Scaffold it\n\n`;
  out += "```bash\n";
  out += `avocado init -t ${target} --reference ${top.slug} ${top.slug} && cd ${top.slug}\n`;
  out += "```\n\n";
  out += `This clones the reference project into \`./${top.slug}/\` and sets \`default_target\` to \`${target}\` in its \`avocado.yaml\`. Then:\n\n`;
  out += "```bash\n";
  out += `avocado install -f\n`;
  out += `avocado build\n`;
  out += "```\n\n";
  out += `Call \`get-reference\` with slug \`${top.slug}\` to see its full structure (file tree, \`avocado.yaml\`, overlays, build hooks) before suggesting edits.\n\n`;

  if (rest.length > 0) {
    out += `## Other matches\n\n`;
    out += `| Slug | Title | Language | Summary |\n|------|-------|----------|---------|\n`;
    for (const r of rest) {
      out += `| \`${r.slug}\` | ${r.title} | ${r.language} | ${r.summary} |\n`;
    }
    out += `\n`;
  }

  out += `_If none of these are a fit, call \`init-project\` again with \`forceFromScratch: true\` to get a blank starter YAML._\n`;
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
  out += `\n**Next:** run \`avocado install\` before the next \`avocado build\` so the new packages/extensions are resolved into the SDK. \`avocado build\` alone won't pick them up.\n`;
  return out;
}
