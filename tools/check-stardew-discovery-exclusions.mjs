#!/usr/bin/env node
/**
 * Every discovery family that filters a subject on a STATE the closed vocabulary names must publish the reason.
 *
 * WHY. A `Discover*` function that drops a subject and says nothing about the drop answers two different questions
 * with one empty list: "there is a tree on this tile but you cannot chop it" and "there is no tree here". The
 * companion then plans against an empty world - measured as a gate whose farm held only weeds scoring 100%. The wire
 * carries `discoveryExclusions: [{family, reason, count}]` beside the families it explains, with a closed vocabulary
 * of reasons (`DiscoveryExclusionReasons.cs`, mirrored by `host/src/protocol.ts`).
 *
 * POPULATION, and why it is derived this way. A text scan cannot decide whether a predicate is a subject-state
 * exclusion or a kind test - the same member (`Tree.stump`) is a STATE in `chop_tree` and the SUBJECT in `chop_stump`.
 * What it CAN decide is whether a FILTER POSITION (a `.Where(...)` lambda or an `if (...) continue;` guard) reads one
 * of the engine members the vocabulary already explains. So the population is `STATE_MEMBERS` below, keyed by the
 * token that explains each member, and it GROWS with the vocabulary: adding a token makes every method that filters on
 * its member accountable. `discoveries N` is printed for the wider population the scan walks.
 *
 * What the scan does NOT read, stated rather than hidden: a state guard written as `if (cond) return <reason>;` inside
 * a helper (that IS the explanation, not a filter), and a predicate that reads a state through another method's name.
 * Both are why the register below exists as well as the scan.
 *
 * ASSERTIONS
 *   1. A method that filters on an explained member must call `exclusions.Record(...)`, or be filed in
 *      `tools/stardew-discovery-exclusions-backlog.json` with a disposition. Otherwise it is a `filter_without_a_reason`
 *      and named with the member it filtered on.
 *   2. Every `exclusions.Record("family", ...)` call site must name a family the Mod DECLARES
 *      (`ExclusionReportingCapabilities` in the controller) and the wire schema publishes.
 *   3. Every declared reporting family must have a method that records it - a declaration with no publisher is a claim.
 *   4. The Mod's vocabulary and the Host's `DISCOVERY_EXCLUSION_REASONS` must be the same set, in both directions: one
 *      fact, two languages, compared by name rather than trusted.
 *   5. The register EXPIRES. An entry whose function no longer exists, or no longer filters on its `member`, is red; an
 *      entry whose `token` is now in the vocabulary is red; an entry with no disposition class is red. A disposition is
 *      `token pending: <state>`, `not vanilla: <who deletes it>`, or `kind test: <why the member names this family's
 *      subject rather than a state>` - the third class exists because the scan cannot tell a subject from a state, and
 *      pretending otherwise would file a correct filter as a defect.
 *   6. ACTOR-CAPABILITY DROPS. A state is not the only thing a filter can hide behind: "I hold no tool that can swing
 *      this" drops the same subject and is the same silence. The population for that class is `ACTOR_CAPABILITY_DROPS`
 *      beside `STATE_MEMBERS` - each entry is a CLAIM that one drop site is decided by what the actor holds (the guard
 *      names the value, the method reads the capability member), and the claim is verified against the source. A claim
 *      whose guard or member is gone is red (`capability_claim_unverified`); a claim whose disposition is `published:`
 *      must still record its family and its reason, or it is a `silent_discovery_drop`; a claim waiting for a token goes
 *      red the moment that token enters the vocabulary. A drop site filtering on a declared capability member with no
 *      entry at all is `actor_capability_drop_unregistered`, so the map grows with the class rather than with memory.
 *      What this population does NOT read, stated rather than hidden: it only knows the members its own entries name, so
 *      an actor test written against a member no entry has named yet is invisible until someone names it.
 *
 * VERDICT. `discoveries N, with exclusions M, filters without a reason K`, then each K by name with its disposition,
 * then the population line - `discovery bodies scanned N · containing continue M · continue statements K ·
 * actor-capability drops examined J` - so a small J is never mistaken for the whole set of drops in the tree.
 * Zero population is `not_measured` (exit 2), never green: a check whose population is empty agrees with itself.
 *
 * red-proof: inject `&& pair.Value.health.Value <= 0f` into `DiscoverWeedTargets`' filter; the gate prints
 *   `filter_without_a_reason: DiscoverWeedTargets ... health.Value` and exits 1.
 * red-proof: delete the `exclusions.Record("debrisTargets", ...)` call from `DiscoverDebrisTargets`; the gate prints
 *   `silent_discovery_drop: DiscoverDebrisTargets:<line>:debrisTargets` and exits 1.
 * red-proof: inject  adding `tool_insufficient` to `DiscoveryExclusionReasons.All` while the other four
 *   `token pending` entries stay filed; each names `capability_token_available` instead of accepting the stale disposition.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STARDEW = "integrations/stardew";
const VOCABULARY = "integrations/stardew/src/Core/Policy/DiscoveryExclusionReasons.cs";
const CONTROLLER = "integrations/stardew/farmhandexecutioncontroller.cs";
const HOST_PROTOCOL = "host/src/protocol.ts";
const SCHEMA = "protocol/bridge-v1.schema.json";
const BACKLOG = "tools/stardew-discovery-exclusions-backlog.json";
const SKIP_DIRS = new Set(["tests", "obj", "bin", "action-development", "navigation", "Sensory"]);

/** The disposition classes a register entry may carry, so "filed" cannot mean "nobody wrote why". */
export const DISPOSITION_CLASSES = Object.freeze(["token pending", "not vanilla", "kind test"]);

