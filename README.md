# Avocado OS MCP Server

MCP server for Avocado OS configuration and package management with **efficient database management** for streamlined package verification.

## 🚀 New Features

### Efficient Database Management
- **`prepare-target-databases`**: One-stop preparation of all SQLite databases for targets
  - Handles discovery, download, decompression, and schema introspection automatically
  - Replaces 10+ individual file downloads with one efficient operation
  - Example: `prepare-target-databases(["jetson-orin-nano-devkit-nvme", "x86_64-generic"])`

- **`query-databases`**: Execute SQL queries against prepared databases
  - Query across multiple targets and repositories simultaneously
  - Perfect for package searches during configuration generation
  - Example: `query-databases(["target"], "SELECT name FROM packages WHERE name LIKE '%kernel%'")`

- **`list-prepared-databases`**: View all prepared targets and their schemas
  - Essential for understanding database structure and building queries

### Benefits
- **10x More Efficient**: One call vs many individual downloads
- **Automatic Decompression**: Handles .bz2, .gz files automatically  
- **Schema Discovery**: No guessing table/column names
- **Robust Error Handling**: Detailed status reporting
- **Persistent Caching**: Databases persist for multiple queries

## Installation

```bash
# either ssh
git clone git@github.com:avocado-linux/avocado-mcp.git
# or https
git clone https://github.com/avocado-linux/avocado-mcp.git

# then
cd avocado-mcp
npm install
npm run build
```

## Usage

### Recommended Workflow
1. **Schema First**: Use `get-schema-download-info` to get JSON schema
2. **Target Verification**: Use `list-targets` to confirm target exists
3. **🚀 Database Preparation**: Use `prepare-target-databases(["your-targets"])` - handles everything automatically!
4. **🚀 Package Verification**: Use `query-databases(["your-targets"], "SELECT name FROM packages WHERE name LIKE '%search%'")` 
5. **Configuration Generation**: Create TOML with verified packages only

Add to your Claude Desktop config:

```json
{
  "mcpServers": {
    "avocado-mcp": {
      "command": "node",
      "args": ["/path/to/avocado-mcp/build/index.js"]
    }
  }
}
```

## Development

```bash
npm install
npm run build
npm run dev
```
