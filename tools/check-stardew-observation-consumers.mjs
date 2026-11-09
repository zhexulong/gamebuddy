#!/usr/bin/env node
/**
 * Can the model ASK about the family an action aims at, or must it pay a whole `stardew_observe`?
 *
 * WHY. `tools/audit-stardew-discovery-channels.mjs` walks four hops for every target-bearing action - the Mod publishes
 * the family, the Host types it, the envelope admits it, the tool description names it - and stops there. Its last hop
 * asks whether SOMETHING consumes the family, and a sentence in a tool description consumes it: `rotate_furniture`'s
 * `expectedTargetId` says, in the argument's own words, "copied from the `worldObjectTargets` entry of the MOST RECENT
 * observe result". The chain is complete and the action is still unreachable without paying ~7k tokens for a full
 * observation, because "the description mentions the family" and "the model can ask a question about the family" are two
 * different facts and only the first one was measured.
 *
 * THE QUESTION, once per (action, family) pair where the action declares a `targetFamily`:
 *   can the model ASK about that family, or is a whole `observe` the only channel?
 *
 * The two queryable channels are DERIVED, never listed here:
 *   - `host/src/game-lookup.ts` - the `stardew_look_up` subjects. Each subject's answer is computed from specific
 *     snapshot families; the derivation reads the `case "<subject>": return <fn>` table for the subject vocabulary and
 *     the `snapshot.<family>` reads inside each subject's own function body for the families it can answer.
 *   - `host/src/snapshot-hud.ts` - the State HUD block re-stated into every turn. Each line DECLARES `fields`, typed
 *     `keyof Snapshot`, so a line cannot read a family it does not declare and this derivation reads the declaration.
 * A third channel is derived from the Mod's own affordance construction sites, because `stardew_read_scene` answers a
 * location's affordances with the identifier the action demands (`host/src/affordance-action-agreement.test.ts` is the
 * gate that proves the identifier is offered); a scene kind whose `actionHint` names a registered action is a channel
 * for that action, and an action that declares an `ObservationBinding` (`sceneTarget`) is answered only by the scene.
 *
 * A tool description that NAMES a family is not a channel, and neither is the fact that a `chest_store`-style argument
 * says where to copy a value from: both describe a dependency on `observe` rather than a way to ask.
 *
 * CLASSIFICATION per pair, and only one of them reds:
 *   `queryable`   a `stardew_look_up` subject reads the family - the model can ask a bounded question for free;
 *   `hud_line`    a State HUD line reads it - the fact arrives with every turn, so nothing has to be asked. This is a
 *                 legitimate answer, not a gap: `shop_purchase -> shopTargets` is answered by the `shop` line;
 *   `scene`       the Mod publishes an affordance for this action, or the action requires an `ObservationBinding`;
 *   `no_channel`  none of the above. The model cannot ask, so the family's values are only visible in a full observe.
 *                 This is the finding, and it reds unless the baseline below declares it.
 *
 * THE BASELINE (`tools/stardew-observation-consumers-baseline.json`) is a measured ratchet, not an acceptance: every
 * entry is a pair that `no_channel` reds TODAY, with the kind of dependency it names and the concrete case. It is
 * checked in BOTH directions - an entry whose pair now has a channel is `stale_baseline_entry` and must be deleted, and
 * an entry naming a pair the surface no longer declares is `baseline_entry_unknown_pair` - so the list can only shrink.
 *
 * ZERO POPULATION IS BLOCKED, never green: a surface with no target-bearing action, a lookup source with no subject, a
 * HUD source with no line, or a subject advertised by `LOOKUP_SUBJECTS` with no case in the switch, all print
 * `observation_consumers_blocked: <reason>` and exit 1. A check that agrees with itself proves nothing.
 *
 *   node tools/check-stardew-observation-consumers.mjs            # the verdict; exit 1 on an undeclared no_channel
 *   node tools/check-stardew-observation-consumers.mjs --list     # every pair and its classification
 *
 * red-proof: inject  add a target-bearing action to a synthetic surface whose family no channel reads, and the gate
 *   fails naming that pair; `tools/check-stardew-observation-consumers.test.mjs` plants exactly that.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const SURFACE = "integrations/stardew/action-development/contracts/generated/action-surface.v1.json";
export const LOOKUP_SOURCE = "host/src/game-lookup.ts";
export const HUD_SOURCE = "host/src/snapshot-hud.ts";
export const MOD_ENTRY = "integrations/stardew/ModEntry.cs";
export const PROTOCOL_SOURCE = "host/src/protocol.ts";
export const BASELINE = "tools/stardew-observation-consumers-baseline.json";

/** The shortest reason this gate will treat as a reason. A baseline entry that cannot name its case is a finding. */
const MIN_REASON_LENGTH = 40;

