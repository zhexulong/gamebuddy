#!/usr/bin/env node
/**
 * A re-derivation is declared, and every declared one is compared to the ENGINE'S OWN ANSWER.
 *
 * WHY. Three defects in two days share one shape: our code recomputes something the engine already computes, and the
 * recomputation drifts. `Tool.tilesAffected`'s footprint ladder was caught because someone happened to compare
 * (`ToolFootprintTableParityTests`); the scythe's 4096-position arc was MEASURED once and recorded as prose, so nothing
 * keeps it true; and `SpawnFishData.GetChance`'s fifth argument was computed once OUTSIDE the row loop while the engine
 * computes `spawn.ItemId == text` PER ROW (`GameLocation.cs:13969`), so the reader told the engine "this is the targeted
 * fish" for every row when no bait named one. A call is not a re-derivation - but a call whose ARGUMENT we derive is,
 * and the compiler holds its type while nothing holds its value.
 *
 * THE REGISTRY is `tools/rederivation-parity-registry.json`: one entry per re-derivation, naming the engine member (with
 * the decompiled `file:line` it is read at), our site (a path and an anchor string that must still be there), and the
 * parity test that drives the engine. `parityTest: null` is a DECLARATION OF DEBT, not an absence: the gate reports it.
 * The registry cannot rot in either direction - an anchor that no longer appears is `rederivation_site_missing`, and two
 * entries for one site are `rederivation_duplicate`.
 *
 * TWO DIRECTIONS, and what the second one can honestly do.
 *   1. `rederivation_without_parity:<engineMember>:<ourSite>` - a declared entry has no parity test, or its test file is
 *      not a test, or the member appears there only inside a comment or a STRING (a source-shape pin mentions the member
 *      in quotes; that is not a call). Comments and string literals are blanked before this is read.
 *   2. `rederivation_undeclared:<file>:<line>` - our code passes, for a parameter the entry declares PER-ITERATION, a
 *      value whose provenance never reaches a loop variable. It is derived from the declared list (entries carrying
 *      `perIterationArguments`) and the arithmetic they imply, NOT from a scan for "anything that looks like a formula":
 *      a member nobody declared is outside its population, and that limit is stated rather than papered over. Only a
 *      DOTTED invocation (`row.GetChance(`) is a call site, so a declaration or an override is not a site.
 *
 * red-proof: inject  the footprint entry's `parityTest` deleted from the registry -> `rederivation_without_parity:
 *   Tool.tilesAffected:<our site>`, verdict blocked (tools/check-rederivation-parity.test.mjs)
 * red-proof: history  today's shipped reader - the fifth `GetChance` argument bound once outside the row loop
 *   (`integrations/stardew/FishingCatchableQuery.cs:190` at e882b765) - read by the scan -> `rederivation_undeclared:
 *   integrations/stardew/FishingCatchableQuery.cs:190` (tools/check-rederivation-parity.test.mjs)
 *
 * POPULATION, printed every run, and a zero one is refused (exit 2) rather than agreed with:
 *   `rederivations examined N · with a parity test M · engine members K · without parity J`
 *   `rederivation call sites examined S · per-iteration arguments examined A`
 *
 * Usage:
 *   node tools/check-rederivation-parity.mjs            # the gate; exit 1 on any finding
 *   node tools/check-rederivation-parity.mjs --json     # the same reading as one JSON report
 */

export const gateDeclaration = {
  id: "check-rederivation-parity",
  domain: "arch",
  tier: "l0",
  kind: "contract",
};

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const GATE = "rederivation_parity/v1";
export const REGISTRY_PATH = "tools/rederivation-parity-registry.json";

/** Directories under a scanned tree that hold tests and fixtures rather than the code we ship. */
const NOT_PRODUCT = Object.freeze(["tests", "action-development", "obj", "bin", "node_modules"]);

const toPosix = (path) => path.split(sep).join("/");

/**
 * The source with its comments AND string/char literals blanked, newlines and lengths kept.
 *
 * Both halves matter. A docblock that says "the engine's `GetChance` is called here" is not a call, and a test that
 * asserts `Should().Contain("this.tilesAffected(")` is reading a source text, not driving the engine - the tree has
 * several of those (`ScytheSweepTests` pins `DoDamage(` that way), so accepting a string match would let a pin stand in
 * for a parity test.
 */
