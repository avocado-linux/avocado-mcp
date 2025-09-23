import { z } from "zod";
class TargetsResource {
    targetsCache = null;
    targetsCacheExpiry = 0;
    CACHE_TTL = 10 * 60 * 1000; // 10 minutes
    async getTargetsConfig() {
        const now = Date.now();
        if (this.targetsCache && now < this.targetsCacheExpiry) {
            return this.targetsCache;
        }
        try {
            const TARGETS_JSON_URL = "https://repo.avocadolinux.org/latest/apollo/edge/targets.json";
            const response = await fetch(TARGETS_JSON_URL, {
                headers: { "User-Agent": "avocado-mcp-server/2.0" },
            });
            if (!response.ok) {
                console.error(`[ERROR] Failed to fetch targets.json: HTTP ${response.status}`);
                return null;
            }
            const targetsData = (await response.json());
            this.targetsCache = targetsData;
            this.targetsCacheExpiry = now + this.CACHE_TTL;
            return targetsData;
        }
        catch (error) {
            console.error(`[ERROR] Failed to fetch targets configuration:`, error);
            return null;
        }
    }
    async getSupportedTargets() {
        const targetsConfig = await this.getTargetsConfig();
        return targetsConfig ? Object.keys(targetsConfig) : [];
    }
    async getRepositoryPathsForTarget(target) {
        const targetsConfig = await this.getTargetsConfig();
        if (!targetsConfig || !targetsConfig[target]) {
            return [];
        }
        return targetsConfig[target];
    }
}
export function registerTargetsTools(server) {
    const targetsResource = new TargetsResource();
    server.tool("list-targets", "List all supported target platforms from targets.json", {}, async () => {
        const targets = await targetsResource.getSupportedTargets();
        if (targets.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No targets available. Repository may be unreachable.",
                    },
                ],
            };
        }
        let output = "# Avocado OS Targets\n\n";
        output += `**Source:** https://repo.avocadolinux.org/latest/apollo/edge/targets.json\n`;
        output += `**Total Targets:** ${targets.length}\n\n`;
        targets.forEach((target) => {
            output += `- \`${target}\`\n`;
        });
        return {
            content: [
                {
                    type: "text",
                    text: output,
                },
            ],
        };
    });
    server.tool("get-target-repos", "Get repository paths for a specific target from targets.json mapping", {
        target: z.string().describe("Target platform name"),
    }, async ({ target }) => {
        const supportedTargets = await targetsResource.getSupportedTargets();
        if (!supportedTargets.includes(target)) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Invalid target "${target}". Supported targets:\n${supportedTargets.map((t) => `- ${t}`).join("\n")}`,
                    },
                ],
            };
        }
        const repos = await targetsResource.getRepositoryPathsForTarget(target);
        const AVOCADO_REPO_BASE = "https://repo.avocadolinux.org";
        let output = `# Repository Paths for ${target}\n\n`;
        output += `**Source:** targets.json mapping\n`;
        output += `**Repository Count:** ${repos.length}\n\n`;
        repos.forEach((repo) => {
            output += `- \`${repo}\`\n`;
            output += `  - Full URL: ${AVOCADO_REPO_BASE}/latest/apollo/edge/${repo}\n`;
        });
        output += `\n**Usage:** These paths constrain package searches to only relevant repositories for ${target}.`;
        return {
            content: [
                {
                    type: "text",
                    text: output,
                },
            ],
        };
    });
}