/**
 * The engine members the vocabulary explains, each under the token that explains it.
 *
 * Keyed by TOKEN rather than by function so a new token automatically makes every method filtering on its member
 * accountable, and a token that explains nothing is visible as an entry no method filters on.
 */
export const STATE_MEMBERS = Object.freeze({
  already_tapped: ["tapped.Value"],
  stump: ["stump.Value"],
  not_grown: ["growthStage.Value"],
  dead: [".dead.Value", "health.Value"],
  petted_today: ["wasPet.Value", "PettedToday"],
  already_watered: ["isWatered()", ".watered.Value", "waterSpots["],
  not_ready: ["readyForHarvest()", "daysOfConstructionLeft.Value"],
  wrong_harvest_method: ["GetHarvestMethod()"],
  already_baited: ["bait.Value"],
  shop_closed_today: ["ClosedMessage"],
  tool_insufficient: ["upgradeLevel.Value"],
});

/**
 * The drop sites whose reason is what the ACTOR HOLDS rather than what the world is: no tool at the tier, no gold, no
 * materials, no room in the pack.
 *
 * Each entry is a claim with two halves and the gate verifies both against the source: `guard` is the value its drop
 * guard tests, and `member` is the capability read that produced that value (a local computed from a tool search is the
 * usual shape - `usableSlot < 0` is decided by `IsValidDebrisTool`). `disposition` is one of:
 *   `published: <family> <token>` - the site records that row today, and the gate holds it to it;
 *   `token pending: <token>`       - the site is a real drop awaiting the vocabulary entry it needs, and the entry goes
 *                                   red the moment that token exists (the same expiry the backlog register has).
 * A capability member named here is also the population scan's vocabulary: a `Discover*` method that drops on one of
 * these members without an entry is `actor_capability_drop_unregistered`, not silence.
 */
