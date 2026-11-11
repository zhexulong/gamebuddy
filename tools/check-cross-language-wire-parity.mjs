#!/usr/bin/env node
/**
 * Every field the Mod puts on the wire must be a field the Host's validator accepts for that frame.
 *
 * WHY. Measured 2026-11-11: the Mod's `BridgeReceipt` could carry a `refusalDetail` on a `partially_succeeded` node and
 * `host/src/protocol.ts` refused the frame, and `host/src/local-stardew-bridge.ts` closes the whole transport on one
 * refused body-program frame - so a live run lost its 7th turn four minutes in and the verdict said one word:
 * `unsettled`. That instance was a value set (the sibling `tools/check-refusal-detail-state-parity.mjs` owns it). The
 * family it belongs to is wider and older: `tool_insufficient` was an exclusion reason the Mod emitted and the Host did
 * not know; `seedSupplyTargets` arrived with three keys; `sceneTarget` arrived as a key nobody admitted; `nativeBinding`
 * and `synthetic` were action-descriptor fields that grew before the Host's optional-key lists did. A field the producer
 * sends and the consumer does not accept is one defect, and it is visible in two source files.
 *
 * THE TWO SIDES, AND WHICH ONE IS THE AUTHORITY.
 *
 *  - FRAMES come from the Mod's own protocol code: a member of `integrations/stardew/src/Core/Protocol/*.cs` or
 *    `integrations/stardew/BridgeSession.cs` which names a frame in a call that actually frames it - `Reply("<frame>",
 *    ...)` for outbound, `TryReadInboundPayload(json, "<frame>", ...)` / `TryDeserializeInbound(json, "<frame>", ...)` for
 *    inbound - pairs that frame with the payload type the same member carries (`BridgeEnvelope<T>` in the signature for a
 *    decoder, the record constructed in the reply for a sender). Nothing here is a hand-written frame table; a frame the
 *    Mod stops framing, or a payload type it swaps, changes this population with no edit to this file. A member that names
 *    a frame AND leaves several payload types possible is AMBIGUOUS and reported by name rather than guessed.
 *  - FIELDS come from the payload declarations under `integrations/stardew/src/Core/Models/*.cs`, in BOTH forms the Mod
 *    uses: a positional `public sealed record <Name>(<Type> <Name>, ...)` and a class of init-only properties (`public
 *    sealed class BridgeExecutionArgs`), which is where `SceneTarget` lives. They are mapped to the wire spelling by the
 *    naming policy the Mod's SERIALISER declares - `JsonNamingPolicy.<Policy>` inside `BridgeProtocol.JsonOptions` - which
 *    this gate reads and PRINTS with its file and line, because assuming `camelCase` would make every drift line it prints
 *    unfalsifiable. Records the payload publishes are walked too, so a field one object deep is examined as well.
 *  - ACCEPTANCE comes from the Host's own validators: the `switch (message.type)` arms in `validateBridgeMessage`
 *    (`host/src/protocol.ts`), followed through every function they call and every key list or family table those
 *    functions name (`host/src/protocol-target-facts.ts` included). The accepted set for a frame is what those bodies
 *    NAME, never a second list written here.
 *
 * THREE RULES, each able to fail on its own:
 *   declarations_readable - the naming policy, the Host's switch arms and the Mod's payload declarations were read. A
 *                           reader that reads nothing has not proved agreement, so this is BLOCKED (exit 2), never green.
 *   population_complete   - THE VERDICT COVERS WHAT IT SAYS IT COVERS. Every frame the Host dispatches on is either paired
 *                           with a Mod payload, owned by another gate (named), or exempt by name with an owner who owes the
 *                           pairing. A frame that is none of those is `frame_not_measured:<frame>` and the run is BLOCKED
 *                           (exit 2) - not `passed` with a trailing sentence saying otherwise. A frame that pairs to a type
 *                           carrying no fields is `frame_without_fields:<frame>` and is blocked for the same reason. An
 *                           exemption whose frame pairs is `stale_wire_exemption:<frame>`.
 *   field_accepted        - every field of every payload the Mod SENDS (and of the records it publishes) is a name the
 *                           Host accepts for that frame, and every field the Host declares on a request is a field the Mod
 *                           can read.
 *
 * VERDICT. `frames examined N · paired P · measured here M · owned elsewhere O · exempt E · unmeasured U` and
 * `fields examined M · accepted A · unaccepted K` on two lines, then the naming policy, then one line per drifting member:
 *   wire_field_unaccepted:<frame>:<field>:<csharpType>   the Mod sends it, the Host's validators never name it
 *   wire_field_unknown_to_mod:<frame>:<field>            the Host writes it, the Mod's decoder declares no such field
 *   stale_wire_exemption:<field>                         an exemption whose field is gone or has stopped drifting
 * `frames examined` is the Host's whole frame population; `measured here` is what this gate itself read, so the two numbers
 * can never be confused. An exemption is a documented disagreement, never a silent pass: it carries a one-line reason and
 * the owner who owes the fix, and it goes red the moment the field or frame it exempts disappears. ONE frame is exempt
 * today - `body_node_admission_grant` - because the Mod names that frame through a `grant ? A : B` ternary inside a generic
 * decoder, so the literal and the payload type never share a declaration; the exemption names the owner who owes it.
 *
 * DIRECTION 2 (Host -> Mod) is derived from the Host's own `BridgeMessage` payload types: the fields the Host's type says
 * it puts on a request must be fields the Mod's request record declares. Its limit is stated rather than hidden - it
 * compares the two DECLARATIONS, so it proves the Mod can READ what the Host declares and says nothing about object
 * literals built at a call site. The `wire_field_unknown_to_mod` code is emitted only from that comparison.
 *
 * ONE DIRECTION PER FRAME, because a payload means opposite things in the two. On a frame the Mod SENDS its record is the
 * producer, so every field of it must be a name the Host accepts. On a frame the Mod DECODES its record is a READER, and
 * a field it tolerates but the Host never writes is tolerance, not a crossing - that frame is judged the other way round,
 * from the Host's declared payload type. Checking a reader's fields against the Host's keys would flag every optional
 * tolerance as a defect; that is why `BridgeExecutionArgs.SceneTarget` - a field the Mod accepts and the Host never
 * writes - is not reported here.
 *
 * USAGE
 *   node tools/check-cross-language-wire-parity.mjs            # the ratchet; exit 1 on drift, 2 when blocked
 *   node tools/check-cross-language-wire-parity.mjs --json     # the whole report
 *   node tools/check-cross-language-wire-parity.mjs --root DIR # read another checkout (the falsifier's own tree)
 *
 * RED PROOF. The incident that motivated this gate is NOT one this gate can see, and the header says so rather than
 * implying otherwise: before `5e26c8bb` the Host's `BODY_PROGRAM_REFUSAL_DETAIL_NODE_STATES` lacked
 * `partially_succeeded` while `refusalDetail` was named by BOTH sides' field lists, so this gate is green on that tree
 * and `tools/check-refusal-detail-state-parity.mjs` names the drift there
 * (`refusal_detail_state_set_drift:partially_succeeded:host`). One fact, one owner: the state set belongs to that gate,
 * the field NAME belongs to this one - and the field-name crossing it does own is reproduced on the real declarations by
 * tools/check-cross-language-wire-parity.test.mjs.
 *
 * red-proof: inject  a field added to the real `BridgeBodyProgramNodeStatus`, and `"refusalDetail"` deleted from the
 *   real `isBodyProgramNodeStatus` key list -> `wire_field_unaccepted:program_status_result:<field>:<C# type>`
 *   (tools/check-cross-language-wire-parity.test.mjs)
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const MODELS_DIRECTORY = "integrations/stardew/src/Core/Models";
export const MOD_PROTOCOL_DIRECTORY = "integrations/stardew/src/Core/Protocol";
/** The file that declares `BridgeProtocol.JsonOptions`: the serialiser whose naming policy maps a property to a key. */
export const MOD_SERIALIZER_PATH = "integrations/stardew/src/Core/Protocol/BridgeProtocol.cs";
/** The outbound reply sites: `Reply("<frame>", ...)` lives with the session, not with the wire model. */
export const MOD_SESSION_PATH = "integrations/stardew/BridgeSession.cs";
/**
 * The program frames' payloads: `ActionProgramCandidate`, `NodeAdmissionChallenge`, `HostAdmissionGrant` and the three
 * concrete admission results are declared here rather than in `Core/Models`, and leaving the file out made
 * `program_submit` pair with a type whose fields this gate then could not read - a frame inside the population that
 * contributed nothing to it.
 */
