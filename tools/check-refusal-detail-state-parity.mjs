#!/usr/bin/env node
/**
 * Which node states may carry a `refusalDetail`: one fact, one owner, one projection.
 *
 * WHY. Measured 2026-11-11: commit `15a3c57c` taught the Mod that a `for_each` pass which worked most of its rows is
 * `PartiallySucceeded` rather than `Failed`, and added that state to `BodyProgramValidation.MayCarryRefusalDetail`
 * (integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs). Its message says the Host half "now matches"; the
 * Host half is not in the diff - `BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES` (host/src/protocol.ts) still named the
 * three pre-`partially_succeeded` states. So the Mod sent a status frame the Host's own validator refused
 * (`invalid_body_program_result`), and `host/src/local-stardew-bridge.ts` closes the whole transport on one refused
 * body-program frame: a live run lost its 7th turn four minutes in, and the journal that proves it is the Mod's own
 * (`plan_75_38eb686380778241 / n01 state=12 PartiallySucceeded refusalDetailLen=490`).
 *
 * THE TWO SIDES, AND WHICH ONE IS THE AUTHORITY. The Mod's `MayCarryRefusalDetail` body is the fact; the Host set is a
 * projection of it, so this gate DERIVES the population from that method's own body - the `BodyProgramNodeState.<Name>`
 * members its expression names - and maps each to the wire spelling mechanically (`PartiallySucceeded` ->
 * `partially_succeeded`, the token `BridgeSession.ToWire` and the Host's own state table already use). Nothing here is
 * a second hand-written list: adding a state to the Mod's method, or removing one, changes what this gate examines with
 * no edit to this file.
 *
 * THREE RULES, each able to fail on its own:
 *   declaration_readable     - both declarations were found and named at least one state. A parser that finds nothing
 *                              has not proved agreement, so this is BLOCKED (exit 2), never green.
 *   wire_vocabulary          - every state the Mod permits maps to a token the Host's own node-state declaration
 *                              (`BODY_PROGRAM_NODE_STATE_VERDICTS`) carries, so a drift line below cannot be a
 *                              mis-spelling invented by the mapping.
 *   state_set_agreement      - the two sets are equal, member for member.
 *
 * VERDICT. `refusal_detail_states examined N · agree M · missing K` on one line, then one line per drifting member,
 * naming the state and the layer that does not carry it:
 *   refusal_detail_state_set_drift:<state>:<mod|host>
 *   refusal_detail_state_unknown_token:<state>:<mod>
 * `examined` is the union of the two sets, `agree` their intersection, `missing` the states exactly one side names.
 *
 * USAGE
 *   node tools/check-refusal-detail-state-parity.mjs            # the ratchet; exit 1 on drift, 2 when blocked
 *   node tools/check-refusal-detail-state-parity.mjs --json     # the whole report
 *   node tools/check-refusal-detail-state-parity.mjs --root DIR # read another checkout (the falsifier's own tree)
 *
 * red-proof: history  the shipped tree of `15a3c57c`, whose Mod method names `PartiallySucceeded` and whose Host set
 *   does not -> `refusal_detail_state_set_drift:partially_succeeded:host`
 *   (tools/check-refusal-detail-state-parity.test.mjs replays it from the real Host source)
 */
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MOD_PATH = "integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs";
export const HOST_PATH = "host/src/protocol.ts";

/** The Mod's own declaration: the one owner of "which states may carry a refusal detail". */
const MOD_DECLARATION = "MayCarryRefusalDetail";
/** The Host's projection of the same fact. */
const HOST_SET = "BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES";
/** The Host's node-state vocabulary, which every mapped token must belong to. */
const HOST_VOCABULARY = "BODY_PROGRAM_NODE_STATE_VERDICTS";

export const EXIT = Object.freeze({ agree: 0, drift: 1, blocked: 2 });
/** The report's own status as an exit code: an unrecognised status is the blocked answer, never a pass. */
const EXIT_FOR_STATUS = Object.freeze({ passed: EXIT.agree, failed: EXIT.drift, blocked: EXIT.blocked });

