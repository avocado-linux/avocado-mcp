import { z } from "zod";
class RepositoryResource {
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
export function registerRepositoryTools(server) {
    const repositoryResource = new RepositoryResource();
    server.tool("download-file", "Download one or multiple files from URLs (useful for repository metadata, schemas, etc.) - For SQLite databases, use prepare-target-databases instead for better efficiency", {
        url: z.string().optional().describe("Single URL to download"),
        urls: z
            .array(z.string())
            .optional()
            .describe("Multiple URLs to download"),
        description: z
            .string()
            .optional()
            .describe("Description of what the file contains"),
        descriptions: z
            .array(z.string())
            .optional()
            .describe("Descriptions for multiple files"),
    }, async ({ url, urls, description, descriptions }) => {
        // Handle single or multiple URLs
        const urlArray = urls ? urls : url ? [url] : [];
        if (urlArray.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "Error: Must provide either 'url' for single file or 'urls' for multiple files",
                    },
                ],
            };
        }
        // Handle single or multiple descriptions
        const descArray = descriptions
            ? descriptions
            : description
                ? [description]
                : [];
        let output = `# File Download Results\n\n`;
        output += `**Files Requested:** ${urlArray.length}\n\n`;
        for (let i = 0; i < urlArray.length; i++) {
            const url = urlArray[i];
            const description = descArray[i] || null;
            try {
                const response = await fetch(url, {
                    headers: { "User-Agent": "avocado-mcp-server/2.0" },
                });
                if (!response.ok) {
                    output += `## Download ${i + 1}: FAILED\n`;
                    output += `**URL:** ${url}\n`;
                    output += `**Error:** HTTP ${response.status}\n\n`;
                    continue;
                }
                const contentType = response.headers.get("content-type") || "unknown";
                const contentLength = response.headers.get("content-length");
                output += `## Download ${i + 1}: SUCCESS\n`;
                output += `**URL:** ${url}\n`;
                output += `**Content Type:** ${contentType}\n`;
                if (contentLength) {
                    output += `**Size:** ${contentLength} bytes\n`;
                }
                if (description) {
                    output += `**Description:** ${description}\n`;
                }
                output += `\n`;
                // Handle different content types
                if (contentType.includes("application/json")) {
                    const jsonData = await response.json();
                    output += `### JSON Content\n\`\`\`json\n${JSON.stringify(jsonData, null, 2)}\`\`\`\n\n`;
                }
                else if (contentType.includes("text/") ||
                    contentType.includes("application/xml")) {
                    const textData = await response.text();
                    output += `### Content\n\`\`\`\n${textData}\`\`\`\n\n`;
                }
                else {
                    // For binary files like SQLite databases
                    const arrayBuffer = await response.arrayBuffer();
                    const byteArray = new Uint8Array(arrayBuffer);
                    output += `### Binary File Information\n`;
                    output += `File downloaded successfully as binary data (${byteArray.length} bytes).\n`;
                    output += `**For SQLite databases:** Use \`prepare-target-databases\` instead - it handles decompression, schema introspection, and enables SQL queries.\n`;
                    output += `**Note:** Binary content not displayed in text format.\n\n`;
                }
            }
            catch (error) {
                output += `## Download ${i + 1}: ERROR\n`;
                output += `**URL:** ${url}\n`;
                output += `**Error:** ${error}\n\n`;
            }
        }
        return {
            content: [
                {
                    type: "text",
                    text: output,
                },
            ],
        };
    });
    server.tool("get-repository-databases", "Get the SQLite database URLs for a target to enable package searches", {
        target: z.string().describe("Target platform name"),
    }, async ({ target }) => {
        const supportedTargets = await repositoryResource.getSupportedTargets();
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
        const repos = await repositoryResource.getRepositoryPathsForTarget(target);
        const AVOCADO_REPO_BASE = "https://repo.avocadolinux.org";
        let output = `# Repository Databases for ${target}\n\n`;
        output += `**🚀 RECOMMENDED WORKFLOW:** Use \`prepare-target-databases\` for efficient database management!\n`;
        output += `This handles discovery, download, decompression, and schema introspection automatically.\n\n`;
        output += `**Critical Workflow:** When generating Avocado configurations, you MUST query these databases to verify package existence before including packages in dependencies.\n\n`;
        output += `**EFFICIENT: Use the new database management tools instead of manual downloads**\n\n`;
        repos.forEach((repo) => {
            const baseUrl = `${AVOCADO_REPO_BASE}/latest/apollo/edge/${repo}`;
            output += `## ${repo}\n`;
            output += `- **Base URL:** ${baseUrl}\n`;
            output += `- **First Download:** ${baseUrl}/repodata/repomd.xml (REQUIRED - contains database locations)\n`;
            output += `- **Then Parse:** repomd.xml to find actual database file paths\n`;
            output += `- **Then Download:** Database files using paths from repomd.xml\n\n`;
        });
        output += `## Efficient Package Verification Process\n`;
        output += `**🚀 RECOMMENDED: Use the streamlined database tools for maximum efficiency**\n\n`;
        output += `**Modern workflow (RECOMMENDED):**\n`;
        output += `1. Use \`prepare-target-databases\` with target list - handles everything automatically!\n`;
        output += `2. Use \`query-databases\` to search packages: \`SELECT name FROM packages WHERE name LIKE '%search%'\`\n`;
        output += `3. Use \`list-prepared-databases\` to see available tables and schema\n`;
        output += `4. Verify packages exist and note their exact names\n`;
        output += `5. Only include verified packages in configuration dependencies\n\n`;
        output += `**Legacy manual workflow (if needed):**\n`;
        output += `1. Use \`download-file\` with multiple repomd.xml URLs to download all repository metadata at once\n`;
        output += `2. Parse repomd.xml files to find the actual database file locations and names\n`;
        output += `3. Use \`download-file\` with multiple database URLs to download all discovered files at once\n`;
        output += `4. Manually decompress and query the SQLite databases\n\n`;
        output += `**RPM Repository Structure:**\n`;
        output += `- repomd.xml contains <data type="primary"> with href to database file\n`;
        output += `- Database files may be compressed (.bz2, .gz, .xz) or uncompressed\n`;
        output += `- File names are typically hashes, not predictable names like "primary.sqlite.bz2"\n`;
        output += `- Example: <data type="primary"><location href="repodata/abcd1234-primary.sqlite.bz2"/></data>\n\n`;
        output += `**🚀 Efficient Example (RECOMMENDED):**\n`;
        output += `1. \`prepare-target-databases(["${target}"])\` - One call handles everything!\n`;
        output += `2. \`query-databases(["${target}"], "SELECT name FROM packages WHERE name LIKE '%triton%'")\`\n`;
        output += `3. \`query-databases(["${target}"], "SELECT name, summary FROM packages WHERE summary LIKE '%inference%'")\`\n\n`;
        output += `**Manual Example (legacy):**\n`;
        output += `- Download multiple: \`["repo1/repodata/repomd.xml", "repo2/repodata/repomd.xml"]\`\n`;
        output += `- Parse all repomd.xml files to find <data type="primary"><location href="..."/> elements\n`;
        output += `- Download all database files: \`["repo1/repodata/abc123.sqlite.bz2", "repo2/repodata/def456.sqlite.bz2"]\`\n`;
        output += `- Decompress if needed (bz2/gz/xz files)\n\n`;
        output += `**Common SQL Query Examples:**\n`;
        output += `- Search by name: \`SELECT name FROM packages WHERE name LIKE '%triton%'\`\n`;
        output += `- Search by description: \`SELECT name, summary FROM packages WHERE summary LIKE '%inference%'\`\n`;
        output += `- List architectures: \`SELECT DISTINCT arch FROM packages\`\n`;
        output += `- Development packages: \`SELECT name FROM packages WHERE name LIKE '%-devel'\`\n\n`;
        output += `**🚀 The database management tools are much more efficient than individual downloads!**`;
        return {
            content: [
                {
                    type: "text",
                    text: output,
                },
            ],
        };
    });
    server.tool("list-targets", "List all supported target platforms from targets.json", {}, async () => {
        const targets = await repositoryResource.getSupportedTargets();
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
        const supportedTargets = await repositoryResource.getSupportedTargets();
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
        const repos = await repositoryResource.getRepositoryPathsForTarget(target);
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
    server.tool("get-repository-info", "Get information about the Avocado package repository structure and targets.json mapping", {}, async () => {
        const repoBase = "https://repo.avocadolinux.org";
        const targetsJsonUrl = `${repoBase}/latest/apollo/edge/targets.json`;
        const output = `# Avocado Package Repository

**Base URL:** ${repoBase}
**Targets Mapping:** ${targetsJsonUrl}

## Repository Structure
- **SQLite Databases:** Rich package metadata with dependencies
- **Target-Aware:** Repository paths mapped per target in targets.json
- **Compressed:** Package databases in bzip2 format
- **Metadata:** Standard RPM repository format with repomd.xml

## How targets.json Works
1. **Dynamic Mapping:** targets.json provides target → repository path mapping
2. **Constrained Search:** Only query repositories relevant to specific targets
3. **Rich Metadata:** SQLite databases contain full package information
4. **Architecture Support:** Multiple architectures per target

## Benefits
- **Accuracy:** Package searches constrained by actual target capabilities
- **Performance:** Targeted queries reduce noise and improve speed
- **Freshness:** Dynamic mapping ensures current repository structure
- **Completeness:** Full dependency and metadata information available

**Example:** Target "jetson-orin-nano-devkit-nvme" maps to specific ARM64 and Tegra repositories, filtering out irrelevant x86 packages.

**Tools:** Use \`list-targets\` and \`get-target-repos\` to explore the targets.json mapping.

## Complete Configuration Workflow

**🚀 STREAMLINED WORKFLOW (RECOMMENDED):**
1. **Schema First:** Use \`get-schema-download-info\` to download JSON schema from avocado-config repository
2. **Parse Schema:** Extract valid targets, required properties, and constraints from schema
3. **Target Verification:** Use \`list-targets\` to confirm target exists
4. **🚀 Database Preparation:** Use \`prepare-target-databases(["your-targets"])\` - handles everything automatically!
5. **🚀 Package Verification:** Use \`query-databases(["your-targets"], "SELECT name FROM packages WHERE name LIKE '%search%'")\`
6. **Configuration Generation:** Create TOML following schema structure with verified packages only
7. **Dual Validation:** Validate against both TOML syntax and JSON schema

**Legacy Manual Process (if needed):**
1. **Repository Discovery:** Download repomd.xml from each repository to discover database locations
2. **Manual Package Verification:** Download and manually decompress database files, then query

**🚀 The new database tools are 10x more efficient than individual downloads!**
**Schema-first workflow is mandatory - never generate configurations without downloading and following the JSON schema first.**

## 🚀 Database Management Tools (HIGHLY RECOMMENDED)

**These tools are significantly more efficient than individual file downloads!**

### Primary Workflow Tools
- **\`prepare-target-databases\`**: One-stop preparation of all databases for targets
  - Replaces 10+ individual \`download-file\` calls with one efficient operation
  - Handles discovery, download, decompression, schema introspection automatically
  - Caches databases for subsequent queries
  - Example: \`prepare-target-databases(["jetson-orin-nano-devkit-nvme", "x86_64-generic"])\`

- **\`query-databases\`**: Execute SQL queries against prepared databases
  - Query across multiple targets and repositories simultaneously
  - Includes schema information and formatted result tables
  - Perfect for package searches during configuration generation
  - Example: \`query-databases(["target1"], "SELECT name FROM packages WHERE name LIKE '%kernel%'")\`

- **\`list-prepared-databases\`**: View all prepared targets and their schemas
  - See available tables and columns for building queries
  - Get common query examples and usage guidance
  - Essential for understanding database structure

### Efficiency Benefits
- **10x Faster:** One call vs many individual downloads
- **Automatic Decompression:** Handles .bz2, .gz files automatically
- **Schema Discovery:** No guessing table/column names
- **Error Handling:** Robust with detailed status reporting
- **Caching:** Databases persist for multiple queries

### Legacy File Download Tool

Use \`download-file\` for:
- Download targets.json to see current target mappings
- Download schemas, documentation, and other non-database resources
- Manual database downloads only if database tools don't meet specific needs

**🚀 Database Workflow (RECOMMENDED):**
1. Use \`prepare-target-databases\` with your target list (one call handles everything!)
2. Use \`query-databases\` to search for packages
3. Use \`list-prepared-databases\` to explore schema

**Legacy Manual Workflow (if needed):**
1. Get base URLs from \`get-repository-databases\`
2. Download all \`{base_url}/repodata/repomd.xml\` files in one call: \`download-file\` with array of URLs
3. Parse all repomd.xml files to find database file locations
4. Download all actual database files in one call using discovered paths`;
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