export const MOD_PROGRAM_MODELS_PATH = "integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs";
export const HOST_PROTOCOL_PATH = "host/src/protocol.ts";
export const HOST_FACTS_PATH = "host/src/protocol-target-facts.ts";

export const EXIT = Object.freeze({ agree: 0, drift: 1, blocked: 2 });
const EXIT_FOR_STATUS = Object.freeze({ passed: EXIT.agree, failed: EXIT.drift, blocked: EXIT.blocked });

const UNACCEPTED = "wire_field_unaccepted";
const UNKNOWN_TO_MOD = "wire_field_unknown_to_mod";
const STALE_EXEMPTION = "stale_wire_exemption";

/**
 * Every disagreement this gate finds on the tree it was written against, each with the reason it is not a crossing TODAY
 * and the owner who owes the decision.
 *
 * The rule is not "these are fine". It is "these are known, named, and owned": a new crossing cannot join the list without
 * an edit here, and an entry whose field stops drifting is `stale_wire_exemption` - so the list can shrink but never rot.
 */
export const EXEMPTIONS = Object.freeze([]);

/**
 * Frames this gate cannot pair yet, each with the reason and the owner who owes the pairing.
 *
 * An entry here is a BLOCKED population made explicit rather than a pass: the frame is printed with the run, it is
 * excluded from `fields examined` (which is why that number never claims to cover it), and the entry goes red
 * (`stale_wire_exemption:<frame>`) the moment the frame pairs - so the list can only shrink.
 */
export const UNPAIRED_FRAME_EXEMPTIONS = Object.freeze([
  Object.freeze({
    frame: "body_node_admission_grant",
    reason:
      'the Mod names this frame through a `grant ? "body_node_admission_grant" : "body_node_admission_challenge"` ternary inside `TryDeserializeAdmission<T>`, whose envelope is the generic `T`: the literal and the payload type are never in the same declaration, so the reader has nothing to join',
    owner:
      "the body-program admission lane (pair it when the decoder stops naming the frame through a parameter, or when this reader learns to join a generic decoder to its callers)",
  }),
]);

/**
 * Frames whose FIELD parity an existing gate already asserts exactly, in both directions.
 *
 * Repeating those comparisons here would give one fact two spellings and the copy would be the one that goes stale - so
 * this gate names the owner and EXCLUDES the frame from its own population instead of quietly checking it twice. The
 * exclusion is printed with the run, so a frame that lost its owner is visible rather than absent.
 */
export const FRAMES_OWNED_ELSEWHERE = Object.freeze([
  Object.freeze({
    frame: "snapshot",
    owner: "host/src/declaration-agreement.test.ts",
    reason:
      "asserts every member of `BridgeSnapshot` against `SNAPSHOT_KEYS` and every family record against the predicate `SNAPSHOT_FAMILY_RULES` binds to it, both directions",
  }),
  Object.freeze({
    frame: "execution_receipt",
    owner: "tools/check-stardew-execution-receipt-field-parity.mjs",
    reason:
      "asserts `BridgeReceipt`'s field set against the Host type, its `allowedKeys` validator, the wire schema and both adapter mappings",
  }),
]);

// ---------------------------------------------------------------------------
// Tokenizer and bracket helpers (comments carry examples of the words under test)
// ---------------------------------------------------------------------------

/** Comments are dropped: a declaration's prose names fields the declaration does not carry. */
function tokenize(source) {
  const result = [];
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index + 2);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const quote = char;
      let value = "";
      index += 1;
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        value += source[index] ?? "";
        index += 1;
      }
      if (source[index] === quote) index += 1;
      result.push({ type: "string", value, offset: index });
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      result.push({ type: "word", value: source.slice(start, index), offset: start });
      continue;
    }
    result.push({ type: "punct", value: char, offset: index });
    index += 1;
  }
  return result;
}

const CLOSER = Object.freeze({ "(": ")", "[": "]", "{": "}", "<": ">" });

