import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import Database from "better-sqlite3";
import * as path from "path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
} from "fs";
import * as xml2js from "xml2js";

interface TargetsConfig {
  [targetName: string]: string[];
}

interface DatabaseInfo {
  target: string;
  repo: string;
  dbPath: string;
  originalUrl: string;
  tables: string[];
  schema: Record<string, string[]>;
}

interface RepoMetadata {
  primaryDb?: string;
  otherDb?: string;
  updateinfoDb?: string;
}

class DatabaseManager {
  private targetsCache: TargetsConfig | null = null;
  private targetsCacheExpiry: number = 0;
  private readonly CACHE_TTL = 10 * 60 * 1000; // 10 minutes
  private readonly AVOCADO_REPO_BASE = "https://repo.avocadolinux.org";
  private readonly CACHE_DIR = path.join(process.cwd(), ".avocado-cache");
  private preparedDatabases = new Map<string, DatabaseInfo[]>();

  constructor() {
    // Ensure cache directory exists
    if (!existsSync(this.CACHE_DIR)) {
      mkdirSync(this.CACHE_DIR, { recursive: true });
    }
  }

  async getTargetsConfig(): Promise<TargetsConfig | null> {
    const now = Date.now();

    if (this.targetsCache && now < this.targetsCacheExpiry) {
      return this.targetsCache;
    }

    try {
      const TARGETS_JSON_URL =
        "https://repo.avocadolinux.org/latest/apollo/edge/targets.json";
      const response = await fetch(TARGETS_JSON_URL, {
        headers: { "User-Agent": "avocado-mcp-server" },
      });

      if (!response.ok) {
        console.error(
          `[ERROR] Failed to fetch targets.json: HTTP ${response.status}`,
        );
        return null;
      }

      const targetsData = (await response.json()) as TargetsConfig;
      this.targetsCache = targetsData;
      this.targetsCacheExpiry = now + this.CACHE_TTL;
      return targetsData;
    } catch (error) {
      console.error(`[ERROR] Failed to fetch targets configuration:`, error);
      return null;
    }
  }

  async getRepositoryPathsForTarget(target: string): Promise<string[]> {
    const targetsConfig = await this.getTargetsConfig();
    if (!targetsConfig || !targetsConfig[target]) {
      return [];
    }
    return targetsConfig[target];
  }

