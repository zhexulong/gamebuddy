#!/usr/bin/env node
/**
 * Invented gates: a numeric bound in an admission predicate must be the engine's number, or say why it is not.
 *
 * WHY. Round 42 refused six purchases with
 * `shop_counter_out_of_reach;owner=Pierre;owner_tile=4,17;actor_tile=5,19;radius=1`
 * (`farmhandexecutioncontroller.shopactions.cs:187-188`). The radius was `ShopOwnerInteractionRadius = 1`,
 * whose own doc comment called it "the native interaction radius for a shop owner (Chebyshev,
 * Utility.cs:4100)". `Utility.cs:4100` is `tileWithinRadiusOfPlayer(int xTile, int yTile, int tileRadius,
 * Farmer f)` - the PREDICATE, whose radius is a parameter the caller supplies, so the citation names an
 * algorithm and the number was ours. The engine's own way to buy is to open the shop
 * (`Utility.TryOpenShopMenu`, Utility.cs:4174, which takes a shop id and an owner name and no tile at all),
 * so the refusal was a restriction we invented, reported as if it were a world fact, and it made a
 * published action unreachable. Nothing in this tree compared such a constant against the engine.
 *
 * POPULATION - derived on every run, never listed (`constants examined N` is printed):
 *   1. the request paths: every `LocalExecutionReceipt Request*(` in
 *      `integrations/stardew/farmhandexecutioncontroller*.cs`, closed transitively over the Mod
 *      methods those bodies call, so a predicate that refuses through a private helper is in scope
 *      (`DiscoverShopTargets` and `TryLocateGeodeCounter` are exactly that shape).
 *   2. the reach predicates, read from their own declarations: a Mod method with an `int radius`
 *      parameter compared against a `Math.Abs` delta (`IsTileWithinChebyshevRadius`), and an engine
 *      member the closure calls (`Utility.tileWithinRadiusOfPlayer`) whose declaration has a
 *      `tileRadius` parameter. The radius argument index is the parameter's index.
 *   3. the sites: every call of a reach predicate inside the closure, plus every numeric comparison
 *      inside it whose left side is a distance - named `distance`/`delta`/`gap`, or assigned from a
 *      `Math.Abs` delta in the same body. A comparison against `0` is a sign test, not a reach.
 *   4. each bound resolves to a numeric literal or to a `const int`/`static readonly int` in the Mod
 *      sources; a bound that resolves to neither is `unresolved_bound`.
 * A member is one declared constant (its sites aggregated) or one literal site.
 *
 * PROPERTY, per member. `ours` is the bound; `engine` is read from the engine member the Mod's OWN
 * source names - never restated here:
 *   - the cited line (`X.cs:NNN`, with two continuation lines) is read out of
 *     `ref/external/StardewValleyDecompiled`. A `tileWithinRadiusOfPlayer(..., N, ...)` radius on that
 *     line is the engine's number; a `const int` declared there is the engine's number; a radius that
 *     arrives as a PARAMETER is `unstated`, because citing the predicate is not citing a number.
 *   - a declared constant citing a member that yields its own value is engine-cited, and the first
 *     such constant becomes the tree's REACH AUTHORITY (`NativeInteractionRadius`, Game1.cs:11509).
 *   - an inline literal needs no doc comment of its own: a literal is not a claim, it is the number,
 *     so it is admissible while it equals the authority's value (`status=via:<authority>`) and a
 *     finding when it does not. A named constant IS a claim - it invents a fact with a name - so it
 *     must cite, or account for itself below.
 *   - a declared constant whose citation states no number must sit in `STATED_DEBT` with a reason a
 *     reader can check. Every entry expires: it names the constant and its value, so a renamed or
 *     re-valued constant leaves the entry matching nothing and the gate goes red (`debt_expired`).
 * Anything else is `invented_gate:<file>:<line>:<symbol>:ours=<n>:engine=<n|unstated>`.
 *
 * SECOND ASSERTION, same class. A radius is only meaningful with what it is measured against, so the
 * gate derives the subject from the call's own coordinate arguments (`npc.TilePoint`, `target`,
 * `x,y`, or the non-actor operands of the `Math.Abs` delta a distance was computed from) and asserts
 * that one constant measures ONE subject: `invented_gate_subject:<file>:<line>:<symbol>:measured=a|b`.
 * `ShopOwnerInteractionRadius` measures the owner NPC's tile at one site and the counter tile at
 * another, and one of those cannot be the interaction the constant names. The citation's own subject
 * is printed beside the finding so a reader can see which.
 *
 * NOT EXAMINED, printed with their names rather than left silent: numeric comparisons against a
 * declared constant whose left side is not a distance (a swing count, a text length, a map's trough
 * rows, a warp grace, a publish cap). A bound on how many swings a pump performs or how long a line
 * may be does not decide whether the actor can reach the thing it asked for, which is this gate's
 * class; a publish cap that hides a target belongs to the snapshot's cap family, not to this one.
 *
 * Refusals: no decompiled tree -> `stardew_decompile_root_missing`; no member ->
 * `invented_gates_no_population`. Both print and exit 2, because a gate that passes on an empty
 * reading is indistinguishable from one that found nothing. The first also prints a
 * `*_skipped:` marker naming the absent mount, which is how `tools/prelive.mjs` tells "this
 * checkout cannot measure it" (UNAVAILABLE) from "it measured and something is wrong" (red);
 * the second is a defect and prints no marker.
 *
 * THE REPORT. Every run ends with one JSON line carrying `checks`: one entry per rule in `RULES` below, each with its own
 * outcome, so the run says which rules this gate is able to report red and what each one found - a rule that passed is
 * enumerated beside the one that failed. `status` is `passed` only when every rule passed over a non-empty population,
 * `blocked` when the decompiled tree or the population could not be read, `failed` when a rule has a finding.
 * `tools/lib/harness-conformance.mjs` reads that line; `--json` prints it alone.
 *
 * Usage: node tools/check-stardew-invented-gates.mjs [--json]
 *
 * red-proof: inject  `ShopOwnerInteractionRadius` citing the predicate (`Utility.cs:4100`) ->
 *   `invented_gate:...:ShopOwnerInteractionRadius:ours=1:engine=unstated`, and the same constant
 *   measuring `npc.TilePoint` at one site and `x` at another -> `invented_gate_subject`
 * red-proof: inject  deleting a constant `STATED_DEBT` names -> `debt_expired` naming the entry
 * red-proof: inject  a source set with no request path -> `invented_gates_no_population` (exit 2)
 * red-proof: self-check  the report's `checks` list names one rule per finding the gate can emit, and a finding lands on
 *   the rule that owns it -> asserted in tools/check-stardew-invented-gates.test.mjs by "the report names the failing
 *   rule, and the rule that passed still enumerates", "a debt entry that expired is the one rule that goes red for it",
 *   and the blocked case's `not_measured` census in "an empty population blocks instead of passing"
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  bodyAfterParameters,
  codeOnly,
  matchingBracket,
  readModSources,
} from "../integrations/stardew/action-development/src/analysis/stardew-mod-csharp-source.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** The engine's own sources: the only place a number can come from, and the reason `engine=` can be `unstated`. */
export const DECOMPILED_ROOT = "ref/external/StardewValleyDecompiled";