/**
 * `LOOKUP_SUBJECTS` (the tool's advertised vocabulary) and, per subject, the snapshot families its own function reads.
 *
 * The two halves are derived separately on purpose: the vocabulary is what the model is TOLD it may ask, and the
 * families are what an answer is actually computed from. A subject with no case, or a case with no family, is reported
 * rather than skipped - a `stardew_look_up` that advertises a subject the switch refuses is the same defect one layer
 * up from the one this gate is about.
 */
export function lookupChannels(source) {
  const vocabulary = readStringArray(source, /export const LOOKUP_SUBJECTS = Object\.freeze\(\[([^\]]*)\]/u);
  const cases = new Map(
    [...source.matchAll(/case "([a-z][a-z0-9_]*)":\s*return ([A-Za-z][A-Za-z0-9_]*)\(([^)]*)\)/gu)].map((match) => [
      match[1],
      { fn: match[2], args: match[3] },
    ]),
  );
  const channels = new Map();
  const nonSnapshot = new Map();
  const problems = [];
  for (const subject of vocabulary) {
    const entry = cases.get(subject);
    if (entry === undefined) {
      problems.push(`lookup_subject_without_case:${subject}`);
      continue;
    }
    const body = functionBody(source, `function ${entry.fn}(`);
    if (body === "") {
      problems.push(`lookup_subject_without_body:${subject}(${entry.fn})`);
      continue;
    }
    const fields = [...new Set([...body.matchAll(/snapshot\.([A-Za-z][A-Za-z0-9]*)/gu)].map((match) => match[1]))];
    if (fields.length > 0) {
      channels.set(subject, fields);
      continue;
    }
    // A subject whose arm HANDS the snapshot to a function that then reads no family of it is the defect this check is
    // for. A subject that reads a different source altogether is a channel of its own kind: `my_work` answers from the
    // Mod's Body Program journal, so it has no snapshot family to read and reporting it as a gap would be asking it to
    // become something it is not. Which of the two it is comes from the arm's own arguments, not from a list here.
    if (/\bsnapshot\b/u.test(entry.args)) {
      problems.push(`lookup_subject_reads_nothing:${subject}(${entry.fn})`);
      continue;
    }
    nonSnapshot.set(subject, entry.fn);
  }
  return { vocabulary, channels, nonSnapshot, problems, genericFamilyLookup: acceptsAnySnapshotFamily(source) };
}

/**
 * Does the tool answer a family by name, without a hand-written subject for it?
 *
 * This is the difference between "the model can ask" and "the model can pay a full observe": the five shaped
 * subjects are doors, and a generic path keyed on `SNAPSHOT_KEYS` means every family the snapshot declares has one.
 * The audit reads the SOURCE for this rather than trusting a comment, so a tool that stops accepting family names
 * puts the 70 pairs back in front of a human.
 */
