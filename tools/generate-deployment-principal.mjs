#!/usr/bin/env node
/**
 * The deployment principal's key set, written once and generated into both languages that need it.
 *
 * WHY THIS FILE EXISTS. `host/src/deployment-manifest.ts` validated the manifest's `principal` object against three
 * key names and `tools/lib/game-operational-gate-preflight.mjs` validated the identity it is handed against the same
 * three names, in its own order, as a list of its own. Nothing compared them: a key renamed or added on one side
 * refused the other side's perfectly correct input with `identity_shape_invalid`, which names no key and points at no
 * file. The two ends cannot import each other (the preflight is a plain ESM tool, the manifest loader is TypeScript in
 * the Host package) and neither can read the other's list at runtime: the preflight states in its own contract that it
 * performs no filesystem access.
 *
 * So the fact lives in `contracts/deployment-principal.v1.json` and both sides are OUTPUTS of it. Each output says it
 * is generated and names this command; `tools/check-generated-artifact-reproducibility.mjs` re-runs the producer and
 * compares its bytes to the tracked file, and `tools/check-fact-seams.mjs` records the pair as `derives: generated`
 * from the contract, so neither a hand edit nor a re-spelled list can pass unnoticed.
 *
 * USAGE
 *   node tools/generate-deployment-principal.mjs --target ts    # stdout, the Host module's bytes
 *   node tools/generate-deployment-principal.mjs --target mjs    # stdout, the tools module's bytes
 *   node tools/generate-deployment-principal.mjs --write         # both tracked files, in place
 */
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const CONTRACT = new URL("../contracts/deployment-principal.v1.json", import.meta.url);
const CONTRACT_PATH = "contracts/deployment-principal.v1.json";
const SCHEMA = "gamebuddy-deployment-principal-key-set/v1";
const HOST_TARGET = "host/src/deployment-principal.generated.ts";
const TOOLS_TARGET = "tools/deployment-principal.generated.mjs";

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;

/** The contract's key set, or a refusal naming what is wrong with the contract rather than emitting a list. */
export function readContractKeys(read = (url) => readFileSync(url, "utf8")) {
  const contract = JSON.parse(read(CONTRACT));
  if (contract.schema !== SCHEMA)
    throw new Error(`contract_schema_mismatch:${String(contract.schema)} (expected ${SCHEMA})`);
  const keys = contract.keys;
  if (!Array.isArray(keys) || keys.length === 0) throw new Error("contract_keys_missing");
  for (const key of keys) {
    if (typeof key !== "string" || !IDENTIFIER.test(key))
      throw new Error(`contract_key_not_an_identifier:${String(key)}`);
  }
  if (new Set(keys).size !== keys.length) throw new Error("contract_keys_duplicated");
  return keys;
}

function header(target) {
  return [
    `// GENERATED FILE - do not edit. Regenerate: node tools/generate-deployment-principal.mjs --write`,
    `// Target: ${target}`,
    `// Source of truth: ${CONTRACT_PATH}`,
  ];
}

/**
 * The Host module's bytes.
 *
 * The array is written on one line because the formatter would collapse it: this text IS the tracked file, so it has to
 * be what `biome format` leaves alone. `tools/check-generated-artifact-reproducibility.mjs` re-runs this producer and
 * compares the bytes, which is what keeps that claim true.
 */
function renderHost(keys) {
  return [
    ...header(HOST_TARGET),
    `export const DEPLOYMENT_PRINCIPAL_KEYS = [${keys.map((key) => `"${key}"`).join(", ")}] as const;`,
    "",
    "/** The keys a deployment manifest's `principal` object must carry, and no others. */",
    "export type DeploymentPrincipalKey = (typeof DEPLOYMENT_PRINCIPAL_KEYS)[number];",
  ].join("\n");
}

function renderTools(keys) {
  return [
    ...header(TOOLS_TARGET),
    `export const DEPLOYMENT_PRINCIPAL_KEYS = Object.freeze([${keys.map((key) => `"${key}"`).join(", ")}]);`,
  ].join("\n");
}

export function render(target, keys) {
  if (target === "ts") return `${renderHost(keys)}\n`;
  if (target === "mjs") return `${renderTools(keys)}\n`;
  throw new Error(`unknown_target:${String(target)}`);
}

function main(argv) {
  const keys = readContractKeys();
  if (argv.includes("--write")) {
    const root = fileURLToPath(new URL("..", import.meta.url));
    for (const [target, path] of [
      ["ts", HOST_TARGET],
      ["mjs", TOOLS_TARGET],
    ]) {
      writeFileSync(`${root}${path}`, render(target, keys), "utf8");
    }
    return 0;
  }
  const targetFlag = argv.indexOf("--target");
  process.stdout.write(render(targetFlag < 0 ? "ts" : argv[targetFlag + 1], keys));
  return 0;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
