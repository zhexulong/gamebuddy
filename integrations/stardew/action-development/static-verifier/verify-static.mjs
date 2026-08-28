#!/usr/bin/env node
import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseJsonWithoutDuplicateKeys } from "../src/json-text.mjs";
import { validateInput } from "./schema.mjs";
import { verifyStaticInput } from "./verifier.mjs";

const STATIC_VERIFIER_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const INPUT_ARG = /^[a-z0-9][a-z0-9._-]{0,127}(\/[a-z0-9][a-z0-9._-]{0,127}){0,7}\.json$/;
const EXIT_CODES = Object.freeze({ passed: 0, failed: 1, blocked: 2, inputRejected: 3 });

function rejectInput(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = EXIT_CODES.inputRejected;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !INPUT_ARG.test(args[0])) {
    rejectInput("stardew_static_verifier_usage_expected_one_package_owned_input_json");
    return;
  }
  // The command is anchored to its own package-owned directory: the input
  // fixture and the artifact root are resolved only inside this tree.
  process.chdir(STATIC_VERIFIER_DIRECTORY);
  const inputPath = path.join("fixtures", ...args[0].split("/"));
  let text;
  try {
    text = readFileSync(inputPath, "utf8");
  } catch {
    rejectInput("stardew_static_verifier_input_unreadable");
    return;
  }
  let parsed;
  try {
    parsed = parseJsonWithoutDuplicateKeys(text, "stardew_static_verifier_input");
  } catch (error) {
    rejectInput(error instanceof Error ? error.message : "stardew_static_verifier_input_invalid");
    return;
  }
  let validated;
  try {
    validated = validateInput(parsed);
  } catch (error) {
    rejectInput(error instanceof Error ? error.message : "stardew_static_verifier_input_invalid");
    return;
  }
  const report = verifyStaticInput(validated);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = EXIT_CODES[report.state];
}

main();