  private async downloadFile(
    url: string,
    outputPath: string,
  ): Promise<{ contentLength: string; contentType: string }> {
    if (existsSync(outputPath)) {
      const stats = statSync(outputPath);
      return {
        contentLength: stats.size.toString(),
        contentType: "cached",
      };
    }

    const response = await fetch(url, {
      headers: { "User-Agent": "avocado-mcp-server/3.0" },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const buffer = await response.arrayBuffer();
    writeFileSync(outputPath, Buffer.from(buffer));

    return {
      contentLength:
        response.headers.get("content-length") || buffer.byteLength.toString(),
      contentType: response.headers.get("content-type") || "unknown",
    };
  }

  private async decompressFile(
    inputPath: string,
    outputPath: string,
  ): Promise<{
    originalSize: number;
    decompressedSize: number;
    fileHeader: string;
  }> {
    if (existsSync(outputPath)) {
      const inputStats = statSync(inputPath);
      const outputStats = statSync(outputPath);
      return {
        originalSize: inputStats.size,
        decompressedSize: outputStats.size,
        fileHeader: "cached",
      };
    }

    const inputBuffer = readFileSync(inputPath);
    const fileHeader = inputBuffer.slice(0, 4).toString("hex");

    let decompressedBuffer: Buffer;

    if (inputPath.endsWith(".bz2")) {
      const bzip2Module = await import("bzip2");
      const bzip2 = bzip2Module.default || bzip2Module;
      const uint8Array = new Uint8Array(inputBuffer);
      const bitstream = bzip2.array(uint8Array);
      const decompressedBytes = bzip2.simple(bitstream);
      decompressedBuffer = Buffer.from(decompressedBytes);
    } else if (inputPath.endsWith(".gz")) {
      const zlib = await import("zlib");
      decompressedBuffer = zlib.gunzipSync(inputBuffer);
    } else {
      throw new Error(`Unsupported compression format for ${inputPath}`);
    }

    writeFileSync(outputPath, decompressedBuffer);

    // Validate that the decompressed file is a SQLite database
    const sqliteHeader = decompressedBuffer.slice(0, 16).toString("utf8");
    if (!sqliteHeader.startsWith("SQLite format 3")) {
      throw new Error(
        `Decompressed file is not a valid SQLite database. Header: ${sqliteHeader.slice(0, 16).replace(/\0/g, "\\0")}`,
      );
    }

    return {
      originalSize: inputBuffer.length,
      decompressedSize: decompressedBuffer.length,
      fileHeader,
    };
  }

  private async parseRepomd(xmlContent: string): Promise<RepoMetadata> {
    const result = await xml2js.parseStringPromise(xmlContent, {
      explicitArray: false,
    });
    const repomd = result.repomd;
    const metadata: RepoMetadata = {};

    if (repomd && repomd.data) {
      const dataArray = Array.isArray(repomd.data)
        ? repomd.data
        : [repomd.data];

      for (const data of dataArray) {
        if (data.$.type === "primary_db") {
          metadata.primaryDb = data.location.$.href;
        } else if (data.$.type === "other") {
          metadata.otherDb = data.location.$.href;
        } else if (data.$.type === "updateinfo") {
          metadata.updateinfoDb = data.location.$.href;
        }
      }
    }

    return metadata;
  }

  private async introspectDatabase(
    dbPath: string,
  ): Promise<{ tables: string[]; schema: Record<string, string[]> }> {
    // Validate file exists and is a SQLite database
    if (!existsSync(dbPath)) {
      throw new Error(`Database file does not exist: ${dbPath}`);
    }

    const fileHeader = readFileSync(dbPath).slice(0, 16).toString("utf8");
    if (!fileHeader.startsWith("SQLite format 3")) {
      throw new Error(
        `File is not a valid SQLite database: ${dbPath}. Header: ${fileHeader.replace(/\0/g, "\\0")}`,
      );
    }

    const db = new Database(dbPath, { readonly: true });
    const schema: Record<string, string[]> = {};

    try {
      const tablesResult = db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'",
        )
        .all() as Array<{ name: string }>;

      const tables = tablesResult.map((row) => row.name);

      for (const tableName of tables) {
        const columnsResult = db
          .prepare(`PRAGMA table_info(${tableName})`)
          .all() as Array<{ name: string }>;
        schema[tableName] = columnsResult.map((col) => col.name);
      }

      return { tables, schema };
    } finally {
      db.close();
    }
  }

  async prepareTargetDatabases(
    targets: string[],
  ): Promise<
    { target: string; success: boolean; dbCount: number; error?: string }[]
  > {
    const results: {
      target: string;
      success: boolean;
      dbCount: number;
      error?: string;
    }[] = [];

    for (const target of targets) {
      const repos = await this.getRepositoryPathsForTarget(target);
      if (repos.length === 0) {
        results.push({
          target,
          success: false,
          dbCount: 0,
          error: `No repositories found for target "${target}". Check if target exists in targets.json.`,
        });
        continue;
      }

      const databasesForTarget: DatabaseInfo[] = [];
      const errors: string[] = [];

      for (const repo of repos) {
        try {
          const baseUrl = `${this.AVOCADO_REPO_BASE}/latest/apollo/edge/${repo}`;
          const repomdUrl = `${baseUrl}/repodata/repomd.xml`;

          // Download repomd.xml
          const repomdPath = path.join(
            this.CACHE_DIR,
            `${target}-${repo.replace(/\//g, "_")}-repomd.xml`,
          );
          await this.downloadFile(repomdUrl, repomdPath);

          // Parse repomd.xml
          const repomdContent = readFileSync(repomdPath, "utf8");
          const metadata = await this.parseRepomd(repomdContent);

          if (metadata.primaryDb) {
            const dbUrl = `${baseUrl}/${metadata.primaryDb}`;
            const compressedDbPath = path.join(
              this.CACHE_DIR,
              `${target}-${repo.replace(/\//g, "_")}-primary${path.extname(metadata.primaryDb)}`,
            );
            const dbPath = path.join(
              this.CACHE_DIR,
              `${target}-${repo.replace(/\//g, "_")}-primary.db`,
            );

            // Download database
            await this.downloadFile(dbUrl, compressedDbPath);

            // Decompress if needed
            if (
              metadata.primaryDb.endsWith(".bz2") ||
              metadata.primaryDb.endsWith(".gz")
            ) {
              await this.decompressFile(compressedDbPath, dbPath);
            } else {
              renameSync(compressedDbPath, dbPath);
            }

            // Introspect database
            const { tables, schema } = await this.introspectDatabase(dbPath);

            const dbInfo: DatabaseInfo = {
              target,
              repo,
              dbPath,
              originalUrl: dbUrl,
              tables,
              schema,
            };

            databasesForTarget.push(dbInfo);
          } else {
            errors.push(`${repo}: No primary database found in repomd.xml`);
          }
        } catch (error) {
          errors.push(`${repo}: ${error}`);
        }
      }

      this.preparedDatabases.set(target, databasesForTarget);

      if (databasesForTarget.length > 0) {
        results.push({
          target,
          success: true,
          dbCount: databasesForTarget.length,
        });
      } else {
        const errorMsg =
          errors.length > 0
            ? errors.join("; ")
            : "Unknown error preparing databases";
        results.push({ target, success: false, dbCount: 0, error: errorMsg });
      }
    }

    return results;
  }

  async queryDatabases(
    targets: string[],
    sqlQuery: string,
  ): Promise<{ summary: string; results: any[] }> {
    // Ensure databases are prepared first
    const preparationResults = await this.prepareTargetDatabases(targets);

    let output = `# Database Query Results\n\n`;
    output += `**Query:** \`${sqlQuery}\`\n\n`;

    // Show preparation status
    output += `## Database Preparation Status\n\n`;
    for (const result of preparationResults) {
      if (result.success) {
        output += `✅ **${result.target}:** ${result.dbCount} databases prepared\n`;
      } else {
        output += `❌ **${result.target}:** ${result.error}\n`;
      }
    }
    output += `\n`;

    const allResults: any[] = [];
    let totalDatabases = 0;
    let successfulQueries = 0;

    for (const target of targets) {
      const databases = this.preparedDatabases.get(target);

      if (!databases || databases.length === 0) {
        output += `## Target: ${target}\n`;
        output += `❌ No databases available for querying. See preparation status above.\n\n`;
        continue;
      }

      output += `## Target: ${target}\n\n`;

      for (const dbInfo of databases) {
        totalDatabases++;
        output += `### Repository: ${dbInfo.repo}\n`;

        try {
          if (!existsSync(dbInfo.dbPath)) {
            output += `❌ Database file not found: ${dbInfo.dbPath}\n\n`;
            continue;
          }

          const db = new Database(dbInfo.dbPath, { readonly: true });

          try {
            const stmt = db.prepare(sqlQuery);
            const results = stmt.all();
            successfulQueries++;

            output += `✅ Query successful - ${results.length} rows returned\n`;

            if (results.length > 0) {
              output += `\n**Sample Results (first 5 rows):**\n`;
              const sampleResults = results.slice(0, 5);

              // Create a simple table format
              if (sampleResults.length > 0) {
                const columns = Object.keys(sampleResults[0] as object);
                output += `| ${columns.join(" | ")} |\n`;
                output += `|${columns.map(() => "---").join("|")}|\n`;

                for (const row of sampleResults) {
                  output += `| ${columns.map((col) => (row as any)[col] || "").join(" | ")} |\n`;
                }
              }

              allResults.push(...results);
            }
          } finally {
            db.close();
          }
        } catch (error) {
          output += `❌ Query failed: ${error}\n`;
        }

        output += `\n`;
      }
    }

    output += `## Summary\n`;
    output += `- **Targets queried:** ${targets.length}\n`;
    output += `- **Databases processed:** ${totalDatabases}\n`;
    output += `- **Successful queries:** ${successfulQueries}\n`;
    output += `- **Total results:** ${allResults.length}\n\n`;

    if (allResults.length > 0) {
      output += `## Available Schema Information\n`;
      output += `Use these table and column names in your queries:\n\n`;

      for (const target of targets) {
        const databases = this.preparedDatabases.get(target);
        if (databases) {
          for (const dbInfo of databases) {
            output += `### ${target} - ${dbInfo.repo}\n`;
            for (const [tableName, columns] of Object.entries(dbInfo.schema)) {
              output += `**${tableName}:** ${columns.join(", ")}\n`;
            }
            output += `\n`;
          }
        }
      }
    }

    return {
      summary: output,
      results: allResults,
    };
  }
}

export function registerConsolidatedTools(server: McpServer) {
  const databaseManager = new DatabaseManager();

  server.tool(
    "get-config-schema",
    "REQUIRED: Acquire the JSON schema for Avocado OS configurations. This schema is essential for validating all Avocado configurations and must be obtained before generating any configuration files.",
    {
      version: z
        .string()
        .optional()
        .describe(
          "Git tag/version to fetch (e.g., 'v1.0.0', 'main'). If not provided, fetches the latest version from main branch",
        ),
    },
    async ({ version }) => {
      try {
        const schemaVersion = version || "main";

        // Fetch schema from avocado-config.json
        const schemaUrl = `https://raw.githubusercontent.com/avocado-linux/avocado-config/${schemaVersion}/avocado-config.json`;

        const response = await fetch(schemaUrl, {
          headers: { "User-Agent": "avocado-mcp-server" },
        });

        if (!response.ok) {
          throw new Error(
            `Schema not found for version '${schemaVersion}'. HTTP ${response.status}: ${response.statusText}`,
          );
        }

        const schema = await response.json();

        return {
          content: [
            {
              type: "text",
              text: `# Avocado OS Configuration Schema\n\n**Version:** ${schemaVersion}\n**Source:** ${schemaUrl}\n\nThis schema is **REQUIRED** for validating Avocado OS configurations. Use it to ensure your YAML configurations (avocado.yaml) meet all structural and constraint requirements.\n\n## Key Validation Points\n\n- **Required Properties:** Ensure all required top-level properties are present\n- **Target Validation:** Target names must match schema enum values\n- **Extension Types:** Must be "sysext" or "confext"\n- **Dependencies:** Use exact package names verified through query-repos\n- **Data Types:** All values must match schema type definitions\n\n## Schema Content\n\n\`\`\`json\n${JSON.stringify(schema, null, 2)}\n\`\`\``,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# Schema Fetch Error\n\n❌ **Failed to fetch schema:** ${error}\n\n## Troubleshooting\n\n1. **Check version:** Ensure the version/tag exists in the repository\n2. **Try main branch:** Use no version parameter to fetch from main\n3. **Manual download:** Visit https://github.com/avocado-linux/avocado-config to browse available schema files\n\n## Available Actions\n\n- Retry with no version parameter for latest\n- Check GitHub repository for available tags\n- Verify network connectivity`,
            },
          ],
        };
      }
    },
  );

  server.tool(
    "query-repos",
    "Perfect for package searches during configuration generation. Execute SQL queries against Avocado OS repository databases with automatic preparation and includes schema information and formatted result tables.",
    {
      targets: z
        .array(z.string())
        .describe(
          "List of target platforms to query databases for (e.g., ['jetson-orin-nano-devkit-nvme', 'raspberrypi4'])",
        ),
      query: z
        .string()
        .describe(
          "SQL query to execute against the package databases (e.g., \"SELECT name FROM packages WHERE name LIKE '%kernel%'\")",
        ),
    },
    async ({ targets, query }) => {
      try {
        const result = await databaseManager.queryDatabases(targets, query);
        return {
          content: [
            {
              type: "text",
              text: result.summary,
            },
            {
              type: "text",
              text: `\n## Complete Results\n\n${JSON.stringify(result.results, null, 2)}`,
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: `# Query Execution Error\n\n❌ **Failed to execute query:** ${error}\n\n## Troubleshooting\n\n1. **Check targets:** Ensure target names are valid (fetch from targets.json)\n2. **Verify SQL:** Check query syntax and table/column names\n3. **Network issues:** Ensure connectivity to repository servers\n\n## Common Queries\n\n- Search packages: \`SELECT name FROM packages WHERE name LIKE '%search%'\`\n- List architectures: \`SELECT DISTINCT arch FROM packages\`\n- Package details: \`SELECT name, summary, version FROM packages WHERE name = 'exact-name'\``,
            },
          ],
        };
      }
    },
  );
}
