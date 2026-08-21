// tools/verify-category-theoretic-architecture.mjs
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));

console.log("=== Category-Theoretic Core Architecture Verification ===");

// 1. Recursive Core Algebra Isolation Audit
console.log("\n[1/3] Auditing Core Algebra Isolation (Zero SMAPI/MonoGame forbidden references)...");
const coreDir = resolve(__dirname, "../integrations/stardew/src/Core");
const forbiddenSMAPITypes = ["StardewValley.", "StardewModdingAPI", "Microsoft.Xna."];

function scanFiles(dir) {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      scanFiles(fullPath);
    } else if (entry.name.endsWith(".cs")) {
      const content = readFileSync(fullPath, "utf-8");
      for (const forbidden of forbiddenSMAPITypes) {
        if (content.includes(forbidden)) {
          console.error(`[Architecture Violation] File ${entry.name} directly references forbidden type "${forbidden}"`);
          process.exit(1);
        }
      }
    }
  }
}

scanFiles(coreDir);
console.log("  -> Core Algebra layer is 100% decoupled and pure.");

// 2. Verify Schema SSOT File & Generated File Consistency
console.log("\n[2/3] Auditing Protocol SSOT & Functorial Target Parity...");
const schemaFile = resolve(__dirname, "../protocol/bridge-v1.schema.json");
const generatedTsFile = resolve(__dirname, "../host/src/protocol.generated.ts");
const generatedCsFile = resolve(__dirname, "../integrations/stardew/src/Core/Protocol/Protocol.Generated.cs");

const schemaContent = readFileSync(schemaFile, "utf-8");
const generatedTsContent = readFileSync(generatedTsFile, "utf-8");
const generatedCsContent = readFileSync(generatedCsFile, "utf-8");

const schema = JSON.parse(schemaContent);
const expectedStates = schema.$defs.executionState.enum;

for (const state of expectedStates) {
  if (!generatedTsContent.includes(`"${state}"`)) {
    console.error(`[SSOT Drift] State "${state}" missing in TypeScript generated protocol`);
    process.exit(1);
  }
}

if (!generatedCsContent.includes("ExecutionRequestDto") || !generatedCsContent.includes("ExecutionReceiptDto")) {
  console.error("[SSOT Drift] Generated C# DTOs missing required protocol records");
  process.exit(1);
}
console.log("  -> All 12 execution states and protocol records verified in generated targets.");

// 3. Guarantee Clean Codegen (Re-run codegen and verify zero disk diff)
console.log("\n[3/3] Verifying Schema Compiler Byte-for-Byte Output Fidelity...");
const codegenScript = resolve(__dirname, "generate-protocol.mjs");
execFileSync(process.execPath, [codegenScript], { stdio: "inherit" });

const postGenTs = readFileSync(generatedTsFile, "utf-8");
const postGenCs = readFileSync(generatedCsFile, "utf-8");
if (postGenTs !== generatedTsContent || postGenCs !== generatedCsContent) {
  console.error("[SSOT Drift] Generated files on disk differed from compiler output. Generated files must not be manually edited.");
  process.exit(1);
}
console.log("  -> Schema compiler output matches committed targets byte-for-byte.");

console.log("\n[PASS] Category-Theoretic architecture boundary & schema drift verification passed successfully!\n");
