#!/usr/bin/env node

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  createReadStream,
  createWriteStream,
} from "fs";
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

interface RepoMetadata {
  primaryDb?: string;
  filelistsDb?: string;
  otherDb?: string;
}

interface ProcessingResult {
  repo: string;
  success: boolean;
  error?: string;
  dbPath?: string;
  usedSqlite: boolean;
}

const CACHE_DIR = path.join(os.tmpdir(), "avocado-mcp-test-databases");
const AVOCADO_REPO_BASE = "https://repo.avocadolinux.org";

if (!existsSync(CACHE_DIR)) {
  mkdirSync(CACHE_DIR, { recursive: true });
}

async function downloadFile(
  url: string,
  destinationPath: string,
): Promise<void> {
  console.log(`📥 Downloading: ${url}`);

  const response = await fetch(url, {
    headers: { "User-Agent": "avocado-mcp-test/1.0" },
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} for ${url}`);
  }

  const fileStream = createWriteStream(destinationPath);
  await pipeline(response.body!, fileStream);
}

function getCompressionFormat(filePath: string): "bz2" | "gz" | "none" {
  if (filePath.endsWith(".bz2")) return "bz2";
  if (filePath.endsWith(".gz")) return "gz";
  return "none";
}

async function decompressFile(
  sourcePath: string,
  destPath: string,
): Promise<void> {
  const compressionFormat = getCompressionFormat(sourcePath);
  const originalSize = readFileSync(sourcePath).length;

  console.log(
    `🗜️  Decompressing ${compressionFormat.toUpperCase()}: ${path.basename(sourcePath)} (${originalSize} bytes)`,
  );

  switch (compressionFormat) {
    case "bz2":
      const compressedData = readFileSync(sourcePath);
      const uint8Array = new Uint8Array(compressedData);
      const bitstream = bzip2.array(uint8Array);
      const decompressedResult = bzip2.simple(bitstream);
      const decompressedData = Buffer.from(decompressedResult);
      writeFileSync(destPath, decompressedData);
      console.log(`   ✅ Decompressed to ${decompressedData.length} bytes`);
      break;

    case "gz":
      const readStream = createReadStream(sourcePath);
      const writeStream = createWriteStream(destPath);
      const decompressor = createGunzip();
      await pipeline(readStream, decompressor, writeStream);
      const decompressedSize = readFileSync(destPath).length;
      console.log(`   ✅ Decompressed to ${decompressedSize} bytes`);
      break;

    case "none":
      const srcStream = createReadStream(sourcePath);
      const dstStream = createWriteStream(destPath);
      await pipeline(srcStream, dstStream);
      console.log(`   ✅ Copied uncompressed file`);
      break;
  }
}

async function parseRepomd(xmlContent: string): Promise<RepoMetadata> {
  const result: any = await parseXML(xmlContent);
  const metadata: RepoMetadata = {};

  if (result?.repomd?.data) {
    for (const data of result.repomd.data) {
      const type = data.$.type;
      const href = data.location?.[0]?.$?.href;

      if (href) {
        switch (type) {
          case "primary_db":
            metadata.primaryDb = href;
            break;
          case "filelists_db":
            metadata.filelistsDb = href;
            break;
          case "other_db":
            metadata.otherDb = href;
            break;
        }
      }
    }
  }

  return metadata;
}

async function validateDatabase(
  dbPath: string,
): Promise<{ isValid: boolean; error?: string }> {
  if (!existsSync(dbPath)) {
    return { isValid: false, error: `Database file does not exist: ${dbPath}` };
  }

  const fileData = readFileSync(dbPath);
  const headerString = fileData.subarray(0, 16).toString("utf8");

  console.log(
    `🔍 Validating database: ${path.basename(dbPath)} (${fileData.length} bytes)`,
  );

  if (!headerString.startsWith("SQLite format 3")) {
    return {
      isValid: false,
      error: `Invalid SQLite header. Expected "SQLite format 3", got "${headerString.replace(/\0/g, "\\0")}"`,
    };
  }

  try {
    const db = new Database(dbPath, { readonly: true });
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as { name: string }[];

    console.log(`   📊 Tables: ${tables.map((t) => t.name).join(", ")}`);

    // Test basic functionality
    if (tables.some((t) => t.name === "packages")) {
      const packageCount = db
        .prepare("SELECT COUNT(*) as count FROM packages")
        .get() as { count: number };
      console.log(`   📦 Package count: ${packageCount.count}`);

      const samplePackages = db
        .prepare("SELECT name FROM packages LIMIT 3")
        .all() as { name: string }[];
      console.log(
        `   🔍 Sample packages: ${samplePackages.map((p) => p.name).join(", ")}`,
      );
    }

    db.close();
    return { isValid: true };
  } catch (error: any) {
    return { isValid: false, error: `SQLite error: ${error.message}` };
  }
}

async function getTargetRepositories(target: string): Promise<string[]> {
  console.log(`\n🎯 Fetching repositories for target: ${target}`);

  const targetsUrl = `${AVOCADO_REPO_BASE}/latest/apollo/edge/targets.json`;
  const response = await fetch(targetsUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch targets.json: ${response.status}`);
  }

  const targetsConfig = await response.json();
  const repos = targetsConfig[target];

  if (!repos) {
    console.log(`❌ Target "${target}" not found in targets.json`);
    console.log(
      `Available targets: ${Object.keys(targetsConfig).slice(0, 10).join(", ")}`,
    );
    return [];
  }

  console.log(`✅ Found ${repos.length} repositories: ${repos.join(", ")}`);
  return repos;
}

