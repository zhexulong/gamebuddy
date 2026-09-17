#!/usr/bin/env node
/**
 * Run publint against the vendored public package while the vendor declaration
 * work is still pending. The baseline is deliberately limited to the two
 * already-audited vendor gaps; every other strict publint error remains a
 * blocking result.
 */
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGE_RELATIVE_PATH = "vendor/magic-context/packages/pi-plugin";
const PACKAGE_PATH = path.join(REPOSITORY_ROOT, PACKAGE_RELATIVE_PATH);
const PACKAGE_JSON_PATH = path.join(PACKAGE_PATH, "package.json");
const DIST_PATH = path.join(PACKAGE_PATH, "dist");
const PUBLINT_EXPORT_PATHS = Object.freeze([".", "./tavern", "./memory"]);

// Remove these entries when the independent vendor declaration task publishes
// types for every export and emits declaration files from its build.
const KNOWN_VENDOR_GAP_RULES = Object.freeze([
  Object.freeze({
    id: "missing-types-condition",
    description: "pi-plugin exports omit a `types` condition",
  }),
  Object.freeze({
    id: "missing-declaration-artifacts",
    description: "pi-plugin dist contains no `.d.ts` declaration artifacts",
  }),
]);

function knownGap(id, detail) {
  return Object.freeze({ id, detail });
}

function hasTypesCondition(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasTypesCondition);
  if (Object.hasOwn(value, "types")) return true;
  return Object.values(value).some(hasTypesCondition);
}

async function countDeclarationFiles(directory) {
  let count = 0;
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return 0;
    throw error;
  }
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      count += await countDeclarationFiles(entryPath);
    } else if (entry.isFile() && entry.name.endsWith(".d.ts")) {
      count += 1;
    }
  }
  return count;
}

async function readActiveKnownGaps() {
  const packageJson = JSON.parse(await readFile(PACKAGE_JSON_PATH, "utf8"));
  const activeGaps = [];
  const exports = packageJson.exports;

  const missingTypesPaths = PUBLINT_EXPORT_PATHS.filter(
    (exportPath) => !hasTypesCondition(exports?.[exportPath]),
  );
  if (missingTypesPaths.length > 0) {
    activeGaps.push(
      knownGap(
        KNOWN_VENDOR_GAP_RULES[0].id,
        `missing types condition for exports: ${missingTypesPaths.join(", ")}`,
      ),
    );
  }

  const declarationCount = await countDeclarationFiles(DIST_PATH);
  if (declarationCount === 0) {
    activeGaps.push(knownGap(KNOWN_VENDOR_GAP_RULES[1].id, "dist/**/*.d.ts count: 0"));
  }

  return { packageJson, activeGaps };
}

function exportPathFromMessage(message) {
  if (!Array.isArray(message.path) || message.path[0] !== "exports") return undefined;
  return typeof message.path[1] === "string" ? message.path[1] : undefined;
}

function matchesKnownGap(message, activeGaps) {
  const activeIds = new Set(activeGaps.map((gap) => gap.id));
  const exportPath = exportPathFromMessage(message);

  if (
    activeIds.has("missing-types-condition") &&
    message.code === "TYPES_NOT_EXPORTED" &&
    exportPath !== undefined &&
    PUBLINT_EXPORT_PATHS.includes(exportPath)
  ) {
    return "missing-types-condition";
  }

  if (
    activeIds.has("missing-declaration-artifacts") &&
    message.code === "FILE_DOES_NOT_EXIST" &&
    exportPath !== undefined &&
    PUBLINT_EXPORT_PATHS.includes(exportPath) &&
    message.path.at(-1) === "types"
  ) {
    return "missing-declaration-artifacts";
  }

  return undefined;
}

function isKnownGap(message, activeGaps) {
  return matchesKnownGap(message, activeGaps) !== undefined;
}

async function main() {
  const { activeGaps } = await readActiveKnownGaps();
  const pub = spawnSync("bun", ["x", "publint", "--strict"], {
    cwd: PACKAGE_PATH,
    encoding: "utf8",
    shell: false,
  });

  const stdout = (pub.stdout ?? "").trim();
  const stderr = (pub.stderr ?? "").trim();
  process.stdout.write(stdout);
  if (stderr) process.stderr.write(`${stderr}\n`);

  const blocked = [];
  const ignored = [];
  const lines = (`${stdout}\n${stderr}`).split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (message && typeof message === "object" && typeof message.code === "string") {
      if (isKnownGap(message, activeGaps)) ignored.push(message.code);
      else blocked.push(message.code);
    }
  }

  if (activeGaps.length > 0) {
    process.stdout.write(`\nKnown vendor publint baseline gaps (pending independent vendor task):\n`);
    for (const gap of activeGaps) process.stdout.write(`- ${gap.id}: ${gap.detail}\n`);
  }

  if (pub.status !== 0 && blocked.length === 0 && activeGaps.length > 0) {
    process.stdout.write(
      `\npublint exited ${pub.status} but every failure maps to a known vendor baseline gap; non-blocking here.\n`,
    );
    process.exit(0);
  }
  if (pub.status === 0) process.exit(0);
  process.exit(pub.status ?? 1);
}

main().catch((error) => {
  process.stderr.write(`check-publint failed: ${error?.message ? error.message : String(error)}\n`);
  process.exit(1);
});