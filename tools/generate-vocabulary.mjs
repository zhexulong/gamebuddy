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
 *   purpose   one sentence, emitted as the generated symbol's doc comment
 *   members   the closed set, in the order the fact is written
 *   outputs   one entry per target: where `--write` puts it, and what it is CALLED there
 *
 * The contract states no symbol of its own, because one fact rarely has one name on both sides: the Host's TypeBox
 * union is `StardewCabinOccupancyUnknownReasonV1` and the browser's array is `CABIN_OCCUPANCY_UNKNOWN_REASONS`. Each
 * output therefore names its own `symbol` - and its own `type`, where that target declares one - rather than the
 * contract carrying a name that half its outputs would override.
 *
 * TARGETS. `typebox` is the Host's `Type.Union([Type.Literal(...)])`: the members stay LITERAL types, because
 * `Type.Literal(value)` over a value a JSON import types as `string[]` widens `Static<>` to `string`, and the answer
 * schemas embedding these unions would stop being the wire's closed set. `ts` is the `as const` array both TypeScript
 * packages read, and `mjs` the plain ESM array the `tools/` tree reads, which carries no types at all. A contract
 * names only the targets it needs.
 *
 * USAGE
 *   node tools/generate-vocabulary.mjs --contract contracts/<name>.v1.json --target typebox  # stdout, one output
 *   node tools/generate-vocabulary.mjs --contract contracts/<name>.v1.json --target mjs      # stdout, one output
 *   node tools/generate-vocabulary.mjs --contract contracts/<name>.v1.json --write           # every declared output
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SELF = "tools/generate-vocabulary.mjs";

/**
 * The targets a contract may name, and whether that target declares a type beside its value.
 *
 * A target is a language shape, not a package: `typebox` and `ts` are both TypeScript, and which package an output
 * lands in is its `path`. `mjs` is the plain ESM array the `tools/` tree reads, which has no types at all.
 */
const TARGETS = Object.freeze({ mjs: { typed: false }, ts: { typed: true }, typebox: { typed: true } });

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/u;
/** A member is a wire token or a key name: both languages spell it the same way, so this is the whole alphabet. */
const MEMBER = /^[A-Za-z][A-Za-z0-9_]*$/u;
/**
 * The formatter's line width (`biome.json`). The tracked file IS the generated text, so a line the formatter would
 * rewrap is a byte that does not reproduce - and the reproducibility gate compares bytes.
 */
const LINE_WIDTH = 120;

/** The contract as this generator needs it, or a refusal naming what is wrong with the contract. */
export function readContract(contractPath, read = (target) => readFileSync(target, "utf8")) {
  const contract = JSON.parse(read(contractPath));
  const members = contract.members;
  if (!Array.isArray(members) || members.length === 0) throw new Error("contract_members_missing");
  for (const member of members) {
    if (typeof member !== "string" || !MEMBER.test(member))
      throw new Error(`contract_member_not_a_token:${String(member)}`);
  }
  if (new Set(members).size !== members.length) throw new Error("contract_members_duplicated");
  const declared = contract.outputs;
  if (typeof declared !== "object" || declared === null || Object.keys(declared).length === 0)
    throw new Error("contract_outputs_missing");
  const outputs = {};
  for (const [target, output] of Object.entries(declared)) {
    const shape = TARGETS[target];
    if (shape === undefined) throw new Error(`contract_output_unknown_target:${target}`);
    if (typeof output?.path !== "string" || output.path.length === 0)
      throw new Error(`contract_output_missing:${target}`);
    if (typeof output.symbol !== "string" || !IDENTIFIER.test(output.symbol))
      throw new Error(`contract_symbol_not_an_identifier:${target}:${String(output.symbol)}`);
    if (shape.typed && (typeof output.type !== "string" || !IDENTIFIER.test(output.type)))
      throw new Error(`contract_type_not_an_identifier:${target}:${String(output.type)}`);
    outputs[target] = { path: output.path, symbol: output.symbol, type: shape.typed ? output.type : null };
  }
  const purpose = typeof contract.purpose === "string" && contract.purpose.length > 0 ? contract.purpose : null;
  return {
    contractPath: path.relative(ROOT, path.resolve(contractPath)).split(path.sep).join("/"),
    purpose,
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
 * One declaration, on one line when that line fits the formatter's width and one member per line when it does not.
 *
 * `biome format` rewraps a longer line, so the generator has to make the same decision it makes; otherwise the tracked
 * bytes are not what the formatter leaves and the reproducibility gate disagrees with the producer.
 */
function declared(head, tail, elements) {
  const inline = `${head}${elements.join(", ")}${tail}`;
  if (inline.length <= LINE_WIDTH) return [inline];
  return [head, ...elements.map((element) => `  ${element},`), tail];
}

const quoted = (contract) => contract.members.map((member) => `"${member}"`);
const purpose = (contract) => (contract.purpose === null ? [] : [`/** ${contract.purpose} */`]);

/** The `as const` array: what both TypeScript packages read, and the type of its own members. */
function renderTs(contract, output) {
  return [
    ...header(contract),
    ...declared(`export const ${output.symbol} = [`, "] as const;", quoted(contract)),
    "",
    ...purpose(contract),
    `export type ${output.type} = (typeof ${output.symbol})[number];`,
  ].join("\n");
}

/** The Host's TypeBox union: one `Type.Literal` per member, so `Static<>` is the closed union the wire validates. */
function renderTypebox(contract, output) {
  return [
    ...header(contract),
    'import { type Static, Type } from "typebox";',
    "",
    ...purpose(contract),
    ...declared(
      `export const ${output.symbol} = Type.Union([`,
      "]);",
      contract.members.map((member) => `Type.Literal("${member}")`),
    ),
    `export type ${output.type} = Static<typeof ${output.symbol}>;`,
  ].join("\n");
}

function renderMjs(contract, output) {
  return [
    ...header(contract),
    ...declared(`export const ${output.symbol} = Object.freeze([`, "]);", quoted(contract)),
  ].join("\n");
}

const RENDERERS = Object.freeze({ mjs: renderMjs, ts: renderTs, typebox: renderTypebox });

export function render(contract, target) {
  const output = contract.outputs[target];
  const renderer = RENDERERS[target];
  if (output === undefined || renderer === undefined) throw new Error(`contract_output_missing:${String(target)}`);
  return `${renderer(contract, output)}\n`;
}

export function writeOutputs(contract) {
  for (const target of Object.keys(contract.outputs))
    writeFileSync(path.join(ROOT, contract.outputs[target].path), render(contract, target), "utf8");
}

function main(argv) {
  const contractFlag = argv.indexOf("--contract");
  if (contractFlag < 0 || argv[contractFlag + 1] === undefined)
    throw new Error(`usage: node ${SELF} --contract <path> [--target typebox|ts|mjs | --write]`);
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
