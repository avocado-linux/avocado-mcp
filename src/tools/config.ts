import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerConfigTools(server: McpServer) {
  server.tool(
    "validate-config-structure",
    "Validate a TOML configuration against both TOML syntax and Avocado schema structure",
    {
      config_content: z
        .string()
        .describe("TOML configuration content to validate"),
    },
    async ({ config_content }) => {
      let output = `# Configuration Validation Results\n\n`;

      output += `## Required Validation Steps\n`;
      output += `**Critical:** Validate both TOML syntax AND schema compliance:\n`;
      output += `1. **TOML Syntax** - Parse as TOML to ensure valid syntax\n`;
      output += `2. **Schema Structure** - Validate against JSON schema from avocado-config repo\n\n`;

      // Basic TOML structure validation
      const requiredSections = ["default_target"];
      const validSections = [
        "default_target",
        "supported_targets",
        "src_dir",
        "runtime",
        "sdk",
        "provision",
        "ext",
      ];
      const deprecatedSections = [
        "system",
        "repositories",
        "services",
        "resources",
      ];

      const lines = config_content.split("\n");
      const foundSections: string[] = [];
      const issues: string[] = [];

      // Note: This is basic structure checking only
      output += `## Basic Structure Check\n`;
      output += `**Note:** This only checks basic structure. You must also:\n`;
      output += `- Parse the content as TOML to validate syntax\n`;
      output += `- Download and validate against the actual JSON schema\n\n`;

      lines.forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          const section = trimmed.slice(1, -1).split(".")[0];
          foundSections.push(section);

          if (deprecatedSections.includes(section)) {
            issues.push(
              `Line ${index + 1}: Section [${section}] is not valid in Avocado schema`,
            );
          } else if (!validSections.includes(section)) {
            issues.push(`Line ${index + 1}: Unknown section [${section}]`);
          }
        }
      });

      // Check for required sections
      requiredSections.forEach((section) => {
        if (!foundSections.includes(section)) {
          issues.push(`Missing required section: ${section}`);
        }
      });

      if (issues.length === 0) {
        output += `✅ **Basic Structure Check Passed**\n\n`;
        output += `The configuration structure appears to follow basic Avocado patterns.\n\n`;
      } else {
        output += `❌ **Structure Issues Found**\n\n`;
        issues.forEach((issue) => {
          output += `- ${issue}\n`;
        });
        output += `\n`;
      }

      output += `## Complete Validation Required\n\n`;
      output += `**TOML Validation:**\n`;
      output += `- Parse the configuration as TOML\n`;
      output += `- Check for TOML syntax errors\n`;
      output += `- Verify proper TOML formatting\n\n`;

      output += `**Schema Validation:**\n`;
      output += `- Download JSON schema from avocado-config repository\n`;
      output += `- Validate property types and constraints\n`;
      output += `- Check enum values (targets, extension types)\n`;
      output += `- Verify required vs optional fields\n\n`;

      if (foundSections.includes("ext")) {
        output += `## Extension Configuration Detected\n\n`;
        output += `Extensions found in configuration. Ensure:\n`;
        output += `- Extension types are "sysext" or "confext"\n`;
        output += `- Overlay directories exist with proper structure\n`;
        output += `- Services listed in enable_services exist in overlay\n`;
      }

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    },
  );

  server.tool(
    "get-config-guidelines",
    "Get style and structure guidelines for Avocado configuration files",
    {},
    async () => {
      const output = `# Avocado Configuration Guidelines

**CRITICAL:** Before generating any Avocado configuration, you MUST follow the schema-first workflow. Never generate configurations without schema validation and package verification.

## Reference Examples
**Official Examples:** https://github.com/avocado-linux/avocado-os/tree/main/references
- Browse reference configurations to understand real-world patterns
- Use these as templates and inspiration for your configurations
- All reference configs follow the official schema and demonstrate best practices

## Mandatory Configuration Workflow

### Step 1: Schema Discovery and Validation (REQUIRED FIRST)
1. Use \`get-schema-download-info\` to learn how to obtain schemas
2. Browse avocado-config repository tags to find appropriate schema version
3. Download JSON schema from GitHub (e.g., https://raw.githubusercontent.com/avocado-linux/avocado-config/1.0.0/schema.json)
4. Parse schema to understand required properties, valid targets, and constraints
5. **Always reference the schema throughout configuration generation**

### Step 2: Target and Repository Discovery
1. Use \`list-targets\` to verify target exists in schema
2. **🚀 RECOMMENDED:** Use \`prepare-target-databases\` to handle all database preparation efficiently

### Step 3: Package Verification (REQUIRED)
**🚀 EFFICIENT WORKFLOW (RECOMMENDED):**
1. Use \`prepare-target-databases(["your-target"])\` - handles discovery, download, decompression automatically
2. Use \`query-databases(["your-target"], "SELECT name FROM packages WHERE name LIKE '%package-name%'")\`
3. Use exact package names from query results in dependencies
4. **Never guess or assume package names exist**

**Legacy Manual Workflow (if needed):**
1. Use \`get-repository-databases\` to get repository URLs for target
2. Download repomd.xml from each repository to discover database locations
3. Download primary.sqlite.bz2 files using paths from repomd.xml
4. Manually decompress and query databases

### Step 4: Configuration Generation and Validation
1. Generate TOML configuration following schema structure
2. Validate TOML syntax is correct
3. Validate against downloaded JSON schema
4. Ensure all property types and constraints are met

## Structure and Style Rules

### File Format
- Use TOML format for all Avocado configuration files
- Maintain consistent indentation (2 spaces recommended)
- Use meaningful property names that reflect their purpose
- Group related configuration properties logically

### Naming Conventions
- Use kebab-case for configuration file names (e.g., \`avocado.toml\`)
- Use kebab-case for property names within the TOML structure
- Choose descriptive names that clearly indicate the property's function
- Avoid abbreviations unless they are widely understood

### Organization Principles
- Structure configurations hierarchically with logical groupings
- Place more critical/frequently modified settings toward the top
- Keep related settings together in the same configuration section
- Use nested objects to group related properties

### Best Practices
- **Verify packages exist before including in dependencies**
- Include only necessary configuration properties
- Provide clear, documented default values where appropriate
- Ensure configurations are environment-agnostic when possible
- Validate all configurations against both TOML syntax and JSON schema

### Schema-First Approach
- **Download and parse the JSON schema BEFORE generating any configuration**
- The schema defines valid targets, required properties, and all constraints
- Use the \`get-schema-download-info\` tool to learn how to get schemas
- Reference schema throughout the entire configuration process
- Validate final configuration against both TOML syntax and JSON schema

### Maintenance
- Keep configurations minimal and focused
- Document any non-obvious configuration choices
- Regularly validate configurations against the latest applicable schema
- Update configurations when migrating between Avocado versions

**Critical Reminder:** Configuration generation without schema-first workflow will result in invalid configurations. Always download schema first, then verify packages, then generate configuration.`;

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    },
  );

  server.tool(
    "get-extension-patterns",
    "Get information about Avocado extension configuration patterns",
    {},
    async () => {
      const output = `# Avocado Extension Configuration Patterns

**Required Before Using Extensions:** Always verify package dependencies exist in target repositories using \`get-repository-databases\` and SQLite queries.

## Extension Types
- **sysext**: System extensions that provide system-level functionality
- **confext**: Configuration extensions that provide configuration files

## Basic Extension Structure
\`\`\`toml
[ext.extension-name]
types = ["sysext"]              # Required: extension type(s)
overlay = "./path/to/overlay"   # Directory with files to overlay
enable_services = ["service.service"]  # Optional: systemd services to enable
dependencies = {               # Optional: package dependencies
  "required-package" = "*"
}
\`\`\`

## Extension Overlay Directory Structure
The overlay directory should mirror the target filesystem structure:
\`\`\`
overlay/
├── etc/                      # Configuration files
│   ├── systemd/
│   └── app-config/
├── usr/
│   ├── bin/                  # Executables
│   └── lib/
│       └── systemd/
│           └── system/       # Systemd unit files
└── opt/                      # Application-specific files
\`\`\`

## Common Extension Use Cases
- **Service Extensions**: Add custom services with systemd units
- **Configuration Extensions**: Overlay config files without system changes
- **Application Extensions**: Bundle applications with their dependencies
- **Development Extensions**: Add development tools and debugging utilities

## Package Dependency Verification

**Before adding any packages to extension dependencies:**

**🚀 EFFICIENT WORKFLOW (RECOMMENDED):**
1. Use \`prepare-target-databases(["your-target"])\` to prepare all databases automatically
2. Use \`query-databases(["your-target"], "SELECT name FROM packages WHERE name LIKE '%search%'")\` to search packages
3. Verify package names exist before including them
4. Use exact package names from database results

**Legacy Manual Workflow (if needed):**
1. Use \`get-repository-databases\` to get SQLite database URLs
2. Download and query package databases for your target
3. Verify package names exist before including them
4. Use exact package names from database results

## Reference Examples
**Official Examples:** https://github.com/avocado-linux/avocado-os/tree/main/references
- Browse reference configurations for real extension usage patterns
- Study how extensions are structured in production configurations
- Use reference examples as templates for your own extensions

Use this pattern information to structure extensions for any use case, but always verify packages exist first.`;

      return {
        content: [
          {
            type: "text",
            text: output,
          },
        ],
      };
    },
  );
}