/** The Mod's request paths: the partials of the one execution manager. */
export const CONTROLLER = /^integrations\/stardew\/farmhandexecutioncontroller[^/]*\.cs$/u;

/** A request path is the member the wire dispatches into; its name is the Mod's own convention. */
const REQUEST_METHOD = /^Request[A-Z]/u;

/** `X.cs:123` in prose, which is how every citation in this tree is spelled. */
const CITATION = /\b([A-Za-z][\w.]*\.cs):(\d+)/gu;

/** Comparisons whose name says they measure a distance, so their bound is a reach. */
const DISTANCE_NAME = /^(?:distance|delta\w*|gap|dx|dy)\w*$/iu;

/** The actor, which is what a reach is measured FROM and never the tile it is measured TO. */
const ACTOR = new Set(["player", "actor", "who", "f", "Game1.player", "farmer"]);

/**
 * Bounds that gate something real and are still not the engine's number, each with a reason a reader
 * can check and each expiring: `{ path, symbol, value }` must match a live member exactly.
 */
export const STATED_DEBT = Object.freeze([
  {
    path: "integrations/stardew/farmhandexecutioncontroller.cs",
    symbol: "AnimalProductActionRadius",
    value: 1,
    kind: "same_value_as_the_cited_authority",
    reason:
      "the animal-product acting reach is the same grab-tile click the tree cites at Game1.cs:11509, and the " +
      "constant's own value already equals that cited authority's; its doc comment names no engine member, so it " +
      "cannot make a published action unreachable by being wrong here",
  },
  {
    path: "integrations/stardew/farmhandexecutioncontroller.itemtileactions.cs",
    symbol: "MailboxClaimReachTiles",
    value: 1,
    kind: "same_value_as_the_cited_authority",
    reason:
      "the claim is the same click on the addressed tile and the constant is 1, the cited authority's value; its " +
      "doc comment states the reach without naming an engine member (the mailbox is the clicked tile, not a " +
      "second radius)",
  },
  {
    path: "integrations/stardew/farmhandexecutioncontroller.itemtileactions.cs",
    symbol: "PanNativeReachTiles",
    value: 2,
    kind: "derived_from_geometry",
    reason:
      "`Pan.beginUsing` (Pan.cs:55-79) accepts when the actor's bounding box intersects the 4x4 rectangle centred " +
      "on `orePanPoint`, so the engine states no radius NUMBER for the pan window and the two-tile window is " +
      "derived from that rectangle; expires when this constant or that rectangle changes",
  },
  {
    path: "integrations/stardew/farmhandexecutioncontroller.cs",
    symbol: "literal@CreateLocalObservation",
    value: 5,
    kind: "not_an_admission_bound",
    reason:
      "bounds whether `CreateLocalObservation` reports another farmer standing nearby " +
      "(`BridgeLocalObservation.playerNearby`); it decides nothing about whether a request may proceed, so no " +
      "engine member is its authority and no action can become unreachable through it",
  },
]);