function generateFilePaths(target: string, repo: string, primaryDbUrl: string) {
  const repoSafeName = repo.replace(/\//g, "_");
  const baseFileName = `${target}-${repoSafeName}`;

  return {
    repomdPath: path.join(CACHE_DIR, `${baseFileName}-repomd.xml`),
    compressedDbPath: path.join(
      CACHE_DIR,
      `${baseFileName}-primary${path.extname(primaryDbUrl)}`,
    ),
    decompressedDbPath: path.join(CACHE_DIR, `${baseFileName}-primary.db`),
  };
}

async function processRepository(
  target: string,
  repo: string,
): Promise<ProcessingResult> {
  console.log(`\n📂 Processing repository: ${repo}`);

  try {
    // Download and parse repomd.xml
    const baseUrl = `${AVOCADO_REPO_BASE}/latest/apollo/edge/${repo}`;
    const repomdUrl = `${baseUrl}/repodata/repomd.xml`;
    const tempRepomdPath = path.join(CACHE_DIR, `temp-repomd.xml`);

    await downloadFile(repomdUrl, tempRepomdPath);
    const repomdContent = readFileSync(tempRepomdPath, "utf8");
    const metadata = await parseRepomd(repomdContent);

    // Get primary database
    const primaryDbUrl = metadata.primaryDb;
    if (!primaryDbUrl) {
      throw new Error("No primary database found in repomd.xml");
    }

    console.log(`   📄 Primary DB: ${primaryDbUrl}`);

    // Generate proper file paths with correct extensions
    const paths = generateFilePaths(target, repo, primaryDbUrl);

    // Download compressed database
    const dbUrl = `${baseUrl}/${primaryDbUrl}`;
    await downloadFile(dbUrl, paths.compressedDbPath);

    // Decompress database
    await decompressFile(paths.compressedDbPath, paths.decompressedDbPath);

    // Validate the decompressed database
    const validation = await validateDatabase(paths.decompressedDbPath);

    if (validation.isValid) {
      console.log(`   ✅ Database processed successfully`);
      return {
        repo,
        success: true,
        dbPath: paths.decompressedDbPath,
        usedSqlite: true,
      };
    } else {
      console.log(`   ❌ Database validation failed: ${validation.error}`);
      return {
        repo,
        success: false,
        error: validation.error,
        usedSqlite: true,
      };
    }
  } catch (error: any) {
    console.log(`   ❌ Error processing repository: ${error.message}`);
    return {
      repo,
      success: false,
      error: error.message,
      usedSqlite: true,
    };
  }
}

async function testDatabasePreparation(
  target: string,
): Promise<ProcessingResult[]> {
  console.log(`\n🚀 Testing Database Preparation for: ${target}`);
  console.log("=".repeat(60));

  const repos = await getTargetRepositories(target);
  if (repos.length === 0) {
    return [];
  }

  const results: ProcessingResult[] = [];
  let successCount = 0;

  for (const repo of repos) {
    const result = await processRepository(target, repo);
    results.push(result);
    if (result.success) {
      successCount++;
    }
  }

  // Print summary
  console.log(`\n📊 Summary for ${target}:`);
  console.log(`   Repositories processed: ${repos.length}`);
  console.log(`   Databases prepared successfully: ${successCount}`);
  console.log(
    `   Success rate: ${((successCount / repos.length) * 100).toFixed(1)}%`,
  );

  if (successCount === 0) {
    console.log(`\n❌ No databases were prepared successfully.`);
    console.log(`\n🔍 Detailed Results:`);
    results.forEach((result) => {
      const status = result.success ? "✅" : "❌";
      const error = result.error ? ` - ${result.error}` : "";
      console.log(`   ${result.repo}: ${status}${error}`);
    });
  } else {
    console.log(`\n✅ Successfully prepared databases:`);
    results
      .filter((r) => r.success)
      .forEach((result) => {
        console.log(`   ${result.repo}: ${result.dbPath}`);
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
    console.log("\n✅ Test completed");
    console.log(`📁 Cache directory: ${CACHE_DIR}`);
  } catch (error) {
    console.error("💥 Test failed:", error);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
