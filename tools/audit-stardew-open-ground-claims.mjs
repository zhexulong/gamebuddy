// Gate: stardew_open_ground_claims/v1
//
// THE CLASS THIS NAMES: the Mod answers "can the body be on this tile?" in a few places with
// `GameLocation.isTilePassable`, and that call reads the map's Back and Buildings layers and NOTHING ELSE
// (GameLocation.cs:2898-2911). It reports a boulder, a chest, a chair or a TRELLIS CROP as open ground - and a `Bush`
// (an impassable `LargeTerrainFeature`, Bush.cs:15 / `isPassable` at :487-490) as a step the engine refuses. The
// engine's own walking admission is `isCollidingPosition(..., pathfinding: true)` - the call `PathFindController.cs:222`
// makes - which consults the objects, the terrain features, the LARGE terrain features (GameLocation.cs:2637-2648) and
// the location's own override.
//
// CORROBORATION IS A PROPERTY, NOT A SPELLING. A member has asked the collision test when its walking answer comes from
// either of two places, and nothing else counts:
//   * `isCollidingPosition` itself, for the site that wants the raw engine answer; or
//   * the one predicate that asks it - `StardewBodyController.IsWalkableTile` / `IsStandableTile` /
//     `IsPlannerAdmissibleTile` / `IsTileAdmittedForBody`. `StardewBodyController.cs:1196-1274` states why the Mod asks
//     this question in exactly one place, and `WarpThreeWayRuleTests` / `MoveApproachSubstitutionTests` pin the two
//     public readings to that one.
// The previous revision tested `member.body.includes("isCollidingPosition")`. That made the census demand sixteen
// copies of one engine fact and reported every member that answered through the predicate as a lie - a substring where
// the property belongs, which is the class `tools/check-child-output-parsing.mjs` exists for.
//
// THE PREDICATE IS CHECKED TOO, because corroboration-by-predicate is only worth what the predicate does. The
// declaration of `StardewBodyController.IsPlannerAdmissibleTile` must still perform `isCollidingPosition`; when it does
// not, the verdict is blocked and the finding names the predicate, so a member cannot be corroborated by an empty
// helper.
//
// POPULATION (derived on every run, printed as `examined N call sites`): every `isTilePassable(` call in the Mod's
// RUNTIME sources - `integrations/stardew/**/*.cs` excluding `tests/` and the `ModEntry.Fixtures*` files, which choose
// a controlled setup tile rather than deciding where the companion may walk - whose receiver is a `GameLocation`.
// `Building.isTilePassable` is a different API on a different subject (a big craftable's own footprint) and is excluded
// by receiver name, which is stated here because it is a boundary and not an accident.
//
// VERDICT: a site is `engine_open_ground_lie` when the member that contains it never asks the collision test, i.e. the
// map-only reading is the only answer that member has. A site whose member asks it is `corroborated` and printed with
// its site, so the census counts BOTH and neither answer can happen quietly. A population of zero is blocked: a scan
// that read no call site has not measured a clean tree.
//
// Measured at this commit: `examined 3 call sites, 0 lies, 3 corroborated` - the two map-geometry arms (a fence tile's
// own placement ground, the engine's `onlyNeedsToBePassable` buildable arm) and one refusal's published evidence, each
// beside the body's answer in the same member `tools/check-prelive-gate-registry.mjs` records it as `elsewhere`.
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const gate = "stardew_open_ground_claims/v1";

const MOD_ROOT = "integrations/stardew";

/** The one place the Mod asks the engine's own walking question, and the readings that delegate to it. */
export const BODY_ADMISSION = Object.freeze({
  file: "integrations/stardew/StardewBodyController.cs",
  /** The declaration that must still make the engine's call. */
  member: "IsPlannerAdmissibleTile",
  /** The engine call it must make; `isCollidingPosition(..., pathfinding: true)`, as `PathFindController` asks it. */
  collisionTest: "isCollidingPosition(",
  /** The names a member may use to ask it through the predicate. */
  readings: Object.freeze(["IsWalkableTile", "IsStandableTile", "IsPlannerAdmissibleTile", "IsTileAdmittedForBody"]),
});

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

/**
 * The text of one DECLARATION - its signature and its body, block-bodied or expression-bodied, ending at the `;` or `{`
 * that closes it. A call site cannot match: the modifiers must sit directly before the name with no parenthesis between
 * them, which every call site in this Mod violates because the caller's own signature is in that span.
 */
