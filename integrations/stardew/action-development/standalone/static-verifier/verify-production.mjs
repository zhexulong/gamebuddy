#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseJsonWithoutDuplicateKeys } from "../src/json-text.mjs";
import {
  FAILED_TARGET_PUBLICATION_MANIFEST_MALFORMED,
  FAILED_TARGET_PUBLICATION_MANIFEST_SCHEMA,
  validateTargetPublicationManifest,
} from "./production-schema.mjs";
import {
  createBlockedManifestReport,
  createMalformedManifestReport,
  verifyTargetPublication,
} from "./production-verifier.mjs";

const STATIC_VERIFIER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const MANIFEST_ARG = /^[a-z0-9][a-z0-9._-]{0,127}(\/[a-z0-9][a-z0-9._-]{0,127}){0,7}\.json$/;
const EXIT_CODES = Object.freeze({ passed: 0, failed: 1, blocked: 2, usage: 3 });
const DOTNET_ENV = "STARDEW_STATIC_VERIFIER_DOTNET";

function isAbsolutePath(value) {
  return /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("/") || value.startsWith("\\\\");
}

function writeReport(report) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || (!MANIFEST_ARG.test(args[0]) && !isAbsolutePath(args[0]))) {
    process.stderr.write("stardew_static_verifier_usage_expected_one_manifest_or_absolute_target_publication_manifest_path\n");
    process.exitCode = EXIT_CODES.usage;
    return;
  }
  // Relative manifest arguments are anchored to the package-owned
  // `production/manifests` tree; absolute paths address independently
  // published manifests and are read as-is.
  process.chdir(STATIC_VERIFIER_DIRECTORY);
  const manifestPath = isAbsolutePath(args[0])
    ? args[0]
    : path.join("production", "manifests", ...args[0].split("/"));
  const inputId = path.basename(args[0]);
  const dotnetCommand = process.env[DOTNET_ENV] ?? "dotnet";
  if (typeof dotnetCommand !== "string" || dotnetCommand.length === 0 || dotnetCommand.includes("\0")) {
    process.stderr.write("stardew_static_verifier_usage_invalid_dotnet_override\n");
    process.exitCode = EXIT_CODES.usage;
    return;
  }

  let text;
  try {
    text = readFileSync(manifestPath, "utf8");
  } catch {
    writeReport(createBlockedManifestReport(inputId));
    process.exitCode = EXIT_CODES.blocked;
    return;
  }
  let parsed;
  try {
    parsed = parseJsonWithoutDuplicateKeys(text, "stardew_target_publication_manifest");
  } catch {
    writeReport(createMalformedManifestReport(inputId, FAILED_TARGET_PUBLICATION_MANIFEST_MALFORMED));
    process.exitCode = EXIT_CODES.failed;
    return;
  }
  let validated;
  try {
    validated = validateTargetPublicationManifest(parsed);
  } catch {
    writeReport(createMalformedManifestReport(inputId, FAILED_TARGET_PUBLICATION_MANIFEST_SCHEMA));
    process.exitCode = EXIT_CODES.failed;
    return;
  }

  const report = await verifyTargetPublication(validated, { inputId, dotnetCommand });
  writeReport(report);
  process.exitCode = EXIT_CODES[report.state];
}

main();