/** Index of the token closing the opening token at `openIndex`, or -1. */
function balanced(tokens, openIndex) {
  const open = tokens[openIndex]?.value;
  const close = CLOSER[open];
  if (close === undefined) return -1;
  let depth = 0;
  for (let index = openIndex; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === open) depth += 1;
    else if (value === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split tokens on `separator` at nesting depth 0, ignoring `()[]{}<>`. */
function splitTopLevel(tokens, separator) {
  const groups = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (value === "(" || value === "[" || value === "{" || value === "<") depth += 1;
    else if (value === ")" || value === "]" || value === "}" || value === ">") depth = Math.max(0, depth - 1);
    else if (value === separator && depth === 0) {
      groups.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  groups.push(tokens.slice(start));
  return groups;
}

/** First token index at depth 0 whose value is `value`, or -1. */
function topLevelIndexOf(tokens, value, from = 0) {
  let depth = 0;
  for (let index = from; index < tokens.length; index += 1) {
    const token = tokens[index].value;
    if (token === "(" || token === "[" || token === "{" || token === "<") depth += 1;
    else if (token === ")" || token === "]" || token === "}" || token === ">") depth = Math.max(0, depth - 1);
    else if (depth === 0 && token === value) return index;
  }
  return -1;
}

/** Comments carry examples of the words under test, so neither declaration is read through them. */
function withoutComments(source) {
  let result = "";
  for (let index = 0; index < source.length; ) {
    const char = source[index];
    if (char === '"' || char === "'" || char === "`") {
      const start = index;
      index += 1;
      while (index < source.length && source[index] !== char) {
        if (source[index] === "\\") index += 1;
        index += 1;
      }
      index += 1;
      result += source.slice(start, index);
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const lineEnd = source.indexOf("\n", index);
      index = lineEnd < 0 ? source.length : lineEnd;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    result += char;
    index += 1;
  }
  return result;
}

const uniqueSorted = (values) => [...new Set(values)].sort();
const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

// ---------------------------------------------------------------------------
// Direction 1, producer side: the Mod's naming policy, records and frame pairs
// ---------------------------------------------------------------------------

/** `CamelCase`, `SnakeCaseLower`, ... as the Mod's serialiser declares it, with where it was read. */
export function extractNamingPolicy(source) {
  const options = /JsonSerializerOptions\s+JsonOptions\s*=\s*new\s*\(\s*\)\s*\{/u.exec(source);
  if (options === null) return null;
  const open = options.index + options[0].length - 1;
  const tokens = tokenize(source.slice(open));
  const close = balanced(tokens, 0);
  if (close < 0) return null;
  const body = source.slice(open, open + tokens[close].offset + 1);
  const policy = /PropertyNamingPolicy\s*=\s*JsonNamingPolicy\.(\w+)/u.exec(body);
  if (policy === null) return null;
  return Object.freeze({
    policy: policy[1],
    where: `${MOD_SERIALIZER_PATH}:${lineOf(source, open + policy.index)}`,
  });
}
/**
 * `.NET`'s `JsonNamingPolicy.CamelCase`: the leading run of capitals comes down, except the one that starts the first
 * lower-case-containing word. `DeduplicationKey` -> `deduplicationKey`, `NPCName` -> `npcName`.
 *
 * Stated here because the gate has to map a C# property to the exact key the serialiser writes, and `.NET`'s rule is not
 * "lowercase the first letter" - a name whose second character is also a capital keeps it low only while the capitals run.
 */
export function wireNameOf(propertyName, policy) {
  if (policy !== "CamelCase")
    throw new Error(`the Mod's serialiser declares \`${policy}\`, which this gate cannot map: only CamelCase is read`);
  if (!/^[A-Z]/u.test(propertyName)) return propertyName;
  const chars = [...propertyName];
  for (let index = 0; index < chars.length; index += 1) {
    const upper = (character) => /[A-Z]/u.test(character ?? "");
    if (index === 1 && !upper(chars[1])) break;
    const hasNext = index + 1 < chars.length;
    if (index > 0 && hasNext && !upper(chars[index + 1])) break;
    chars[index] = chars[index].toLowerCase();
  }
  return chars.join("");
}

/** One positional record parameter: its declared type and its name, attributes and default stripped. */
function readParameter(parameterTokens) {
  let index = 0;
  while (parameterTokens[index]?.value === "[") {
    const attributeClose = balanced(parameterTokens, index);
    if (attributeClose < 0) throw new Error("a C# record parameter has an unbalanced attribute list");
    index = attributeClose + 1;
  }
  const remaining = parameterTokens.slice(index);
  if (remaining.length === 0) return null;
  const eq = topLevelIndexOf(remaining, "=");
  const lhs = eq < 0 ? remaining : remaining.slice(0, eq);
  const nameAt = lhs
    .map((token, at) => ({ token, at }))
    .filter((entry) => entry.token.type === "word")
    .at(-1);
  if (nameAt === undefined) return null;
  const type = lhs
    .slice(0, nameAt.at)
    .map((token) => token.value)
    .join("")
    .trim();
  if (type.length === 0) return null;
  return Object.freeze({ name: nameAt.token.value, type });
}

/**
 * Every wire type the source declares, name -> its parameters/properties.
 *
 * TWO DECLARATION FORMS carry a bridge payload in this Mod and both are read, because the surface grew one of each:
 * a positional `record` states its shape in its parameter list (`public sealed record BridgeReceipt(...)`), and a class
 * with init-only properties states it one member at a time (`public sealed class BridgeExecutionArgs`, whose `SceneTarget`
 * was the key the Host did not admit). A reader that knew only the first form would have skipped the very type the
 * incident lived on.
 */
export function modRecords(source) {
  const tokens = tokenize(source);
  const records = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "word" || tokens[index].value !== "record") continue;
    const name = tokens[index + 1];
    if (name?.type !== "word" || tokens[index + 2]?.value !== "(") continue;
    const close = balanced(tokens, index + 2);
    if (close < 0) continue;
    const fields = [];
    for (const parameter of splitTopLevel(tokens.slice(index + 3, close), ",")) {
      const field = readParameter(parameter);
      if (field !== null) fields.push(field);
    }
    // A FIELD-LEGAL EMPTY declaration is recorded as empty rather than dropped: `internal sealed record
    // BridgeObserveRequest();` is the Mod's statement that the frame carries no fields, and a reader that dropped it would
    // report that frame as "paired to a type it cannot find" - a gap where the truth is "declared, and it carries none".
    if (!records.has(name.value)) records.set(name.value, Object.freeze(fields));
  }
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "word" || tokens[index].value !== "class") continue;
    const name = tokens[index + 1];
    if (name?.type !== "word" || records.has(name.value)) continue;
    let bodyOpen = index + 2;
    while (bodyOpen < tokens.length && tokens[bodyOpen].value !== "{" && tokens[bodyOpen].value !== ";") bodyOpen += 1;
    if (tokens[bodyOpen]?.value !== "{") continue;
    const bodyClose = balanced(tokens, bodyOpen);
    if (bodyClose < 0) continue;
    const fields = [];
    for (let cursor = bodyOpen + 1; cursor < bodyClose; cursor += 1) {
      if (tokens[cursor].value !== "public") continue;
      // `[JsonExtensionData]` changes the mapping: the member's CONTENTS are flattened into sibling keys, so the property
      // name never appears on the wire and comparing it would invent a field the Mod does not send.
      if (tokens[cursor - 1]?.value === "]") {
        let open = cursor - 1;
        let depth = 0;
        for (; open >= bodyOpen; open -= 1) {
          if (tokens[open].value === "]") depth += 1;
          else if (tokens[open].value === "[") {
            depth -= 1;
            if (depth === 0) break;
          }
        }
        const attribute = tokens.slice(open, cursor).map((token) => token.value);
        if (attribute.includes("JsonExtensionData")) continue;
      }
      let open = cursor + 1;
      while (open < bodyClose && tokens[open].value !== "{" && tokens[open].value !== ";" && tokens[open].value !== "(")
        open += 1;
      if (tokens[open]?.value !== "{" || tokens[open + 1]?.value !== "get") continue;
      const field = readParameter(tokens.slice(cursor + 1, open));
      if (field !== null) fields.push(field);
    }
    if (fields.length > 0 || !records.has(name.value)) records.set(name.value, Object.freeze(fields));
  }
  return records;
}

/**
 * base type -> the records that declare it as their base, from the declarations themselves (`record X(...) : Base`).
 *
 * Three of the body-program frames carry an ABSTRACT base (`BodyNodeAdmissionResultWire`) whose fields live on the three
 * records that derive from it, so a field-level reader that stopped at the base would report those frames as having no
 * fields at all - and, before the population check, call that a pass.
 */
export function modDerivations(source) {
  const tokens = tokenize(source);
  const derived = new Map();
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "record" || tokens[index + 1]?.type !== "word" || tokens[index + 2]?.value !== "(")
      continue;
    const close = balanced(tokens, index + 2);
    if (close < 0 || tokens[close + 1]?.value !== ":") continue;
    const base = tokens[close + 2];
    if (base?.type !== "word") continue;
    const set = derived.get(base.value) ?? new Set();
    set.add(tokens[index + 1].value);
    derived.set(base.value, set);
  }
  return derived;
}

/** The record a C# type names, for a `BridgeX` or an `IReadOnlyList<BridgeX>?`, or null for a primitive. */
export function recordOfType(declaredType) {
  const single = /^(?:Bridge\w+)(?:\?|\[\])?$/u.exec(declaredType);
  if (single !== null) return declaredType.replace(/[?[\]]/gu, "");
  const list = /^IReadOnlyList<(Bridge\w+)>\??$/u.exec(declaredType);
  return list === null ? null : list[1];
}

/** Where the Mod DECODES a frame: the payload is the envelope's type argument in the same signature. */
const INBOUND_CALLS = Object.freeze([
  /TryReadInboundPayload\s*\(\s*\w+\s*,\s*"([a-z][a-z0-9_]*)"/gu,
  /TryDeserializeInbound\s*\(\s*\w+\s*,\s*"([a-z][a-z0-9_]*)"/gu,
  /IsValidEnvelope\s*\(\s*[\w!]+\s*,\s*"([a-z][a-z0-9_]*)"/gu,
]);

/** Where the Mod SENDS a frame: the payload is the value the reply carries, named in the same body. */
const OUTBOUND_CALLS = Object.freeze([/Reply\s*\(\s*"([a-z][a-z0-9_]*)"/gu]);

/** Types that appear beside a payload without being one. */
const NOT_A_PAYLOAD = new Set(["BridgeEnvelope", "BridgeScope", "BridgeProtocol", "BridgeSession"]);

/**
 * The members of one C# file: their signature tokens and their body tokens.
 *
 * Read structurally rather than by line indentation, because a signature may wrap over four lines (`TryObserve` does) and
 * a body may nest braces. TWO body forms are read, because the reply sites this gate exists for use both: a block
 * (`{ ... }`) and an expression (`=> ... ;`). `CreateError` - the only `error` frame producer - is the expression form, so
 * a reader that knew only blocks left that frame unpaired and then called its own gap a pass.
 */
export function csharpMembers(source) {
  const tokens = tokenize(source);
  const members = [];
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].type !== "word" || !/^(?:public|private|internal|protected)$/u.test(tokens[index].value))
      continue;
    let open = -1;
    for (let cursor = index + 1; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor].value;
      if (value === ";" || value === "{" || value === "=>" || value === "=") break;
      if (value === "(") {
        open = cursor;
        break;
      }
    }
    if (open < 0) continue;
    const parameterClose = balanced(tokens, open);
    if (parameterClose < 0) continue;
    let bodyOpen = parameterClose + 1;
    let arrow = false;
    while (bodyOpen < tokens.length) {
      const value = tokens[bodyOpen].value;
      if (value === "{" || value === ";") break;
      // `=>` arrives as TWO tokens, so a scan for the literal never saw an expression-bodied member - and the only
      // `error` producer in the Mod is written exactly that way.
      if (value === "=" && tokens[bodyOpen + 1]?.value === ">") {
        arrow = true;
        break;
      }
      bodyOpen += 1;
    }
    if (tokens[bodyOpen]?.value === "{") {
      const bodyClose = balanced(tokens, bodyOpen);
      if (bodyClose < 0) continue;
      members.push({
        signature: tokens.slice(index, parameterClose + 1),
        body: tokens.slice(bodyOpen + 1, bodyClose),
      });
      continue;
    }
    if (!arrow) continue;
    let depth = 0;
    let bodyClose = bodyOpen + 2;
    for (; bodyClose < tokens.length; bodyClose += 1) {
      const value = tokens[bodyClose].value;
      if (value === "(" || value === "[" || value === "{") depth += 1;
      else if (value === ")" || value === "]" || value === "}") depth = Math.max(0, depth - 1);
      else if (value === ";" && depth === 0) break;
    }
    members.push({ signature: tokens.slice(index, parameterClose + 1), body: tokens.slice(bodyOpen + 2, bodyClose) });
  }
  return members;
}

