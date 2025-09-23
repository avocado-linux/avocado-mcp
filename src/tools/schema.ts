import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerSchemaTools(server: McpServer) {
  server.tool(
    "get-schema-info",
    "Get JSON schemas specifying the Avocado config structure",
    {},
    async () => {
      const schemaRepo = "https://github.com/avocado-linux/avocado-config";

      const output = `# Avocado JSON Configuration Schemas

**CRITICAL:** This tool should be used FIRST before any configuration generation. The schema defines all valid properties, targets, and constraints.

**Official Repository:** ${schemaRepo}

## Reference Examples
**Official Examples:** https://github.com/avocado-linux/avocado-os/tree/main/references
- Browse reference configurations to understand real-world patterns
- Study production-ready configuration examples
- Use these as templates alongside schema validation

## Schema-First Workflow
**MANDATORY:** Download and parse the JSON schema BEFORE generating any Avocado configuration.

## Schema Purpose
- **JSON Schema Definition:** Formal specification of Avocado configuration structure
- **Config Validation:** Define valid configuration properties and types
- **Structure Documentation:** Canonical reference for config format
- **Valid Targets:** Authoritative list of supported target platforms
- **Required Properties:** Specifies which configuration properties are mandatory

## Key Resources
- **JSON Schema Files:** Machine-readable configuration structure definitions
- **Tagged Versions:** Stable schema releases for production use
- **Validation Rules:** Official configuration property validation
- **Documentation:** Schema reference and configuration examples

## Usage Priority
**ALWAYS START HERE:** Before any configuration work:
1. Download the appropriate JSON schema version
2. Parse schema to understand valid targets and required properties
3. Reference schema throughout configuration generation
4. Validate final configuration against the schema

## Recommended Approach
1. Browse ${schemaRepo}/tags to find available schema versions
2. Navigate to a specific tag (e.g., 1.0.0) or use main branch
3. Look for JSON schema files in the repository (likely named avocado-config.json or similar)
4. Use GitHub's raw content URLs to download the schema file
5. Example: https://raw.githubusercontent.com/avocado-linux/avocado-config/1.0.0/schema.json

## Schema File Discovery
- Schema files are typically JSON format with .json extension
- Look in the root directory or a schemas/ subdirectory
- Check the repository README for schema file locations
- Use GitHub's file browser to locate schema files`;

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
    "get-schema-download-info",
    "Get information on how to discover and download Avocado configuration schemas from GitHub - USE THIS FIRST",
    {},
    async () => {
      const output = `# How to Discover and Download Avocado Configuration Schemas

**WARNING:** This tool should be used FIRST before any configuration generation. Never generate Avocado configurations without downloading and following the JSON schema.

## Reference Examples First
**Browse Examples:** https://github.com/avocado-linux/avocado-os/tree/main/references
- Start by examining reference configurations to understand patterns
- See how real configurations use extensions, dependencies, and targets
- Use examples as templates while ensuring schema compliance

## Schema Repository
**Repository:** https://github.com/avocado-linux/avocado-config

## MANDATORY Schema-First Workflow
**CRITICAL:** Always download and parse the schema BEFORE generating configurations:

### Step 1: Schema Discovery (REQUIRED FIRST)
1. **Browse the repository** to understand the structure
2. **Check tags/releases** for versioned schemas
3. **Look for JSON files** that define the schema structure
4. **Read repository documentation** for schema file locations

### Step 2: Schema Download (REQUIRED)
Use GitHub's raw content URLs:
- **Format:** \`https://raw.githubusercontent.com/avocado-linux/avocado-config/{tag-or-branch}/{schema-file}\`
- **Example:** \`https://raw.githubusercontent.com/avocado-linux/avocado-config/main/schema.json\`
- **Tagged version:** \`https://raw.githubusercontent.com/avocado-linux/avocado-config/1.0.0/schema.json\`

## Typical Schema Locations in Repository
- Root directory: \`avocado-config.json\`, \`schema.json\`
- Schemas directory: \`schemas/avocado-config.json\`
- Versioned files: \`v1/schema.json\`

## Schema Structure to Parse FIRST
When you download a schema, extract these critical elements:
- **properties**: Top-level configuration properties and their types
- **definitions.target.enum**: Valid target platform names (AUTHORITATIVE LIST)
- **examples**: Sample configuration patterns
- **required**: Which properties are mandatory
- **enum values**: Valid choices for specific fields

## Working with Downloaded Schemas
**Parse schema to understand constraints BEFORE generating configs:**
1. Extract valid target names from target enum definition
2. Identify required vs optional properties
3. Understand valid property types and formats
4. Reference examples for common patterns
5. Use schema as source of truth for all configuration decisions

## Dual Validation Required
**Critical:** Avocado configurations must pass TWO validation steps:
1. **TOML Syntax Validation** - Ensure the file is valid TOML format
2. **Schema Validation** - Ensure the structure matches the JSON schema

**Schema-first approach prevents configuration errors - always start here.**

## Complete Workflow
1. **Browse examples:** https://github.com/avocado-linux/avocado-os/tree/main/references for patterns
**Usage workflow:**
1. **Download schema:** Get JSON schema for validation rules
2. **Generate config:** Use examples as templates, follow schema constraints
3. **🚀 Verify packages efficiently:** Use \`prepare-target-databases\` + \`query-databases\` for package verification

**🚀 EFFICIENT PACKAGE VERIFICATION:**
- Use \`prepare-target-databases(["your-target"])\` to prepare all databases automatically
- Use \`query-databases(["your-target"], "SELECT name FROM packages WHERE name LIKE '%search%'")\` to find packages
- Much more efficient than individual downloads and manual database handling

**Note:** Always discover schema files from the actual repository rather than assuming specific URLs.`;

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
    "get-schema-validation-patterns",
    "Get guidance on how to validate configurations against JSON schemas",
    {},
    async () => {
      const output = `# Schema Validation Patterns for Avocado Configurations

## Key Validation Areas

### Required Properties
Check that required top-level properties are present:
- \`default_target\` is typically required
- Validate against the schema's required array

### Target Validation
- Target names must match schema enum values
- Download schema to get current valid target list
- Target appears in multiple places (default_target, supported_targets, runtime sections)

### Extension Structure
- Extension types must be "sysext" or "confext"
- Extension names follow pattern constraints
- Overlay paths should be valid directory references

### Dependency Format
- Dependencies use package name to version mapping
- Version strings follow semantic versioning or "*"
- Package names should exist in target repositories

## Schema-Based Validation Process
1. **Download the JSON schema** from avocado-config repository
2. **Parse the schema** to understand structure and constraints
3. **Check required fields** against the schema's required array
4. **Validate enum values** against schema definitions
5. **Verify data types** match schema property types
6. **Check pattern matching** for names and paths

## Common Validation Issues
- Invalid target names (not in schema enum)
- Missing required properties
- Incorrect extension types
- Malformed dependency specifications
- Invalid TOML syntax

## Dual Validation Strategy
**Step 1: TOML Syntax Validation**
- Parse the configuration as TOML to ensure valid syntax
- Check for proper TOML formatting (strings, arrays, tables)
- Verify TOML-specific rules (key naming, nesting, etc.)

**Step 2: Schema Structure Validation**
Use the downloaded JSON schema as the source of truth for:
- Valid property names and types
- Required vs optional fields
- Enum constraints (targets, extension types)
- Pattern validation for names and paths

**Remember:** Both TOML syntax AND schema structure must be valid.`;

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