const DRIFT = "refusal_detail_state_set_drift";
const UNKNOWN_TOKEN = "refusal_detail_state_unknown_token";

/** `Foo` -> `foo`, `PartiallySucceeded` -> `partially_succeeded`: the wire spelling the Host token list uses. */
export function wireTokenOf(csharpMember) {
  return csharpMember.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

/** Comments carry examples of the words under test, so neither declaration is read through them. */
function withoutComments(source) {
  return source.replaceAll(/\/\*[\s\S]*?\*\//gu, "").replaceAll(/\/\/[^\n]*/gu, "");
}

/** The region of `source` from the first `[` inside `<anchor> = new Set(` to its closing `]`, or null. */
function setLiteralRegion(source, anchor) {
  const at = source.indexOf(anchor);
  if (at < 0) return null;
  const open = source.indexOf("[", source.indexOf("new Set(", at));
  if (open < 0) return null;
  const close = source.indexOf("]", open);
  return close < 0 ? null : source.slice(open + 1, close);
}

const quotedWords = (text) => [...text.matchAll(/"([A-Za-z0-9_]+)"/gu)].map((match) => match[1]);
const uniqueSorted = (values) => [...new Set(values)].sort();

/**
 * The states the Mod's `MayCarryRefusalDetail` names, as C# member names, or null when the method cannot be read.
 *
 * The body is an expression (`state is BodyProgramNodeState.A or ...`), so the region under test is what follows its
 * `=>` up to the statement's `;`. An empty read is null, not an empty population: the two are different readings.
 */
export function extractModStates(source) {
  const clean = withoutComments(source);
  const declaration = /MayCarryRefusalDetail\s*\([^)]*\)\s*=>/u.exec(clean);
  if (declaration === null) return null;
  const body = clean.slice(declaration.index + declaration[0].length);
  const end = body.indexOf(";");
  if (end < 0) return null;
  const members = [...body.slice(0, end).matchAll(/BodyProgramNodeState\.([A-Za-z0-9_]+)/gu)].map((match) => match[1]);
  return members.length === 0 ? null : uniqueSorted(members);
}

/** The wire states the Host's projection names, or null when the set cannot be read or names nothing. */
export function extractHostStates(source) {
  const clean = withoutComments(source);
  const region = setLiteralRegion(clean, `${HOST_SET}:`);
  if (region === null) return null;
  const states = quotedWords(region);
  return states.length === 0 ? null : uniqueSorted(states);
}

/** The Host's node-state vocabulary: the keys of its verdict declaration. */
export function extractHostVocabulary(source) {
  const clean = withoutComments(source);
  const at = clean.indexOf(`${HOST_VOCABULARY} = Object.freeze({`);
  if (at < 0) return null;
  const open = clean.indexOf("{", at);
  const close = clean.indexOf("}", open);
  if (open < 0 || close < 0) return null;
  const keys = [...clean.slice(open + 1, close).matchAll(/^\s*([a-z0-9_]+)\s*:/gmu)].map((match) => match[1]);
  return keys.length === 0 ? null : uniqueSorted(keys);
}

const check = (id, status, detail) => (detail === undefined ? { id, status } : { id, status, detail });

/**
 * Read both declarations and judge the three rules. Pure over its overrides, so a falsifier can hand it the tree that
 * drifted without touching a checkout.
 */
export function checkRefusalDetailStateParity({ root = REPOSITORY_ROOT, overrides = {} } = {}) {
  const read = (relativePath) => overrides[relativePath] ?? readFileSync(join(root, relativePath), "utf8");
  const modMembers = extractModStates(read(MOD_PATH));
  const hostStates = extractHostStates(read(HOST_PATH));
  const vocabulary = extractHostVocabulary(read(HOST_PATH));

  if (modMembers === null || hostStates === null || vocabulary === null) {
    const unreadable = [
      modMembers === null ? `${MOD_DECLARATION} (${MOD_PATH})` : null,
      hostStates === null ? `${HOST_SET} (${HOST_PATH})` : null,
      vocabulary === null ? `${HOST_VOCABULARY} (${HOST_PATH})` : null,
    ].filter((entry) => entry !== null);
    return Object.freeze({
      gate: "refusal_detail_state_parity/v1",
      status: "blocked",
      examined: 0,
      agree: 0,
      missing: 0,
      mod: Object.freeze([]),
      host: Object.freeze([]),
      violations: Object.freeze([]),
      checks: Object.freeze([
        check("declaration_readable", "blocked", `read nothing from ${unreadable.join(", ")}`),
        check("wire_vocabulary", "blocked", "not judged: a declaration could not be read"),
        check("state_set_agreement", "blocked", "not judged: a declaration could not be read"),
      ]),
    });
  }

  const modStates = uniqueSorted(modMembers.map(wireTokenOf));
  const known = new Set(vocabulary);
  const unknownTokens = modStates.filter((state) => !known.has(state));
  const missingOnMod = hostStates.filter((state) => !modStates.includes(state));
  const missingOnHost = modStates.filter((state) => !hostStates.includes(state));

  const violations = Object.freeze([
    ...unknownTokens.map((state) => ({
      code: `${UNKNOWN_TOKEN}:${state}:mod`,
      state,
      side: "mod",
      detail: `${MOD_DECLARATION} permits a state the Host's ${HOST_VOCABULARY} does not carry, so the mapping or the Mod's state is wrong before any set can agree`,
    })),
    ...missingOnHost.map((state) => ({
      code: `${DRIFT}:${state}:host`,
      state,
      side: "host",
      detail: `${HOST_SET} does not carry a state ${MOD_DECLARATION} permits, so a frame the Mod sends with a detail on it is refused and the bridge closes`,
    })),
    ...missingOnMod.map((state) => ({
      code: `${DRIFT}:${state}:mod`,
      state,
      side: "mod",
      detail: `${HOST_SET} permits a state ${MOD_DECLARATION} does not, so the Host accepts a detail the Mod's own journal would refuse`,
    })),
  ]);

  const agreement = missingOnHost.length === 0 && missingOnMod.length === 0;
  return Object.freeze({
    gate: "refusal_detail_state_parity/v1",
    status: agreement && unknownTokens.length === 0 ? "passed" : "failed",
    examined: uniqueSorted([...modStates, ...hostStates]).length,
    agree: modStates.filter((state) => hostStates.includes(state)).length,
    missing: violations.length,
    mod: Object.freeze(modStates),
    host: Object.freeze(hostStates),
    violations,
    checks: Object.freeze([
      check(
        "declaration_readable",
        "passed",
        `${modMembers.length} state(s) in ${MOD_DECLARATION}, ${hostStates.length} in ${HOST_SET}`,
      ),
      unknownTokens.length === 0
        ? check("wire_vocabulary", "passed", `${modStates.length} mapped token(s), all carried by ${HOST_VOCABULARY}`)
        : check("wire_vocabulary", "failed", `${unknownTokens.join(", ")} not carried by ${HOST_VOCABULARY}`),
      agreement
        ? check("state_set_agreement", "passed", `${modStates.length} state(s) on both sides`)
        : check("state_set_agreement", "failed", `${violations.length} drifting member(s)`),
    ]),
  });
}

/** The lines one run prints: the population first, then the members, so a failure names the drifting state. */
export function formatRefusalDetailStates(report) {
  const lines = [
    `refusal_detail_states examined ${report.examined} · agree ${report.agree} · missing ${report.missing}`,
    `  ${MOD_DECLARATION} ${report.mod.join(", ")}`,
    `  ${HOST_SET} ${report.host.join(", ")}`,
  ];
  for (const violation of report.violations) lines.push(`${violation.code} ${violation.detail}`);
  return lines;
}

function rootFromArguments(argv) {
  const at = argv.indexOf("--root");
  return at < 0 ? REPOSITORY_ROOT : resolve(argv[at + 1]);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const report = checkRefusalDetailStateParity({ root: rootFromArguments(process.argv) });
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const line of formatRefusalDetailStates(report)) process.stdout.write(`${line}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = EXIT_FOR_STATUS[report.status] ?? EXIT.blocked;
}