export function declarationText(source, name) {
  const pattern = new RegExp(`\\b(?:public|private|internal|protected)\\b[^;{}()]*\\b${name}\\s*\\(`, "gu");
  const match = pattern.exec(source);
  if (match === null) return null;
  let depth = 0;
  for (let index = match.index + match[0].length - 1; index < source.length; index += 1) {
    const character = source[index];
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (depth === 0 && (character === ";" || character === "{")) return source.slice(match.index, index + 1);
  }
  return source.slice(match.index);
}

/** Whether this member's walking answer comes from the collision test, directly or through the one predicate. */
export function asksCollisionTest(body) {
  if (body.includes(BODY_ADMISSION.collisionTest)) return true;
  return BODY_ADMISSION.readings.some((reading) => body.includes(`StardewBodyController.${reading}(`));
}

/**
 * Whether the predicate every corroborated site relies on still performs the engine's call. `ok: false` comes with the
 * sentence the report prints and names the predicate, never a bare boolean.
 */
export function checkAdmissionAuthority(sources) {
  const authority = sources.find((entry) => entry.path === BODY_ADMISSION.file);
  if (authority === undefined)
    return Object.freeze({
      member: BODY_ADMISSION.member,
      ok: false,
      reason:
        `${BODY_ADMISSION.file} is not in the scanned population, so ${BODY_ADMISSION.member} cannot be read and every ` +
        "site corroborated through the predicate would be answering from an unread helper",
    });
  const declaration = declarationText(authority.source, BODY_ADMISSION.member);
  if (declaration === null)
    return Object.freeze({
      member: BODY_ADMISSION.member,
      ok: false,
      reason:
        `${BODY_ADMISSION.member} is not declared in ${BODY_ADMISSION.file}, so the readings every corroborated site ` +
        "uses no longer resolve to the collision test",
    });
  if (!declaration.includes(BODY_ADMISSION.collisionTest))
    return Object.freeze({
      member: BODY_ADMISSION.member,
      ok: false,
      reason:
        `${BODY_ADMISSION.member} no longer performs ${BODY_ADMISSION.collisionTest}..., so a member corroborated ` +
        "through it is corroborated by an empty helper",
    });
  return Object.freeze({ member: BODY_ADMISSION.member, ok: true, reason: "" });
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
      if (asksCollisionTest(member.body)) corroborated.push(entry);
      else findings.push(entry);
    }
  }
  const authority = checkAdmissionAuthority(sources);
  const verdict = examined === 0 || findings.length > 0 || !authority.ok ? "blocked" : "passed";
  return Object.freeze({
    gate,
    verdict,
    examined,
    findings: Object.freeze(findings),
    corroborated: Object.freeze(corroborated),
    authority,
  });
}

function report(result) {
  const lines = [`stardew_open_ground_claims: examined ${result.examined} call sites of GameLocation.isTilePassable`];
  for (const finding of result.findings)
    lines.push(
      `engine_open_ground_lie:${finding.file}:${finding.line} in ${finding.member} - the map-only test is this member's ` +
        "only walking answer, so it reports a trellis crop, a bush, a rock or a chest as open ground",
    );
  for (const entry of result.corroborated)
    lines.push(`engine_open_ground_corroborated:${entry.file}:${entry.line} in ${entry.member}`);
  lines.push(
    result.authority.ok
      ? `engine_open_ground_predicate:${BODY_ADMISSION.file} ${result.authority.member} performs ` +
          `${BODY_ADMISSION.collisionTest}..., the call PathFindController.cs:222 admits a step with`
      : `engine_open_ground_predicate_lie:${BODY_ADMISSION.file} ${result.authority.reason}`,
  );
  if (result.examined === 0)
    lines.push(
      "engine_open_ground_lie: <none examined> - the scan read no call site, which is not a clean tree; the population " +
        "is derived from the Mod's runtime sources and it is empty",
    );
  lines.push(
    `stardew_open_ground_claims: ${result.verdict} ` +
      `(${result.findings.length} lie(s), ${result.corroborated.length} corroborated)`,
  );
  process.stdout.write(`${lines.join("\n")}\n`);
  return result.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = report(checkStardewOpenGroundClaims());
}