export const ACTOR_CAPABILITY_DROPS = Object.freeze([
  {
    function: "DiscoverDebrisTargets",
    guard: "usableSlot",
    member: "IsValidDebrisTool",
    disposition: "published: debrisTargets tool_insufficient",
  },
  {
    function: "DiscoverBuildFarmBuildingTargets",
    guard: "Game1.player.Money",
    member: "Game1.player.Money",
    disposition: "token pending: insufficient_gold",
  },
  {
    function: "DiscoverBuildFarmBuildingTargets",
    guard: "CountBuildFarmBuildingMaterials",
    member: "CountBuildFarmBuildingMaterials",
    disposition: "token pending: insufficient_materials",
  },
  {
    function: "DiscoverAnimalProductTargets",
    guard: "MilkPail",
    member: "MilkPail",
    disposition: "token pending: tool_absent",
  },
  {
    function: "DiscoverAnimalProductTargets",
    guard: "couldInventoryAcceptThisItem",
    member: "couldInventoryAcceptThisItem",
    disposition: "token pending: inventory_full",
  },
]);

/** Every `.cs` file whose `Discover*` declarations form the population. */
function stardewSources(dir = STARDEW, out = []) {
  for (const entry of readdirSync(resolve(ROOT, dir), { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      stardewSources(path, out);
    } else if (entry.name.endsWith(".cs")) out.push(path);
  }
  return out;
}

/** `{ name, file, body, bodyStart }` for every `Discover*` method, expression bodies included. */
export function discoverMethods({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  const methods = [];
  for (const file of stardewSources()) {
    const text = read(file);
    const declaration = /\b(?:IReadOnlyList<[^;{}]*?>|IEnumerable<[^;{}]*?>)\s+(Discover\w+)\s*\(/gu;
    let match;
    while ((match = declaration.exec(text)) !== null) {
      const found = methodBody(text, match.index + match[0].length - 1);
      if (found === null) continue;
      methods.push({ name: match[1], file, body: found.body, bodyStart: found.start });
    }
  }
  return methods.sort((left, right) => left.name.localeCompare(right.name));
}

/** The method body from the opening `(` of its parameter list: brace-matched, or to the statement end for `=>`. */
function methodBody(text, openParen) {
  let index = openParen;
  let depth = 0;
  for (; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (index >= text.length) return null;
  index++;
  while (index < text.length && /\s/u.test(text[index])) index++;
  if (text.startsWith("=>", index)) {
    const end = text.indexOf("\n", index);
    return { body: text.slice(index, end === -1 ? text.length : end), start: index };
  }
  if (text[index] !== "{") return null;
  let braces = 0;
  const start = index;
  for (; index < text.length; index++) {
    if (text[index] === "{") braces++;
    else if (text[index] === "}") {
      braces--;
      if (braces === 0) return { body: text.slice(start, index + 1), start };
    }
  }
  return null;
}

/** The `(...)` group starting at `open`. */
function balanced(text, open) {
  if (text[open] !== "(") return null;
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") {
      depth--;
      if (depth === 0) return text.slice(open + 1, index);
    }
  }
  return null;
}

/** Every FILTER POSITION in a method body: `.Where(...)` lambdas and `if (...) continue;` guards, with their offsets. */
export function filterPositionSites(body) {
  const positions = [];
  for (const match of body.matchAll(/\.Where\s*\(/gu)) {
    const lambda = balanced(body, match.index + match[0].length - 1);
    if (lambda !== null) positions.push({ text: lambda, index: match.index });
  }
  for (const match of body.matchAll(/\bif\s*\(/gu)) {
    const condition = balanced(body, match.index + match[0].length - 1);
    if (condition === null) continue;
    const tail = body.slice(match.index + match[0].length + condition.length + 2);
    if (!/\bcontinue\s*;/u.test(/^\s*([^\n]*)/u.exec(tail)?.[1] ?? "")) continue;
    positions.push({ text: condition, index: match.index });
  }
  return positions;
}

/** The same positions as text, which is all the state scan needs. */
export function filterPositions(body) {
  return filterPositionSites(body).map((site) => site.text);
}

/**
 * Every CONDITION in a method body, whether or not it ends in `continue;`: the `.Where(...)` lambdas and every
 * `if (...)` guard.
 *
 * The capability scan reads this instead of the filter positions, because the shape of these drops is not fixed: the
 * same drop is `if (usableSlot < 0) continue;` in one commit and `if (usableSlot < 0) { exclusions.Record(...);
 * continue; }` in the next, and a population that went empty because the fix wrapped the body in braces would be a
 * population that only agreed with itself. A condition mentioning no state member is not counted by the state scan, so
 * widening this does not widen that.
 */
export function conditionSites(body) {
  const positions = [];
  for (const match of body.matchAll(/\.Where\s*\(/gu)) {
    const lambda = balanced(body, match.index + match[0].length - 1);
    if (lambda !== null) positions.push({ text: lambda, index: match.index });
  }
  for (const match of body.matchAll(/\bif\s*\(/gu)) {
    const condition = balanced(body, match.index + match[0].length - 1);
    if (condition !== null) positions.push({ text: condition, index: match.index });
  }
  return positions;
}

/** Which explained members a method body FILTERS on, as `[{ token, member }]`. */
export function membersFiltered(body) {
  const positions = filterPositions(body);
  const found = [];
  for (const [token, members] of Object.entries(STATE_MEMBERS))
    for (const member of members)
      if (positions.some((position) => position.includes(member))) found.push({ token, member });
  return found;
}

/** The families a method publishes through `exclusions.Record("family", ...)`. */
export function recordedFamilies(body) {
  return [...body.matchAll(/exclusions\.Record\(\s*"([A-Za-z]+)"/gu)].map((match) => match[1]);
}

/** The Mod's vocabulary tokens, read from its own declaration. */
export function vocabularyTokens({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  return [...read(VOCABULARY).matchAll(/public const string \w+ = "([a-z_]+)";/gu)].map((match) => match[1]);
}

/** The Host's mirror of the same set, read from `protocol.ts`. */
export function hostTokens({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  const block = /DISCOVERY_EXCLUSION_REASONS = Object\.freeze\(\[([\s\S]*?)\] as const\)/u.exec(read(HOST_PROTOCOL));
  return block === null ? null : [...block[1].matchAll(/"([a-z_]+)"/gu)].map((match) => match[1]);
}

/** The reporting families the Mod declares, from `ExclusionReportingCapabilities`. */
export function declaredFamilies({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  const block = /ExclusionReportingCapabilities\s*=\s*\{([\s\S]*?)\n    \};/u.exec(read(CONTROLLER));
  return block === null
    ? null
    : [...block[1].matchAll(/\(\s*"([a-z_]+)"\s*,\s*"([A-Za-z]+)"\s*\)/gu)].map((match) => ({
        capability: match[1],
        family: match[2],
      }));
}

/** The snapshot properties the wire schema publishes. */
export function schemaFamilies({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  return Object.keys(JSON.parse(read(SCHEMA)).$defs.snapshot.properties);
}

/** The `family` enum of the exclusion row, i.e. the families the WIRE admits a row for. */
export function schemaExclusionFamilies({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  const definition = JSON.parse(read(SCHEMA)).$defs.discoveryExclusion;
  return definition?.properties?.family?.enum ?? null;
}

function readBacklog({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  const parsed = JSON.parse(read(BACKLOG));
  return Array.isArray(parsed.entries) ? parsed.entries : [];
}

/** The PascalCase constant a token is published under, so a disposition names one spelling and the gate derives the other. */
function constantFromToken(token) {
  return token
    .split("_")
    .filter((part) => part.length > 0)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join("");
}

/** The whole measurement. One function, so the CLI and its falsifier cannot read the tree two different ways. */
export function measure({
  read = (file) => readFileSync(resolve(ROOT, file), "utf8"),
  methods = discoverMethods({ read }),
  entries = readBacklog({ read }),
  tokens = vocabularyTokens({ read }),
  mirror = hostTokens({ read }),
  declared = declaredFamilies({ read }),
  wireFamilies = schemaFamilies({ read }),
  wireExclusionFamilies = schemaExclusionFamilies({ read }),
  capabilityClaims = ACTOR_CAPABILITY_DROPS,
} = {}) {
  const findings = [];
  const unexplained = [];
  const filed = [];
  let withExclusions = 0;
  const byFunction = new Map(methods.map((method) => [method.name, method]));
  const declaredSet = new Set((declared ?? []).map((entry) => entry.family));
  const wireSet = new Set(wireFamilies);

  if (mirror === null)
    findings.push({
      code: "host_vocabulary_missing",
      subject: HOST_PROTOCOL,
      detail: "DISCOVERY_EXCLUSION_REASONS was not found",
    });
  if (declared === null)
    findings.push({
      code: "declaration_missing",
      subject: CONTROLLER,
      detail: "ExclusionReportingCapabilities was not found",
    });
  if (mirror !== null) {
    for (const token of tokens.filter((candidate) => !mirror.includes(candidate)))
      findings.push({
        code: "vocabulary_drift",
        subject: token,
        detail: "published by the Mod and missing from the Host's closed set",
      });
    for (const token of mirror.filter((candidate) => !tokens.includes(candidate)))
      findings.push({
        code: "vocabulary_drift",
        subject: token,
        detail: "published by the Host and missing from the Mod's closed set",
      });
  }
  for (const token of Object.keys(STATE_MEMBERS).filter((candidate) => !tokens.includes(candidate)))
    findings.push({
      code: "explained_member_without_a_token",
      subject: token,
      detail:
        "STATE_MEMBERS explains a member with a token the vocabulary no longer admits, so this population is stale",
    });
  for (const token of tokens.filter((candidate) => !Object.hasOwn(STATE_MEMBERS, candidate)))
    findings.push({
      code: "token_explains_nothing",
      subject: token,
      detail:
        "the vocabulary admits a token whose engine member STATE_MEMBERS does not name, so no method is accountable",
    });

  const publishedFamilies = new Set();
  for (const method of methods) {
    const records = recordedFamilies(method.body);
    if (records.length > 0) withExclusions++;
    for (const family of records) {
      publishedFamilies.add(family);
      if (!declaredSet.has(family))
        findings.push({
          code: "undeclared_family",
          subject: method.name,
          detail: `"${family}" is not in ExclusionReportingCapabilities`,
        });
      if (!wireSet.has(family))
        findings.push({
          code: "family_without_a_wire_field",
          subject: method.name,
          detail: `"${family}" is not a snapshot property`,
        });
    }
    for (const read of membersFiltered(method.body)) {
      if (records.length > 0) continue;
      const entry = entries.find((candidate) => candidate.function === method.name && candidate.member === read.member);
      if (entry === undefined) {
        unexplained.push({ function: method.name, file: method.file, member: read.member, token: read.token });
        continue;
      }
      const className = String(entry.disposition ?? "")
        .split(":")[0]
        .trim();
      if (!DISPOSITION_CLASSES.includes(className)) {
        findings.push({
          code: "backlog_unreasoned",
          subject: `${method.name} ${read.member}`,
          detail: `disposition "${String(entry.disposition ?? "")}" names no class; classes are ${DISPOSITION_CLASSES.join("|")}`,
        });
        continue;
      }
      if (typeof entry.token === "string" && tokens.includes(entry.token)) {
        findings.push({
          code: "backlog_token_available",
          subject: `${method.name} ${read.member}`,
          detail: `"${entry.token}" is now in the closed vocabulary; publish it instead of filing this filter`,
        });
        continue;
      }
      filed.push({ function: method.name, member: read.member, entry });
    }
  }

  for (const entry of entries) {
    const method = byFunction.get(entry.function);
    if (method === undefined) {
      findings.push({
        code: "backlog_not_a_discovery",
        subject: entry.function,
        detail: "no `Discover*` method by that name exists",
      });
      continue;
    }
    if (!method.body.includes(entry.member))
      findings.push({
        code: "backlog_stale",
        subject: `${entry.function} ${entry.member}`,
        detail: "the method no longer reads it; delete the entry",
      });
  }
  for (const family of declaredSet)
    if (!publishedFamilies.has(family))
      findings.push({
        code: "declared_family_silent",
        subject: family,
        detail: "declared as exclusion-reporting, but no `Discover*` records it",
      });
  // The schema's `family` enum and the Mod's declaration are the same fact in two languages: compared by name, so
  // neither can grow alone. A family the wire refuses makes the whole snapshot frame unreadable, which has cost live
  // runs before.
  if (wireExclusionFamilies === null) {
    findings.push({
      code: "schema_family_enum_missing",
      subject: SCHEMA,
      detail: "$defs.discoveryExclusion has no `family` enum",
    });
  } else {
    for (const family of declaredSet)
      if (!wireExclusionFamilies.includes(family))
        findings.push({
          code: "schema_family_enum_drift",
          subject: family,
          detail: "declared by the Mod and missing from the schema's `family` enum",
        });
    for (const family of wireExclusionFamilies)
      if (!declaredSet.has(family))
        findings.push({
          code: "schema_family_enum_drift",
          subject: family,
          detail: "admitted by the schema's `family` enum and not declared by the Mod",
        });
  }

  // THE ACTOR-CAPABILITY POPULATION, and its population line. A `continue` is the shape a drop takes here, so the
  // counts are printed as measured: a small examined set beside 146 statements is the difference between "five drops
  // are actor-capability drops" and "there are only five drops", and only one of those is true.
  let withContinue = 0;
  let continueStatements = 0;
  for (const method of methods) {
    const count = [...method.body.matchAll(/\bcontinue\s*;/gu)].length;
    if (count > 0) withContinue++;
    continueStatements += count;
  }
  const texts = new Map();
  const lineAt = (method, offset) => {
    if (typeof method.bodyStart !== "number") return 0;
    if (!texts.has(method.file)) texts.set(method.file, read(method.file));
    return texts
      .get(method.file)
      .slice(0, method.bodyStart + offset)
      .split("\n").length;
  };
  const capabilityDrops = [];
  for (const claim of capabilityClaims) {
    const method = byFunction.get(claim.function);
    if (method === undefined) {
      findings.push({
        code: "capability_claim_unverified",
        subject: `${claim.function} ${claim.guard}`,
        detail: "no `Discover*` method by that name exists, so the claim names no drop site",
      });
      continue;
    }
    const sites = conditionSites(method.body).filter((site) => site.text.includes(claim.guard));
    if (sites.length === 0) {
      findings.push({
        code: "capability_claim_unverified",
        subject: `${claim.function} ${claim.guard}`,
        detail: `no drop guard in ${method.file} tests \`${claim.guard}\`; the claim is stale or the drop moved`,
      });
      continue;
    }
    if (!method.body.includes(claim.member)) {
      findings.push({
        code: "capability_claim_unverified",
        subject: `${claim.function} ${claim.member}`,
        detail: `the method no longer reads \`${claim.member}\`, so nothing proves this drop is about what the actor holds`,
      });
      continue;
    }
    const line = lineAt(method, sites[0].index);
    capabilityDrops.push({
      function: claim.function,
      file: method.file,
      line,
      guard: claim.guard,
      member: claim.member,
      disposition: claim.disposition,
    });
    if (claim.disposition.startsWith("published:")) {
      const [family, token] = claim.disposition.slice("published:".length).trim().split(/\s+/u);
      const reasonConstant = `DiscoveryExclusionReasons.${constantFromToken(token ?? "")}`;
      const publishes = family !== undefined && recordedFamilies(method.body).includes(family);
      if (!publishes || !method.body.includes(reasonConstant))
        findings.push({
          code: "silent_discovery_drop",
          subject: `${claim.function}:${line}:${family ?? "<no-family>"}`,
          detail:
            `the drop guarded by \`${claim.guard}\` must record \`exclusions.Record("${family}", ${reasonConstant})\`; ` +
            `it publishes ${publishes ? "no reason" : "nothing"} today`,
        });
    } else if (claim.disposition.startsWith("token pending:")) {
      const token = claim.disposition.slice("token pending:".length).trim();
      if (tokens.includes(token))
        findings.push({
          code: "capability_token_available",
          subject: `${claim.function}:${line}`,
          detail: `"${token}" is now in the closed vocabulary; publish the drop instead of filing it`,
        });
    } else {
      findings.push({
        code: "capability_disposition_unreasoned",
        subject: `${claim.function}:${line}`,
        detail: `disposition "${claim.disposition}" is neither \`published: <family> <token>\` nor \`token pending: <token>\``,
      });
    }
  }
  // A drop site filtering on a capability member with no claim above is a new member of the class: it is named rather
  // than accepted, so the map is the smallest thing and the SCAN is what grows.
  const capabilityVocabulary = [...new Set(capabilityClaims.flatMap((claim) => [claim.guard, claim.member]))];
  for (const method of methods)
    for (const site of conditionSites(method.body))
      for (const member of capabilityVocabulary.filter((candidate) => site.text.includes(candidate))) {
        // A claim covers both halves of its mechanism: the guard that drops and the capability read that decides it.
        const claimed = capabilityClaims.some(
          (claim) =>
            claim.function === method.name && (site.text.includes(claim.guard) || site.text.includes(claim.member)),
        );
        if (claimed) continue;
        findings.push({
          code: "actor_capability_drop_unregistered",
          subject: `${method.name}:${lineAt(method, site.index)}:${member}`,
          detail:
            "this drop is decided by what the actor holds and names no disposition in ACTOR_CAPABILITY_DROPS, so it is " +
            "neither published nor filed",
        });
      }

  return {
    status: findings.length === 0 && unexplained.length === 0 ? "passed" : "failed",
    discoveries: methods.length,
    withExclusions,
    unexplained,
    filed,
    findings,
    population: {
      scanned: methods.length,
      withContinue,
      continueStatements,
      capabilityDrops: capabilityDrops.length,
    },
  };
}

export function report(result) {
  if (result.discoveries === 0) {
    process.stdout.write(
      "stardew_discovery_exclusions_skipped: no `Discover*` method was found under integrations/stardew, so nothing was examined\n",
    );
    return 2;
  }
  process.stdout.write(
    `stardew_discovery_exclusions: discoveries ${result.discoveries}, with exclusions ${result.withExclusions}, ` +
      `filters without a reason ${result.unexplained.length + result.filed.length} (filed ${result.filed.length})\n`,
  );
  if (result.population !== undefined)
    process.stdout.write(
      `stardew_discovery_exclusions_population: discovery bodies scanned ${result.population.scanned} · ` +
        `containing continue ${result.population.withContinue} · continue statements ${result.population.continueStatements} · ` +
        `actor-capability drops examined ${result.population.capabilityDrops}\n`,
    );
  for (const entry of result.unexplained)
    process.stdout.write(
      `stardew_discovery_exclusions_filter_without_a_reason: ${entry.function} (${entry.file}) filters on ${entry.member} ` +
        `(explained by "${entry.token}") and publishes nothing\n`,
    );
  for (const entry of result.filed)
    process.stdout.write(
      `stardew_discovery_exclusions_filed: ${entry.function} filters on ${entry.member} - ${entry.entry.disposition}\n`,
    );
  for (const finding of result.findings)
    process.stdout.write(`stardew_discovery_exclusions_${finding.code}: ${finding.subject} - ${finding.detail}\n`);
  process.stdout.write(`stardew_discovery_exclusions: ${result.status}\n`);
  return result.status === "passed" ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = report(measure());
}