function acceptsAnySnapshotFamily(source) {
  const body = functionBody(source, "function lookUp(");
  return /SNAPSHOT_KEYS/u.test(body) && /familyRows\(/u.test(body);
}

/** The State HUD lines and the families each declares in `fields`. */
export function hudChannels(source) {
  const header = "export const SNAPSHOT_HUD_LINES";
  const at = source.indexOf(header);
  if (at < 0) return { lines: [], problems: ["hud_lines_unread"] };
  const wrapped = source.indexOf("Object.freeze(", at);
  if (wrapped < 0) return { lines: [], problems: ["hud_lines_unread"] };
  const open = source.indexOf("[", wrapped);
  if (open < 0) return { lines: [], problems: ["hud_lines_unread"] };
  const body = balancedSlice(source, open, "[", "]");
  const lines = [...body.matchAll(/name:\s*"([^"]+)",\s*fields:\s*\[([^\]]*)\]/gu)].map((match) => ({
    name: match[1],
    fields: [...match[2].matchAll(/"([^"]+)"/gu)].map((field) => field[1]),
  }));
  const problems = lines
    .filter((line) => line.fields.length === 0)
    .map((line) => `hud_line_without_fields:${line.name}`);
  return { lines: lines.filter((line) => line.fields.length > 0), problems };
}

/**
 * Which registered actions the Mod's own `read_scene` affordances name.
 *
 * The parse is the one `host/src/affordance-action-agreement.test.ts` already performs over the same construction sites
 * (`new SceneAffordanceSource(SceneAffordanceKind.X, ... "actionHint", ...)` plus the hint switch); that gate asks
 * whether the affordance offers the identifier the action demands, and this one asks whether an affordance exists at
 * all. Both read the Mod, neither restates the other's answer. An empty result is a problem, not a pass: a Mod that
 * publishes no affordance cannot be a channel, and a parse that silently stopped matching must not read as "covered".
 */
export function sceneActions(modEntrySource, knownActionIds) {
  const known = new Set(knownActionIds);
  const hinted = new Set();
  for (const block of modEntrySource.matchAll(
    /new SceneAffordanceSource\(\s*SceneAffordanceKind\.(\w+)([\s\S]{0,900}?)\)\);/gu,
  )) {
    const literal = /"([a-z0-9_]+)"\s*,\s*SceneAffordanceKindWire\.DefaultPriority/u.exec(block[2]);
    const ternary = /\?\s*"([a-z0-9_]+)"\s*:\s*"([a-z0-9_]+)"/u.exec(block[2]);
    const names = literal === null ? (ternary === null ? [] : [ternary[1], ternary[2]]) : [literal[1]];
    for (const name of names) if (known.has(name)) hinted.add(name);
  }
  for (const arm of modEntrySource.matchAll(/SceneAffordanceKind\.(\w+)\s*=>\s*"([a-z0-9_]+)"/gu))
    if (known.has(arm[2])) hinted.add(arm[2]);
  return hinted;
}

/**
 * The population: every action the surface declares with a `targetFamily`.
 *
 * `opaqueArguments` is derived from the action's own `argumentSchema` and is the severity the report prints beside the
 * pair: an action whose schema demands an identity (`expectedTargetId`, `chestId`) cannot be dispatched at all without
 * that family's published id, while an action addressed by `x`/`y`/`slot` can at least be attempted from a tile the
 * model is already standing on. Both are findings; they are not the same finding.
 */
export function targetBearingPairs(surface) {
  const actions = Array.isArray(surface?.actions) ? surface.actions : [];
  const pairs = [];
  for (const action of actions) {
    if (typeof action?.actionId !== "string") continue;
    if (typeof action.targetFamily !== "string" || action.targetFamily.length === 0) continue;
    const argumentsDeclared = Object.keys(action.argumentSchema ?? {});
    pairs.push({
      actionId: action.actionId,
      family: action.targetFamily,
      lifecycle: typeof action.lifecycle === "string" ? action.lifecycle : "unknown",
      // The identity argument, by the surface's own spelling: `expectedTargetId` on 76 of the 88 actions today. An
      // action whose only arguments are `x`/`y`/`slot` can be attempted from the tile the model already stands on; one
      // that demands this argument cannot be dispatched at all until the family is read, which is the harder finding.
      opaqueArguments: argumentsDeclared.filter((name) => /TargetId$/u.test(name)),
      requiresSceneBinding: action.sceneTarget !== undefined,
    });
  }
  return pairs;
}