function citationsIn(text) {
  const found = [];
  for (const match of text.matchAll(CITATION)) found.push(`${match[1]}:${match[2]}`);
  return found;
}

/**
 * The citations in the comment block directly above `index` - the declaration's OWN doc comment.
 *
 * Not a fixed line window: `MailboxClaimReachTiles` sits under a sibling's `<see cref="Object.cs:3172"/>`,
 * and a window that reached past the previous member would read that citation as this constant's.
 */
export function citationsAbove(source, index) {
  const lines = source.split("\n");
  const line = codeOnly(source).slice(0, index).split("\n").length - 1;
  let first = line;
  while (first > 0 && /^\s*(?:\/\/\/|\/\/|\[|$)/u.test(lines[first - 1])) first -= 1;
  return citationsIn(lines.slice(first, line).join("\n"));
}

/** Every `.cs` the decompiled tree holds, by file name, so a citation resolves without a path list. */
export function indexEngineSources({ root = ROOT, decompiledRoot = DECOMPILED_ROOT } = {}) {
  const base = resolve(root, decompiledRoot);
  if (!existsSync(base)) return null;
  const byName = new Map();
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      if (!byName.has(entry.name)) byName.set(entry.name, absolute);
    }
  };
  walk(base);
  return byName;
}

/** The tile a pair of coordinate expressions names, reduced to its root: `npc.TilePoint.X` -> `npc.TilePoint`. */
export function subjectOf(args) {
  const roots = args
    .map((argument) => argument.replace(/^\(int\)\s*/u, "").trim())
    .map((argument) => argument.replace(/\.(?:X|Y)$/u, ""))
    .filter((root) => root.length > 0 && !ACTOR.has(root));
  const unique = [...new Set(roots)];
  if (unique.length === 2 && unique.every((root) => root.length > 1)) {
    const stripped = unique.map((root) => root.replace(/[XY]$/u, ""));
    if (stripped[0] === stripped[1]) return stripped[0];
  }
  return unique.join(",");
}

/**
 * The engine's own number at a cited member, or `null` when the member states none.
 *
 * The two readings a Stardew citation is ever made for: the `tileRadius` argument of a
 * `tileWithinRadiusOfPlayer` call on the line (the decision, with its own subject), and a `const int`
 * declared there. A radius that arrives as a parameter is `null` ON PURPOSE - citing the predicate is
 * not citing a number, which is the whole defect this gate exists for.
 */
