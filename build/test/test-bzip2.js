import { readFileSync, writeFileSync } from "fs";
// @ts-ignore - bzip2 doesn't have types
import bzip2 from "bzip2";
function testBzip2() {
    console.log("Testing bzip2 library in isolation");
    // Test data
    const testString = "Hello World! This is a test file for bzip2 compression and decompression.";
    const testBuffer = Buffer.from(testString, "utf8");
    console.log("Original data:");
    console.log("  Size:", testBuffer.length);
    console.log("  Content:", testString);
    console.log("  Hex:", testBuffer.toString("hex").substring(0, 32));
    // Load actual bzip2 compressed file
    const compressedFile = readFileSync("test.txt.bz2");
    console.log("\nCompressed file:");
    console.log("  Size:", compressedFile.length);
    console.log("  Header hex:", compressedFile.subarray(0, 16).toString("hex"));
    console.log("  Header text:", compressedFile.subarray(0, 16).toString());
    // Test bzip2 library methods
    console.log("\nTesting bzip2 library methods:");
    console.log("Available methods:", Object.keys(bzip2));
    try {
        // Convert to Uint8Array as required by library
        const uint8Array = new Uint8Array(compressedFile);
        console.log("Converted to Uint8Array, size:", uint8Array.length);
        console.log("First 16 bytes:", Array.from(uint8Array.slice(0, 16)));
        // Create bitstream
        const bitstream = bzip2.array(uint8Array);
        console.log("Created bitstream:", typeof bitstream);
        // Try simple decompression
        const decompressedResult = bzip2.simple(bitstream);
        console.log("Decompressed result type:", typeof decompressedResult);
        console.log("Decompressed result:", decompressedResult);
        console.log("Is Array:", Array.isArray(decompressedResult));
        console.log("Is Uint8Array:", decompressedResult instanceof Uint8Array);
        if (decompressedResult instanceof Uint8Array) {
            console.log("Result length:", decompressedResult.length);
            console.log("First 16 bytes:", Array.from(decompressedResult.slice(0, 16)));
            const decompressedBuffer = Buffer.from(decompressedResult);
            console.log("Buffer size:", decompressedBuffer.length);
            console.log("Buffer content:", decompressedBuffer.toString("utf8"));
            console.log("Matches original:", decompressedBuffer.toString("utf8") === testString);
        }
        else {
            console.log("Result as string:", decompressedResult);
        }
    }
    catch (error) {
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
    }
    // Test manually writing/reading files
    console.log("\nTesting file operations:");
    try {
        const uint8Array = new Uint8Array(compressedFile);
        const bitstream = bzip2.array(uint8Array);
        const decompressedResult = bzip2.simple(bitstream);
        if (decompressedResult instanceof Uint8Array) {
            writeFileSync("test_decompressed.txt", Buffer.from(decompressedResult));
            const readBack = readFileSync("test_decompressed.txt");
            console.log("Written file size:", readBack.length);
            console.log("Written file header hex:", readBack.slice(0, 16).toString("hex"));
            console.log("Written file content:", readBack.toString("utf8"));
        }
    }
    catch (error) {
        console.error("File test error:", error.message);
    }
}
testBzip2();
