# Avocado OS MCP Server

MCP server for Avocado OS configuration with 2 essential tools for streamlined workflow.

## Essential Tools

### 1. `get-config-schema` - REQUIRED FIRST STEP
- **Purpose:** Acquire the JSON schema for Avocado OS configurations
- **Why Required:** This schema is essential for validating all Avocado configurations and must be obtained before generating any configuration files
- **Parameters:**
  - `version` (optional): Git tag/version to fetch (e.g., 'v1.0.0', 'main'). If not provided, fetches the latest version from main branch
- **Example:** `get-config-schema()` or `get-config-schema({version: "v1.2.0"})`

### 2. `query-repos` - PACKAGE VERIFICATION
- **Purpose:** Perfect for package searches during configuration generation
- **Features:** Execute SQL queries against Avocado OS repository databases with automatic preparation and includes schema information and formatted result tables
- **Parameters:**
  - `targets`: Array of target platforms (e.g., `["jetson-orin-nano-devkit-nvme", "raspberrypi4"]`)
  - `query`: SQL query string (e.g., `"SELECT name FROM packages WHERE name LIKE '%kernel%'"`)
- **Example:** `query-repos(["jetson-orin-nano-devkit-nvme"], "SELECT name FROM packages WHERE name LIKE '%triton%'")`

## Streamlined Workflow

**Essential 3-Step Process:**

1. **Schema First (REQUIRED):** `get-config-schema()` - Download and parse JSON schema
2. **Package Verification:** `query-repos(["your-target"], "SELECT name FROM packages WHERE name LIKE '%search%'")` - Verify packages exist
3. **Configuration Generation:** Create YAML configuration (avocado.yaml) using schema structure with verified packages only

## Installation

Install via npx (no clone required):

```json
{
  "mcpServers": {
    "avocado-os": {
      "command": "npx",
      "args": ["-y", "avocado-os-mcp-server"]
    }
  }
}
```

Add the above to your MCP client configuration (e.g., Claude Desktop, Cursor, etc.).

## Common Usage Examples

### Get Latest Schema
```
get-config-schema()
```

### Get Specific Schema Version
```
get-config-schema({version: "v1.0.0"})
```

### Search for Packages
```
query-repos(["jetson-orin-nano-devkit-nvme"], "SELECT name FROM packages WHERE name LIKE '%kernel%'")
```

### Find Development Packages
```
query-repos(["raspberrypi4"], "SELECT name FROM packages WHERE name LIKE '%-devel'")
```

### Get Package Details
```
query-repos(["target"], "SELECT name, summary, version FROM packages WHERE name = 'exact-package-name'")
```

## Key Features

- **Schema-First Approach:** Enforces proper validation against JSON schemas
- **Automatic Database Management:** Handles discovery, download, decompression, and schema introspection
- **Efficient Caching:** Databases persist for multiple queries
- **Target Auto-Discovery:** Automatically fetches valid targets from official repository
- **Rich Query Results:** Formatted tables with complete schema information
- **Error Handling:** Robust error reporting and troubleshooting guidance

## Development

```bash
# Clone the repository
git clone https://github.com/avocado-linux/avocado-mcp.git
cd avocado-mcp

# Install dependencies
npm install

# Build the server
npm run build

# Run in development mode
npm run dev
```

### Testing

```bash
npm run test
```

### Running locally (without npx)

Add to your MCP client config:

```json
{
  "mcpServers": {
    "avocado-os": {
      "command": "node",
      "args": ["/path/to/avocado-mcp/build/index.js"]
    }
  }
}
```

## Documentation

- **Avocado OS:** https://docs.peridio.com/avocado/
- **Configuration Reference:** https://docs.peridio.com/avocado/configuration
- **Schema Repository:** https://github.com/avocado-linux/avocado-config
- **Target Platforms:** https://docs.peridio.com/avocado/targets

## Repository Links

- **Official Repository:** https://repo.avocadolinux.org
- **Targets Configuration:** https://repo.avocadolinux.org/latest/apollo/edge/targets.json
- **Schema Repository:** https://github.com/avocado-linux/avocado-config
- **Example Configurations:** https://github.com/avocado-linux/avocado-os/tree/main/references

## Important Notes

- **Always start with `get-config-schema`** - This is required before any configuration generation
- **Verify packages with `query-repos`** - Never guess package names, always verify they exist
- **Use exact target names** - Target names are case-sensitive and must match exactly
- **Schema validation is dual** - Validate both YAML syntax AND schema compliance