/** One classification per pair, from the derived channels. Order of precedence is the order of the channels' cost. */
export function classifyPairs({ pairs, lookup, hud, scene, snapshotKeys = [] }) {
  const subjectByFamily = new Map();
  for (const [subject, families] of lookup.channels)
    for (const family of families) if (!subjectByFamily.has(family)) subjectByFamily.set(family, subject);
  const hudLineByFamily = new Map();
  for (const line of hud.lines)
    for (const family of line.fields) if (!hudLineByFamily.has(family)) hudLineByFamily.set(family, line.name);
  const declaredFamilies = new Set(snapshotKeys);
  return pairs.map((pair) => {
    const subject = subjectByFamily.get(pair.family);
    if (subject !== undefined) return { ...pair, classification: "queryable", channel: `look_up:${subject}` };
    const line = hudLineByFamily.get(pair.family);
    if (line !== undefined) return { ...pair, classification: "hud_line", channel: `hud:${line}` };
    if (scene.has(pair.actionId)) return { ...pair, classification: "scene", channel: "read_scene:affordance" };
    if (pair.requiresSceneBinding) return { ...pair, classification: "scene", channel: "read_scene:binding" };
    // The generic family door: the tool answers any family the snapshot declares, so a declared family is askable
    // by name. A family the snapshot does NOT declare is worse than no channel - nothing can ever answer it -
    // so it keeps its own classification and its own refusal word below.
    if (lookup.genericFamilyLookup === true) {
      if (declaredFamilies.has(pair.family))
        return { ...pair, classification: "queryable", channel: `look_up:${pair.family}` };
      return { ...pair, classification: "family_not_in_snapshot", channel: null };
    }
    return { ...pair, classification: "no_channel", channel: null };
  });
}

/** `<actionId> -> <family>`, the pair's identity in the baseline and in every finding. */
export function pairId(pair) {
  return `${pair.actionId} -> ${pair.family}`;
}

/** How many of the rows demand an opaque identity, printed so the severity of the list is a number. */
function opaqueOf(pairs) {
  return pairs.filter((pair) => pair.opaqueArguments.length > 0).length;
}

/**
 * The verdict, from sources rather than from files, so the tests can drive it without the tree.
 *
 * `files` carries the texts: `{ surface, lookup, hud, modEntry, baseline }`. A missing file is a blocked measurement.
 */