/** The record words a token list names, minus the structural types that merely carry a payload. */
function recordWords(tokens, records) {
  const named = new Set();
  for (const token of tokens) if (token.type === "word" && records.has(token.value)) named.add(token.value);
  for (const candidate of NOT_A_PAYLOAD) named.delete(candidate);
  return named;
}

/**
 * The normalised name of a wire type, so the two languages' spellings can be compared without a table.
 *
 * `BridgeNavigationReadResult`, `NavigationReadResult` and `ObserveSceneResultPayload` all normalise to
 * `NavigationReadResult` / `ObserveSceneResult`: the decoration (`Bridge` prefix, `Payload`/`Wire`/`Args` suffix) is
 * spelling, not identity. Used ONLY to choose among the candidates the Mod's own body already named.
 */
const normalisedType = (name) => name.replace(/^Bridge/u, "").replace(/(?:Payload|Wire|Args)$/u, "");

/**
 * The record a reply at `frame` sends: the first `new <Record>(` after the frame literal, which is the value the reply
 * carries (`Reply("hello_ack", ..., new BridgeHelloAck(...))`). Nested constructions inside that one are not the payload,
 * which is why the FIRST is taken rather than every record the body builds.
 */
function constructedAtReply(tokens, frame) {
  const at = tokens.findIndex((token) => token.type === "string" && token.value === frame);
  if (at < 0) return null;
  // Bounded to the enclosing `Reply(...)` call: scanning to the end of the member ran past the reply into whatever the
  // member built next, and paired `execution_receipt` with the Mod's ledger record instead of the wire one.
  let callAt = -1;
  for (let index = at; index >= 0; index -= 1)
    if (tokens[index].value === "Reply") {
      callAt = index;
      break;
    }
  if (callAt < 0) return null;
  const open = tokens.findIndex((token, index) => index > callAt && token.value === "(");
  const close = open < 0 ? -1 : balanced(tokens, open);
  const end = close < 0 ? tokens.length : close;
  for (let index = at; index < end; index += 1)
    if (tokens[index].value === "new" && tokens[index + 1]?.type === "word" && tokens[index + 2]?.value === "(")
      return tokens[index + 1].value;
  return null;
}

/**
 * frame -> the C# record that carries it, from the Mod's own framing calls, one direction at a time.
 *
 * INBOUND is the Mod's decoder: `out BridgeEnvelope<BridgeReceipt>?` in the signature beside `TryReadInboundPayload(json,
 * "execution_receipt", ...)` in the body. OUTBOUND is a reply: `Reply("snapshot", ...)` beside the value the same member
 * sends. Keeping the two apart is what stops `Reply("data_query_result", ..., request)` from pairing a RESULT frame with a
 * REQUEST record.
 *
 * OUTBOUND EVIDENCE IS RANKED, strongest first, because five different reply shapes exist in this Mod and only the first
 * two are self-describing:
 *   1. `out BridgeEnvelope<T>?` in the signature - the reply's DECLARED type (`TileAreaQuery.Answer(...)` is otherwise
 *      just a call into another type);
 *   2. `new BridgeEnvelope<T>(...)` in the body;
 *   3. `new T(...)` inside the `Reply(...)` call itself (`Reply("hello_ack", ..., new BridgeHelloAck(...))`);
 *   4. the RETURN TYPE of a function the reply calls (`Reply("body_node_admission_challenge", ...,
 *      BridgeProtocol.ProjectBodyNodeAdmissionChallenge(...))`);
 *   5. the records the body happens to name, which is a superset and therefore only a fallback.
 * An entry at a weaker rank never overrides a stronger one from another member, and when the strongest rank still names
 * several records the Host's own `BridgeMessage` type is the tie-break. What remains is reported as AMBIGUOUS with its
 * candidates - never guessed, and (since the population check) never silently dropped.
 */
export function modFramePairs(
  source,
  hostFrames,
  records,
  hostTypeOf = () => null,
  returnTypes = new Map(),
  serialisable = new Set(),
) {
  const inboundCandidates = new Map();
  const outboundEvidence = new Map();
  const ambiguous = [];
  const record = (map, frame, candidates, rank) => {
    const entries = map.get(frame) ?? [];
    entries.push({ rank, candidates: new Set(candidates) });
    map.set(frame, entries);
  };

  for (const member of csharpMembers(source)) {
    const signatureText = member.signature.map((token) => token.value).join(" ");
    const bodyText = member.body.map((token) => (token.type === "string" ? `"${token.value}"` : token.value)).join(" ");

    const inbound = []
      .concat(...INBOUND_CALLS.map((pattern) => [...bodyText.matchAll(pattern)].map((match) => match[1])))
      .filter((frame) => hostFrames.has(frame));
    if (inbound.length > 0) {
      const envelope = /BridgeEnvelope\s*<\s*(\w+)\s*>/u.exec(signatureText);
      const candidates = envelope === null ? recordWords(member.signature, records) : new Set([envelope[1]]);
      const rank = envelope === null ? 2 : 1;
      for (const frame of inbound) record(inboundCandidates, frame, candidates, rank);
    }

    const outbound = []
      .concat(...OUTBOUND_CALLS.map((pattern) => [...bodyText.matchAll(pattern)].map((match) => match[1])))
      .filter((frame) => hostFrames.has(frame));
    if (outbound.length === 0) continue;
    const declared = replyEnvelopeType(signatureText);
    const wrapped = /new\s+BridgeEnvelope\s*<\s*(\w+)\s*>/u.exec(bodyText);
    for (const frame of outbound) {
      const built = constructedAtReply(member.body, frame);
      const projected = replyProjections(member.body, frame, records, returnTypes);
      if (declared !== null) record(outboundEvidence, frame, [declared], 1);
      else if (wrapped !== null) record(outboundEvidence, frame, [wrapped[1]], 2);
      else if (built !== null) record(outboundEvidence, frame, [built], 3);
      else if (projected.size > 0) record(outboundEvidence, frame, projected, 4);
      record(outboundEvidence, frame, recordWords(member.body, records), 5);
    }
  }

  const pairs = new Map();
  /** The candidates at the strongest rank recorded for one frame, or an empty set. */
  const strongest = (entries) => {
    const rank = Math.min(...entries.map((entry) => entry.rank));
    const candidates = new Set();
    for (const entry of entries)
      if (entry.rank === rank) for (const candidate of entry.candidates) candidates.add(candidate);
    return { rank, candidates };
  };
  const tieBreak = (frame, candidates) => {
    // 1. the type the Mod's own serialiser handles: its `value switch` is the statement of what goes on the wire.
    const serialised = [...candidates].filter((candidate) => serialisable.has(candidate));
    if (serialised.length === 1) return serialised[0];
    // 2. the Host's own `BridgeMessage` declares which type carries this frame.
    const declared = hostTypeOf(frame);
    if (declared === null) return null;
    const matches = [...candidates].filter((candidate) => normalisedType(candidate) === normalisedType(declared));
    return matches.length === 1 ? matches[0] : null;
  };

  for (const [frame, entries] of inboundCandidates) {
    const { candidates } = strongest(entries);
    const chosen = candidates.size === 1 ? [...candidates][0] : tieBreak(frame, candidates);
    if (chosen === null)
      ambiguous.push(
        `${frame} (inbound): the decoder names ${candidates.size} payload candidate(s) ` +
          `[${[...candidates].sort().join(", ")}], so it is not paired`,
      );
    else pairs.set(frame, { ...(pairs.get(frame) ?? {}), inbound: chosen });
  }
  for (const [frame, entries] of outboundEvidence) {
    const { rank, candidates } = strongest(entries);
    if (candidates.size === 0) continue;
    const chosen = candidates.size === 1 ? [...candidates][0] : tieBreak(frame, candidates);
    if (chosen === null)
      ambiguous.push(
        `${frame} (outbound, evidence rank ${rank}): the reply names ${candidates.size} payload candidate(s) ` +
          `[${[...candidates].sort().join(", ")}], so it is not paired`,
      );
    else pairs.set(frame, { ...(pairs.get(frame) ?? {}), outbound: chosen });
  }
  return Object.freeze({ pairs, ambiguous: Object.freeze(uniqueSorted(ambiguous)) });
}

