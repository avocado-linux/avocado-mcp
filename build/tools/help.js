export function registerHelpTools(server) {
    server.tool("explain-core-resources", "Explain the four core resources this MCP server provides", {}, async () => {
        const targetsJsonUrl = "https://repo.avocadolinux.org/latest/apollo/edge/targets.json";
        const configRepo = "https://github.com/avocado-linux/avocado-config";
        const docsBase = "https://docs.peridio.com";
        const repoBase = "https://repo.avocadolinux.org";
        const output = `# Avocado MCP Server Core Resources

This server provides access to four key resources for Avocado OS development:

## 1. Dynamic Target Configuration (targets.json)
**Location:** ${targetsJsonUrl}
**Purpose:** Real-time mapping of hardware targets to repository paths
**Benefit:** Constrains package searches to only relevant repositories

## 2. Official Configuration Schema
**Location:** ${configRepo}
**Purpose:** Canonical avocado.toml structure and validation
**Benefit:** Ensures configuration compliance with official standards

## 3. Comprehensive Documentation
**Location:** ${docsBase}
**Purpose:** Official guides, references, and integration documentation
**Benefit:** Authoritative and up-to-date information source

## 4. Package Repository with SQLite Metadata
**Location:** ${repoBase}
**Purpose:** Rich package databases with dependency information
**Benefit:** Target-aware package discovery with full metadata

## Architecture Principle
Rather than duplicating or hardcoding information, this server provides **intelligent access** to these authoritative sources, ensuring accuracy and freshness.

**Use the tools above to explore each resource in detail.**`;
        return {
            content: [
                {
                    type: "text",
                    text: output,
                },
            ],
        };
    });
    server.tool("get-help", "Get general help and overview of available tools", {}, async () => {
        const output = `# Avocado MCP Server

This server provides access to core Avocado OS resources without duplicating official information.

## Available Tools

### Core Resources
- **list-targets** - List all supported target platforms from targets.json
- **get-target-repos** - Get repository paths for a specific target
- **get-schema-info** - Get information about the official configuration schema
- **get-docs-info** - Get links to official documentation
- **get-repository-info** - Learn about the package repository structure

### Help
- **explain-core-resources** - Detailed explanation of the four core resources
- **get-help** - This help message

## Quick Examples

### List Available Targets
\`\`\`
list-targets
\`\`\`

### Get Repository Paths for a Target
\`\`\`
get-target-repos target="jetson-orin-nano-devkit-nvme"
\`\`\`

### Learn About Configuration Schema
\`\`\`
get-schema-info
\`\`\`

## Key Principle
This server provides **intelligent access** to official Avocado OS resources rather than duplicating information, ensuring you always get accurate and up-to-date data from authoritative sources.`;
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
