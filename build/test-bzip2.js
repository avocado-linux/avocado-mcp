"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
var fs_1 = require("fs");
// @ts-ignore - bzip2 doesn't have types
var bzip2 = require("bzip2");
function testBzip2() {
    console.log("Testing bzip2 library in isolation");
    // Test data
    var testString = "Hello World! This is a test file for bzip2 compression and decompression.";
    var testBuffer = Buffer.from(testString, "utf8");
    console.log("Original data:");
    console.log("  Size:", testBuffer.length);
    console.log("  Content:", testString);
    console.log("  Hex:", testBuffer.toString("hex").substring(0, 32));
    // Load actual bzip2 compressed file
    var compressedFile = (0, fs_1.readFileSync)("test.txt.bz2");
    console.log("\nCompressed file:");
    console.log("  Size:", compressedFile.length);
    console.log("  Header hex:", compressedFile.subarray(0, 16).toString("hex"));
    console.log("  Header text:", compressedFile.subarray(0, 16).toString());
    // Test bzip2 library methods
    console.log("\nTesting bzip2 library methods:");
    console.log("Available methods:", Object.keys(bzip2));
    try {
        // Convert to Uint8Array as required by library
        var uint8Array = new Uint8Array(compressedFile);
        console.log("Converted to Uint8Array, size:", uint8Array.length);
        // Create bitstream
        var bitstream = bzip2.array(uint8Array);
        console.log("Created bitstream:", typeof bitstream);
        // Try simple decompression
        var decompressedString = bzip2.simple(bitstream);
        console.log("Decompressed string length:", decompressedString.length);
        console.log("Decompressed content:", decompressedString);
        // Convert back to Buffer
        var decompressedBuffer = Buffer.from(decompressedString, "latin1");
        console.log("Decompressed buffer size:", decompressedBuffer.length);
        console.log("Matches original:", decompressedBuffer.toString("utf8") === testString);
    }
    catch (error) {
        console.error("Error:", error.message);
        console.error("Stack:", error.stack);
    }
    // Test with different encodings
    console.log("\nTesting different encodings:");
    try {
        var uint8Array = new Uint8Array(compressedFile);
        var bitstream = bzip2.array(uint8Array);
        var decompressedString = bzip2.simple(bitstream);
        console.log("String length:", decompressedString.length);
        console.log("As UTF8:", Buffer.from(decompressedString, "utf8").toString());
        console.log("As Latin1:", Buffer.from(decompressedString, "latin1").toString());
        console.log("As Binary:", Buffer.from(decompressedString, "binary").toString());
    }
    catch (error) {
        console.error("Encoding test error:", error.message);
    }
}
testBzip2();
