#!/usr/bin/env node
/**
 * A closed string vocabulary, written once as a contract and generated into the languages that read it.
 *
 * WHY THIS FILE EXISTS. Three facts in this tree are one list that two packages read at COMPILE time and neither can
 * import from the other:
 *
 *   deployment principal keys  host/src/deployment-manifest.ts and tools/lib/game-operational-gate-preflight.mjs,
 *                              whose own contract states it performs no filesystem access.
 *   truncation reasons         the Host's `observe_scene` validator and two native-local smoke harnesses that are plain
 *                              ESM under `tools/`.
 *   chat turn terminal states  the browser bundle (which cannot reach `tools/`) and the live-run audit harness.
 *
 * Each was several hand-written copies of one list, and nothing compared them: a member a producer emits and one
 * reader never heard of makes that reader refuse a valid frame, and the refusal names no member. A generated output
 * that says it is generated, plus `tools/check-generated-artifact-reproducibility.mjs` re-running this producer and
 * comparing the bytes, plus `tools/check-fact-seams.mjs` recording the two outputs as `derives: generated` from the
 * contract, is the shape that keeps them one fact.
 *
 * ONE GENERATOR, NOT ONE PER FACT: the per-fact generator this started as was copied for the second fact and the
 * duplication gate counted the copy (`tools/check-code-duplication.mjs`: the `main`/`render` block at three sites).
 * The contract names its own symbols and output paths, so the generator needs no knowledge of any fact.
 *
 * THE CONTRACT (`contracts/<name>.v1.json`) states:
 *   schema    the contract's own identity, for a reader
 *   purpose   one sentence, emitted as the generated type's doc comment
 *   symbol    the array's name in both languages
 *   type      the member type's name in the host module
 *   members   the closed set, in the order the fact is written
 *   outputs   where `--write` puts each language's module
 *
 * USAGE
 *   node tools/generate-vocabulary.mjs --contract contracts/<name>.v1.json --target ts   # stdout, the host module
 *   node tools/generate-vocabulary.mjs --contract contracts/<name>.v1.json --target mjs  # stdout, the tools module
 *   node tools/generate-vocabulary.mjs --contract contracts/<name>.v1.json --write       # both tracked files
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "tools/generate-vocabulary.mjs";
const TARGETS = Object.freeze(["ts", "mjs"]);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
/** A member is a wire token or a key name: both languages spell it the same way, so this is the whole alphabet. */
const MEMBER = /^[A-Za-z][A-Za-z0-9_]*$/u;

/** The contract as this generator needs it, or a refusal naming what is wrong with the contract. */
export function readContract(contractPath, read = (target) => readFileSync(target, "utf8")) {
  const contract = JSON.parse(read(contractPath));
  for (const key of ["symbol", "type"]) {
    if (typeof contract[key] !== "string" || !IDENTIFIER.test(contract[key]))
      throw new Error(`contract_${key}_not_an_identifier:${String(contract[key])}`);
  }
  const members = contract.members;
  if (!Array.isArray(members) || members.length === 0) throw new Error("contract_members_missing");
  for (const member of members) {
    if (typeof member !== "string" || !MEMBER.test(member))
      throw new Error(`contract_member_not_a_token:${String(member)}`);
  }
  if (new Set(members).size !== members.length) throw new Error("contract_members_duplicated");
  const outputs = contract.outputs ?? {};
  for (const target of TARGETS) {
    if (typeof outputs[target] !== "string" || outputs[target].length === 0)
      throw new Error(`contract_output_missing:${target}`);
  }
  const purpose = typeof contract.purpose === "string" && contract.purpose.length > 0 ? contract.purpose : null;
  return {
    contractPath: path.relative(ROOT, path.resolve(contractPath)).split(path.sep).join("/"),
    purpose,
    symbol: contract.symbol,
    type: contract.type,
    members,
    outputs,
  };
}

/**
 * The generated header: the marker, and the one command that rebuilds every output from its contract.
 *
 * The contract is named ONCE, on the command line. A second line repeating it (`// Source of truth: <path>`) was what
 * the deployment principal's generator wrote, and it made the seam gate's underived direction unreachable: editing
 * that line left the path in the command line above it, so the file still named its contract. Naming it once means a
 * hand edit of any line that carries it is visible.
 */
function header(contract) {
  return [
    "// GENERATED FILE - do not edit.",
    `// Regenerate: node ${SELF} --contract ${contract.contractPath} --write`,
  ];
}

/**
 * The host module's bytes.
 *
 * The array is written on one line because the formatter would collapse it: this text IS the tracked file, so it has to
 * be what `biome format` leaves alone. `tools/check-generated-artifact-reproducibility.mjs` re-runs this producer and
 * compares the bytes, which is what keeps that claim true.
 */
function renderHost(contract) {
  return [
    ...header(contract),
    `export const ${contract.symbol} = [${contract.members.map((member) => `"${member}"`).join(", ")}] as const;`,
    "",
    ...(contract.purpose === null ? [] : [`/** ${contract.purpose} */`]),
    `export type ${contract.type} = (typeof ${contract.symbol})[number];`,
  ].join("\n");
}

function renderTools(contract) {
  return [
    ...header(contract),
    `export const ${contract.symbol} = Object.freeze([${contract.members.map((member) => `"${member}"`).join(", ")}]);`,
  ].join("\n");
}

export function render(contract, target) {
  if (target === "ts") return `${renderHost(contract)}\n`;
  if (target === "mjs") return `${renderTools(contract)}\n`;
  throw new Error(`unknown_target:${String(target)}`);
}

export function writeOutputs(contract) {
  for (const target of TARGETS)
    writeFileSync(path.join(ROOT, contract.outputs[target]), render(contract, target), "utf8");
}

function main(argv) {
  const contractFlag = argv.indexOf("--contract");
  if (contractFlag < 0 || argv[contractFlag + 1] === undefined)
    throw new Error(`usage: node ${SELF} --contract <path> [--target ts|mjs | --write]`);
  const contract = readContract(argv[contractFlag + 1]);
  if (argv.includes("--write")) {
    writeOutputs(contract);
    return 0;
  }
  const targetFlag = argv.indexOf("--target");
  process.stdout.write(render(contract, targetFlag < 0 ? "ts" : argv[targetFlag + 1]));
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
