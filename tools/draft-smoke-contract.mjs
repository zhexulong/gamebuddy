#!/usr/bin/env node
/**
 * DRAFT A CONTRACT FROM A HAND-WRITTEN RUNNER — and refuse rather than guess.
 *
 * WHY. Converting a runner to a contract is a reading of the runner's code, and the thing that makes a conversion
 * batch unsafe is a converter that fills a gap with something plausible: the result looks derived, nobody can tell
 * which fields came from where, and the third hand-written table is born with extra steps. So every field this
 * prints carries the place it was read from - a `file:line` in the runner, or the declaration that owns it - and
 * every field it cannot read is printed as `not_derivable:<field>:<why>` with a non-zero exit. A human fills those
 * in, or decides the runner stays a runner.
 *
 * WHAT IT READS, AND WHERE FROM
 *   action               the file name (`run-stardew-native-local-player-<action>-smoke.mjs`)
 *   expectedReasonCode   the action's own declaration when it is specific; otherwise the literal the runner's
 *                        terminal check compares against
 *   discovery.source     the declaration's `targetFamily`, cross-checked against the projection the runner reads
 *   discovery.cardinality/select   the runner's selector (`length !== 1` -> exactly_one, `find(` -> at_least_one)
 *   discovery.requiredFields       the target fields the request substitutes, plus `targetId` when it is substituted
 *   args                 the runner's `args:` object, one entry at a time: `target.<field>` -> `$target.<field>`,
 *                        a string literal (or a `const` holding one) -> that literal, anything else refused
 *   evidence             a key the runner compares to a constant, or to `String(target.<field>)`/`target.<field>`;
 *                        any other comparison (a count, a delta, a set membership) is refused by name
 *   worldAfter           `every(... targetId !== target.targetId)` -> excludesTarget, `length === 0` -> size 0
 *   stale                a second dispatch plus the refusal codes the runner compares against
 *
 * USAGE
 *   node tools/draft-smoke-contract.mjs tools/run-stardew-native-local-player-shake-tree-smoke.mjs
 *   node tools/draft-smoke-contract.mjs <runner> --check contracts/smoke/<action>.json   # round-trip
 *
 * Exit 0 only when every field was derived; 1 when any field is `not_derivable`; 2 when the runner cannot be read.
 */
import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACTION_SURFACE_PATH,
  deriveActionFacts,
  GENERIC_POSTCONDITION,
  SMOKE_CONTRACT_SCHEMA,
} from "./lib/stardew-action-smoke-contract.mjs";

const RUNNER_NAME = /^run-stardew-native-local-player-([a-z0-9-]+)-smoke\.mjs$/u;

/** One derived value, with the place it was read. */
const derived = (field, value, where) => ({ field, value, where, ok: true });
const refusedField = (field, why, where = null) => ({ field, why, where, ok: false });

function lineOf(source, index) {
  return source.slice(0, index).split("\n").length;
}

