import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as gettingStarted from "../resources/getting-started.js";
import * as hardwareCatalog from "../resources/hardware-catalog.js";
import * as referencesCatalog from "../resources/references-catalog.js";
import * as configYamlGuide from "../resources/config-yaml-guide.js";
import * as extensionsAndRuntimes from "../resources/extensions-and-runtimes.js";
import * as filesystemModel from "../resources/filesystem-model.js";
import * as deviceDebugging from "../resources/device-debugging.js";
import * as avocadoRuntimeDetails from "../resources/avocado-runtime-details.js";
import * as tmuxUartBridge from "../resources/tmux-uart-bridge.js";
import * as extensionBuildDebugging from "../resources/extension-build-debugging.js";
import * as iterativeDeployment from "../resources/iterative-deployment.js";
import * as appDevelopment from "../resources/app-development.js";
import * as avocadoCliExecution from "../resources/avocado-cli-execution.js";
import * as upstreamSources from "../resources/upstream-sources.js";

interface Skill {
  uri: string;
  name: string;
  description: string;
  content: string;
}

const SKILLS: Skill[] = [
  toSkill(gettingStarted),
  toSkill(hardwareCatalog),
  toSkill(referencesCatalog),
  toSkill(configYamlGuide),
  toSkill(extensionsAndRuntimes),
  toSkill(filesystemModel),
  toSkill(deviceDebugging),
  toSkill(avocadoRuntimeDetails),
  toSkill(tmuxUartBridge),
  toSkill(extensionBuildDebugging),
  toSkill(iterativeDeployment),
  toSkill(appDevelopment),
  toSkill(avocadoCliExecution),
  toSkill(upstreamSources),
];

function toSkill(mod: {
  URI: string;
  NAME: string;
  DESCRIPTION: string;
  CONTENT: string;
}): Skill {
  return {
    uri: mod.URI,
    name: mod.NAME,
    description: mod.DESCRIPTION,
    content: mod.CONTENT,
  };
}

export function registerSkillResources(server: McpServer): void {
  for (const skill of SKILLS) {
    server.resource(
      skill.name,
      skill.uri,
      { description: skill.description, mimeType: "text/markdown" },
      async () => ({
        contents: [
          {
            uri: skill.uri,
            text: skill.content,
            mimeType: "text/markdown",
          },
        ],
      }),
    );
  }
}