export function engineReadingAt(citation, engine) {
  const [file, lineText] = citation.split(":");
  const absolute = engine?.get(basename(file)) ?? null;
  if (absolute === null) {
    return {
      value: null,
      subject: null,
      engineSubject: null,
      kind: null,
      why: `cited file ${file} is not in ${DECOMPILED_ROOT}`,
    };
  }
  const lines = readFileSync(absolute, "utf8").split("\n");
  const start = Math.max(0, Number(lineText) - 1);
  const text = lines.slice(start, start + 4).join("\n");
  const call = text.indexOf("tileWithinRadiusOfPlayer(");
  if (call >= 0) {
    const open = text.indexOf("(", call);
    const close = matchingBracket(text, open);
    const args = text
      .slice(open + 1, close)
      .split(",")
      .map((argument) => argument.trim());
    const radius = args[2] ?? "";
    const tile = subjectOf(args.slice(0, 2));
    if (!/^\d+$/u.test(radius)) {
      // The predicate again: its subject and its radius are both the CALLER's, so this citation states neither.
      return {
        value: null,
        subject: null,
        engineSubject: tile,
        kind: "radius-call",
        why: `the radius at ${citation} is the parameter "${radius}" - the citation names the predicate, not a decision`,
      };
    }
    return { value: Number(radius), subject: tile, engineSubject: tile, kind: "radius-call", why: null };
  }
  const constant = /\bconst\s+int\s+(\w+)\s*=\s*(\d+)\s*;/u.exec(text);
  if (constant) return { value: Number(constant[2]), subject: null, engineSubject: null, kind: "constant", why: null };
  return { value: null, subject: null, engineSubject: null, kind: null, why: `${citation} states no radius number` };
}