export function auditConsumers({ surface, lookupSource, hudSource, modEntrySource, baseline, protocolSource }) {
  const blocked = [];
  const pairs = targetBearingPairs(surface);
  if (pairs.length === 0) blocked.push("surface_declares_no_target_family");

  const lookup = lookupChannels(lookupSource ?? "");
  if (lookup.vocabulary.length === 0) blocked.push("lookup_subjects_unread");
  blocked.push(...lookup.problems);

  const hud = hudChannels(hudSource ?? "");
  if (hud.lines.length === 0) blocked.push("hud_lines_unread");
  blocked.push(...hud.problems);

  const knownActionIds = (Array.isArray(surface?.actions) ? surface.actions : [])
    .map((action) => action?.actionId)
    .filter((id) => typeof id === "string");
  const scene = sceneActions(modEntrySource ?? "", knownActionIds);
  if (scene.size === 0) blocked.push("scene_affordances_unread");

  const classified = classifyPairs({
    pairs,
    lookup,
    hud,
    scene,
    snapshotKeys: readStringArray(protocolSource ?? "", /export const SNAPSHOT_KEYS = \[([\s\S]*?)\n\]/u),
  });
  const entries = Array.isArray(baseline?.entries) ? baseline.entries : [];
  const baselineById = new Map();
  const findings = [];
  for (const entry of entries) {
    const id = typeof entry?.id === "string" ? entry.id : "";
    if (baselineById.has(id)) findings.push({ code: "baseline_entry_duplicated", pair: id });
    baselineById.set(id, entry);
    if (typeof entry?.reason !== "string" || entry.reason.length < MIN_REASON_LENGTH)
      findings.push({ code: "baseline_entry_unreasoned", pair: id, detail: "no reason long enough to name the case" });
    if (typeof entry?.kind !== "string" || entry.kind.length === 0)
      findings.push({ code: "baseline_entry_unreasoned", pair: id, detail: "no kind" });
  }

  const byId = new Map(classified.map((pair) => [pairId(pair), pair]));
  for (const id of baselineById.keys()) {
    const pair = byId.get(id);
    if (pair === undefined) {
      findings.push({ code: "baseline_entry_unknown_pair", pair: id, detail: "the surface no longer declares it" });
      continue;
    }
    if (pair.classification !== "no_channel")
      findings.push({
        code: "stale_baseline_entry",
        pair: id,
        detail: `now ${pair.classification} through ${pair.channel}; delete the entry`,
      });
  }

  for (const pair of classified) {
    // A family the snapshot never declares cannot be answered by anything, ever - that is not a missing door, it is
    // a fact nothing publishes. It is reported under its own word so the fix is obvious (publish it, or stop the
    // action naming it), and it cannot be baselined away as if a channel could be added later.
    if (pair.classification === "family_not_in_snapshot") {
      findings.push({
        code: "family_not_in_snapshot",
        pair: pairId(pair),
        detail: `${pair.family} is not among SNAPSHOT_KEYS, so no channel can ever answer it`,
      });
      continue;
    }
    if (pair.classification !== "no_channel") continue;
    if (baselineById.has(pairId(pair))) continue;
    findings.push({ code: "no_channel_undeclared", pair: pairId(pair), detail: pair });
  }

  const counts = { queryable: 0, hud_line: 0, scene: 0, no_channel: 0, family_not_in_snapshot: 0 };
  for (const pair of classified) counts[pair.classification] += 1;
  const reds = classified.filter((pair) => pair.classification === "no_channel");
  return {
    status: blocked.length > 0 ? "blocked" : findings.length === 0 ? "passed" : "failed",
    blocked,
    findings,
    counts,
    classified,
    pairs: classified.length,
    actions: knownActionIds.length,
    families: new Set(classified.map((pair) => pair.family)).size,
    declared: reds.filter((pair) => baselineById.has(pairId(pair))).length,
    undeclared: reds.filter((pair) => !baselineById.has(pairId(pair))).length,
    opaque: opaqueOf(reds),
    lookupVocabulary: lookup.vocabulary,
    lookupNonSnapshot: [...lookup.nonSnapshot.keys()],
    hudLines: hud.lines.length,
    sceneActions: scene.size,
  };
}

/** The whole check, read off the real tree. One function, so the CLI and its tests cannot read it two ways. */
export function auditTree({ read = (file) => readFileSync(resolve(ROOT, file), "utf8") } = {}) {
  const readOrNull = (file) => {
    try {
      return read(file);
    } catch {
      return null;
    }
  };
  const surfaceText = readOrNull(SURFACE);
  const lookupSource = readOrNull(LOOKUP_SOURCE);
  const hudSource = readOrNull(HUD_SOURCE);
  const modEntrySource = readOrNull(MOD_ENTRY);
  const baselineText = readOrNull(BASELINE);
  const protocolSource = readOrNull(PROTOCOL_SOURCE);
  const missing = [
    [SURFACE, surfaceText],
    [LOOKUP_SOURCE, lookupSource],
    [HUD_SOURCE, hudSource],
    [MOD_ENTRY, modEntrySource],
    [BASELINE, baselineText],
    // The snapshot's own key list is the population for the generic family door, so a tree without it cannot answer
    // the question this gate asks - skip rather than guess.
    [PROTOCOL_SOURCE, protocolSource],
  ]
    .filter(([, text]) => text === null)
    .map(([file]) => file);
  if (missing.length > 0) return { status: "blocked", blocked: [`missing_input:${missing.join(",")}`], findings: [] };
  return auditConsumers({
    surface: JSON.parse(surfaceText),
    lookupSource,
    hudSource,
    modEntrySource,
    baseline: JSON.parse(baselineText),
    protocolSource,
  });
}