/**
 * The type a reply DECLARES: the last `out BridgeEnvelope<T>` parameter, or a `BridgeEnvelope<T>` return type.
 *
 * The reply is the member's last output, so the LAST `out` envelope is the one a `Reply(...)` fills - and the INBOUND
 * request envelope usually sits beside it in the same signature (`BridgeEnvelope<BridgeNavigationReadRequest>? envelope,
 * out BridgeEnvelope<BridgeNavigationReadResult>? response`). Reading the first one paired every such reply with the
 * REQUEST record, which is how this gate came to report a request's fields as unaccepted on a result frame.
 */
function replyEnvelopeType(signatureText) {
  const outs = [...signatureText.matchAll(/out\s+BridgeEnvelope\s*<\s*(\w+)\s*>/gu)];
  if (outs.length > 0) return outs[outs.length - 1][1];
  const returned = /BridgeEnvelope\s*<\s*(\w+)\s*>\s+\w+\s*\(/u.exec(signatureText);
  return returned === null ? null : returned[1];
}

/**
 * Every type the Mod's OWN serialiser handles: the arms of the `value switch` inside `TrySerialize`.
 *
 * This is the Mod's statement of which types go out on the wire. `body_node_admission_result` is decoded twice - once
 * into the domain type and once into the `...Wire` projection - and only the serializer's switch says which of the two
 * actually travels.
 */
export function modSerialisableTypes(source) {
  const member = csharpMembers(source).find((entry) =>
    entry.signature.some((token) => token.type === "word" && token.value === "TrySerialize"),
  );
  if (member === undefined) return new Set();
  const text = member.body.map((token) => token.value).join(" ");
  const types = new Set();
  for (const match of text.matchAll(/BridgeEnvelope\s*<\s*(\w+)\s*>/gu)) types.add(match[1]);
  for (const match of text.matchAll(/\b(Bridge[A-Z]\w*)\b/gu)) types.add(match[1]);
  return types;
}

/** The declared return type of every function the Mod source declares: name -> type. */
export function csharpReturnTypes(source) {
  const types = new Map();
  for (const member of csharpMembers(source)) {
    // The signature ENDS with the parameter list, so the words BEFORE the `(` are `<Type> <Name>` - reading the last
    // words of the whole signature read the last PARAMETER's type and name instead, which made every projection lookup
    // miss.
    const open = member.signature.findIndex((token) => token.value === "(");
    if (open < 2) continue;
    const words = member.signature.slice(0, open).filter((token) => token.type === "word");
    if (words.length < 2) continue;
    const name = words[words.length - 1].value;
    const type = words[words.length - 2].value;
    if (!types.has(name)) types.set(name, type);
  }
  return types;
}

/**
 * The payload a reply hands over when it hands over a CALL: `Reply("…", …, BridgeProtocol.ProjectX(value))`.
 *
 * The record is the called function's declared return type, which is the Mod's own statement of what that projection
 * produces. Only functions the same sources declare are followed, and only when the type is a record this gate knows.
 */
function replyProjections(tokens, frame, records, returnTypes) {
  const at = tokens.findIndex((token) => token.type === "string" && token.value === frame);
  if (at < 0) return new Set();
  let callAt = -1;
  for (let index = at; index >= 0; index -= 1)
    if (tokens[index].value === "Reply") {
      callAt = index;
      break;
    }
  if (callAt < 0) return new Set();
  const open = tokens.findIndex((token, index) => index > callAt && token.value === "(");
  const close = open < 0 ? -1 : balanced(tokens, open);
  if (close < 0) return new Set();
  const projections = new Set();
  for (const token of tokens.slice(open + 1, close)) {
    if (token.type !== "word") continue;
    const type = returnTypes.get(token.value);
    if (type !== undefined && records.has(type)) projections.add(type);
  }
  return projections;
}

// ---------------------------------------------------------------------------
// Direction 1, consumer side: what each Host frame's validators accept
// ---------------------------------------------------------------------------

/** The body of `function <name>(...) { ... }`, or null. */
function functionBody(source, name) {
  const at = source.indexOf(`function ${name}(`);
  if (at < 0) return null;
  const tokens = tokenize(source.slice(at));
  const open = tokens.findIndex((token) => token.value === "(");
  if (open < 0) return null;
  const close = balanced(tokens, open);
  if (close < 0) return null;
  let bodyOpen = close + 1;
  while (bodyOpen < tokens.length && tokens[bodyOpen].value !== "{") bodyOpen += 1;
  const bodyClose = balanced(tokens, bodyOpen);
  if (bodyClose < 0) return null;
  return source.slice(at, at + tokens[bodyClose].offset + 1);
}

/** Every function declared in the Host protocol sources: name -> its body text. */
export function hostFunctionBodies(hostSource) {
  const bodies = new Map();
  for (const match of hostSource.matchAll(/function\s+(\w+)\s*\(/gu)) {
    const body = functionBody(hostSource, match[1]);
    if (body !== null && !bodies.has(match[1])) bodies.set(match[1], body);
  }
  return bodies;
}

/**
 * The `case "<frame>":` arms of the Host's own bridge dispatch.
 *
 * This is the Host's frame population: every frame the bridge can carry has an arm here, and an arm is exactly the text
 * whose named keys are what the Host accepts for it.
 */
export function hostFrameArms(protocolSource) {
  const switchAt = protocolSource.indexOf("switch (message.type)");
  if (switchAt < 0) return new Map();
  const tokens = tokenize(protocolSource.slice(switchAt));
  const open = tokens.findIndex((token) => token.value === "{");
  if (open < 0) return new Map();
  const close = balanced(tokens, open);
  if (close < 0) return new Map();
  const bodyStart = switchAt + tokens[open].offset + 1;
  const bodyText = protocolSource.slice(bodyStart, switchAt + tokens[close].offset);
  const tokensOfBody = tokenize(bodyText);
  const arms = new Map();
  const starts = [];
  for (let index = 0; index < tokensOfBody.length; index += 1) {
    if (tokensOfBody[index].value !== "case" || tokensOfBody[index + 1]?.type !== "string") continue;
    if (tokensOfBody[index + 2]?.value !== ":") continue;
    starts.push({ frame: tokensOfBody[index + 1].value, at: tokensOfBody[index].offset });
  }
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1].at : bodyText.length;
    arms.set(starts[index].frame, bodyText.slice(starts[index].at, end));
  }
  return arms;
}