/** Strip comments so a described shape is not read as a live one, keeping the line numbers intact. */
function blankComments(source) {
  const lines = source.split("\n");
  let inBlock = false;
  const out = lines.map((line) => {
    const blanked = line.replace(/\/\*[\s\S]*?\*\//gu, (match) => " ".repeat(match.length));
    if (inBlock) {
      const end = blanked.indexOf("*/");
      if (end < 0) return " ".repeat(line.length);
      inBlock = false;
      return `${" ".repeat(end + 2)}${blanked.slice(end + 2)}`;
    }
    const start = blanked.indexOf("/*");
    if (start >= 0 && blanked.indexOf("*/", start) < 0) {
      inBlock = true;
      return `${blanked.slice(0, start)}${" ".repeat(line.length - start)}`;
    }
    const comment = blanked.indexOf("//");
    return comment < 0 ? blanked : `${blanked.slice(0, comment)}${" ".repeat(line.length - comment)}`;
  });
  return out.join("\n");
}

/** The `{...}` body that follows `args:` and the offset it starts at. */
function argsBlock(code) {
  const match = /\bargs:\s*\{/u.exec(code);
  if (match === null) return null;
  let depth = 0;
  let index = match.index + match[0].length - 1;
  const start = index;
  for (; index < code.length; index += 1) {
    if (code[index] === "{") depth += 1;
    else if (code[index] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return { body: code.slice(start + 1, index), offset: start + 1 };
}

/** `const NAME = "literal";` - the only constant form this converter will follow. */
function stringConstant(code, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"\\s*;`, "u").exec(code);
  return match === null ? null : { value: match[1], line: lineOf(code, match.index) };
}

function deriveArgs(code, facts) {
  const block = argsBlock(code);
  if (block === null) return { value: null, fields: [refusedField("args", "no `args:` object literal in the runner")] };
  const fields = [];
  const args = {};
  const declared = facts.argumentSchema;
  for (const entry of block.body.split(/,(?![^(]*\))/u)) {
    const pair = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*:\s*([\s\S]+?)\s*$/u.exec(entry.replace(/\n/gu, " "));
    if (pair === null) continue;
    const [, name, raw] = pair;
    const line = lineOf(code, block.offset + block.body.indexOf(entry));
    if (declared[name] === undefined) continue;
    const substitution = /^(?:[A-Za-z_$][\w$]*\.)?target\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(raw);
    if (substitution !== null) {
      args[name] = `$target.${substitution[1]}`;
      fields.push(derived(`args.${name}`, args[name], `runner:${line}`));
      continue;
    }
    const literal = /^"([^"]*)"$/u.exec(raw);
    if (literal !== null) {
      args[name] = literal[1];
      fields.push(derived(`args.${name}`, args[name], `runner:${line}`));
      continue;
    }
    const constant = /^([A-Za-z_$][\w$]*)$/u.exec(raw) === null ? null : stringConstant(code, raw);
    if (constant !== null) {
      args[name] = constant.value;
      fields.push(derived(`args.${name}`, args[name], `runner:${constant.line}`));
      continue;
    }
    fields.push(
      refusedField(
        `args.${name}`,
        `value '${raw.trim()}' is computed at run time, so the contract cannot carry it`,
        `runner:${line}`,
      ),
    );
  }
  const missing = Object.keys(declared).filter((name) => args[name] === undefined);
  for (const name of missing)
    fields.push(refusedField(`args.${name}`, "the runner never sends this declared argument"));
  return { value: args, fields };
}

function deriveDiscovery(code, facts, args) {
  const fields = [];
  if (facts.targetFamily === null)
    return { value: null, fields: [refusedField("discovery.source", "the declaration names no targetFamily")] };
  const read = new RegExp(`\\.${facts.targetFamily}\\b`, "u").exec(code);
  // A selector helper that takes the projection's NAME as a string (`chooseAdjacent(snapshot, "bushTargets")`)
  // names the same fact; both forms are read, and a runner that does neither is refused rather than assumed to
  // read the declaration's family by default.
  const named = new RegExp(`"${facts.targetFamily}"`, "u").exec(code);
  const site = read ?? named;
  if (site === null)
    return {
      value: null,
      fields: [
        refusedField(
          "discovery.source",
          `the runner neither reads .${facts.targetFamily} nor names "${facts.targetFamily}"`,
        ),
      ],
    };
  fields.push(
    derived(
      "discovery.source",
      facts.targetFamily,
      `declaration:${basename(ACTION_SURFACE_PATH)} + runner:${lineOf(code, site.index)}`,
    ),
  );

  const exactlyOne = /\.length\s*!==\s*1\b|\.length\s*===\s*1\b/u.exec(code);
  const find = /\.find\s*\(/u.exec(code);
  let cardinality = null;
  let select = null;
  if (exactlyOne !== null) {
    cardinality = "exactly_one";
    select = "only";
    fields.push(derived("discovery.cardinality", cardinality, `runner:${lineOf(code, exactlyOne.index)}`));
    fields.push(derived("discovery.select", select, `runner:${lineOf(code, exactlyOne.index)}`));
  } else if (find !== null) {
    cardinality = "at_least_one";
    select = "first";
    fields.push(derived("discovery.cardinality", cardinality, `runner:${lineOf(code, find.index)}`));
    fields.push(derived("discovery.select", select, `runner:${lineOf(code, find.index)}`));
  } else {
    fields.push(refusedField("discovery.cardinality", "no selector shape (a `length !== 1` count or a `find(`)"));
  }

  const requiredFields = [
    ...new Set(
      Object.values(args)
        .filter((value) => typeof value === "string" && value.startsWith("$target."))
        .map((value) => value.slice("$target.".length)),
    ),
  ].sort();
  fields.push(derived("discovery.requiredFields", requiredFields, "the substituted target fields in args"));
  return { value: { cardinality, select, requiredFields }, fields };
}

function deriveReasonCode(code, facts) {
  if (facts.expectedReasonCode !== null)
    return {
      value: facts.expectedReasonCode,
      fields: [
        derived(
          "expectedReasonCode",
          facts.expectedReasonCode,
          `declaration:postcondition.name:${facts.declaredPostcondition}`,
        ),
      ],
    };
  if (facts.declaredPostcondition !== GENERIC_POSTCONDITION)
    return {
      value: null,
      fields: [refusedField("expectedReasonCode", `postcondition '${facts.declaredPostcondition}'`)],
    };
  const match =
    /(?:terminal\??\.)?reasonCode\s*[!=]==\s*"([a-z][a-z0-9_]*)"|"([a-z][a-z0-9_]*)"\s*[!=]==\s*(?:terminal\??\.)?reasonCode/u.exec(
      code,
    );
  if (match === null)
    return {
      value: null,
      fields: [
        refusedField(
          "expectedReasonCode",
          `the declaration is ${GENERIC_POSTCONDITION} and no terminal reasonCode literal is compared`,
        ),
      ],
    };
  const word = match[1] ?? match[2];
  return { value: word, fields: [derived("expectedReasonCode", word, `runner:${lineOf(code, match.index)}`)] };
}

const EVIDENCE_EQUALS =
  /(?:assertEvidence\(\s*evidence\s*,\s*"([a-z0-9_]+)"\s*,\s*"([^"]*)"\s*\)|evidence\.([a-z0-9_]+)\s*===\s*"([^"]*)")/gu;
const EVIDENCE_TARGET =
  /(?:assertEvidence\(\s*evidence\s*,\s*"([a-z0-9_]+)"\s*,\s*target\.([A-Za-z][A-Za-z0-9_]*)\s*\)|evidence\.([a-z0-9_]+)\s*===\s*String\(target\.([A-Za-z][A-Za-z0-9_]*)\)|evidence\.([a-z0-9_]+)\s*===\s*target\.([A-Za-z][A-Za-z0-9_]*)(?![.\w(]))/gu;

function deriveEvidence(code) {
  const fields = [];
  const evidence = {};
  for (const match of code.matchAll(EVIDENCE_EQUALS)) {
    const key = match[1] ?? match[3];
    const value = match[2] ?? match[4];
    evidence[key] = value;
    fields.push(derived(`evidence.${key}`, value, `runner:${lineOf(code, match.index)}`));
  }
  for (const match of code.matchAll(EVIDENCE_TARGET)) {
    const key = match[1] ?? match[3] ?? match[5];
    const targetField = match[2] ?? match[4] ?? match[6];
    evidence[key] = { equalsTarget: targetField };
    fields.push(derived(`evidence.${key}`, `$target.${targetField}`, `runner:${lineOf(code, match.index)}`));
  }
  const known = new Set([...Object.keys(evidence), "detail"]);
  for (const match of code.matchAll(/evidence\.([a-z0-9_]+)/gu)) {
    const key = match[1];
    if (known.has(key)) continue;
    const line = lineOf(code, match.index);
    const lineText = code.split("\n")[line - 1] ?? "";
    if (!lineText.includes(`evidence.${key}`)) continue;
    fields.push(
      refusedField(
        `evidence.${key}`,
        "the runner compares this key to something data cannot carry (a number, a delta or another key)",
        `runner:${line}`,
      ),
    );
    known.add(key);
  }
  return { value: evidence, fields };
}

/** The published field a `.every(`/`.some(` runs over: the nearest `<src>.<field>` in front of it. */
function fieldBefore(code, index) {
  const window = code.slice(Math.max(0, index - 200), index);
  const matches = [
    ...window.matchAll(/\b(?:snapshot|after|settled|latest|current|before)\.([A-Za-z][A-Za-z0-9_]*)\b/gu),
  ];
  return matches.length === 0 ? null : matches[matches.length - 1][1];
}

function deriveWorldAfter(code) {
  const fields = [];
  const worldAfter = [];
  const everyForm = /\.every\(\s*\(?\s*\w+\s*\)?\s*=>\s*\w+\??\.targetId\s*!==\s*target\.targetId/u.exec(code);
  const someForm = /\.some\(\s*\(?\w+\)?\s*=>\s*\w+\??\.targetId\s*===\s*target\.targetId/u.exec(code);
  const excludes = everyForm ?? someForm;
  if (excludes !== null) {
    const field = fieldBefore(code, excludes.index);
    const line = lineOf(code, excludes.index);
    const refusedBecauseTheTargetSurvives =
      everyForm === null &&
      !/throw\b/u.test(
        code
          .split("\n")
          .slice(line - 1, line + 2)
          .join("\n"),
      );
    if (field === null)
      fields.push(
        refusedField(
          "worldAfter.excludesTarget",
          "the target set is read through an unnamed expression",
          `runner:${line}`,
        ),
      );
    else if (refusedBecauseTheTargetSurvives)
      fields.push(
        refusedField(
          `worldAfter.${field}.excludesTarget`,
          "the runner reads this set but does not refuse a still-advertised target",
          `runner:${line}`,
        ),
      );
    else {
      worldAfter.push({ field, excludesTarget: true });
      fields.push(derived(`worldAfter.${field}.excludesTarget`, true, `runner:${line}`));
    }
  }
  const empty = /\.length\s*===\s*0/u.exec(code);
  if (empty !== null) {
    const field = fieldBefore(code, empty.index);
    const line = lineOf(code, empty.index);
    // A count of zero on no published field is an evidence parser or a key-set check, not a world claim: this
    // converter says nothing about it rather than inventing an assertion for some other list.
    if (field !== null) {
      worldAfter.push({ field, size: 0 });
      fields.push(derived(`worldAfter.${field}.size`, 0, `runner:${line}`));
    }
  }
  const rowAtTile = /\.find\(\s*\(?\w+\)?\s*=>\s*\w+\??\.x\s*===\s*target\.x/u.exec(code);
  if (rowAtTile !== null)
    fields.push(
      refusedField(
        "worldAfter.rowAtTargetTile",
        "the runner compares the row standing on the target tile field by field; name the fields by hand",
        `runner:${lineOf(code, rowAtTile.index)}`,
      ),
    );
  return { value: worldAfter, fields };
}

function deriveStale(code, args) {
  const fields = [];
  const dispatches = [...code.matchAll(/executeFresh(?:AfterReobserve)?\s*\(/gu)];
  if (dispatches.length < 2) return { value: null, fields };
  const list = /const\s+(?:STALE_)?REFUSALS?\w*\s*=\s*\[([^\]]*)\]/u.exec(code);
  const inline = /\[((?:\s*"[a-z][a-z0-9_]*"\s*,?\s*){1,})\]\s*\.includes\s*\(/u.exec(code);
  // A single code compared once after the second dispatch is the same fact as a list of one.
  const single =
    /(?:stale|repeat)\w*\??\.reasonCode\s*[!=]==\s*"([a-z][a-z0-9_]*)"|reasonCode\s*[!=]==\s*"([a-z][a-z0-9_]*)"/u.exec(
      code.slice(dispatches[1].index),
    );
  const source = list ?? inline;
  if (source === null && single !== null) {
    const word = single[1] ?? single[2];
    fields.push(derived("stale.refusedWith", [word], `runner:${lineOf(code, dispatches[1].index + single.index)}`));
    return { value: { refusedWith: [word] }, fields };
  }
  if (source === null) {
    fields.push(
      refusedField(
        "stale.refusedWith",
        `the runner dispatches ${dispatches.length} frames but names no refusal list`,
        `runner:${lineOf(code, dispatches[1].index)}`,
      ),
    );
    return { value: null, fields };
  }
  const refusedWith = [...source[1].matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1]);
  fields.push(derived("stale.refusedWith", refusedWith, `runner:${lineOf(code, source.index)}`));
  return { value: { refusedWith }, fields };
}

/** The draft contract plus the provenance of every field in it. */
export function draftContract(runnerPath, { facts = null } = {}) {
  const absolute = resolve(runnerPath);
  const name = basename(absolute);
  const nameMatch = RUNNER_NAME.exec(name);
  if (nameMatch === null) throw new Error(`draft_not_a_native_local_runner:${name}`);
  const actionId = nameMatch[1].replaceAll("-", "_");
  const source = readFileSync(absolute, "utf8");
  const code = blankComments(source);
  const actionFacts = facts ?? deriveActionFacts(actionId);

  const reason = deriveReasonCode(code, actionFacts);
  const args = deriveArgs(code, actionFacts);
  const discovery = deriveDiscovery(code, actionFacts, args.value ?? {});
  const evidence = deriveEvidence(code);
  const worldAfter = deriveWorldAfter(code);
  const stale = deriveStale(code, args.value ?? {});

  const contract = { schema: SMOKE_CONTRACT_SCHEMA, action: actionId };
  // Only a declaration too generic to name a success word may carry one in the contract, so only then is it written;
  // when it is derived, writing it would be the redeclaration `validateSmokeContract` refuses.
  if (actionFacts.expectedReasonCode === null && reason.value !== null) contract.expectedReasonCode = reason.value;
  if (discovery.value !== null)
    contract.discovery = Object.fromEntries(
      Object.entries(discovery.value).filter(([, value]) => value !== null && value !== undefined),
    );
  if (args.value !== null) contract.args = args.value;
  if (Object.keys(evidence.value).length > 0) contract.evidence = evidence.value;
  if (worldAfter.value.length > 0) contract.worldAfter = worldAfter.value;
  if (stale.value !== null) contract.stale = stale.value;

  const fields = [
    derived("action", actionId, `runner:${name}`),
    ...reason.fields,
    ...discovery.fields,
    ...args.fields,
    ...evidence.fields,
    ...worldAfter.fields,
    ...stale.fields,
  ];
  return { action: actionId, runner: absolute, contract, fields, complete: fields.every((field) => field.ok) };
}

/** Where one contract's own values differ from the draft's, field by field. */
export function compareContracts(draft, existing) {
  const differences = [];
  const walk = (path, left, right) => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    const isObject = (value) => typeof value === "object" && value !== null;
    if (isObject(left) && isObject(right) && !Array.isArray(left) && !Array.isArray(right)) {
      for (const key of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort())
        walk(path === "" ? key : `${path}.${key}`, left[key], right[key]);
      return;
    }
    differences.push({ field: path, draft: left ?? "<absent>", contract: right ?? "<absent>" });
  };
  walk("", draft, existing);
  return differences;
}

function main(argv) {
  const runnerPath = argv[0];
  if (runnerPath === undefined) {
    process.stderr.write("usage: node tools/draft-smoke-contract.mjs <runner-path> [--check <contract.json>]\n");
    return 2;
  }
  let draft;
  try {
    draft = draftContract(runnerPath);
  } catch (error) {
    process.stderr.write(`${String(error?.message ?? error)}\n`);
    return 2;
  }
  process.stdout.write(`${JSON.stringify(draft.contract, null, 2)}\n`);
  process.stdout.write("\n# where each field was read\n");
  for (const field of draft.fields) {
    process.stdout.write(
      field.ok
        ? `  derived  ${field.field} = ${JSON.stringify(field.value)}  <- ${field.where}\n`
        : `  not_derivable:${field.field}:${field.why}${field.where === null ? "" : `  <- ${field.where}`}\n`,
    );
  }
  const checkIndex = argv.indexOf("--check");
  if (checkIndex >= 0) {
    const existingPath = argv[checkIndex + 1];
    const existing = JSON.parse(readFileSync(resolve(existingPath), "utf8"));
    const differences = compareContracts(draft.contract, existing);
    if (differences.length === 0) {
      process.stdout.write(`\nround_trip: identical to ${existingPath}\n`);
    } else {
      process.stdout.write(`\nround_trip: ${differences.length} field(s) differ from ${existingPath}\n`);
      for (const difference of differences)
        process.stdout.write(
          `  differs  ${difference.field}: draft=${JSON.stringify(difference.draft)} contract=${JSON.stringify(difference.contract)}\n`,
        );
    }
  }
  const refused = draft.fields.filter((field) => !field.ok);
  process.stdout.write(
    `\n${refused.length === 0 ? "complete" : `refused ${refused.length} field(s)`}: ` +
      `${draft.fields.length - refused.length} derived, ${refused.length} not_derivable\n`,
  );
  return refused.length === 0 ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = main(process.argv.slice(2));