export function blankNonCode(source) {
  const out = source.split("");
  const length = source.length;
  const blank = (from, to) => {
    for (let index = from; index < to && index < length; index += 1) if (out[index] !== "\n") out[index] = " ";
  };
  let index = 0;
  while (index < length) {
    const here = source[index];
    const next = source[index + 1];
    if (here === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const stop = end === -1 ? length : end;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (here === "/" && next === "*") {
      const end = source.indexOf("*/", index + 2);
      const stop = end === -1 ? length : end + 2;
      blank(index, stop);
      index = stop;
      continue;
    }
    if (here === '"' || here === "'" || here === "`") {
      let cursor = index + 1;
      while (cursor < length && source[cursor] !== here) {
        if (source[cursor] === "\\" && here !== "`") cursor += 1;
        cursor += 1;
      }
      blank(index + 1, Math.min(cursor, length));
      index = cursor + 1;
      continue;
    }
    index += 1;
  }
  return out.join("");
}

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

/** The `(` that opens the argument list of the invocation starting at `offset`, or -1. */
function openParenAt(source, offset) {
  const cursor = source.indexOf("(", offset);
  return cursor === -1 ? -1 : cursor;
}

/** The index of the `)` matching the `(` at `open`, or -1. */
function matchingParen(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "(") depth += 1;
    else if (source[index] === ")") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The arguments of one invocation, as text plus the offset each one starts at, split on TOP-LEVEL commas only. */
export function argumentsOf(source, open) {
  const close = matchingParen(source, open);
  if (close === -1) return [];
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let index = open + 1; index < close; index += 1) {
    const character = source[index];
    if (character === "(" || character === "[" || character === "{") depth += 1;
    else if (character === ")" || character === "]" || character === "}") depth -= 1;
    else if (character === "," && depth === 0) {
      args.push({ text: source.slice(start, index).trim(), offset: skipSpace(source, start) });
      start = index + 1;
    }
  }
  const last = source.slice(start, close);
  if (last.trim().length > 0) args.push({ text: last.trim(), offset: skipSpace(source, start) });
  return args;
}

const skipSpace = (source, offset) => {
  let cursor = offset;
  while (cursor < source.length && /\s/u.test(source[cursor])) cursor += 1;
  return cursor;
};

/** Every DOTTED invocation of `member` in blanked source: a declaration or an override has no receiver, so it is not one. */
export function callSites(source, member) {
  const pattern = new RegExp(`\\.\\s*${member}\\s*\\(`, "gu");
  const sites = [];
  for (const match of source.matchAll(pattern)) {
    const open = openParenAt(source, match.index);
    if (open === -1) continue;
    sites.push({ offset: match.index, line: lineOf(source, match.index), open, args: argumentsOf(source, open) });
  }
  return sites;
}

/** The identifiers a `for`/`foreach` introduces: the element of the loop, which is what "per iteration" MEANS here. */
export function iterationVariables(source) {
  const names = new Set();
  for (const match of source.matchAll(/foreach\s*\(([^)]*?)\bin\b([^)]*?)\)/gu)) {
    const declared = /([A-Za-z_]\w*)\s*$/u.exec(match[1] ?? "");
    if (declared !== null) names.add(declared[1]);
  }
  for (const match of source.matchAll(/\bfor\s*\(\s*(?:int|long|var)?\s*([A-Za-z_]\w*)\s*=/gu)) names.add(match[1]);
  return names;
}

/** The member (method signature and parameter names) whose brace block contains `offset`. */
export function enclosingMember(source, offset) {
  const stack = [];
  for (let index = 0; index < offset && index < source.length; index += 1) {
    if (source[index] === "{") stack.push(index);
    else if (source[index] === "}") stack.pop();
  }
  for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
    const open = stack[depth];
    const headerStart =
      Math.max(
        source.lastIndexOf(";", open - 1),
        source.lastIndexOf("{", open - 1),
        source.lastIndexOf("}", open - 1),
      ) + 1;
    const header = source.slice(headerStart, open);
    if (!/\b(?:private|internal|public|protected)\b/u.test(header)) continue;
    const name = /([A-Za-z_]\w*)\s*\(/u.exec(header);
    if (name === null) continue;
    const paren = headerStart + header.indexOf("(", name.index);
    const close = matchingParen(source, paren);
    if (close === -1 || source.slice(close + 1, open).trim() !== "") continue;
    const parameters = argumentsOf(source, paren)
      .map((argument) => /([A-Za-z_]\w*)\s*$/u.exec(argument.text.replace(/=.*$/su, ""))?.[1])
      .filter((parameter) => typeof parameter === "string");
    return { name: name[1], parameters, bodyStart: open, bodyEnd: matchingBrace(source, open) };
  }
  return null;
}