/** The literal contents of a `const NAME = [ ... ]` / `= Object.freeze([ ... ])` declaration, or null. */
function constArrayText(hostSource, name) {
  const pattern = new RegExp(`const\\s+${name}\\b[^=]*=\\s*(?:Object\\.freeze\\()?\\s*\\[`, "u");
  const match = pattern.exec(hostSource);
  if (match === null) return null;
  const tokens = tokenize(hostSource.slice(match.index));
  const open = tokens.findIndex((token) => token.value === "[");
  if (open < 0) return null;
  const close = balanced(tokens, open);
  if (close < 0) return null;
  return hostSource.slice(match.index, match.index + tokens[close].offset + 1);
}

/**
 * Every name the Host NAMES in the bodies reachable from one frame's arm.
 *
 * Two readings, both mechanical: the keys a `has*(Exact|Only)Keys*(...)` call lists (following a bare identifier argument
 * to the `const` array it names), and the members the validators read off the value they were handed. A name reached this
 * way is a name the Host accepts; a name reached by neither is one it does not.
 */
export function hostAcceptedNames(arm, bodies, hostSource, limit = 8, entryPoints = []) {
  const names = new Set();
  const visited = new Set();

  const collect = (text, depth) => {
    if (depth > limit) return;
    const localArrays = localConstArrays(text);
    // WHICH OBJECT each key list decides. A read of `value.status` is acceptance evidence unless the same body lists
    // the keys of `value` ITSELF; a read of `value.args.x` is a name in its own right whatever `value`'s list says,
    // because the list that would decide it is `hasExactKeys(value.args, ...)` and that names its own receiver.
    const keyed = new Set();
    for (const match of text.matchAll(/\bhas(?:Exact|Only)Keys(?:OrOptional)?\s*\(/gu)) {
      const tokens = tokenize(text.slice(match.index));
      const open = tokens.findIndex((token) => token.value === "(");
      const close = balanced(tokens, open);
      if (close < 0) continue;
      const args = tokens.slice(open + 1, close);
      const comma = topLevelIndexOf(args, ",");
      if (comma < 0) continue;
      keyed.add(
        args
          .slice(0, comma)
          .map((token) => token.value)
          .join(""),
      );
      for (const token of args.slice(comma + 1)) {
        if (token.type === "string") names.add(token.value);
        if (token.type !== "word") continue;
        const local = localArrays.get(token.value);
        if (local !== undefined) for (const key of local) names.add(key);
      }
    }
    // The Host writes its key lists two ways: inline in the call, and as a `const allowedKeys = [...]` the call
    // receives. `validateWorldFact` is entirely the second shape, and a reader that knew only the first reported every
    // one of that frame's own keys as a crossing.
    for (const match of text.matchAll(/"(\w+)"\s+in\s+value/gu)) names.add(match[1]);
    for (const match of text.matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/gu)) {
      const array = constArrayText(hostSource, match[1]);
      if (array === null) continue;
      for (const literal of tokenize(array)) if (literal.type === "string") names.add(literal.value);
      if (!visited.has(match[1])) {
        visited.add(match[1]);
        collect(array, depth + 1);
      }
    }
    // A member READ is evidence the Host knows the key, and it is the only evidence when nothing lists that object's
    // keys. `isBodyProgramNodeStatus` both lists `refusalDetail` and reads `value.refusalDetail`, so counting the read
    // would hide the field being dropped from the list - which is the crossing this gate exists for.
    for (const match of text.matchAll(
      /\b(payload|value|entry|candidate|receipt|result|snapshot|record|target|args)((?:\.[A-Za-z_]\w*)+)/gu,
    )) {
      const segments = [...match[2].matchAll(/\.([A-Za-z_]\w*)/gu)].map((path) => path[1]);
      for (const segment of keyed.has(match[1]) ? segments.slice(1) : segments) names.add(segment);
    }
    for (const match of text.matchAll(/\b([A-Za-z_]\w*)\b/gu)) follow(match[1], depth);
  };

  const follow = (name, depth) => {
    const body = bodies.get(name);
    if (body === undefined || visited.has(name)) return;
    visited.add(name);
    collect(body, depth + 1);
  };

  collect(arm, 0);
  // The Host names its per-frame validators after the frame (`execution_request` -> `validateExecutionRequest`), and the
  // dispatch arm is not the only place a frame is decided: `validateExecutionRequest` runs on the execution path, after
  // the envelope was admitted. The convention is the edge - a function named for the frame is part of that frame's
  // surface - so a validator renamed away stops contributing and the fields it named stop being accepted.
  for (const name of entryPoints) follow(name, 0);
  return names;
}

/** The Host payload type each frame declares: `Envelope<"<frame>", <type>>` in `BridgeMessage`. */
export function hostFramePayloadTypes(protocolSource) {
  const unionAt = protocolSource.indexOf("export type BridgeMessage =");
  if (unionAt < 0) return new Map();
  const union = protocolSource.slice(unionAt, protocolSource.indexOf("\n\n", unionAt) + 1);
  const types = new Map();
  for (const match of union.matchAll(/Envelope<\s*"([a-z][a-z0-9_]*)"\s*,/gu)) {
    const after = union.slice(match.index + match[0].length);
    const tokens = tokenize(after);
    const first = tokens.find((token) => token.type === "word");
    // An INLINE payload (`Envelope<"hello_ack", Readonly<{ ... }>>`) declares no type name, so it is left out rather than
    // recorded as the wrapper's own name - a name this gate would then try to match against a C# record.
    if (first === undefined || first.value === "Readonly" || first.value === "Record") continue;
    types.set(match[1], first.value);
  }
  return types;
}

/** The property names of a Host `type X = Readonly<{ ... }>` (or `interface X { ... }`) declaration. */
export function hostTypeProperties(protocolSource, typeName) {
  const tokens = tokenize(protocolSource);
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value !== "type" && token.value !== "interface") continue;
    if (tokens[index + 1]?.value !== typeName) continue;
    let open = -1;
    for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
      if (tokens[cursor].value === ";") break;
      if (tokens[cursor].value === "{") {
        open = cursor;
        break;
      }
    }
    if (open < 0) continue;
    const close = balanced(tokens, open);
    if (close < 0) continue;
    const names = [];
    for (const statement of splitTopLevel(tokens.slice(open + 1, close), ";")) {
      const head = statement.find((entry) => entry.type === "word");
      if (head === undefined) continue;
      const at = statement.indexOf(head);
      if (statement[at + 1]?.value === "?") names.push(head.value);
      else if (statement[at + 1]?.value === ":") names.push(head.value);
    }
    return names;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Checker
// ---------------------------------------------------------------------------

/**
 * The names one body enumerates in a `const <name> = ...;` it later hands to a key list.
 *
 * Not only an array literal: `validateSemanticEvent` builds its expected keys from a TERNARY of four arrays
 * (`bodyTraceKind ? [...] : playerControlKind ? [...] : ...`), so a reader that recognised only `const x = [` reported the
 * four keys of that frame's own `expectedKeys` as crossings. Every string literal inside the declaration is a key the body
 * names, which is the property this reader needs.
 */
function localConstArrays(text) {
  const arrays = new Map();
  const tokens = tokenize(text);
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index].value !== "const" || tokens[index + 1]?.type !== "word") continue;
    let depth = 0;
    const literals = [];
    for (let cursor = index + 2; cursor < tokens.length; cursor += 1) {
      const value = tokens[cursor].value;
      if (value === "(" || value === "[" || value === "{") depth += 1;
      else if (value === ")" || value === "]" || value === "}") depth = Math.max(0, depth - 1);
      else if (value === ";" && depth === 0) break;
      if (tokens[cursor].type === "string") literals.push(value);
    }
    if (literals.length > 0) arrays.set(tokens[index + 1].value, literals);
  }
  return arrays;
}