/** Every method declaration in `sources`, keyed by name: the closure, the predicates and the sites read here. */
export function readMethods(sources) {
  const methods = new Map();
  for (const { path, source } of sources) {
    const code = codeOnly(source);
    for (const match of code.matchAll(
      /\b(?:private|internal|public|protected)[^;{}()]*?\b(\w+)\s*(?:<[^<>()]*>)?\s*\(/gu,
    )) {
      const open = code.indexOf("(", match.index + match[0].length - 1);
      if (open < 0) continue;
      const close = matchingBracket(code, open);
      if (close < 0) continue;
      const body = bodyAfterParameters(code, close);
      if (body === null || methods.has(match[1])) continue;
      methods.set(match[1], {
        name: match[1],
        path,
        source,
        parameters: code.slice(open + 1, close),
        body,
        code,
        bodyStart: code.indexOf(body, match.index),
        line: code.slice(0, match.index).split("\n").length,
      });
    }
  }
  return methods;
}

/** The request paths, closed over the Mod methods their bodies reach. */
export function requestClosure(methods) {
  const reached = new Map();
  const queue = [...methods.values()].filter((method) => REQUEST_METHOD.test(method.name)).map((method) => method.name);
  while (queue.length > 0) {
    const name = queue.pop();
    if (reached.has(name)) continue;
    const declaration = methods.get(name);
    if (!declaration) continue;
    reached.set(name, declaration);
    for (const call of declaration.body.matchAll(/\b([A-Za-z_]\w*)\s*(?:<[^<>()]*>)?\s*\(/gu)) {
      if (methods.has(call[1]) && !reached.has(call[1])) queue.push(call[1]);
    }
  }
  return reached;
}

function parameterIndex(parameters, name) {
  return parameters.split(",").findIndex((parameter) => new RegExp(`\\b${name}\\b`, "u").test(parameter));
}

/**
 * The reach predicates, from their declarations rather than from a list here: a Mod method whose
 * `int radius` parameter is compared against a `Math.Abs` delta, and an engine member the closure
 * calls whose declaration takes a `tileRadius` parameter. The radius argument index is the
 * parameter's index, so a changed signature moves the reading without an edit here.
 */
export function readReachPredicates(closure, engine) {
  const mod = [];
  for (const method of closure.values()) {
    if (!/\bint\s+radius\b/u.test(method.parameters)) continue;
    if (!/Math\.Abs\(/u.test(method.body)) continue;
    if (mod.some((predicate) => predicate.name === method.name)) continue;
    mod.push({ name: method.name, radiusIndex: parameterIndex(method.parameters, "radius"), qualified: method.name });
  }
  const candidates = new Set();
  for (const method of closure.values()) {
    for (const call of method.body.matchAll(/\b([A-Z]\w*)\.(\w+)\s*\(/gu)) candidates.add(`${call[1]}.${call[2]}`);
  }
  const enginePredicates = [];
  for (const qualified of candidates) {
    const [owner, name] = qualified.split(".");
    const absolute = engine?.get(`${owner}.cs`) ?? null;
    if (absolute === null) continue;
    const text = readFileSync(absolute, "utf8");
    const signature = new RegExp(
      `\\b(?:public|internal|private)\\s+static\\s+bool\\s+${name}\\s*\\(([^)]*)\\)`,
      "u",
    ).exec(text);
    if (signature === null) continue;
    const radiusName = /\bint\s+tileRadius\b/u.test(signature[1])
      ? "tileRadius"
      : /\bint\s+radius\b/u.test(signature[1])
        ? "radius"
        : null;
    if (radiusName === null) continue;
    enginePredicates.push({ name, qualified, radiusIndex: parameterIndex(signature[1], radiusName) });
  }
  return { mod, engine: enginePredicates };
}

/** The line a match inside a method's body occupies in its own file. */
function lineOf(method, bodyIndex) {
  return method.code.slice(0, method.bodyStart + bodyIndex).split("\n").length;
}

function callSite(method, match, radiusIndex, predicate) {
  const open = method.body.indexOf("(", match.index + match[0].length - 1);
  if (open < 0) return null;
  const close = matchingBracket(method.body, open);
  if (close < 0) return null;
  const args = method.body
    .slice(open + 1, close)
    .split(",")
    .map((argument) => argument.trim());
  if (args.length <= radiusIndex) return null;
  const coordinates = args.filter((_, index) => index !== radiusIndex).slice(0, 3);
  return {
    path: method.path,
    line: lineOf(method, match.index),
    method: method.name,
    family: "reach-predicate",
    predicate,
    boundText: args[radiusIndex],
    subject: subjectOf(coordinates),
    statement: method.body
      .slice(match.index, close + 1)
      .replace(/\s+/gu, " ")
      .trim(),
  };
}

/** Is this identifier a distance? Named so, or assigned from a `Math.Abs` delta in the same body. */
function isDistanceQuantity(body, identifier) {
  if (DISTANCE_NAME.test(identifier)) return true;
  return new RegExp(`\\b${identifier}\\s*=[^;]*Math\\.Abs\\(`, "u").test(body);
}

/** What a distance is measured to: the non-actor operands of the `Math.Abs` delta it was computed from. */
function comparisonSubject(body, identifier) {
  if (/^(?:delta|dx|dy)\w*$/iu.test(identifier)) return "offset-from-actor";
  const assignment = new RegExp(`\\b${identifier}\\s*=([^;]+);`, "u").exec(body);
  if (assignment === null) return identifier;
  const operands = [];
  for (const delta of assignment[1].matchAll(/Math\.Abs\(\s*([\w.()\s]+?)\s*-\s*([\w.()\s]+?)\s*\)/gu)) {
    for (const operand of [delta[1], delta[2]]) {
      const root = operand
        .replace(/^\(int\)\s*/u, "")
        .replace(/[XY]$/u, "")
        .trim();
      if (root.length === 0 || ACTOR.has(root)) continue;
      operands.push(root);
    }
  }
  return [...new Set(operands)].join(",") || identifier;
}

/** Every site in the closure whose bound decides admission. */
export function readSites(closure, predicates) {
  const sites = [];
  for (const method of closure.values()) {
    for (const predicate of [...predicates.mod, ...predicates.engine]) {
      const pattern = new RegExp(`\\b${predicate.qualified.replace(".", "\\.")}\\s*\\(`, "gu");
      for (const match of method.body.matchAll(pattern)) {
        const site = callSite(method, match, predicate.radiusIndex, predicate.qualified);
        if (site !== null) sites.push(site);
      }
    }
    for (const match of method.body.matchAll(/\b([A-Za-z_]\w*)\s*(?:<=|>=|<|>)\s*([A-Za-z_]\w*|\d+)\b/gu)) {
      const [text, left, right] = match;
      if (!isDistanceQuantity(method.body, left)) continue;
      if (/^\d+$/u.test(right) && Number(right) === 0) continue;
      sites.push({
        path: method.path,
        line: lineOf(method, match.index),
        method: method.name,
        family: "distance-comparison",
        predicate: left,
        boundText: right,
        subject: comparisonSubject(method.body, left),
        statement: text.trim(),
      });
    }
  }
  return sites;
}

/** Every `const int`/`static readonly int` the Mod declares, by name, with the doc comment above it. */
export function readDeclarations(sources) {
  const declarations = new Map();
  for (const { path, source } of sources) {
    const code = codeOnly(source);
    for (const match of code.matchAll(/\b(?:const|static\s+readonly)\s+int\s+(\w+)\s*=\s*(-?\d+)\s*;/gu)) {
      if (declarations.has(match[1])) continue;
      declarations.set(match[1], {
        symbol: match[1],
        value: Number(match[2]),
        path,
        line: code.slice(0, match.index).split("\n").length,
        citations: citationsAbove(source, match.index),
      });
    }
  }
  return declarations;
}

/** The comparisons this gate prints and does not examine, so the limit is a reading rather than a silence. */
function notExaminedComparisons(closure, declarations, examined) {
  const found = new Set();
  for (const method of closure.values()) {
    for (const match of method.body.matchAll(/\b([A-Za-z_]\w*)\s*(?:<=|>=|<|>)\s*([A-Za-z_]\w*)\b/gu)) {
      if (isDistanceQuantity(method.body, match[1])) continue;
      const declaration = declarations.get(match[2]);
      if (!declaration) continue;
      found.add(`${declaration.path.split("/").pop()}:${declaration.symbol}=${declaration.value}`);
    }
  }
  for (const member of examined.values()) {
    if (member.declared === null) continue;
    found.delete(`${member.path.split("/").pop()}:${member.symbol}=${member.value}`);
  }
  return [...found].sort();
}

/** The report, over one source set and one engine index. `sources`/`engine` are injected by the suite. */
export function analyze({ sources, engine, debt = STATED_DEBT }) {
  const controller = sources.filter((source) => CONTROLLER.test(source.path));
  const methods = readMethods(controller);
  const closure = requestClosure(methods);
  const predicates = readReachPredicates(closure, engine);
  const declarations = readDeclarations(sources);
  const sites = readSites(closure, predicates);

  const members = new Map();
  const findings = [];
  for (const site of sites) {
    const declared = declarations.get(site.boundText) ?? null;
    if (declared === null && !/^\d+$/u.test(site.boundText)) {
      findings.push(`unresolved_bound:${site.path}:${site.line}:${site.boundText}`);
      continue;
    }
    const symbol = declared === null ? `literal@${site.method}` : declared.symbol;
    const key = declared === null ? `${site.path}:${symbol}:${site.boundText}` : `${declared.path}:${declared.symbol}`;
    const member = members.get(key) ?? {
      key,
      path: declared === null ? site.path : declared.path,
      line: declared === null ? site.line : declared.line,
      symbol,
      value: declared === null ? Number(site.boundText) : declared.value,
      declared,
      citations: declared === null ? [] : declared.citations,
      sites: [],
    };
    member.sites.push(site);
    members.set(key, member);
  }

  const readings = new Map();
  for (const member of members.values()) {
    const attempts = member.citations.map((citation) => ({ citation, ...engineReadingAt(citation, engine) }));
    readings.set(member.key, attempts.find((attempt) => attempt.value !== null) ?? attempts[0] ?? null);
  }

  // The tree's reach authority: a declared constant whose OWN citation is a radius call that yields
  // its value. Derived from the declarations, not from the sites, so a constant that no site uses
  // today still says which engine number the inline literals are spelling.
  const authority =
    [...declarations.values()]
      .map((declaration) => {
        const attempts = declaration.citations.map((citation) => ({ citation, ...engineReadingAt(citation, engine) }));
        const confirmed = attempts.find(
          (attempt) => attempt.kind === "radius-call" && attempt.value === declaration.value,
        );
        return confirmed === undefined ? null : { symbol: declaration.symbol, value: declaration.value, ...confirmed };
      })
      .find((candidate) => candidate !== null) ?? null;

  const named = [];
  const debtMatched = new Set();
  let engineCited = 0;
  let debtCount = 0;
  for (const member of members.values()) {
    const reading = readings.get(member.key);
    const subjects = [...new Set(member.sites.map((site) => site.subject))];
    const entry = debt.find(
      (candidate) =>
        candidate.path === member.path && candidate.symbol === member.symbol && candidate.value === member.value,
    );
    const cited = member.declared !== null && reading !== null && reading.value === member.value;
    const viaAuthority = member.declared === null && authority !== null && member.value === authority.value;
    const status = cited ? "engine-cited" : viaAuthority ? `via:${authority.symbol}` : entry ? "debt" : "invented";
    if (cited || viaAuthority) engineCited += 1;
    if (status === "debt") {
      debtCount += 1;
      debtMatched.add(entry);
    }
    if (status === "invented") {
      findings.push(
        `invented_gate:${member.path}:${member.line}:${member.symbol}:ours=${member.value}:engine=${
          reading?.value ?? "unstated"
        }`,
      );
      findings.push(`  cited: ${reading?.citation ?? "nothing"} - ${reading?.why ?? "no citation in the doc comment"}`);
    }
    // The second assertion: a citation of a DECISION names the tile it measures (`grabTile`); a citation of
    // a predicate names none, so nothing says what the number is measured against and a reader has to be
    // shown the tiles it is applied to instead. Printed for every constant, a finding only where it is silent.
    if (status !== "debt" && member.declared !== null && reading?.subject == null) {
      findings.push(
        `invented_gate_subject:${member.path}:${member.line}:${member.symbol}:measured=${subjects.join("|")}`,
      );
      findings.push(
        `  measured: ${member.sites.map((site) => `${site.subject} at :${site.line}`).join(", ")}; ` +
          `the citation states no subject (${reading?.citation ?? "no citation"})`,
      );
    }
    if (member.declared !== null) {
      named.push(
        `const ${member.path}:${member.line} ${member.symbol} ours=${member.value} ` +
          `engine=${reading?.value ?? "unstated"} status=${status} measured=${subjects.join("|")}` +
          (reading?.citation ? ` cited=${reading.citation}` : ""),
      );
    }
  }
  for (const entry of debt) {
    if (debtMatched.has(entry)) continue;
    findings.push(`debt_expired:${entry.path}:${entry.symbol}=${entry.value}`);
  }

  const literals = [...members.values()].filter((member) => member.declared === null);
  return {
    predicates,
    sites,
    members,
    readings,
    authority,
    named,
    findings,
    examined: members.size,
    engineCited,
    debt: debtCount,
    invented: members.size - engineCited - debtCount,
    literalSites: literals.reduce((total, member) => total + member.sites.length, 0),
    literalValues: [...new Set(literals.map((member) => member.value))].sort((left, right) => left - right),
    notExamined: notExaminedComparisons(closure, declarations, members),
  };
}

/** The one reason the gate refuses to render a verdict: a reading that found nothing has not passed. */
export function blockedReason(report) {
  return report.examined === 0 ? "invented_gates_no_population" : null;
}

/**
 * The rules this gate asserts, one entry per finding it can report red with - the list the default run's report
 * enumerates. Built from this table rather than from the findings, so a rule that passed today is named beside the one
 * that failed; a report that lists only what went wrong cannot say what the gate looked at.
 */
export const RULES = Object.freeze([
  { id: "engine_citations_readable", codes: ["stardew_decompile_root_missing"] },
  { id: "population_derived_from_request_paths", codes: ["invented_gates_no_population"] },
  { id: "every_reach_bound_resolves", codes: ["unresolved_bound:"] },
  { id: "every_bound_is_the_engine_number", codes: ["invented_gate:"] },
  { id: "one_constant_measures_one_subject", codes: ["invented_gate_subject:"] },
  { id: "stated_debt_expires", codes: ["debt_expired:"] },
]);

/** A finding line starts in column 0; an indented one is the detail of the finding above it, not a finding. */
const FINDING_LINE = /^[^ ]/u;

/** The per-rule outcomes, each rule's findings named, in `RULES` order. */
export function ruleChecks({ findings = [], blocked = null } = {}) {
  const reported = findings.filter((finding) => FINDING_LINE.test(finding));
  const checks = RULES.map((rule) => {
    if (blocked !== null) {
      // A blocked run measured nothing, so nothing below it passed: the rule that names the block says so, the rest say
      // they were not reached.
      return {
        id: rule.id,
        status: "not_measured",
        reason: rule.codes.includes(blocked) ? blocked : `not reached: ${blocked}`,
      };
    }
    const hits = reported.filter((finding) => rule.codes.some((code) => finding.startsWith(code)));
    return hits.length === 0 ? { id: rule.id, status: "passed" } : { id: rule.id, status: "failed", findings: hits };
  });
  // A finding this table does not name is a rule reported red and absent from the report, so it is enumerated rather
  // than dropped: the report's population stays the gate's own capability.
  const covered = RULES.flatMap((rule) => rule.codes);
  for (const finding of reported) {
    if (covered.some((code) => finding.startsWith(code))) continue;
    checks.push({ id: `unclassified:${finding.split(":")[0]}`, status: "failed", findings: [finding] });
  }
  return checks;
}

/** The one JSON report the default run ends with — the line `tools/lib/harness-conformance.mjs` reads. */
function reportLine({ report = null, blocked = null } = {}) {
  const checks = ruleChecks({ findings: report?.findings ?? [], blocked });
  const status = blocked !== null ? "blocked" : checks.some((check) => check.status === "failed") ? "failed" : "passed";
  return JSON.stringify({
    gate: "stardew-invented-gates",
    examined: report?.examined ?? 0,
    engineCited: report?.engineCited ?? 0,
    debt: report?.debt ?? 0,
    invented: report?.invented ?? 0,
    authority: report?.authority?.symbol ?? null,
    findings: report?.findings ?? [],
    checks,
    status,
  });
}

function main() {
  const asJson = process.argv.includes("--json");
  const modIndex = process.argv.indexOf("--mod");
  const modRoot = modIndex >= 0 ? process.argv[modIndex + 1] : undefined;
  const engine = indexEngineSources();
  if (engine === null) {
    console.log(
      `stardew_invented_gates_skipped: stardew_decompile_root_missing - ${DECOMPILED_ROOT} is absent, so no cited ` +
        "member can be read and no constant can be called engine-cited",
    );
    console.log(reportLine({ blocked: "stardew_decompile_root_missing" }));
    process.exitCode = 2;
    return;
  }
  const report = analyze({ sources: readModSources(modRoot === undefined ? {} : { modRoot }), engine });
  const blocked = blockedReason(report);
  if (blocked !== null) {
    console.log(`${blocked}: no reach bound in a request path was found under the controller partials`);
    console.log(reportLine({ report, blocked }));
    process.exitCode = 2;
    return;
  }
  const line = reportLine({ report });
  if (asJson) {
    console.log(line);
    process.exitCode = report.findings.length === 0 ? 0 : 1;
    return;
  }
  console.log(
    "invented-gates: reader integrations/stardew/action-development/src/analysis/stardew-mod-csharp-source.mjs",
  );
  console.log(
    `invented-gates: reach predicates Mod=${report.predicates.mod.length} engine=${report.predicates.engine.length}; ` +
      `sites=${report.sites.length}; literal sites=${report.literalSites} values={${report.literalValues.join(",")}}; ` +
      `authority=${report.authority ? `${report.authority.symbol}=${report.authority.value}` : "none"}`,
  );
  console.log(
    `invented-gates: constants examined ${report.examined} · engine-cited ${report.engineCited} · ` +
      `debt ${report.debt} · invented ${report.invented}`,
  );
  for (const name of report.named) console.log(`invented-gates: ${name}`);
  if (report.notExamined.length > 0) {
    console.log(`invented-gates: not examined (not a reach): ${report.notExamined.join(", ")}`);
  }
  for (const finding of report.findings) console.log(finding);
  console.log(line);
  process.exitCode = report.findings.length === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
