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

export function registerProjectTools(
  server: McpServer,
  repoClient: RepoClient,
): void {
  server.tool(
    "init-project",
    "Generate a starter avocado.yaml for a target. Includes the dev runtime with SSH + debug tooling, the target's BSP, and placeholder `app` + `config` extensions. After generating, the user runs `avocado build` and `avocado provision` to flash a device.",
    {
      target: z
        .string()
        .describe(
          "Target name (must match an entry from list-targets, e.g. 'raspberrypi5').",
        ),
      runtimeName: z
        .string()
        .optional()
        .describe(
          "Name for the initial runtime. Defaults to 'dev'. Most projects keep 'dev' and add 'prod' later.",
        ),
      extraExtensions: z
        .array(z.string())
        .optional()
        .describe(
          "Optional list of extra extension names to include in the runtime (e.g. ['monitoring']). Must be names of extensions that exist either in this YAML or in the package repo.",
        ),
    },
    async ({ target, runtimeName, extraExtensions }) => {
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

      const yaml = buildStarterYaml({ target, runtimeName, extraExtensions });

      // Validate the generated YAML against the schema to catch any drift.
      const validation = await validateAvocadoYaml(yaml);

      let out = `# init-project — \`${target}\`\n\n`;
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
  return out;
}