/** The `validate<PascalFrame>` functions the Host declares for one frame, from the frame's own wire name. */
function frameEntryPoints(frame, bodies) {
  const pascal = frame
    .split("_")
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join("");
  return [`validate${pascal}`, `is${pascal}`].filter((name) => bodies.has(name));
}

const check = (id, status, detail) => (detail === undefined ? { id, status } : { id, status, detail });

/** Every `.cs` file under `integrations/stardew/src/Core/Models`, concatenated: the payload declarations. */
function readModelsDirectory(root, overrides) {
  const directory = join(root, MODELS_DIRECTORY);
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .sort();
  return names.map((name) => overrides[`${MODELS_DIRECTORY}/${name}`] ?? readFileSync(join(directory, name), "utf8"));
}

function readProtocolDirectory(root, overrides) {
  const directory = join(root, MOD_PROTOCOL_DIRECTORY);
  const names = readdirSync(directory)
    .filter((name) => name.endsWith(".cs"))
    .sort();
  return names.map(
    (name) => overrides[`${MOD_PROTOCOL_DIRECTORY}/${name}`] ?? readFileSync(join(directory, name), "utf8"),
  );
}

/**
 * Read both declarations and judge the three rules. Pure over its overrides, so a falsifier can hand it the tree that
 * drifted without touching a checkout.
 */
export function checkCrossLanguageWireParity({
  root = REPOSITORY_ROOT,
  overrides = {},
  exemptions = EXEMPTIONS,
  frameExemptions = UNPAIRED_FRAME_EXEMPTIONS,
} = {}) {
  const read = (relativePath) => overrides[relativePath] ?? readFileSync(join(root, relativePath), "utf8");
  const models = readModelsDirectory(root, overrides).join("\n");
  const protocol = readProtocolDirectory(root, overrides).join("\n");
  const session = read(MOD_SESSION_PATH);
  const program = read(MOD_PROGRAM_MODELS_PATH);
  const hostProtocol = withoutComments(read(HOST_PROTOCOL_PATH));
  const hostFacts = withoutComments(read(HOST_FACTS_PATH));
  const hostSource = `${hostProtocol}\n${hostFacts}`;

  const blocked = (reason, extra = {}) =>
    Object.freeze({
      gate: "cross_language_wire_parity/v1",
      status: "blocked",
      reason,
      policy: null,
      frames: Object.freeze({ examined: 0, paired: 0, unpaired: Object.freeze([]) }),
      fields: Object.freeze({ examined: 0, accepted: 0, unaccepted: 0, exempt: 0 }),
      violations: Object.freeze([]),
      checks: Object.freeze([
        check("declarations_readable", "blocked", reason),
        check("population_complete", "blocked", "not judged: a declaration could not be read"),
        check("field_accepted", "blocked", "not judged: a declaration could not be read"),
      ]),
      ...extra,
    });

  const naming = extractNamingPolicy(protocol);
  if (naming === null)
    return blocked(
      `no \`PropertyNamingPolicy = JsonNamingPolicy.<Policy>\` inside \`JsonOptions\` in ${MOD_SERIALIZER_PATH}`,
    );
  if (naming.policy !== "CamelCase")
    return blocked(
      `the Mod's serialiser declares \`JsonNamingPolicy.${naming.policy}\` (${naming.where}), which this gate cannot map: only CamelCase is read, so a name-by-name comparison would be a guess`,
    );

  const arms = hostFrameArms(hostProtocol);
  if (arms.size === 0)
    return blocked(`no \`case "<frame>":\` arm in \`validateBridgeMessage\` (${HOST_PROTOCOL_PATH})`);
  const bodies = hostFunctionBodies(hostSource);
  const modelRecords = modRecords(models);
  if (modelRecords.size === 0) return blocked(`no wire type declaration under ${MODELS_DIRECTORY}`);
  const records = modRecords(`${models}\n${protocol}\n${session}\n${program}`);
  const derivations = modDerivations(`${models}\n${protocol}\n${session}\n${program}`);
  const hostTypes = hostFramePayloadTypes(hostProtocol);
  const paired = modFramePairs(
    `${protocol}\n${session}`,
    new Set(arms.keys()),
    records,
    (frame) => hostTypes.get(frame) ?? null,
    csharpReturnTypes(`${protocol}\n${session}`),
    modSerialisableTypes(`${protocol}\n${session}`),
  );
  /** frame -> how many fields the walk over that frame's payload contributed, so "paired but empty" is visible. */
  const examinedFrames = new Map();

  const violations = [];
  const examined = [];
  const accepted = [];
  let exemptCount = 0;
  const usedExemptions = new Set();

  const hold = (frame, field, csharpType, detail) => {
    const key = `${frame}:${field}:${csharpType}`;
    const exemption = exemptions.find((entry) => entry.key === key);
    if (exemption !== undefined) {
      usedExemptions.add(exemption.key);
      exemptCount += 1;
      accepted.push(`${frame}/${field}`);
      return;
    }
    violations.push({ code: `${UNACCEPTED}:${frame}:${field}:${csharpType}`, frame, field, csharpType, detail });
  };

  for (const entry of exemptions)
    if (entry.reason.trim().length === 0 || entry.owner.trim().length === 0)
      violations.push({
        code: `exemption_without_owner:${entry.key}`,
        frame: entry.key.split(":")[0],
        field: entry.key.split(":")[1] ?? entry.key,
        csharpType: entry.key.split(":")[2] ?? "",
        detail:
          "an exemption is a documented disagreement: it must carry a one-line reason and the owner who owes the fix",
      });

  for (const [frame, pair] of [...paired.pairs].sort((left, right) => left[0].localeCompare(right[0]))) {
    const arm = arms.get(frame);
    if (arm === undefined) continue;
    if (FRAMES_OWNED_ELSEWHERE.some((entry) => entry.frame === frame)) continue;
    // A frame the Mod DECODES is one the Host writes: its record is a reader, and a field the Mod tolerates but the Host
    // never sends is tolerance, not a crossing. That direction is judged below, from the Host's own payload type.
    if (pair.outbound === undefined) continue;
    const acceptedNames = hostAcceptedNames(arm, bodies, hostSource, 8, frameEntryPoints(frame, bodies));
    const seen = new Set();
    let contributed = 0;
    const walk = (typeName, depth) => {
      if (seen.has(typeName) || depth > 4) return;
      seen.add(typeName);
      // A UNION payload names an abstract base whose fields live on the records that derive from it - three of the
      // body-program frames are exactly that, and stopping at the base reports them as carrying nothing.
      const derived = derivations.get(typeName) ?? new Set();
      const declared = records.get(typeName) ?? [];
      if (declared.length === 0 && derived.size === 0) return;
      for (const field of declared) {
        const wire = wireNameOf(field.name, naming.policy);
        contributed += 1;
        examined.push(`${frame}/${wire}`);
        if (acceptedNames.has(wire)) accepted.push(`${frame}/${wire}`);
        else
          hold(
            frame,
            wire,
            typeName,
            `${typeName}.${field.name} is published by the Mod and no validator reachable from the Host's \`${frame}\` arm names \`${wire}\`, so this frame is refused and \`local-stardew-bridge\` closes the transport on it`,
          );
        const nested = recordOfType(field.type);
        if (nested !== null) walk(nested, depth + 1);
      }
      for (const child of [...derived].sort()) walk(child, depth + 1);
    };
    walk(pair.outbound, 0);
    examinedFrames.set(frame, contributed);
  }

  for (const entry of exemptions) {
    if (usedExemptions.has(entry.key)) continue;
    if (entry.reason.trim().length === 0 || entry.owner.trim().length === 0) continue;
    violations.push({
      code: `${STALE_EXEMPTION}:${entry.key}`,
      frame: entry.key.split(":")[0],
      field: entry.key.split(":")[1] ?? entry.key,
      csharpType: entry.key.split(":")[2] ?? "",
      detail: `this exemption names a field that no longer crosses (or no longer drifts), so it must be deleted: ${entry.reason}`,
    });
  }

  // Direction 2: on a frame the HOST writes, its declared payload type must be readable by the Mod's own record.
  for (const [frame, hostType] of [...hostTypes].sort((left, right) => left[0].localeCompare(right[0]))) {
    const pair = paired.pairs.get(frame);
    if (pair === undefined || pair.inbound === undefined) continue;
    const declared = records.get(pair.inbound);
    if (declared === undefined) continue;
    const properties = hostTypeProperties(hostProtocol, hostType);
    if (properties === null) continue;
    const fields = new Set(declared.map((field) => wireNameOf(field.name, naming.policy)));
    for (const property of properties)
      if (!fields.has(property))
        violations.push({
          code: `${UNKNOWN_TO_MOD}:${frame}:${property}`,
          frame,
          field: property,
          csharpType: hostType,
          detail: `the Host's \`${hostType}\` declares \`${property}\` on \`${frame}\` and the Mod's \`${pair.inbound}\` declares no such field, so the Host writes a key the decoder cannot read`,
        });
  }

  // THE POPULATION IS A VERDICT, NOT A TRAILING SENTENCE. A frame the Host dispatches on that this gate could not pair
  // contributes nothing to "fields examined", and a run that reported `passed` over such a population would be saying the
  // thing it exists to check had been checked. So each of them is either resolved above, exempted by name with an owner
  // who owes the pairing, or BLOCKED here - and an exemption whose frame is paired (or gone) is red.
  const ownedElsewhereFrames = new Set(FRAMES_OWNED_ELSEWHERE.map((entry) => entry.frame));
  const exemptFrames = new Map(frameExemptions.map((entry) => [entry.frame, entry]));
  const unpaired = [];
  const gaps = [];
  let frameExemptCount = 0;
  for (const frame of [...arms.keys()].sort()) {
    if (ownedElsewhereFrames.has(frame)) continue;
    const pair = paired.pairs.get(frame);
    if (pair === undefined) {
      const exemption = exemptFrames.get(frame);
      if (exemption === undefined) {
        unpaired.push(frame);
        gaps.push(`frame_not_measured:${frame}`);
        continue;
      }
      if (exemption.reason.trim().length === 0 || exemption.owner.trim().length === 0) {
        gaps.push(`exemption_without_owner:${frame}`);
        continue;
      }
      frameExemptCount += 1;
      continue;
    }
    if (pair.outbound !== undefined && examinedFrames.get(frame) === 0)
      gaps.push(`frame_without_fields:${frame}:${pair.outbound}`);
    // An INBOUND frame is never walked for fields (its record is a reader, judged by direction 2), but a record this gate
    // cannot find is still a frame it cannot speak about - the state `program_submit` was in while its declaration file was
    // outside the reader.
    if (pair.inbound !== undefined) {
      const declared = records.get(pair.inbound) ?? [];
      const derived = derivations.get(pair.inbound) ?? new Set();
      if (declared.length === 0 && derived.size === 0 && !records.has(pair.inbound))
        gaps.push(`frame_without_fields:${frame}:${pair.inbound}`);
    }
  }
  for (const entry of frameExemptions) {
    // An exemption that outlives what it exempted is a licence nobody re-read: the frame is paired now, owned by another
    // gate, or gone from the Host's switch entirely.
    if (!(paired.pairs.has(entry.frame) || ownedElsewhereFrames.has(entry.frame)) && arms.has(entry.frame)) continue;
    violations.push({
      code: `${STALE_EXEMPTION}:${entry.frame}`,
      frame: entry.frame,
      field: entry.frame,
      csharpType: "",
      detail:
        "this frame exemption names a frame that is paired now (or owned by another gate, or no longer dispatched on), so it must be deleted: " +
        entry.reason,
    });
  }

  const drift = violations.length > 0;
  const status = gaps.length > 0 ? "blocked" : drift ? "failed" : "passed";
  return Object.freeze({
    gate: "cross_language_wire_parity/v1",
    status,
    reason: gaps.length > 0 ? `the population is not what this gate claims to have checked: ${gaps.join(", ")}` : "",
    policy: naming,
    frames: Object.freeze({
      examined: arms.size,
      paired: paired.pairs.size,
      unpaired: Object.freeze(unpaired),
      exempt: frameExemptCount,
      gaps: Object.freeze(gaps),
      ownedElsewhere: Object.freeze(FRAMES_OWNED_ELSEWHERE),
      ambiguous: paired.ambiguous,
    }),
    fields: Object.freeze({
      examined: examined.length,
      accepted: accepted.length,
      unaccepted: violations.filter((violation) => violation.code.startsWith(UNACCEPTED)).length,
      exempt: exemptCount,
    }),
    violations: Object.freeze(violations),
    checks: Object.freeze([
      check(
        "declarations_readable",
        "passed",
        `${naming.policy} at ${naming.where}, ${paired.pairs.size} frame pair(s), ${arms.size} Host arm(s), ${records.size} wire type(s)`,
      ),
      gaps.length === 0
        ? check(
            "population_complete",
            "passed",
            `${paired.pairs.size} of ${arms.size} frame(s) paired · ${FRAMES_OWNED_ELSEWHERE.length} owned by another gate · ${frameExemptCount} exempt with an owner · ${unpaired.length} unmeasured`,
          )
        : check("population_complete", "blocked", `not measured: ${gaps.join(", ")}`),
      drift
        ? check("field_accepted", "failed", `${violations.length} drifting member(s)`)
        : check("field_accepted", "passed", `${examined.length} field(s) of ${paired.pairs.size} frame(s) accepted`),
    ]),
  });
}