function matchingBrace(source, open) {
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    else if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** The expressions assigned to `name` in this file, plus - when it is a parameter - what its callers pass for it. */
export function sourcesOf(source, name) {
  const found = [];
  const pattern = new RegExp(`(?:^|[^\\w.$])${name}\\s*=(?!=)\\s*([^;]+);`, "gu");
  for (const match of source.matchAll(pattern)) found.push({ text: match[1].trim(), offset: match.index });
  for (const match of source.matchAll(/\b(?:private|internal|public|protected)\b[^;{}()]*?([A-Za-z_]\w*)\s*\(/gu)) {
    const open = openParenAt(source, match.index);
    if (open === -1) continue;
    const parameters = argumentsOf(source, open).map((argument) =>
      /([A-Za-z_]\w*)\s*$/u.exec(argument.text.replace(/=.*$/su, "")),
    );
    const position = parameters.findIndex((parameter) => parameter !== null && parameter[1] === name);
    if (position === -1) continue;
    for (const site of callSites(source, match[1])) {
      const argument = site.args[position];
      if (argument !== undefined) found.push({ text: argument.text, offset: argument.offset });
    }
  }
  return found;
}

/**
 * Does this expression's provenance reach a loop variable?
 *
 * The walk is over identifiers, through assignments and (one call site at a time) through parameter bindings, so the
 * question is "could this value be a function of the row" rather than "does the text contain the word `row`". A value
 * that reaches no loop variable after `depth` hops is loop-invariant, which is what the engine's own call site cannot be.
 */
export function reachesIteration({ source, expression, loopVariables, depth = 3, seen = new Set() }) {
  const identifiers = [...new Set([...expression.matchAll(/[A-Za-z_]\w*/gu)].map((match) => match[0]))];
  if (identifiers.some((identifier) => loopVariables.has(identifier))) return true;
  if (depth === 0) return false;
  for (const identifier of identifiers) {
    if (seen.has(identifier)) continue;
    seen.add(identifier);
    for (const next of sourcesOf(source, identifier))
      if (reachesIteration({ source, expression: next.text, loopVariables, depth: depth - 1, seen })) return true;
  }
  return false;
}

const isParityTestPath = (path) =>
  /\.test\.mjs$/u.test(path) || /(?:^|\/)tests?\//u.test(path) || /Tests?\.cs$/u.test(path);

/** Every `.cs` file under `directory`, plus any override that lives there; tests and build outputs are not product code. */
export function listSources({ root, directory, overrides = {} }) {
  const files = [];
  const walk = (absolute) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || NOT_PRODUCT.includes(entry.name)) continue;
      const next = join(absolute, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.name.endsWith(".cs")) files.push(toPosix(relative(root, next)));
    }
  };
  const absolute = resolve(root, directory);
  if (existsSync(absolute)) walk(absolute);
  for (const path of Object.keys(overrides))
    if (path.startsWith(`${directory}/`) && path.endsWith(".cs") && !files.includes(path)) files.push(path);
  return files.sort();
}

/**
 * The reading. `overrides` replaces (or adds) a file's text, so a falsifier can put the tree into the shape it names
 * without writing to disk; `registry` replaces the declared entries for the same reason.
 */
