#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, mkdirSync, createReadStream, createWriteStream, } from "fs";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import path from "path";
import os from "os";
// @ts-ignore - bzip2 doesn't have types
import bzip2 from "bzip2";
import Database from "better-sqlite3";
import { parseString } from "xml2js";
import { promisify } from "util";
const parseXML = promisify(parseString);
const CACHE_DIR = path.join(os.tmpdir(), "avocado-mcp-test-databases");
const AVOCADO_REPO_BASE = "https://repo.avocadolinux.org";
// Ensure cache directory exists
if (!existsSync(CACHE_DIR)) {
    mkdirSync(CACHE_DIR, { recursive: true });
}
async function downloadFile(url, destinationPath) {
    console.log(`📥 Downloading: ${url}`);
    const response = await fetch(url, {
        headers: { "User-Agent": "avocado-mcp-test/1.0" },
    });
    const contentType = response.headers.get("content-type") || "unknown";
    const contentLength = parseInt(response.headers.get("content-length") || "0");
    console.log(`   Status: ${response.status}, Type: ${contentType}, Length: ${contentLength}`);
    if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
    }
    const fileStream = createWriteStream(destinationPath);
    await pipeline(response.body, fileStream);
    return { contentType, contentLength, statusCode: response.status };
}
async function decompressFile(sourcePath, destPath) {
    const originalSize = readFileSync(sourcePath).length;
    console.log(`🗜️  Decompressing: ${sourcePath} (${originalSize} bytes)`);
    if (sourcePath.endsWith(".bz2")) {
        try {
            console.log(`   Attempting bzip2 decompression...`);
            const compressedData = readFileSync(sourcePath);
            console.log(`   Compressed data size: ${compressedData.length}`);
            console.log(`   Compressed header: ${compressedData.slice(0, 16).toString("hex")}`);
            const uint8Array = new Uint8Array(compressedData);
            const bitstream = bzip2.array(uint8Array);
            console.log(`   Created bitstream: ${typeof bitstream}`);
            const decompressedResult = bzip2.simple(bitstream);
            console.log(`   Decompression result type: ${typeof decompressedResult}`);
            console.log(`   Is Uint8Array: ${decompressedResult instanceof Uint8Array}`);
            console.log(`   Result size: ${decompressedResult.length}`);
            const decompressedData = Buffer.from(decompressedResult);
            console.log(`   Final buffer size: ${decompressedData.length}`);
            console.log(`   Final buffer header: ${decompressedData.slice(0, 16).toString("hex")}`);
            writeFileSync(destPath, decompressedData);
            console.log(`   Successfully wrote decompressed file`);
        }
        catch (error) {
            console.log(`   Bzip2 decompression failed: ${error.message}`);
            throw error;
        }
    }
    else if (sourcePath.endsWith(".gz")) {
        const readStream = createReadStream(sourcePath);
        const writeStream = createWriteStream(destPath);
        const decompressor = createGunzip();
        await pipeline(readStream, decompressor, writeStream);
    }
    else {
        const readStream = createReadStream(sourcePath);
        const writeStream = createWriteStream(destPath);
        await pipeline(readStream, writeStream);
    }
    const decompressedData = readFileSync(destPath);
    const decompressedSize = decompressedData.length;
    const fileHeader = decompressedData.subarray(0, 32).toString("hex");
    console.log(`   Decompressed: ${decompressedSize} bytes`);
    console.log(`   File header (hex): ${fileHeader}`);
    return { originalSize, decompressedSize, fileHeader };
}
async function parseRepomd(xmlContent) {
    const result = await parseXML(xmlContent);
    const metadata = {};
    if (result?.repomd?.data) {
        for (const data of result.repomd.data) {
            const type = data.$.type;
            const href = data.location?.[0]?.$?.href;
            if (href) {
                switch (type) {
                    // SQLite databases (preferred) - following repository.ts structure documentation
                    case "primary_db":
                        metadata.primaryDb = href;
                        break;
                    case "filelists_db":
                        metadata.filelistsDb = href;
                        break;
                    case "other_db":
                        metadata.otherDb = href;
                        break;
                    // XML fallbacks
                    case "primary":
                        if (!metadata.primaryDb)
                            metadata.primaryXml = href;
                        break;
                    case "filelists":
                        if (!metadata.filelistsDb)
                            metadata.filelistsXml = href;
                        break;
                    case "other":
                        if (!metadata.otherDb)
                            metadata.otherXml = href;
                        break;
                }
            }
        }
    }
    return metadata;
}
async function introspectDatabase(dbPath) {
    if (!existsSync(dbPath)) {
        return {
            isValid: false,
            error: `Database file does not exist: ${dbPath}`,
            fileInfo: { size: 0, header: "", headerHex: "" },
        };
    }
    const fileData = readFileSync(dbPath);
    const fileSize = fileData.length;
    const fileHeader = fileData.subarray(0, 32);
    const headerString = fileHeader.toString("utf8");
    const headerHex = fileHeader.toString("hex");
    console.log(`🔍 Inspecting database: ${dbPath}`);
    console.log(`   File size: ${fileSize} bytes`);
    console.log(`   Header (text): "${headerString.replace(/\0/g, "\\0").substring(0, 16)}"`);
    console.log(`   Header (hex): ${headerHex}`);
    const fileInfo = {
        size: fileSize,
        header: headerString.substring(0, 16),
        headerHex: headerHex,
    };
    if (!headerString.startsWith("SQLite format 3")) {
        return {
            isValid: false,
            error: `File is not a valid SQLite database. Expected "SQLite format 3", got "${headerString.substring(0, 16)}"`,
            fileInfo,
        };
    }
    try {
        const db = new Database(dbPath, { readonly: true });
        const tables = db
            .prepare("SELECT name FROM sqlite_master WHERE type='table'")
            .all();
        const tableNames = tables.map((t) => t.name);
        const schema = {};
        for (const tableName of tableNames) {
            const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
            schema[tableName] = columns.map((c) => c.name);
        }
        db.close();
        return {
            isValid: true,
            tables: tableNames,
            schema,
            fileInfo,
        };
    }
    catch (error) {
        return {
            isValid: false,
            error: `SQLite error: ${error.message}`,
            fileInfo,
        };
    }
}
async function testTargetRepositories(target) {
    console.log(`\n🎯 Testing repositories for target: ${target}`);
    // Get targets config first
    try {
        const targetsUrl = `${AVOCADO_REPO_BASE}/latest/apollo/edge/targets.json`;
        const targetsResponse = await fetch(targetsUrl);
        if (!targetsResponse.ok) {
            throw new Error(`Failed to fetch targets.json: ${targetsResponse.status}`);
        }
        const targetsConfig = await targetsResponse.json();
        const repos = targetsConfig[target];
        if (!repos) {
            console.log(`❌ Target "${target}" not found in targets.json`);
            console.log(`Available targets:`, Object.keys(targetsConfig).slice(0, 10));
            return [];
        }
        console.log(`✅ Found ${repos.length} repositories for target: ${repos.join(", ")}`);
        return repos;
    }
    catch (error) {
        console.log(`❌ Error fetching target repositories: ${error.message}`);
        return [];
    }
}
async function testDatabasePreparation(target) {
    console.log(`\n🚀 Testing Database Preparation for: ${target}`);
    console.log("=".repeat(60));
    const repos = await testTargetRepositories(target);
    if (repos.length === 0) {
        return;
    }
    let successCount = 0;
    const results = [];
    for (const repo of repos) {
        console.log(`\n📂 Processing repository: ${repo}`);
        try {
            // Step 1: Download repomd.xml
            const baseUrl = `${AVOCADO_REPO_BASE}/latest/apollo/edge/${repo}`;
            const repomdUrl = `${baseUrl}/repodata/repomd.xml`;
            const repomdPath = path.join(CACHE_DIR, `${target}-${repo.replace(/\//g, "_")}-repomd.xml`);
            const repomdInfo = await downloadFile(repomdUrl, repomdPath);
            // Step 2: Parse repomd.xml
            const repomdContent = readFileSync(repomdPath, "utf8");
            const metadata = await parseRepomd(repomdContent);
            // Prefer SQLite database, fallback to XML if needed
            const primaryDbPath = metadata.primaryDb || metadata.primaryXml;
            if (!primaryDbPath) {
                console.log("   ⚠️  No primary database or XML found in repomd.xml");
                console.log(`   Available data types: ${Object.keys(metadata).join(", ")}`);
                continue;
            }
            console.log(`   📄 Primary DB: ${primaryDbPath}`);
            console.log(`   🎯 Using SQLite: ${!!metadata.primaryDb ? "Yes" : "No (XML fallback)"}`);
            // Step 3: Download database
            const dbUrl = `${baseUrl}/${primaryDbPath}`;
            const compressedDbPath = path.join(CACHE_DIR, `${target}-${repo.replace(/\//g, "_")}-primary.db.compressed`);
            const dbDownloadInfo = await downloadFile(dbUrl, compressedDbPath);
            // Step 4: Decompress database
            const dbPath = path.join(CACHE_DIR, `${target}-${repo.replace(/\//g, "_")}-primary.db`);
            const decompressionInfo = await decompressFile(compressedDbPath, dbPath);
            // Step 5: Introspect database
            const dbIntrospection = await introspectDatabase(dbPath);
            if (dbIntrospection.isValid) {
                console.log(`   ✅ Database prepared successfully`);
                console.log(`   📊 Tables: ${dbIntrospection.tables.join(", ")}`);
                successCount++;
                // Test a simple query
                try {
                    const db = new Database(dbPath, { readonly: true });
                    const packageCount = db
                        .prepare("SELECT COUNT(*) as count FROM packages")
                        .get();
                    console.log(`   📦 Package count: ${packageCount.count}`);
                    const samplePackages = db
                        .prepare("SELECT name FROM packages LIMIT 3")
                        .all();
                    console.log(`   🔍 Sample packages: ${samplePackages.map((p) => p.name).join(", ")}`);
                    db.close();
                }
                catch (queryError) {
                    console.log(`   ⚠️  Query test failed: ${queryError.message}`);
                }
            }
            else {
                console.log(`   ❌ Database validation failed: ${dbIntrospection.error}`);
            }
            results.push({
                repo,
                success: dbIntrospection.isValid,
                error: dbIntrospection.error,
                dbPath: dbIntrospection.isValid ? dbPath : undefined,
                usedSqlite: !!metadata.primaryDb,
            });
        }
        catch (error) {
            console.log(`   ❌ Error processing repository: ${error.message}`);
            results.push({
                repo,
                success: false,
                error: error.message,
                usedSqlite: false,
            });
        }
    }
    // Summary
    console.log(`\n📊 Summary for ${target}:`);
    console.log(`   Repositories processed: ${repos.length}`);
    console.log(`   Databases prepared successfully: ${successCount}`);
    console.log(`   Success rate: ${((successCount / repos.length) * 100).toFixed(1)}%`);
    if (successCount === 0) {
        console.log(`\n❌ No databases were prepared successfully. This explains the original error.`);
        console.log(`\n🔍 Detailed Results:`);
        results.forEach((result) => {
            console.log(`   ${result.repo}: ${result.success ? "✅" : "❌"} ${result.error || ""} ${result.usedSqlite ? "(SQLite)" : "(XML)"}`);
        });
    }
    return results;
}
async function main() {
    console.log("🧪 Avocado MCP Database Preparation Test");
    console.log("==========================================");
    const target = "jetson-orin-nano-devkit-nvme";
    try {
        await testDatabasePreparation(target);
    }
    catch (error) {
        console.error("💥 Test failed:", error);
        process.exit(1);
    }
    console.log("\n✅ Test completed");
    console.log(`📁 Cache directory: ${CACHE_DIR}`);
}
if (import.meta.url === `file://${process.argv[1]}`) {
    main();
}
