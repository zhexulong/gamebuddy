import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Tests execute from dist-test; inspect only the authored substrate under host/src.
const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const substrateFiles = ["deployment-manifest.ts", "windows-partition-mutex.ts", "strict-json-reader.ts"] as const;
const substrateDirectories = [
  "continuity-semantic-store",
  "continuity-semantic-provisioning",
  "continuity-semantic-owner-death",
] as const;
const substrateSources = Object.freeze([
  ...substrateFiles,
  ...substrateDirectories.flatMap((directory) =>
    readdirSync(`${sourceRoot}${directory}`, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".ts") && !entry.includes(".test.") && !entry.includes(".test-support."))
      .map((entry) => `${directory}/${entry.replaceAll("\\", "/")}`),
  ),
]);
const forbidden = /(?:integration-|voice|tavern|dialogue-web|createGameRuntimeBinding|farmhand|portfolio)/i;
const neutralForbidden = /(?:continuity-semantic-store|continuity-semantic-production-coordinator|continuity-semantic-game-runtime-binding|integration-)/i;

test("semantic authority substrate production imports exclude product and integration surfaces", () => {
  for (const relativePath of substrateSources) {
    const source = readFileSync(`${sourceRoot}${relativePath}`, "utf8");
    const imports = [...source.matchAll(/(?:from\s+["']|import\s*\(\s*["'])([^"']+)/g)].map((match) => match[1]!);
    for (const specifier of imports) assert.doesNotMatch(specifier, forbidden, `${relativePath}: ${specifier}`);
  }
});

test("neutral owner-death leaf imports no authority consumer or binding", () => {
  for (const relativePath of substrateSources.filter((path) => path.startsWith("continuity-semantic-owner-death/"))) {
    const source = readFileSync(`${sourceRoot}${relativePath}`, "utf8");
    const imports = [...source.matchAll(/(?:from\s+["']|import\s*\(\s*["'])([^"']+)/g)].map((match) => match[1]!);
    for (const specifier of imports) assert.doesNotMatch(specifier, neutralForbidden, `${relativePath}: ${specifier}`);
  }
});
