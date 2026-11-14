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
 *   discovery.source     the declaration's `targetFamily`, cross-checked against the projection the runner reads;
 *                        an action whose declaration names no family gets the format's `none` shape, in words
 *   discovery.cardinality/select   the runner's selector (`length !== 1` -> exactly_one, `find(` -> at_least_one)
 *   discovery.requiredFields       the target fields the request substitutes, plus `targetId` when it is substituted
 *   args                 the argument object of the request that names THIS action - written inline in an
 *                        `executeFresh(client, { action, args })` object, passed positionally to a local helper that
 *                        takes `args`, or held in a `const` either of those names - one entry at a time:
 *                        `<binding>.<field>` -> `$target.<field>` when the binding is proven to hold this action's
 *                        discovered row, a string literal (or a `const` holding one) -> that literal, anything else
 *                        refused. Two sites that disagree, a spread, a value built at run time: refused by name.
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
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ACTION_SURFACE_PATH,
  deriveActionFacts,
  GENERIC_POSTCONDITION,
  SMOKE_CONTRACT_SCHEMA,
  validateSmokeContract,
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

/** The offset just past the bracket that opens at `open`, or -1 when it never closes. */
function endOfBracket(code, open) {
  let depth = 0;
  let quote = null;
  for (let index = open; index < code.length; index += 1) {
    const char = code[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** The top-level comma-separated pieces between `from` and `to`, each with where its own text starts. */
function pieces(code, from, to) {
  const out = [];
  let start = from;
  let depth = 0;
  let quote = null;
  const push = (end) => {
    const raw = code.slice(start, end);
    const text = raw.trim();
    if (text.length > 0) out.push({ text, start: start + (raw.length - raw.trimStart().length) });
  };
  for (let index = from; index < to; index += 1) {
    const char = code[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") quote = char;
    else if (char === "(" || char === "[" || char === "{") depth += 1;
    else if (char === ")" || char === "]" || char === "}") depth -= 1;
    else if (char === "," && depth === 0) {
      push(index);
      start = index + 1;
    }
  }
  push(to);
  return out;
}

/** Where an initializer written at `from` ends: a `;` at the top level, or a line break that ends the expression. */
function statementEnd(code, from) {
  let depth = 0;
  let quote = null;
  let seen = false;
  for (let index = from; index < code.length; index += 1) {
    const char = code[index];
    if (quote !== null) {
      if (char === "\\") index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      seen = true;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      seen = true;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth -= 1;
      seen = true;
      continue;
    }
    if (depth !== 0) continue;
    if (char === ";") return index;
    if (char === "\n" && seen && !/[=+*/?:,.&|>([{-]$/u.test(code.slice(from, index).trimEnd())) return index;
  }
  return code.length;
}

/** Every `const|let|var NAME = <initializer>` in the file, in source order, with the initializer's own text. */
function initializers(code, name) {
  const found = [];
  for (const match of code.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*`, "gu"))) {
    const from = match.index + match[0].length;
    const end = statementEnd(code, from);
    const raw = code.slice(from, end);
    found.push({ text: raw.trim(), start: from + (raw.length - raw.trimStart().length), end });
  }
  return found;
}

/** A local function's own body, when the runner declares one under that name. */
function localFunctionBody(code, name) {
  const match = new RegExp(`(?:^|[^\\w$.])(?:async\\s+)?function\\s+${name}\\s*\\(`, "u").exec(code);
  if (match === null) return null;
  const paramsEnd = endOfBracket(code, match.index + match[0].length - 1);
  const bodyOpen = paramsEnd < 0 ? -1 : code.indexOf("{", paramsEnd);
  if (bodyOpen < 0) return null;
  return code.slice(bodyOpen, endOfBracket(code, bodyOpen));
}

const TARGET_BINDING_DEPTH = 4;

/**
 * The name the format's own `$target` substitution was read from before this reader could prove anything.
 *
 * It keeps its meaning unchanged: `target.<field>` was a target field when this converter could not tell a target
 * from a tool, and requiring proof for the conventional spelling would refuse fields the format already carried. A
 * tightening that turns a derived field into a refusal is not free - a refusal cannot be told apart from "the runner
 * never sends this argument". Any OTHER name is new ground, so it is proven.
 */
const CONVENTIONAL_TARGET_NAME = "target";

/**
 * Whether `text` reads the declared discovery family, directly, through a local helper, or through another name.
 *
 * `scope` is the text whose own declarations a name resolves against - the enclosing helper body when this came from
 * a helper, the whole runner when it came from the request. Resolving against the whole file from inside a helper is
 * the first reading of this probe and it is wrong: `targets` is a different local in every helper.
 */
function namesFamily(scope, code, family, text, depth = 0, seen = new Set()) {
  if (depth > TARGET_BINDING_DEPTH) return false;
  if (new RegExp(`\\.${family}\\b`, "u").test(text) || text.includes(`"${family}"`)) return true;
  for (const match of text.matchAll(/([A-Za-z_$][\w$]*)/gu)) {
    const word = match[1];
    if (word === family || seen.has(word)) continue;
    seen.add(word);
    const declared = initializers(scope, word);
    if (declared.length > 0) {
      if (declared.every((entry) => namesFamily(scope, code, family, entry.text, depth + 1, seen))) return true;
      continue;
    }
    const body = localFunctionBody(code, word);
    if (body !== null && namesFamily(body, code, family, body, depth + 1, seen)) return true;
  }
  return false;
}

/**
 * Whether a name holds the row this slice discovered - the only thing `<name>.<field>` may stand for.
 *
 * The proof is the declaration's own `targetFamily` appearing in the name's initializer chain: `const target =
 * (snapshot.cropTargets ?? []).find(...)`, or `const target = chooseOnlyReachableCrop(snapshot)` where that helper
 * reads `.cropTargets` through `validCropTargets`. A name with no initializer, an initializer from an import, or two
 * initializers that disagree is NOT proven, and the caller refuses that field instead of calling it the target's.
 */
function holdsTargetRow(scope, code, family, name, depth = 0) {
  if (family === null || depth > TARGET_BINDING_DEPTH) return false;
  const declared = initializers(scope, name);
  if (declared.length === 0) return false;
  return declared.every((entry) => namesFamily(scope, code, family, entry.text, depth));
}

/** The object literal whose body holds `index`, or null when `index` sits outside every brace body. */
function enclosingObject(code, index) {
  for (let at = code.lastIndexOf("{", index); at >= 0; at = code.lastIndexOf("{", at - 1)) {
    const end = endOfBracket(code, at);
    if (end > index) return { start: at, end: end - 1 };
  }
  return null;
}

/** The properties written at the top level of one object literal, in source order. */
function objectProperties(code, object) {
  return pieces(code, object.start + 1, object.end).map((piece) => {
    const pair = /^([A-Za-z_$][\w$]*)\s*:\s*([\s\S]+)$/u.exec(piece.text);
    if (pair !== null) return { key: pair[1], value: pair[2].trim(), start: piece.start, shorthand: false };
    const shorthand = /^([A-Za-z_$][\w$]*)$/u.exec(piece.text);
    if (shorthand !== null) return { key: shorthand[1], value: shorthand[1], start: piece.start, shorthand: true };
    return { key: null, value: piece.text, start: piece.start, shorthand: false };
  });
}

/** The parameter names of the innermost function whose body holds `index`, or none when it sits outside every one. */
function enclosingParameters(code, index) {
  let found = { bodyOpen: -1, params: [] };
  for (const match of code.matchAll(/(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(/gu)) {
    const paramsOpen = match.index + match[0].length - 1;
    const paramsEnd = endOfBracket(code, paramsOpen);
    if (paramsEnd < 0) continue;
    const bodyOpen = code.indexOf("{", paramsEnd);
    if (bodyOpen < 0 || bodyOpen > index || bodyOpen <= found.bodyOpen) continue;
    found = {
      bodyOpen,
      params: pieces(code, paramsOpen + 1, paramsEnd - 1).map((piece) =>
        piece.text.replace(/\s*=[\s\S]*$/u, "").trim(),
      ),
    };
  }
  return found.params;
}

/**
 * Where the runner writes the argument object for `actionId`.
 *
 * Two shapes carry a request, and reading only one of them is what made `args` look underivable in 26 runners:
 *
 *   `executeFresh(client, { action: "<this action>", args: {...} })`   the object is written inline
 *   `execute(client, trace, phase, "<this action>", {...}, snapshot)`  a local helper takes `action` and `args`
 *   `request(client, receipts, timeout, {...})`                        a local helper takes `args` and dispatches
 *
 * The action is matched by VALUE (a string literal, or a `const` holding one), never by position, so a runner's
 * `equip_tool` prerequisite request cannot be mistaken for its own slice.
 */
function argumentSites(code, actionId) {
  const constants = new Map(
    [...code.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*"([^"]*)"\s*;/gu)].map((match) => [match[1], match[2]]),
  );
  const namesAction = (expression) => {
    const text = String(expression).trim();
    const literal = /^"([^"]*)"$/u.exec(text);
    if (literal !== null) return literal[1] === actionId;
    const identifier = /^([A-Za-z_$][\w$]*)$/u.exec(text);
    return identifier !== null && constants.get(identifier[1]) === actionId;
  };
  const sites = [];
  for (const match of code.matchAll(/\baction\s*:/gu)) {
    const object = enclosingObject(code, match.index);
    if (object === null) continue;
    const properties = objectProperties(code, object);
    const declared = properties.find((property) => property.key === "action");
    const args = properties.find((property) => property.key === "args");
    if (declared === undefined || args === undefined) continue;
    if (!namesAction(declared.value)) continue;
    // `{ action: ACTION, args }` inside a helper names the caller's argument: the expression that matters is what
    // each call site passes, so that site is left to the call-site reading below instead of being refused here.
    if (/^[A-Za-z_$][\w$]*$/u.test(args.value) && enclosingParameters(code, args.start).includes(args.value)) continue;
    sites.push({ start: args.start, expression: args.value });
  }
  for (const match of code.matchAll(/(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gu)) {
    const name = match[1];
    const nameAt = match.index + match[0].lastIndexOf(name);
    const paramsOpen = match.index + match[0].length - 1;
    const paramsEnd = endOfBracket(code, paramsOpen);
    if (paramsEnd < 0) continue;
    const params = pieces(code, paramsOpen + 1, paramsEnd - 1).map((piece) =>
      piece.text.replace(/\s*=[\s\S]*$/u, "").trim(),
    );
    const argsIndex = params.indexOf("args");
    if (argsIndex < 0) continue;
    const bodyOpen = code.indexOf("{", paramsEnd);
    if (bodyOpen < 0) continue;
    const body = code.slice(bodyOpen, endOfBracket(code, bodyOpen));
    const actionIndex = params.indexOf("action");
    const dispatchesAction =
      actionIndex < 0 && [...body.matchAll(/\baction\s*:\s*([^,\n}]+)/gu)].some((entry) => namesAction(entry[1]));
    if (actionIndex < 0 && !dispatchesAction) continue;
    for (const call of code.matchAll(new RegExp(`(?:^|[^\\w$.])${name}\\s*\\(`, "gu"))) {
      const at = call.index + call[0].lastIndexOf(name);
      if (at === nameAt) continue;
      const open = call.index + call[0].length - 1;
      const close = endOfBracket(code, open);
      if (close < 0) continue;
      const passed = pieces(code, open + 1, close - 1);
      if (passed.length <= argsIndex) continue;
      if (actionIndex >= 0 && !namesAction(passed[actionIndex].text)) continue;
      sites.push({ start: passed[argsIndex].start, expression: passed[argsIndex].text });
    }
  }
  return sites;
}

const ARGUMENT_RESOLUTION_DEPTH = 4;

/** The object literal a site's expression names, or the reason it cannot be read as one. */
function argumentObject(code, site) {
  let text = site.expression.trim();
  let start = site.start;
  for (let depth = 0; depth < ARGUMENT_RESOLUTION_DEPTH; depth += 1) {
    const frozen = /^Object\.freeze\s*\(\s*([\s\S]*?)\s*\)$/u.exec(text);
    if (frozen !== null) {
      text = frozen[1].trim();
      continue;
    }
    if (text.startsWith("{")) {
      const open = code.indexOf("{", start);
      const end = open < 0 ? -1 : endOfBracket(code, open);
      if (end < 0) return { why: "the request's argument object literal is not closed" };
      return { object: { start: open, end: end - 1 } };
    }
    const identifier = /^([A-Za-z_$][\w$]*)$/u.exec(text);
    if (identifier === null) return { why: `the request's argument object is \`${text}\`, computed at run time` };
    const binding = initializers(code, identifier[1])
      .filter((entry) => entry.start < start)
      .at(-1);
    if (binding === undefined)
      return { why: `the request's argument object is \`${text}\`, which the runner builds outside this file` };
    text = binding.text;
    start = binding.start;
  }
  return { why: "the request's argument object is assembled through more indirection than this reader follows" };
}

/** `const NAME = "literal";` - the only constant form this converter will follow. */
function stringConstant(code, name) {
  const match = new RegExp(`const\\s+${name}\\s*=\\s*"([^"]*)"\\s*;`, "u").exec(code);
  return match === null ? null : { value: match[1], line: lineOf(code, match.index) };
}

function deriveArgs(code, facts) {
  const sites = argumentSites(code, facts.actionId);
  if (sites.length === 0)
    return {
      value: null,
      fields: [
        refusedField(
          "args",
          `no request in the runner dispatches '${facts.actionId}' with an argument object (no \`executeFresh(client, { action, args })\` object and no local helper taking \`args\`)`,
        ),
      ],
    };
  const readings = sites.map((site) => {
    const found = argumentObject(code, site);
    if (found.object === undefined) return { why: found.why, start: site.start };
    const properties = objectProperties(code, found.object);
    const spread = properties.find((property) => property.key === null);
    if (spread !== undefined)
      return { why: `the request's argument object spreads \`${spread.value}\``, start: spread.start };
    return { entries: properties, start: found.object.start };
  });
  const unreadable = readings.find((reading) => reading.why !== undefined);
  if (unreadable !== undefined)
    return {
      value: null,
      fields: [refusedField("args", unreadable.why, `runner:${lineOf(code, unreadable.start)}`)],
    };
  const shapes = new Set(
    readings.map((reading) => JSON.stringify(reading.entries.map((entry) => [entry.key, entry.value]))),
  );
  if (shapes.size > 1) {
    const where = readings.map((reading) => `runner:${lineOf(code, reading.start)}`).join(", ");
    return {
      value: null,
      fields: [
        refusedField(
          "args",
          `the runner dispatches '${facts.actionId}' from ${readings.length} sites whose argument objects differ (${where}); a contract states one request`,
        ),
      ],
    };
  }
  const fields = [];
  const args = {};
  const declared = facts.argumentSchema;
  for (const entry of readings[0].entries) {
    const name = entry.key;
    const raw = entry.value.trim();
    const line = lineOf(code, entry.start);
    if (declared[name] === undefined) continue;
    if (args[name] !== undefined) {
      fields.push(refusedField(`args.${name}`, "the runner's argument object names this key twice", `runner:${line}`));
      continue;
    }
    const substitution = /^([A-Za-z_$][\w$]*)\.([A-Za-z][A-Za-z0-9_]*)$/u.exec(raw);
    if (
      substitution !== null &&
      (substitution[1] === CONVENTIONAL_TARGET_NAME || holdsTargetRow(code, code, facts.targetFamily, substitution[1]))
    ) {
      args[name] = `$target.${substitution[2]}`;
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
        entry.shorthand
          ? `the runner passes \`${raw}\` by shorthand and its value is chosen at run time`
          : `value '${raw}' is computed at run time, so the contract cannot carry it`,
        `runner:${line}`,
      ),
    );
  }
  const missing = Object.keys(declared).filter((name) => args[name] === undefined);
  for (const name of missing)
    fields.push(refusedField(`args.${name}`, "the runner never sends this declared argument"));
  return { value: args, fields };
}

/**
 * What a draft says when the action's own declaration names no target: the format's `none` shape, in words.
 *
 * Omitting the block instead was the converter bug this comment replaces - ten runners whose action carries no
 * `targetFamily` (`craft_item`, `ride_bus`, `open_geode`, ...) drafted a contract that could not load at all, and
 * the format already had a shape for their case. The words have to say WHY, because `discovery: null` alone cannot.
 */
const NO_TARGET_REASON = "the action's declaration names no targetFamily, so this slice discovers no target";

function deriveDiscovery(code, facts, args) {
  const fields = [];
  if (facts.targetFamily === null)
    return {
      value: { none: NO_TARGET_REASON },
      fields: [derived("discovery.none", NO_TARGET_REASON, "declaration:targetFamily:null")],
    };
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
  return { value: { source: facts.targetFamily, cardinality, select, requiredFields }, fields };
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

function deriveEvidence(code, deltaClaimed = new Set()) {
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
    if (known.has(key) || deltaClaimed.has(key)) continue;
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

function deriveStale(code) {
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

/**
 * `Number(evidence.x)` blanked away, keeping every offset (and therefore every line number) where it was.
 *
 * The narrowing call changes no key - `Number(evidence.count_after) === Number(evidence.count_before) + 1` is the sum
 * between the same two keys - and reading it through an optional `\)?` in every pattern did not work: a sum's left
 * half still matched the equality shape because the regex engine could give back the closing paren. Blanking the
 * wrapper leaves one spelling of each comparison.
 */
function withoutNarrowing(code) {
  return code.replace(
    /Number\(\s*(evidence\.[a-z0-9_]+)\s*\)/gu,
    (match, key) => `${key}${" ".repeat(match.length - key.length)}`,
  );
}

const DELTA_SUM = /evidence\.([a-z0-9_]+)\s*===\s*evidence\.([a-z0-9_]+)\s*\+\s*(\d+)/gu;
// The lookahead keeps an equality from claiming the left half of a sum as a relation of its own: `a === b + 1` is one
// entry, not a `b === a` entry beside it.
const DELTA_EQUAL = /evidence\.([a-z0-9_]+)\s*===\s*evidence\.([a-z0-9_]+)(?![\w.])(?!\s*[+-]\s*\d)/gu;
const DELTA_AT_LEAST = /evidence\.([a-z0-9_]+)\s*>=\s*(\d+)\b/gu;

/**
 * The `delta` entries a runner's arithmetic asks for, and the keys those entries answer for.
 *
 * Three shapes only, because those are the three the format carries: a sum (`to === from + n`), an equality
 * (`to === from`) and a bare lower bound (`to >= n`). All three read the key through an optional `Number(...)`,
 * because that is how a runner writes it: `Number(evidence.swings) >= 1` appears in
 * `run-stardew-native-local-player-break-resource-clump-smoke.mjs:175`, and the unwrapped pattern this converter
 * shipped read none of it - the lower-bound shape was declared by it and never once derived. Anything else stays a
 * refusal, so the frequency table keeps naming what the schema still cannot say.
 */
function deriveDelta(code) {
  const fields = [];
  const entries = [];
  const claimed = new Set();
  const bare = withoutNarrowing(code);
  for (const match of bare.matchAll(DELTA_SUM)) {
    entries.push({ from: match[2], to: match[1], equals: Number(match[3]) });
    claimed.add(match[1]);
    claimed.add(match[2]);
    fields.push(derived(`delta.${match[1]}`, `${match[2]}+${match[3]}`, `runner:${lineOf(code, match.index)}`));
  }
  for (const match of bare.matchAll(DELTA_EQUAL)) {
    if (match[1] === match[2]) continue;
    entries.push({ from: match[2], to: match[1], equals: 0 });
    claimed.add(match[1]);
    claimed.add(match[2]);
    fields.push(derived(`delta.${match[1]}`, `${match[2]}+0`, `runner:${lineOf(code, match.index)}`));
  }
  for (const match of bare.matchAll(DELTA_AT_LEAST)) {
    entries.push({ to: match[1], atLeast: Number(match[2]) });
    claimed.add(match[1]);
    fields.push(derived(`delta.${match[1]}`, `>=${match[2]}`, `runner:${lineOf(code, match.index)}`));
  }
  return { value: entries, claimed, fields };
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
  const delta = deriveDelta(code);
  const evidence = deriveEvidence(code, delta.claimed);
  const worldAfter = deriveWorldAfter(code);
  const stale = deriveStale(code);

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
  if (delta.value.length > 0) contract.delta = delta.value;

  const fields = [
    derived("action", actionId, `runner:${name}`),
    ...reason.fields,
    ...discovery.fields,
    ...args.fields,
    ...delta.fields,
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

/** Where `--all` writes its drafts. A directory, never stdout: a reading nobody can open is a claim. */
export const DRAFT_DIRECTORY = ".tmp/contract-drafts";

/** Every hand-written runner still on disk, derived by a scan so tomorrow's runner is measured the moment it exists. */
export function runnerPopulation({ toolsRoot }) {
  return readdirSync(toolsRoot)
    .filter((name) => RUNNER_NAME.test(name))
    .sort();
}

/**
 * The measurement: every hand-written runner, drafted; every field the converter could not read, counted.
 *
 * The frequency table is the point. A field that blocks one runner is a hook to write; a field that blocks five is a
 * schema kind, because five runners is data and one is code. `drafted` counts contracts that LOAD - a file written
 * from a draft the format refuses is not a draft anybody can use, so it is counted apart and named with its reason.
 */
export async function draftAll({ toolsRoot, outDir, write = true } = {}) {
  const population = runnerPopulation({ toolsRoot });
  if (population.length === 0)
    return Object.freeze({
      blocked: `runner_population_empty:${toolsRoot}`,
      examined: 0,
      drafted: 0,
      incomplete: 0,
      unloadable: Object.freeze([]),
      refusals: Object.freeze([]),
      runnersWithRefusals: 0,
      byField: Object.freeze([]),
      outDir,
    });
  const refusals = [];
  const unloadable = [];
  let drafted = 0;
  let incomplete = 0;
  for (const runner of population) {
    let draft;
    try {
      draft = draftContract(join(toolsRoot, runner));
    } catch (error) {
      unloadable.push(Object.freeze({ runner, why: String(error?.message ?? error) }));
      continue;
    }
    const refused = draft.fields.filter((field) => !field.ok);
    if (refused.length > 0) incomplete += 1;
    for (const field of refused)
      refusals.push(Object.freeze({ runner, field: field.field, why: field.why, where: field.where }));
    if (write) {
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, `${draft.action}.json`), `${JSON.stringify(draft.contract, null, 2)}\n`, "utf8");
    }
    try {
      validateSmokeContract(draft.contract);
      drafted += 1;
    } catch (error) {
      unloadable.push(Object.freeze({ runner, why: String(error?.message ?? error) }));
    }
  }
  const counts = new Map();
  for (const refusal of refusals) counts.set(refusal.field, (counts.get(refusal.field) ?? 0) + 1);
  const byField = [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([field, count]) => Object.freeze({ field, count }));
  return Object.freeze({
    blocked: null,
    examined: population.length,
    drafted,
    incomplete,
    unloadable: Object.freeze(unloadable),
    refusals: Object.freeze(refusals),
    runnersWithRefusals: incomplete,
    byField: Object.freeze(byField),
    outDir,
  });
}

/** The reading, in the shape a batch is chosen from. */
export function renderDraftAll(reading) {
  if (reading.blocked !== null) return [`not_measured:${reading.blocked}`];
  const lines = [
    `runners examined ${reading.examined} · drafted ${reading.drafted} · not_derivable ${reading.refusals.length}` +
      ` (fields, across ${reading.runnersWithRefusals} runners)`,
    `underived fields by frequency (top 10):`,
  ];
  for (const entry of reading.byField.slice(0, 10)) lines.push(`  ${entry.field.padEnd(34)} ${entry.count}`);
  if (reading.unloadable.length > 0) {
    lines.push(`unloadable ${reading.unloadable.length}:`);
    for (const entry of reading.unloadable) lines.push(`  ${entry.runner}: ${entry.why}`);
  }
  lines.push(`drafts: ${reading.outDir}`);
  return lines;
}

function main(argv) {
  if (argv.includes("--all")) {
    const outIndex = argv.indexOf("--out");
    const outDir = outIndex >= 0 ? resolve(argv[outIndex + 1]) : resolve(DRAFT_DIRECTORY);
    return draftAll({ toolsRoot: resolve(import.meta.dirname), outDir }).then((reading) => {
      for (const line of renderDraftAll(reading)) process.stdout.write(`${line}\n`);
      if (reading.blocked !== null) return 2;
      for (const refusal of reading.refusals)
        process.stdout.write(
          `  not_derivable:${refusal.field}:${refusal.why}  <- ${refusal.runner}` +
            `${refusal.where === null ? "" : ` ${refusal.where}`}\n`,
        );
      return reading.refusals.length === 0 ? 0 : 1;
    });
  }
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
  // `--all` is the mode that measures the tree, and it returns a promise: assigning that promise to `exitCode`
  // crashed with ERR_INVALID_ARG_TYPE after the reading had already been printed, so the sweep's own exit code
  // (1 when anything was refused, 2 when the population was empty) never reached a caller.
  process.exitCode = await main(process.argv.slice(2));