function readStringArray(source, opener) {
  const body = opener.exec(source)?.[1];
  if (typeof body !== "string") return [];
  return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

/** The `{...}` body of the function whose header starts at `header`, or "" when the header is absent. */
function functionBody(source, header) {
  const at = source.indexOf(header);
  if (at < 0) return "";
  const open = source.indexOf("{", at);
  if (open < 0) return "";
  return balancedSlice(source, open, "{", "}");
}

function balancedSlice(source, start, open, close) {
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === open) depth += 1;
    else if (source[index] === close) {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return "";
}

export function report(result, { list = false, write = (text) => process.stdout.write(`${text}\n`) } = {}) {
  const out = (text) => write(text);
  if (result.status === "blocked") {
    for (const reason of result.blocked) out(`observation_consumers_blocked: ${reason}`);
    out("observation_consumers: blocked");
    return 1;
  }
  out(
    `observation_consumers: examined ${result.pairs} target-bearing pairs over ${result.actions} actions ` +
      `(${result.families} families)`,
  );
  out(
    `observation_consumers: queryable=${result.counts.queryable} hud_line=${result.counts.hud_line} ` +
      `scene=${result.counts.scene} no_channel=${result.counts.no_channel} ` +
      `(declared ${result.declared}, undeclared ${result.undeclared}; ${result.opaque} demand an opaque id)`,
  );
  out(
    `observation_consumers: channels derived from ${result.lookupVocabulary.length} look_up subjects ` +
      `[${result.lookupVocabulary.join(",")}], ${result.hudLines} HUD lines, ${result.sceneActions} scene affordance(s)` +
      (result.lookupNonSnapshot.length === 0
        ? ""
        : `; read from a source other than the snapshot [${result.lookupNonSnapshot.join(",")}]`),
  );
  if (list)
    for (const pair of result.classified)
      out(`observation_consumers_pair: ${pairId(pair)} ${pair.classification} ${pair.channel ?? "-"}`);
  for (const finding of result.findings) {
    switch (finding.code) {
      case "no_channel_undeclared":
        out(
          `observation_consumers_no_channel: ${finding.pair} - no look_up subject reads it, no HUD line declares it, ` +
            `and no read_scene affordance names the action; the only channel is a full stardew_observe`,
        );
        break;
      case "family_not_in_snapshot":
        out(
          `observation_consumers_family_not_in_snapshot: ${finding.pair} - ${finding.detail}` +
            `; nothing publishes it, so no channel can ever answer it`,
        );
        break;
      case "stale_baseline_entry":
        out(`observation_consumers_stale_baseline_entry: ${finding.pair} - ${finding.detail}`);
        break;
      case "baseline_entry_unknown_pair":
        out(`observation_consumers_baseline_entry_unknown_pair: ${finding.pair} - ${finding.detail}`);
        break;
      case "baseline_entry_duplicated":
        out(`observation_consumers_baseline_entry_duplicated: ${finding.pair} is listed twice`);
        break;
      case "baseline_entry_unreasoned":
        out(`observation_consumers_baseline_entry_unreasoned: ${finding.pair} - ${finding.detail}`);
        break;
      default:
        out(`observation_consumers_${finding.code}: ${finding.pair}`);
    }
  }
  out(`observation_consumers: ${result.status}`);
  return result.status === "passed" ? 0 : 1;
}

function main() {
  process.exitCode = report(auditTree(), { list: process.argv.includes("--list") });
}

if (import.meta.main) main();
