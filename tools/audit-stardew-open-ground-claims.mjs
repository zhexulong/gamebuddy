// Gate: stardew_open_ground_claims/v1
//
// THE CLASS THIS NAMES: the Mod answers "can the body be on this tile?" in a few places with
// `GameLocation.isTilePassable`, and that call reads the map's Back and Buildings layers and NOTHING ELSE
// (GameLocation.cs:2898-2911). It reports a boulder, a chest, a chair or a TRELLIS CROP as open ground. The engine's own
// walking admission is `isCollidingPosition(..., pathfinding: true)` - the call `PathFindController.cs:222` makes - which
// consults the objects, the terrain features and the location's own override.
//
// The two answers disagree on exactly the tiles a farm is made of, and `StardewBodyController.cs:999-1005` already says
// so about the trellis case. It was found again on 2026-11-09 while giving a crop row its `tileBlockedNow` fact: the
// literal expression the task named (`location.isTilePassable(tile)`) would have published `true` for the trellis tile the
// field exists to expose. So the class gets a census rather than a fourth anecdote.
//
// POPULATION (derived on every run, printed as `examined N call sites`): every `isTilePassable(` call in the Mod's
// RUNTIME sources - `integrations/stardew/**/*.cs` excluding `tests/` and the `ModEntry.Fixtures*` files, which choose a
// controlled setup tile rather than deciding where the companion may walk - whose receiver is a `GameLocation`.
// `Building.isTilePassable` is a different API on a different subject (a big craftable's own footprint) and is excluded
// by receiver name, which is stated here because it is a boundary and not an accident.
//
// VERDICT: a site is `engine_open_ground_lie` when the member that contains it never asks the collision test, i.e. the
// map-only reading is the only answer that member has. A site beside a collision test is `corroborated` and printed as
// such, so the census counts BOTH and the exclusion cannot happen quietly.
//
// This gate is RED at the commit it lands, which is the point: these are pre-existing sites in files other lanes hold, and
// the job of this unit is to name them, not to fix them. `tools/check-prelive-gate-registry.mjs` records it as `debt`.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "stardew_open_ground_claims/v1";

const MOD_ROOT = "integrations/stardew";

/** Control keywords whose `( ... ) { ... }` block is not a method, so the walk keeps going outward. */
const NOT_A_MEMBER = new Set(["if", "for", "foreach", "while", "switch", "using", "catch", "lock", "do", "else"]);

/** One `.cs` file of the Mod's runtime surface, with its path and source. */
export function runtimeSources({
  list = (relative) => readdirSync(path.join(repositoryRoot, relative), { withFileTypes: true }),
  read = (relative) => readFileSync(path.join(repositoryRoot, relative), "utf8"),
} = {}) {
  const sources = [];
  const walk = (relative) => {
    const entries = list(relative).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const child = `${relative}/${entry.name}`;
      if (entry.isDirectory()) {
        if (["tests", "bin", "obj", "node_modules"].includes(entry.name)) continue;
        walk(child);
        continue;
      }
      if (!entry.name.endsWith(".cs")) continue;
      if (/\/ModEntry\.Fixtures[^/]*\.cs$/u.test(child)) continue;
      sources.push({ path: child, source: read(child) });
    }
  };
  walk(MOD_ROOT);
  return sources;
}

/**
 * The method the offset sits inside, by walking out through balanced braces until a block whose signature names a
 * declaration. Returns `{ name, body }`, or `null` when the offset is outside every member.
 */
export function enclosingMember(source, offset) {
  let depth = 0;
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (source[index] === "}") {
      depth += 1;
      continue;
    }
    if (source[index] !== "{") continue;
    if (depth > 0) {
      depth -= 1;
      continue;
    }
    const head = source.slice(Math.max(0, index - 600), index).replace(/\s+$/u, "");
    // The member's name is the identifier before the parameter list that closes at the end of the head. Read backwards
    // through balanced parentheses, so a multi-line signature (and a default value inside it) still names its member.
    const closeAt = head.lastIndexOf(")");
    if (closeAt < 0) continue;
    let parameters = 0;
    let openAt = -1;
    for (let cursor = closeAt; cursor >= 0; cursor -= 1) {
      if (head[cursor] === ")") parameters += 1;
      else if (head[cursor] === "(") {
        parameters -= 1;
        if (parameters === 0) {
          openAt = cursor;
          break;
        }
      }
    }
    if (openAt < 0) continue;
    const name = /(\w+)$/u.exec(head.slice(0, openAt))?.[1];
    const declared = /\b(?:public|private|internal|protected)\b/u.test(head);
    if (name !== undefined && !NOT_A_MEMBER.has(name) && declared) {
      const close = matchingBrace(source, index);
      return { name, body: close < 0 ? source.slice(index) : source.slice(index, close + 1) };
    }
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

/**
 * @param {{ sources?: readonly { path: string, source: string }[] }} options
 */
export function checkStardewOpenGroundClaims({ sources = runtimeSources() } = {}) {
  const findings = [];
  const corroborated = [];
  let examined = 0;
  for (const { path: file, source } of sources) {
    const pattern = /\b(\w+)\.isTilePassable\(/gu;
    for (const match of source.matchAll(pattern)) {
      const receiver = match[1];
      if (receiver === "building" || receiver === "Building") continue;
      examined += 1;
      const line = source.slice(0, match.index).split("\n").length;
      const member = enclosingMember(source, match.index) ?? { name: "<file scope>", body: "" };
      const entry = { file, line, member: member.name };
      if (member.body.includes("isCollidingPosition")) corroborated.push(entry);
      else findings.push(entry);
    }
  }
  const verdict = examined === 0 || findings.length > 0 ? "blocked" : "passed";
  return Object.freeze({
    gate,
    verdict,
    examined,
    findings: Object.freeze(findings),
    corroborated: Object.freeze(corroborated),
  });
}

function report(result) {
  const lines = [`stardew_open_ground_claims: examined ${result.examined} call sites of GameLocation.isTilePassable`];
  for (const finding of result.findings)
    lines.push(
      `engine_open_ground_lie:${finding.file}:${finding.line} in ${finding.member} - the map-only test is this member's ` +
        "only walking answer, so it reports a trellis crop, a rock or a chest as open ground",
    );
  for (const entry of result.corroborated)
    lines.push(`engine_open_ground_corroborated:${entry.file}:${entry.line} in ${entry.member}`);
  if (result.examined === 0)
    lines.push(
      "engine_open_ground_lie: <none examined> - the scan read no call site, which is not a clean tree; the population " +
        "is derived from the Mod's runtime sources and it is empty",
    );
  lines.push(
    `stardew_open_ground_claims: ${result.findings.length === 0 && result.examined > 0 ? "passed" : "blocked"}` +
      ` (${result.findings.length} lie(s), ${result.corroborated.length} corroborated)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.findings.length === 0 && result.examined > 0 ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = report(checkStardewOpenGroundClaims());
}