export function checkRederivationParity({ root = ROOT, registry = null, overrides = {} } = {}) {
  const read = (path) =>
    typeof overrides[path] === "string" ? overrides[path] : readFileSync(join(root, path), "utf8");
  const exists = (path) => typeof overrides[path] === "string" || existsSync(join(root, path));
  const entries = registry ?? JSON.parse(readFileSync(join(root, REGISTRY_PATH), "utf8")).entries;
  const findings = [];
  const examined = {
    declared: entries.length,
    withParity: 0,
    engineMembers: 0,
    withoutParity: 0,
    callSites: 0,
    arguments: 0,
  };
  const engineMembers = new Set();
  const sites = new Map();

  for (const entry of entries) {
    engineMembers.add(entry.engineMember);
    const site = `${entry.ourSite.path}`;
    const identity = `${entry.engineMember}:${site}`;
    if (sites.has(identity)) findings.push({ code: "rederivation_duplicate", detail: `${entry.id}:${identity}` });
    sites.set(identity, entry.id);

    if (!exists(entry.ourSite.path)) {
      findings.push({ code: "rederivation_site_missing", detail: `${entry.id}:${entry.ourSite.path}` });
    } else if (!read(entry.ourSite.path).includes(entry.ourSite.anchor)) {
      findings.push({
        code: "rederivation_site_missing",
        detail: `${entry.id}:${entry.ourSite.path} no longer contains ${JSON.stringify(entry.ourSite.anchor)}`,
      });
    }

    const parity = entry.parityTest;
    if (parity === null || parity === undefined || typeof parity !== "object") {
      examined.withoutParity += 1;
      findings.push({ code: "rederivation_without_parity", detail: identity });
      continue;
    }
    if (!exists(parity.path)) {
      examined.withoutParity += 1;
      findings.push({ code: "rederivation_without_parity", detail: `${identity} (${parity.path} does not exist)` });
      continue;
    }
    if (!isParityTestPath(parity.path)) {
      examined.withoutParity += 1;
      findings.push({ code: "rederivation_parity_not_a_test", detail: `${identity} (${parity.path})` });
      continue;
    }
    // Blanked: a member named in a docblock or asserted inside a string is a pin on source text, not a call to the engine.
    if (!blankNonCode(read(parity.path)).includes(parity.member)) {
      examined.withoutParity += 1;
      findings.push({
        code: "rederivation_without_parity",
        detail: `${identity} (${parity.path} never calls ${parity.member} outside comments and strings)`,
      });
      continue;
    }
    examined.withParity += 1;
  }

  for (const entry of entries) {
    const declared = entry.perIterationArguments;
    if (!Array.isArray(declared) || declared.length === 0) continue;
    const member = entry.engineMember.split(".").at(-1);
    let found = 0;
    for (const path of listSources({ root, directory: entry.scan ?? "", overrides })) {
      const source = blankNonCode(read(path));
      const loopVariables = iterationVariables(source);
      for (const call of callSites(source, member)) {
        found += 1;
        examined.callSites += 1;
        for (const argument of declared) {
          examined.arguments += 1;
          const passed = call.args[argument.index];
          if (passed === undefined) {
            findings.push({ code: "rederivation_argument_not_read", detail: `${entry.id}:${path}:${call.line}` });
            continue;
          }
          if (reachesIteration({ source, expression: passed.text, loopVariables })) continue;
          findings.push({
            code: "rederivation_undeclared",
            detail: `${path}:${lineOf(source, passed.offset)}`,
          });
        }
      }
    }
    // A declaration whose invocation this scan could not find examined NOTHING, which is not the same as a clean site.
    if (found === 0)
      findings.push({
        code: "rederivation_site_missing",
        detail: `${entry.id}: no ${member} invocation under ${entry.scan}`,
      });
  }

  examined.engineMembers = engineMembers.size;
  findings.sort((left, right) => `${left.code}:${left.detail}`.localeCompare(`${right.code}:${right.detail}`));
  const verdict =
    entries.length === 0 ? "blocked" : findings.length === 0 && examined.withoutParity === 0 ? "passed" : "blocked";
  if (examined.withoutParity !== 0 && findings.length === 0)
    findings.push({ code: "rederivation_without_parity", detail: "the count disagrees with the finding list" });
  return Object.freeze({
    gate: GATE,
    verdict,
    examined: Object.freeze(examined),
    findings: Object.freeze(findings),
  });
}

function report(result) {
  const { examined } = result;
  const lines = [
    `rederivations examined ${examined.declared} · with a parity test ${examined.withParity} · ` +
      `engine members ${examined.engineMembers} · without parity ${examined.withoutParity}`,
    `rederivation call sites examined ${examined.callSites} · per-iteration arguments examined ${examined.arguments}`,
  ];
  for (const finding of result.findings) lines.push(`${finding.code}:${finding.detail}`);
  if (examined.declared === 0)
    lines.push("rederivation_registry_empty: no entry is declared, so this gate measured nothing and refuses to pass");
  lines.push(
    `${result.gate}: ${result.verdict}${result.findings.length === 0 ? "" : ` (${result.findings.length} finding(s))`}`,
  );
  if (process.argv.includes("--json")) {
    lines.push(
      JSON.stringify({
        gate: result.gate,
        status: result.verdict,
        examined: result.examined,
        population: {
          status: examined.declared === 0 ? "blocked" : "measured",
          detail: `${examined.declared} declared · ${examined.withParity} with a parity test · ${examined.engineMembers} engine members`,
        },
        checks: [
          {
            rule: "every declared re-derivation has a parity test that calls the engine",
            status: examined.withoutParity === 0 ? "passed" : "failed",
            detail: `${examined.withoutParity} without parity`,
          },
          {
            rule: "no declared engine argument is bound outside the loop its call site re-evaluates",
            status: result.findings.some((finding) => finding.code.startsWith("rederivation_undeclared"))
              ? "failed"
              : "passed",
            detail: `${examined.arguments} per-iteration argument(s) examined`,
          },
        ],
      }),
    );
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return examined.declared === 0 ? 2 : result.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = report(checkRederivationParity());
}
