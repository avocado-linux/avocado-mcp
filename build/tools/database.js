import { z } from "zod";
import Database from "better-sqlite3";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync, } from "fs";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import { parseString } from "xml2js";
import { promisify } from "util";
import path from "path";
import os from "os";
// @ts-ignore - bzip2 doesn't have types
import * as bzip2 from "bzip2";
const parseXML = promisify(parseString);
class DatabaseManager {
    targetsCache = null;
    targetsCacheExpiry = 0;
    CACHE_TTL = 10 * 60 * 1000; // 10 minutes
    AVOCADO_REPO_BASE = "https://repo.avocadolinux.org";
    CACHE_DIR = path.join(os.tmpdir(), "avocado-mcp-databases");
    preparedDatabases = new Map();
    constructor() {
        if (!existsSync(this.CACHE_DIR)) {
            mkdirSync(this.CACHE_DIR, { recursive: true });
        }
    }
    async getTargetsConfig() {
        const now = Date.now();
        if (this.targetsCache && now < this.targetsCacheExpiry) {
            return this.targetsCache;
        }
        try {
            const TARGETS_JSON_URL = `${this.AVOCADO_REPO_BASE}/latest/apollo/edge/targets.json`;
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
    async getRepositoryPathsForTarget(target) {
        const targetsConfig = await this.getTargetsConfig();
        if (!targetsConfig || !targetsConfig[target]) {
            return [];
        }
        return targetsConfig[target];
    }
    async downloadFile(url, destinationPath) {
        const response = await fetch(url, {
            headers: { "User-Agent": "avocado-mcp-server/2.0" },
        });
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} for ${url}`);
        }
        const contentType = response.headers.get("content-type") || "unknown";
        const contentLength = parseInt(response.headers.get("content-length") || "0");
        const fileStream = createWriteStream(destinationPath);
        await pipeline(response.body, fileStream);
        return { contentType, contentLength };
    }
    async decompressFile(sourcePath, destPath) {
        const originalSize = readFileSync(sourcePath).length;
        if (sourcePath.endsWith(".bz2")) {
            // Handle bz2 decompression
            const compressedData = readFileSync(sourcePath);
            const decompressedData = bzip2.decode(compressedData);
            writeFileSync(destPath, decompressedData);
        }
        else if (sourcePath.endsWith(".gz")) {
            // Handle gzip decompression
            const readStream = createReadStream(sourcePath);
            const writeStream = createWriteStream(destPath);
            const decompressor = createGunzip();
            await pipeline(readStream, decompressor, writeStream);
        }
        else if (sourcePath.endsWith(".xz")) {
            // XZ would need external library - for now, provide helpful error
            throw new Error("XZ decompression requires external tools. Please decompress manually or use a different format.");
        }
        else {
            // File is already decompressed, just copy it
            const readStream = createReadStream(sourcePath);
            const writeStream = createWriteStream(destPath);
            await pipeline(readStream, writeStream);
        }
        // Check the decompressed file
        const decompressedData = readFileSync(destPath);
        const decompressedSize = decompressedData.length;
        const fileHeader = decompressedData.subarray(0, 16).toString("hex");
        return { originalSize, decompressedSize, fileHeader };
    }
    async parseRepomd(xmlContent) {
        const result = (await parseXML(xmlContent));
        const metadata = {};
        if (result.repomd && result.repomd.data) {
            for (const data of result.repomd.data) {
                const type = data.$.type;
                const href = data.location?.[0]?.$?.href;
                if (href) {
                    switch (type) {
                        case "primary":
                            metadata.primaryDb = href;
                            break;
                        case "filelists":
                            metadata.filelists = href;
                            break;
                        case "other":
                            metadata.other = href;
                            break;
                    }
                }
            }
        }
        return metadata;
    }
    async introspectDatabase(dbPath) {
        // Check if file exists and get basic info
        if (!existsSync(dbPath)) {
            throw new Error(`Database file does not exist: ${dbPath}`);
        }
        const fileData = readFileSync(dbPath);
        const fileSize = fileData.length;
        const fileHeader = fileData.subarray(0, 16);
        const headerString = fileHeader.toString("utf8");
        const headerHex = fileHeader.toString("hex");
        // SQLite files should start with "SQLite format 3\0"
        if (!headerString.startsWith("SQLite format 3")) {
            throw new Error(`File is not a valid SQLite database. ` +
                `Size: ${fileSize} bytes, ` +
                `Header (text): "${headerString.replace(/\0/g, "\\0")}", ` +
                `Header (hex): ${headerHex}`);
        }
        const db = new Database(dbPath, { readonly: true });
        try {
            const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all();
            const tableNames = tables.map((t) => t.name);
            const schema = {};
            for (const tableName of tableNames) {
                const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
                schema[tableName] = columns.map((c) => c.name);
            }
            return { tables: tableNames, schema };
        }
        finally {
            db.close();
        }
    }
    async prepareTargetDatabases(targets) {
        let output = `# Database Preparation Results\n\n`;
        const allDatabaseInfo = [];
        for (const target of targets) {
            output += `## Target: ${target}\n\n`;
            const repos = await this.getRepositoryPathsForTarget(target);
            if (repos.length === 0) {
                output += `No repositories found for target ${target}\n\n`;
                continue;
            }
            const databasesForTarget = [];
            for (const repo of repos) {
                output += `### Repository: ${repo}\n`;
                try {
                    const baseUrl = `${this.AVOCADO_REPO_BASE}/latest/apollo/edge/${repo}`;
                    const repomdUrl = `${baseUrl}/repodata/repomd.xml`;
                    // Download repomd.xml
                    const repomdPath = path.join(this.CACHE_DIR, `${target}-${repo.replace(/\//g, "_")}-repomd.xml`);
                    const repomdInfo = await this.downloadFile(repomdUrl, repomdPath);
                    output += `- Repomd downloaded: ${repomdInfo.contentLength} bytes, type: ${repomdInfo.contentType}\n`;
                    // Parse repomd.xml
                    const repomdContent = await import("fs").then((fs) => fs.promises.readFile(repomdPath, "utf8"));
                    const metadata = await this.parseRepomd(repomdContent);
                    if (metadata.primaryDb) {
                        const dbUrl = `${baseUrl}/${metadata.primaryDb}`;
                        const compressedDbPath = path.join(this.CACHE_DIR, `${target}-${repo.replace(/\//g, "_")}-primary.db.compressed`);
                        const dbPath = path.join(this.CACHE_DIR, `${target}-${repo.replace(/\//g, "_")}-primary.db`);
                        // Download database
                        const dbDownloadInfo = await this.downloadFile(dbUrl, compressedDbPath);
                        output += `- Database downloaded: ${dbDownloadInfo.contentLength} bytes, type: ${dbDownloadInfo.contentType}\n`;
                        // Decompress if needed
                        if (metadata.primaryDb.endsWith(".bz2") ||
                            metadata.primaryDb.endsWith(".gz") ||
                            metadata.primaryDb.endsWith(".xz")) {
                            try {
                                const decompressionInfo = await this.decompressFile(compressedDbPath, dbPath);
                                output += `✅ Database decompressed successfully\n`;
                                output += `- Original size: ${decompressionInfo.originalSize} bytes\n`;
                                output += `- Decompressed size: ${decompressionInfo.decompressedSize} bytes\n`;
                                output += `- File header: ${decompressionInfo.fileHeader}\n`;
                            }
                            catch (error) {
                                output += `⚠️  Database downloaded but decompression failed: ${error}\n`;
                                output += `File available at: ${compressedDbPath}\n`;
                                output += `You may need to decompress manually using appropriate tools.\n`;
                                continue;
                            }
                        }
                        else {
                            // File is already uncompressed, just rename
                            await import("fs").then((fs) => fs.promises.rename(compressedDbPath, dbPath));
                        }
                        // Introspect database
                        try {
                            const { tables, schema } = await this.introspectDatabase(dbPath);
                            const dbInfo = {
                                target,
                                repo,
                                dbPath,
                                originalUrl: dbUrl,
                                tables,
                                schema,
                            };
                            databasesForTarget.push(dbInfo);
                            allDatabaseInfo.push(dbInfo);
                            output += `✅ Primary database prepared\n`;
                            output += `- Tables: ${tables.join(", ")}\n`;
                            output += `- Path: ${dbPath}\n`;
                        }
                        catch (dbError) {
                            output += `❌ Database introspection failed: ${dbError}\n`;
                            output += `- Database file exists but cannot be read as SQLite\n`;
                            output += `- File path: ${dbPath}\n`;
                            continue;
                        }
                    }
                    else {
                        output += `⚠️  No primary database found in repomd.xml\n`;
                    }
                }
                catch (error) {
                    output += `❌ Error processing repository: ${error}\n`;
                }
                output += `\n`;
            }
            this.preparedDatabases.set(target, databasesForTarget);
        }
        output += `\n## Summary\n`;
        output += `- **Targets processed:** ${targets.length}\n`;
        output += `- **Total databases prepared:** ${allDatabaseInfo.length}\n`;
        output += `- **Cache directory:** ${this.CACHE_DIR}\n\n`;
        output += `## Database Schema Overview\n\n`;
        for (const dbInfo of allDatabaseInfo) {
            output += `### ${dbInfo.target} - ${dbInfo.repo}\n`;
            for (const [tableName, columns] of Object.entries(dbInfo.schema)) {
                output += `**${tableName}:** ${columns.join(", ")}\n`;
            }
            output += `\n`;
        }
        output += `## Next Steps\n`;
        output += `Use the \`query-databases\` tool to run SQL queries against the prepared databases.\n`;
        output += `Example queries:\n`;
        output += `- \`SELECT name FROM packages WHERE name LIKE '%kernel%' LIMIT 10\`\n`;
        output += `- \`SELECT DISTINCT arch FROM packages\`\n`;
        output += `- \`SELECT name, summary FROM packages WHERE summary LIKE '%development%'\`\n`;
        return output;
    }
    async queryDatabases(targets, sqlQuery) {
        let output = `# Database Query Results\n\n`;
        output += `**Query:** \`${sqlQuery}\`\n\n`;
        const allResults = [];
        let totalDatabases = 0;
        let successfulQueries = 0;
        for (const target of targets) {
            const databases = this.preparedDatabases.get(target);
            if (!databases || databases.length === 0) {
                output += `## Target: ${target}\n`;
                output += `❌ No prepared databases found. Run \`prepare-target-databases\` first.\n\n`;
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
                                const columns = Object.keys(sampleResults[0]);
                                output += `| ${columns.join(" | ")} |\n`;
                                output += `|${columns.map(() => "---").join("|")}|\n`;
                                for (const row of sampleResults) {
                                    output += `| ${columns.map((col) => row[col] || "").join(" | ")} |\n`;
                                }
                            }
                            allResults.push(...results);
                        }
                    }
                    finally {
                        db.close();
                    }
                }
                catch (error) {
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
        return output;
    }
    getPreparedTargets() {
        return Array.from(this.preparedDatabases.keys());
    }
    getDatabaseInfo(target) {
        return this.preparedDatabases.get(target);
    }
}
export function registerDatabaseTools(server) {
    const databaseManager = new DatabaseManager();
    server.tool("prepare-target-databases", "Download, decompress, and prepare SQLite databases for one or more targets", {
        targets: z
            .array(z.string())
            .describe("List of target platforms to prepare databases for"),
    }, async ({ targets }) => {
        try {
            const result = await databaseManager.prepareTargetDatabases(targets);
            return {
                content: [
                    {
                        type: "text",
                        text: result,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error preparing databases: ${error}`,
                    },
                ],
            };
        }
    });
    server.tool("query-databases", "Execute SQL queries against prepared databases with schema information", {
        targets: z
            .array(z.string())
            .describe("List of targets to query databases for"),
        query: z.string().describe("SQL query to execute against the databases"),
    }, async ({ targets, query }) => {
        try {
            const result = await databaseManager.queryDatabases(targets, query);
            return {
                content: [
                    {
                        type: "text",
                        text: result,
                    },
                ],
            };
        }
        catch (error) {
            return {
                content: [
                    {
                        type: "text",
                        text: `Error executing query: ${error}`,
                    },
                ],
            };
        }
    });
    server.tool("list-prepared-databases", "List all currently prepared database targets and their schema information", {}, async () => {
        const preparedTargets = databaseManager.getPreparedTargets();
        if (preparedTargets.length === 0) {
            return {
                content: [
                    {
                        type: "text",
                        text: "No databases currently prepared. Use `prepare-target-databases` first.",
                    },
                ],
            };
        }
        let output = `# Prepared Database Targets\n\n`;
        output += `**Total Targets:** ${preparedTargets.length}\n\n`;
        for (const target of preparedTargets) {
            const databases = databaseManager.getDatabaseInfo(target);
            if (databases) {
                output += `## Target: ${target}\n`;
                output += `**Databases:** ${databases.length}\n\n`;
                for (const dbInfo of databases) {
                    output += `### Repository: ${dbInfo.repo}\n`;
                    output += `- **Path:** ${dbInfo.dbPath}\n`;
                    output += `- **Original URL:** ${dbInfo.originalUrl}\n`;
                    output += `- **Tables:** ${dbInfo.tables.join(", ")}\n`;
                    output += `\n**Schema:**\n`;
                    for (const [tableName, columns] of Object.entries(dbInfo.schema)) {
                        output += `- **${tableName}:** ${columns.join(", ")}\n`;
                    }
                    output += `\n`;
                }
            }
        }
        output += `## Common Query Examples\n`;
        output += `\`\`\`sql\n`;
        output += `-- Search for packages by name\n`;
        output += `SELECT name, summary FROM packages WHERE name LIKE '%search-term%';\n\n`;
        output += `-- List all available architectures\n`;
        output += `SELECT DISTINCT arch FROM packages;\n\n`;
        output += `-- Find development packages\n`;
        output += `SELECT name, summary FROM packages WHERE name LIKE '%-devel' OR summary LIKE '%development%';\n\n`;
        output += `-- Count packages per architecture\n`;
        output += `SELECT arch, COUNT(*) as package_count FROM packages GROUP BY arch;\n`;
        output += `\`\`\`\n`;
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