/** The lines one run prints: the population first, then the members, so a failure names the drifting field. */
export function formatWireParity(report) {
  if (report.status === "blocked") return [`cross_language_wire_parity blocked: ${report.reason}`];
  const lines = [
    `frames examined ${report.frames.examined} · paired ${report.frames.paired} · measured here ${report.frames.paired - report.frames.ownedElsewhere.length} · owned elsewhere ${report.frames.ownedElsewhere.length} · exempt ${report.frames.exempt} · unmeasured ${report.frames.unpaired.length}`,
    `fields examined ${report.fields.examined} · accepted ${report.fields.accepted} · unaccepted ${report.fields.unaccepted} · exempt ${report.fields.exempt}`,
    `  naming policy ${report.policy.policy} (${report.policy.where})`,
    `  unmeasured frames ${report.frames.unpaired.join(", ") || "none"}`,
  ];
  for (const owned of report.frames.ownedElsewhere) lines.push(`  owned elsewhere ${owned.frame} -> ${owned.owner}`);
  for (const gap of report.frames.gaps) lines.push(`  BLOCKED ${gap}`);
  for (const ambiguous of report.frames.ambiguous) lines.push(`  ambiguous ${ambiguous}`);
  for (const violation of report.violations) lines.push(`${violation.code} ${violation.detail}`);
  return lines;
}

function rootFromArguments(argv) {
  const at = argv.indexOf("--root");
  return at < 0 ? REPOSITORY_ROOT : resolve(argv[at + 1]);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let report;
  try {
    report = checkCrossLanguageWireParity({ root: rootFromArguments(process.argv) });
  } catch (error) {
    // A declaration this gate cannot open is BLOCKED, never a stack trace: a crash and a pass are both answers about the
    // runner rather than about the tree.
    const reason = error instanceof Error ? error.message : String(error);
    report = Object.freeze({
      gate: "cross_language_wire_parity/v1",
      status: "blocked",
      reason: `a declaration could not be read: ${reason}`,
      policy: null,
      frames: Object.freeze({
        examined: 0,
        paired: 0,
        unpaired: Object.freeze([]),
        exempt: 0,
        gaps: Object.freeze([]),
      }),
      fields: Object.freeze({ examined: 0, accepted: 0, unaccepted: 0, exempt: 0 }),
      violations: Object.freeze([]),
      checks: Object.freeze([check("declarations_readable", "blocked", reason)]),
    });
  }
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  } else {
    for (const line of formatWireParity(report)) process.stdout.write(`${line}\n`);
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = EXIT_FOR_STATUS[report.status] ?? EXIT.blocked;
}
