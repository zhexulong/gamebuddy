/**
 * Gate: refusal_informativeness/v1
 *
 * The defect class this exists for: a refusal the companion could not act on. Each one of those was
 * found by spending a live run - `body_program_preflight_rejected` with nothing after it,
 * `invalid_tool_selector` carrying `evidence: null`, `unknown_action:cut_weeds` for an action the
 * runtime really enforces. The catalogs that define those refusals are readable offline, so ONE
 * gate can find all of them at once instead of one per run.
 *
 * What it reads (nothing else, and nothing is written):
 *   - the published action surface (`action-surface.v1.json`): every action, its arguments, its
 *     `tool:<category>` claim and whether it names `expectedTargetId`;
 *   - every refusal site in the Mod's C# sources (`ExecutionState.Rejected` receipts);
 *   - the Body Program authority's own refusal vocabulary (`PreconditionForCode`) and diagnostic
 *     construction sites (`Error(...)` / `Reject(...)` / `Rejected(...)`);
 *   - the Host plan compiler's refusals (`refused(...)` / `refusePlan(...)` / `reasonCode:`);
 *   - the Host body-hold remedy table (`remedyForBodyHold`);
 *   - the one seam that binds a refused receipt to its action (`BridgeSession.TryProjectReceipt`).
 *
 * What it asserts, per refusal class:
 *   1. the reason code is a CLOSED vocabulary - a declared family, not a free-form string;
 *   2. the refusal names the ACTION it was about;
 *   3. a failed precondition carries the two values that disagree (`expected` / `actual`);
 *   4. a class the caller can act on carries a remediation.
 *
 * It reports a matrix (action x refusal class -> informative / not) so the gap is visible on one
 * page. It reports; it does not fix: the Mod and the Host are out of its scope by design.
 *
 * Limits, stated rather than hidden:
 *   - A receipt site whose reason-code argument is an identifier the resolver cannot follow is
 *     reported as `unattributed` and is NOT judged. It follows two shapes: a name assigned a literal
 *     (or a member that returns one), and an `out string` carrier filled by the callee that owns the
 *     literals. A code read through an object (`resolution.ReasonCode`) is beyond it. The count is
 *     printed, so a rising number is visible rather than silent.
 *   - The classes are assigned by the code's own words (the family table below). A code that
 *     matches no family is a finding, not a default: a new kind of refusal needs a decision.
 *   - Remediation is checked at the seam that OWNS it for each class, so a class whose seam is
 *     silent reports it by name (`*_remediation_missing`, `target_remediation_absent`).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const GATE = "refusal_informativeness/v1";

export const SOURCES = Object.freeze({
  surface: "integrations/stardew/action-development/contracts/generated/action-surface.v1.json",
  modRoot: "integrations/stardew",
  programAuthority: "integrations/stardew/src/Core/BodyPrograms/OpenBodyProgramJournalAuthority.cs",
  programModels: "integrations/stardew/src/Core/BodyPrograms/BodyProgramModels.cs",
  bridgeSession: "integrations/stardew/BridgeSession.cs",
  planScript: "host/src/body-program-script.ts",
  remedy: "host/src/stardew-action-remedy.ts",
});

/** Directories under the Mod root that are not shipped refusal sites. */
const NOT_SHIPPED = new Set(["obj", "bin", "tests", "action-development"]);

// ---------------------------------------------------------------------------
// The closed vocabulary: one family per class, matched on the code's own words.
// ---------------------------------------------------------------------------

/**
 * Every class a refusal can belong to. `needs.remediation` names the seam that must carry the
 * countermeasure for that class; `null` means the class is reported, not actioned.
 */
export const REFUSAL_CLASSES = Object.freeze([
  Object.freeze({
    id: "program",
    rationale:
      "The program authority refused a submitted program: its shape, its graph, its bindings, or an action it cannot register/project.",
    needs: Object.freeze({ actionId: true, valuePair: true, remediation: "plan_vocabulary" }),
  }),
  Object.freeze({
    id: "body",
    rationale: "The actor's body is held or unavailable, so no action could start.",
    needs: Object.freeze({ actionId: true, valuePair: false, remediation: "body_remedy" }),
  }),
  Object.freeze({
    id: "tool",
    rationale: "The tool the request needs is not in hand, or not in the slot it named.",
    needs: Object.freeze({ actionId: true, valuePair: true, remediation: "tool_requirement" }),
  }),
  Object.freeze({
    id: "target",
    rationale: "The world target the request named is gone, changed, or was never valid there.",
    needs: Object.freeze({ actionId: true, valuePair: true, remediation: "target_reobservation" }),
  }),
  Object.freeze({
    id: "argument",
    rationale: "An argument the caller supplied does not match what the surface declares or the pack holds.",
    needs: Object.freeze({ actionId: true, valuePair: true, remediation: "plan_vocabulary" }),
  }),
  Object.freeze({
    id: "state",
    rationale:
      "The world, the inventory or the lifecycle is not in a state this action can run in. Reported with its code and its action; the caller has no argument to change.",
    needs: Object.freeze({ actionId: true, valuePair: false, remediation: null }),
  }),
]);

/** Family matchers, in decision order. A family matches when ANY of its patterns does; the report prints the winning family. */
const FAMILY_MATCHERS = Object.freeze([
  [
    "program",
    [
      /^(?:plan_|policy_identity_)/u,
      /^(?:authority_unavailable|invalid_program|invalid_node|invalid_dependency|cycle|too_many_edges|invalid_binding|resource_conflict|tool_requirement_undeclared|execution_mismatch|no_matching_execution)$/u,
      /^(?:unknown_action|action_not_enabled|invalid_arguments)/u,
    ],
  ],
  [
    "body",
    [
      /^(?:body_owned|body_release|actor_held_by)/u,
      /^(?:actor_passed_out|cutscene_active|transient_busy|player_not_actionable)$/u,
    ],
  ],
  ["tool", [/(?:tool)|(?:equipped)/u, /^golden_scythe_grab_override$/u]],
  [
    "target",
    [
      /(?:target)|(?:site_)/u,
      /(?:tile_occupied|tile_not_placeable|soil_|pedestal_locked|destination_|door_|warp_|mine_|location_changed|not_a_container|not_refillable|observation_binding_)/u,
    ],
  ],
  [
    "argument",
    [
      /^(?:invalid_|unsupported_|missing_|unexpected_)/u,
      /(?:not_owned_in_slot|not_owned_in_exact_slot|not_held_in_requested_slot|slot_changed|slot_occupied|item_mismatch|body_slot_mismatch|not_wearable|not_consumable|not_shippable|not_sold_here|not_giftable|not_a_warp_totem|not_usable_here|not_dyeable|no_colour|insufficient_money|out_of_stock|name_invalid|response_key|recipe_unknown|recipe_not_learned|ingredients_missing|ingredients_unavailable|quantity_mismatch|choice_for_ordinary_level|clothing_|tailoring_)/u,
    ],
  ],
  [
    "state",
    [
      /^(?:world_not_ready|farm_required|lifecycle_|no_driver|vault_not_completed|hands_not_empty|inventory_full|invalid_deadline|chat_egress_unavailable|chat_multiplayer_only|chat_rate_limited|level_up_|actor_moving|modal_open|no_modal_present|modal_not_|emote_busy|player_cannot_move|player_menu_open|gift_rejected_)/u,
      /_riding_horse$/u,
      /(?:^|_)(?:refused|not_handled|not_available|not_adjacent|not_owned|not_ready|not_started|not_found|not_current_location|not_pending|not_offered|not_riding|rider_mismatch|out_of_range|out_of_reach|out_of_service|unavailable|already_at_destination|already_in_progress|already_current|already_set|already_watered|already_pending|already_tilled|already_read|empty|full|locked|busy|settling|expired|invalid|unreadable|disagree|present_before|required|limit|divorced|dumped|interference|override|rejected_|unaffordable|not_built|under_construction|precondition_failed|not_purchasable|requires_dialogue|not_shakeable_today|not_consumable_here|not_refillable_here)$/u,
    ],
  ],
]);

/**
 * Codes whose words point at one class but whose meaning is another. Kept as a list of deliberate
 * decisions rather than reordered matchers, because ordering one family before another for a single
 * code leaves the next such code to be discovered by a reader instead of by this gate.
 */
export const EXPLICIT_CLASSES = Object.freeze(
  new Map([
    ["missing_expected_target_id", "argument"],
    ["missing_expected_item", "argument"],
    ["invalid_deadline", "state"],
  ]),
);

/** A reason code on the wire: `snake_case`, optionally `head:parameter`. Prose fails this. */
const CODE_SHAPE = /^[a-z][a-z0-9_]*(?::[A-Za-z0-9_.,:-]+)?$/u;

/** Program codes whose refusal is about one ACTION, so the wire code has to carry its id. */
const ACTION_SCOPED_PROGRAM_CODES =
  /^(?:unknown_action|action_not_enabled|invalid_arguments|invalid_binding|resource_conflict)$/u;

/**
 * Codes whose two disagreeing values are not both in the Mod's hands.
 *
 * `policy_identity_stale` is the Host's adopted identity against the Mod's published one: the Mod
 * sees only its own half, so demanding it name both would make it invent the other. The refusal
 * still names the precondition, which is the actionable half.
 */
export const VALUE_PAIR_EXEMPT = Object.freeze(
  new Set(["authority_unavailable", "policy_identity_invalid", "policy_identity_stale"]),
);

/**
 * Plan refusals whose remedy is a smaller plan rather than a vocabulary answer. The code already
 * carries the bound (`:${state.calls}`, `:${nodes}`), so a requirement would repeat it.
 */
export const PLAN_VOCABULARY_EXEMPT = Object.freeze(
  new Set([
    "plan_script_call_cap",
    "plan_cap_exceeded",
    "plan_script_timeout",
    // An unknown action name is answered by the shape tool's own legal vocabulary, checked once below.
    "plan_script_unknown_action",
    "plan_shape_unknown_action",
    "plan_shape_unknown_family",
  ]),
);

/**
 * The class a reason code belongs to, or null when the code names a family nothing declares.
 * The `:parameter` suffix is stripped first: `unknown_action:cut_weeds` classifies as `unknown_action`.
 */
export function classifyReasonCode(code) {
  const head = code.split(":", 1)[0];
  if (!CODE_SHAPE.test(code)) return null;
  const explicit = EXPLICIT_CLASSES.get(head);
  if (explicit !== undefined) return explicit;
  for (const [id, matchers] of FAMILY_MATCHERS) if (matchers.some((matcher) => matcher.test(head))) return id;
  return null;
}

/** A reason family is the code without its parameter, so one family covers every action it names. */
export function reasonFamilyOf(code) {
  return code.split(":", 1)[0];
}

/** `expectedTargetId` -> `expected_target_id`, so a code and a surface argument compare in one spelling. */
export function toSnakeCase(name) {
  return name.replace(/([a-z0-9])([A-Z])/gu, "$1_$2").toLowerCase();
}

/**
 * True when the reason code's own words already name an argument the published surface declares.
 * `missing_expected_target_id` tells the caller which argument is missing; `invalid_tool_selector`
 * does not, because `tool` is not the argument the request named.
 */
export function namesSurfaceArgument(code, argumentNames) {
  const family = reasonFamilyOf(code);
  for (const name of argumentNames) if (name.length >= 4 && family.includes(name)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Tokenizer (comments and strings), balanced groups, top-level splits.
// ---------------------------------------------------------------------------

const OPENERS = Object.freeze({ "(": ")", "[": "]", "{": "}", "<": ">" });

export function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/u.test(char)) {
      index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "/") {
      const next = source.indexOf("\n", index + 2);
      index = next < 0 ? source.length : next;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close < 0 ? source.length : close + 2;
      continue;
    }
    if (char === "$" && source[index + 1] === '"') {
      const start = index;
      index += 2;
      let value = "";
      while (index < source.length && source[index] !== '"') {
        if (source[index] === "\\") index += 1;
        value += source[index] ?? "";
        index += 1;
      }
      index += 1;
      tokens.push({ type: "interpolated", value, offset: start });
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const quote = char;
      const start = index;
      index += 1;
      let value = "";
      while (index < source.length && source[index] !== quote) {
        if (source[index] === "\\") index += 1;
        value += source[index] ?? "";
        index += 1;
      }
      index += 1;
      tokens.push({ type: quote === "`" ? "template" : "string", value, offset: start });
      continue;
    }
    if (/[A-Za-z_$]/u.test(char)) {
      const start = index;
      index += 1;
      while (/[A-Za-z0-9_$]/u.test(source[index] ?? "")) index += 1;
      tokens.push({ type: "word", value: source.slice(start, index), offset: start });
      continue;
    }
    tokens.push({ type: "punct", value: char, offset: index });
    index += 1;
  }
  return tokens;
}

function lineAt(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function splitTopLevel(tokens, separator) {
  const groups = [];
  let start = 0;
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const value = tokens[index].value;
    if (OPENERS[value] !== undefined) depth += 1;
    else if (value === ")" || value === "]" || value === "}") depth -= 1;
    else if (depth === 0 && value === separator) {
      groups.push(tokens.slice(start, index));
      start = index + 1;
    }
  }
  groups.push(tokens.slice(start));
  return groups;
}

function matchingClose(tokens, openIndex) {
  const open = tokens[openIndex]?.value;
  const close = OPENERS[open];
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

/** The `(` that opens the call whose argument list contains `at`, or -1. */
function enclosingCallOpen(tokens, at) {
  let depth = 0;
  for (let index = at - 1; index >= 0; index -= 1) {
    const value = tokens[index].value;
    if (value === ")" || value === "]" || value === "}") depth += 1;
    else if (value === "(" || value === "[" || value === "{") {
      if (depth === 0) return tokens[index].value === "(" ? index : -1;
      depth -= 1;
    }
  }
  return -1;
}

/** A reason-code expression as source text, e.g. `"unknown_action"` or `$"unknown_action:{id}"`. */
function expressionText(tokens) {
  return tokens
    .map((token) =>
      token.type === "string" || token.type === "interpolated" || token.type === "template"
        ? `${token.type === "interpolated" ? "$" : ""}"${token.value}"`
        : token.value,
    )
    .join(" ");
}

/** The code a literal or interpolated expression names, with parameters normalised to `<param>`. */
function literalCodeOf(token) {
  if (token?.type === "string" || token?.type === "template") return { code: token.value, parameterised: false };
  if (token?.type !== "interpolated") return null;
  const head = token.value.split(":", 1)[0];
  return { code: `${head}:<param>`, parameterised: token.value.includes(":") };
}

// ---------------------------------------------------------------------------
// Reads: the published action surface.
// ---------------------------------------------------------------------------

export function readActionSurface(source) {
  const parsed = JSON.parse(source);
  const actions = (parsed.actions ?? []).map((action) => {
    const argumentNames = Object.keys(action.argumentSchema ?? {});
    const claims = action.resourceTemplate?.claims ?? [];
    const toolClaim = claims.find((claim) => typeof claim.key === "string" && claim.key.startsWith("tool:"));
    return {
      actionId: action.actionId,
      lifecycle: action.lifecycle,
      argumentNames,
      targetBound: argumentNames.includes("expectedTargetId"),
      toolCategory: toolClaim === undefined ? null : toolClaim.key.slice("tool:".length),
      toolUpgradeRequirement: toolClaim === undefined ? null : toolClaim.value,
    };
  });
  if (actions.length === 0) throw new Error("action surface publishes no actions");
  return actions;
}

// ---------------------------------------------------------------------------
// Reads: the Mod's rejected-receipt sites.
// ---------------------------------------------------------------------------

/**
 * Every place the Mod answers with a rejected receipt: the reason code it names, and the evidence
 * it carries. An evidence argument of `null` is the shape that cost a live run to discover.
 */
export function extractModReceiptSites(sources) {
  const sites = [];
  const unattributed = [];
  const outParamMethods = outParamCodeCarriers(sources);
  const methodLiterals = methodCodeLiterals(sources);
  for (const [relativePath, source] of Object.entries(sources)) {
    const tokens = tokenize(source);
    const perFile = [];
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== "word" || token.value !== "ExecutionState") continue;
      if (tokens[index + 1]?.value !== "." || tokens[index + 2]?.value !== "Rejected") continue;
      const open = enclosingCallOpen(tokens, index);
      if (open < 0) continue;
      const close = matchingClose(tokens, open);
      if (close < 0) continue;
      const args = splitTopLevel(tokens.slice(open + 1, close), ",");
      const stateAt = args.findIndex((group) => group.some((item) => item.value === "ExecutionState"));
      if (stateAt < 0) continue;
      const codeGroup = args[stateAt + 1] ?? [];
      const evidenceGroup = args[stateAt + 2] ?? [];
      const location = { path: relativePath, line: lineAt(source, token.offset) };
      const evidence = evidenceText(evidenceGroup);
      const literal = codeGroup.length === 1 ? literalCodeOf(codeGroup[0]) : null;
      if (literal !== null) {
        sites.push({
          ...location,
          code: literal.code,
          parameterised: literal.parameterised,
          evidence,
          resolvedBy: "literal",
        });
        continue;
      }
      const name = codeGroup
        .filter((item) => item.type === "word")
        .map((item) => item.value)
        .at(-1);
      perFile.push({ location, evidence, name, expression: expressionText(codeGroup) });
    }
    // Only the names a site actually uses as a reason code are followed, one hop, in this file.
    const literalsByName = resolveCodeNames(
      tokens,
      new Set(perFile.map((entry) => entry.name).filter((name) => name !== undefined)),
    );
    for (const entry of perFile) {
      const resolved =
        entry.name === undefined
          ? undefined
          : (literalsByName.get(entry.name) ?? carriedLiterals(entry.name, outParamMethods, methodLiterals));
      if (resolved === undefined || resolved.size === 0) {
        unattributed.push({ ...entry.location, expression: entry.expression });
        continue;
      }
      for (const code of resolved)
        sites.push({
          ...entry.location,
          code,
          parameterised: false,
          evidence: entry.evidence,
          resolvedBy: `name:${entry.name}`,
        });
    }
  }
  return { sites, unattributed };
}

/**
 * A reason code a site never spells: `out string scopeReason` is filled by the callee, whose own body
 * holds the literals. This is the second (and last) hop the resolver follows - the caller must hand
 * the code to the name, so the name and the callee are one fact.
 */
function outParamCodeCarriers(sources) {
  const carriers = new Map();
  for (const source of Object.values(sources)) {
    const tokens = tokenize(source);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].value !== "out" || tokens[index + 1]?.value !== "string") continue;
      const name = tokens[index + 2]?.value;
      if (tokens[index + 2]?.type !== "word") continue;
      const open = enclosingCallOpen(tokens, index);
      if (open < 1) continue;
      const callee = tokens[open - 1]?.type === "word" ? tokens[open - 1].value : null;
      if (callee !== null) carriers.set(name, callee);
    }
  }
  return carriers;
}

/** Every reason-code literal inside each member body, keyed by member name. */
function methodCodeLiterals(sources) {
  const byName = new Map();
  for (const source of Object.values(sources)) {
    const tokens = tokenize(source);
    for (let index = 0; index < tokens.length; index += 1) {
      if (tokens[index].type !== "word" || tokens[index + 1]?.value !== "(") continue;
      if (tokens[index - 1]?.value === "." || tokens[index - 1]?.value === "new") continue;
      const codes = codeLiteralsInUnit(tokens, index);
      if (codes.length === 0) continue;
      const bucket = byName.get(tokens[index].value) ?? new Set();
      for (const code of codes) bucket.add(code);
      byName.set(tokens[index].value, bucket);
    }
  }
  return byName;
}

function carriedLiterals(name, outParamMethods, methodLiterals) {
  const callee = outParamMethods.get(name);
  return callee === undefined ? undefined : methodLiterals.get(callee);
}

/** `null` / absent / `default` are the three ways a site says nothing about the world. */
function evidenceText(group) {
  const meaningful = group.filter((item) => item.type !== "punct" || item.value !== ",");
  if (meaningful.length === 0) return { kind: "absent" };
  if (meaningful.length === 1 && meaningful[0].type === "word") {
    const word = meaningful[0].value;
    const kind = word === "null" || word === "default" ? "absent" : "expression";
    return { kind, text: word };
  }
  return { kind: "expression", text: expressionText(meaningful) };
}

/**
 * One-hop resolution of the reason-code identifiers a site uses: a literal assignment to the name,
 * or the member that returns the code whose body holds the literals. Deeper indirection is
 * reported as unattributed, never guessed.
 */
function resolveCodeNames(tokens, names) {
  const byName = new Map();
  for (const name of names) {
    const codes = new Set();
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index];
      if (token.type !== "word" || token.value !== name) continue;
      if (tokens[index + 1]?.value === "=") {
        const literal = literalCodeOf(tokens[index + 2]);
        if (literal !== null && classifyReasonCode(literal.code) !== null) codes.add(literal.code);
        continue;
      }
      if (tokens[index + 1]?.value === "(" && declaredReturnsString(tokens, index))
        for (const code of codeLiteralsInUnit(tokens, index)) codes.add(code);
    }
    if (codes.size > 0) byName.set(name, codes);
  }
  return byName;
}

/** True when `name(` is a member declaration whose return type is a string. */
function declaredReturnsString(tokens, index) {
  for (let back = index - 1; back >= Math.max(0, index - 6); back -= 1) {
    const value = tokens[back]?.value;
    if (value === "string") return true;
    if (value === ";" || value === "{" || value === "}" || value === ")") return false;
  }
  return false;
}

/** Every reason-code literal inside one method/local-function body (one hop, bounded). */
function codeLiteralsInUnit(tokens, nameIndex) {
  let open = -1;
  for (let index = nameIndex + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") {
      open = index;
      break;
    }
    if (tokens[index].value === ";") break;
  }
  if (open < 0) return [];
  const close = matchingClose(tokens, open);
  if (close < 0) return [];
  const unit = tokens.slice(open + 1, close);
  if (unit.length > 4000) return [];
  const codes = [];
  for (const token of unit) {
    const literal = literalCodeOf(token);
    if (literal === null) continue;
    if (classifyReasonCode(literal.code) !== null) codes.push(literal.code);
  }
  return codes;
}

// ---------------------------------------------------------------------------
// Reads: the Body Program authority's diagnostics.
// ---------------------------------------------------------------------------

/** The closed vocabulary `PreconditionForCode` declares, plus the families it matches by prefix. */
export function extractPreconditionVocabulary(source) {
  const tokens = tokenize(source);
  const at = tokens.findIndex((token) => token.type === "word" && token.value === "PreconditionForCode");
  if (at < 0) throw new Error("PreconditionForCode not found");
  let open = -1;
  for (let index = at + 1; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") {
      open = index;
      break;
    }
  }
  const close = matchingClose(tokens, open);
  const body = tokens.slice(open + 1, close);
  const codes = [];
  const prefixes = [];
  for (let index = 0; index < body.length; index += 1) {
    if (body[index].type === "string") codes.push(body[index].value);
    if (body[index].type === "word" && body[index].value === "StartsWith" && body[index + 2]?.type === "string") {
      prefixes.push(body[index + 2].value);
    }
  }
  return Object.freeze({ codes: Object.freeze([...new Set(codes)]), prefixes: Object.freeze([...new Set(prefixes)]) });
}

/**
 * Every diagnostic the verifier builds. `valuePair` is true when the site supplies the two values
 * that disagree (the `expected, actual` overload) or a message that interpolates them.
 */
export function extractProgramDiagnosticSites(relativePath, source) {
  const tokens = tokenize(source);
  const sites = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.type !== "word") continue;
    if (token.value !== "Error" && token.value !== "Reject" && token.value !== "Rejected") continue;
    if (tokens[index + 1]?.value !== "(") continue;
    // The helper declarations themselves are not refusals.
    if (declaredReturnsString(tokens, index) || tokens[index - 1]?.value === "static") continue;
    const close = matchingClose(tokens, index + 1);
    if (close < 0) continue;
    const args = splitTopLevel(tokens.slice(index + 2, close), ",").filter((group) => group.length > 0);
    if (args.length === 0) continue;
    const codeGroup = args[0];
    const named = new Map();
    for (const group of args)
      if (group[0]?.type === "word" && group[1]?.value === ":") named.set(group[0].value, group.slice(2));
    // `Named("code", actionId)` names the action inside the wire code.
    const namedCall = codeGroup[0]?.value === "Named" && codeGroup[2]?.type === "string";
    const literalCode = codeGroup.length === 1 && codeGroup[0].type === "string" ? codeGroup[0].value : null;
    const code = namedCall ? codeGroup[2].value : literalCode;
    if (code === null) continue;
    // The overloads: (code,node,path) bare; (code,node,path,message) message only;
    // (code,node,path,expected,actual) and (…,message,precondition,expected,actual) carry the pair.
    const namesBothValues = named.has("expected") && named.has("actual");
    const positionalValuePair = token.value === "Error" && (args.length === 5 || args.length >= 7);
    sites.push({
      path: relativePath,
      line: lineAt(source, token.offset),
      helper: token.value,
      code,
      namesAction: namedCall,
      valuePair: namesBothValues || positionalValuePair,
      namesValues: args.length === 4 ? hasInterpolated(args) : false,
    });
  }
  return sites;
}

function hasInterpolated(groups) {
  return groups.some((group) => group.some((token) => token.type === "interpolated"));
}

/** The diagnostic rendering: the cause must reach the wire inside the message. */
export function extractDiagnosticRendering(source) {
  const wire = source.match(/WireMessage\s*=>[\s\S]*?;/u)?.[0] ?? "";
  return Object.freeze({
    rendersPrecondition: /failed_precondition=/u.test(wire),
    rendersExpected: /expected=/u.test(wire),
    rendersActual: /actual=/u.test(wire),
  });
}

// ---------------------------------------------------------------------------
// Reads: the Host plan compiler and the body-hold remedy table.
// ---------------------------------------------------------------------------

/** `refused(...)` / `refusePlan(...)` / `reasonCode: ...` — the plan compiler's refusals. */
export function extractPlanRefusalSites(source) {
  const tokens = tokenize(source);
  const sites = [];
  const push = (invocationIndex, openIndex, kind) => {
    const close = matchingClose(tokens, openIndex);
    if (close < 0) return;
    const args = splitTopLevel(tokens.slice(openIndex + 1, close), ",").filter((group) => group.length > 0);
    const codeToken = args[0]?.length === 1 ? args[0][0] : null;
    const literal = literalCodeOf(codeToken);
    if (literal === null) return;
    sites.push({
      path: SOURCES.planScript,
      line: lineAt(source, tokens[invocationIndex].offset),
      kind,
      code: literal.code,
      carriesRemediation:
        args.length >= 3 || /requirement|legal/i.test(source.slice(tokens[openIndex].offset, tokens[close].offset)),
    });
  };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (
      token.type === "word" &&
      (token.value === "refused" || token.value === "refusePlan") &&
      tokens[index + 1]?.value === "("
    ) {
      push(index, index + 1, token.value);
      continue;
    }
    if (token.type === "word" && token.value === "reasonCode" && tokens[index + 1]?.value === ":") {
      const group = [tokens[index + 2]].filter((item) => item !== undefined);
      const literal = group.length === 1 ? literalCodeOf(group[0]) : null;
      if (literal === null) continue;
      // Only a refusal answer: `{ ok: false as const, reasonCode: ... }`. A shape declaration's default
      // (`reasonCode: "tool_requirement_undeclared"`) names a state, not a refusal site.
      const before = tokens.slice(Math.max(0, index - 8), index);
      if (!before.some((item) => item.value === "ok")) continue;
      // `legalActionIds`/`legalFamilies` are the vocabulary answer that makes this code actionable.
      const window = tokens.slice(index, index + 40);
      sites.push({
        path: SOURCES.planScript,
        line: lineAt(source, token.offset),
        kind: "reasonCode",
        code: literal.code,
        carriesRemediation: window.some((item) => item.value === "legalActionIds" || item.value === "legalFamilies"),
      });
    }
  }
  return sites;
}

/** The shape answer's legal vocabulary: the remediation an unknown action/family name needs. */
export function extractPlanLexicon(source) {
  return Object.freeze({
    unknownActionAnswersWithIds: /plan_shape_unknown_action[\s\S]{0,200}legalActionIds/u.test(source),
    unknownFamilyAnswersWithFamilies: /plan_shape_unknown_family[\s\S]{0,200}legalFamilies/u.test(source),
  });
}

/** The reason codes the body-hold remedy table answers, plus the prefix fallback it declares. */
export function extractRemedyVocabulary(source) {
  const cases = [...source.matchAll(/case\s+"([a-z0-9_]+)"\s*:/gu)].map((match) => match[1]);
  const fallback = source.match(/startsWith\("([a-z0-9_]+)"\)/u)?.[1] ?? null;
  return Object.freeze({ cases: Object.freeze([...new Set(cases)]), fallbackPrefix: fallback });
}

/** The one seam that binds a refused receipt to the action it was about. */
export function extractActionIdProjection(source) {
  return Object.freeze({
    resolvesFromReceiptOrBinding:
      /resolvedActionId\s*=\s*actionId\s*\?\?\s*receipt\.ActionId\s*\?\?\s*binding\?\.ActionId/u.test(source),
    refusesUnresolved:
      /!\w*I?BridgeProtocol\.IsOpaqueId\(resolvedActionId\)/u.test(source) ||
      /!BridgeProtocol\.IsOpaqueId\(resolvedActionId\)/u.test(source),
    projectsResolved: /TryProjectReceipt\(\s*receipt,\s*resolvedActionId/u.test(source),
  });
}

// ---------------------------------------------------------------------------
// The checks.
// ---------------------------------------------------------------------------

function finding(id, subject, detail, classId = null) {
  return Object.freeze({ id, subject, detail, class: classId });
}

/**
 * @param {{ root?: string, overrides?: Record<string, string>, modSources?: Record<string, string> }} options
 * `modSources` replaces the whole C# walk: a test that wants one synthetic refusal site should not have
 * to reproduce the shipped tree to exercise it.
 */
export function checkRefusalInformativeness({ root = REPOSITORY_ROOT, overrides = {}, modSources = null } = {}) {
  const read = (relativePath) => overrides[relativePath] ?? readFileSync(path.join(root, relativePath), "utf8");
  const readModSources = () => {
    const directory = path.join(root, SOURCES.modRoot);
    const sources = {};
    const walk = (current) => {
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const full = path.join(current, entry.name);
        const relative = path.relative(root, full).split(path.sep).join("/");
        if (entry.isDirectory()) {
          if (NOT_SHIPPED.has(entry.name)) continue;
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".cs")) {
          sources[relative] = overrides[relative] ?? readFileSync(full, "utf8");
        }
      }
    };
    if (statSync(directory).isDirectory()) walk(directory);
    return sources;
  };

  const actions = readActionSurface(read(SOURCES.surface));
  const shippedModSources = modSources ?? readModSources();
  const receiptSites = extractModReceiptSites(shippedModSources);
  const programAuthoritySource = read(SOURCES.programAuthority);
  const preconditionVocabulary = extractPreconditionVocabulary(programAuthoritySource);
  const programSites = extractProgramDiagnosticSites(SOURCES.programAuthority, programAuthoritySource);
  const rendering = extractDiagnosticRendering(read(SOURCES.programModels));
  const planSites = extractPlanRefusalSites(read(SOURCES.planScript));
  const planLexicon = extractPlanLexicon(read(SOURCES.planScript));
  const remedy = extractRemedyVocabulary(read(SOURCES.remedy));
  const projection = extractActionIdProjection(read(SOURCES.bridgeSession));

  const codes = collectVocabulary({ receiptSites, preconditionVocabulary, programSites, planSites, remedy });
  const classOf = (code) => codes.get(reasonFamilyOf(code))?.class ?? classifyReasonCode(reasonFamilyOf(code));
  const classNeeds = new Map(REFUSAL_CLASSES.map((entry) => [entry.id, entry.needs]));

  const findings = [
    ...checkClosedVocabulary(codes),
    ...checkActionIdentity(projection),
    ...checkProgramDiagnostics({ programSites, rendering, classOf, classNeeds }),
    ...checkReceiptFacts({
      sites: receiptSites.sites,
      classOf,
      classNeeds,
      argumentNames: surfaceArgumentNames(actions),
    }),
    ...checkRemediation({
      codes,
      classOf,
      classNeeds,
      planSites,
      remedy,
      planLexicon,
      toolActions: actions.filter((action) => action.toolCategory !== null),
      targetSites: receiptSites.sites,
    }),
  ];

  const classStatus = new Map();
  for (const refusalClass of REFUSAL_CLASSES) classStatus.set(refusalClass.id, classVerdict(refusalClass.id, findings));

  const matrix = buildMatrix(actions, classStatus);
  const tally = (verdict) =>
    matrix.reduce((total, row) => total + Object.values(row.cells).filter((cell) => cell === verdict).length, 0);
  const informative = tally("informative");
  const notInformative = tally("not_informative");

  return Object.freeze({
    gate: GATE,
    verdict: findings.length === 0 && receiptSites.unattributed.length === 0 ? "passed" : "blocked",
    classVerdicts: Object.freeze(Object.fromEntries([...classStatus.entries()])),
    actions: Object.freeze(actions.map((action) => action.actionId)),
    vocabulary: Object.freeze(
      [...codes.values()]
        .map((entry) =>
          Object.freeze({
            family: entry.family,
            class: entry.class,
            codes: Object.freeze([...entry.codes].sort()),
            provenance: Object.freeze([...entry.provenance].sort()),
          }),
        )
        .sort((left, right) => left.family.localeCompare(right.family)),
    ),
    unattributed: Object.freeze(receiptSites.unattributed.sort((left, right) => left.path.localeCompare(right.path))),
    counts: Object.freeze({
      actions: actions.length,
      receiptSites: receiptSites.sites.length,
      programSites: programSites.length,
      planSites: planSites.length,
      reasonFamilies: codes.size,
      reasonCodes: [...codes.values()].reduce((total, entry) => total + entry.codes.size, 0),
    }),
    findings: Object.freeze(
      dedupe(findings).sort((left, right) =>
        `${left.id}:${left.subject}`.localeCompare(`${right.id}:${right.subject}`),
      ),
    ),
    matrix: Object.freeze(matrix),
    summary: Object.freeze({ informative, notInformative, cells: informative + notInformative }),
  });
}

/** One finding per distinct (id, subject, detail): two sites on one line are one fact to the reader. */
function dedupe(items) {
  const seen = new Set();
  const kept = [];
  for (const item of items) {
    const key = `${item.id}:${item.subject}:${item.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(item);
  }
  return kept;
}

/** Every reason family the tree declares, with the layer that declares it. */
function collectVocabulary({ receiptSites, preconditionVocabulary, programSites, planSites, remedy }) {
  const codes = new Map();
  const remember = (code, provenance) => {
    const family = reasonFamilyOf(code);
    const entry = codes.get(family) ?? {
      family,
      class: classifyReasonCode(family),
      codes: new Set(),
      provenance: new Set(),
    };
    entry.codes.add(code);
    entry.provenance.add(provenance);
    codes.set(family, entry);
  };
  for (const site of receiptSites.sites) remember(site.code, `mod_receipt:${site.path}`);
  for (const code of preconditionVocabulary.codes) remember(code, "program_authority:vocabulary");
  for (const prefix of preconditionVocabulary.prefixes) remember(`${prefix}<param>`, "program_authority:vocabulary");
  for (const site of programSites) remember(site.code, `program_authority:${site.helper}`);
  for (const site of planSites) remember(site.code, `plan:${site.kind}`);
  for (const code of remedy.cases) remember(code, "body_remedy:case");
  return codes;
}

/** 1. The closed vocabulary: a code a caller cannot reason about is a finding, not a default. */
function checkClosedVocabulary(codes) {
  const findings = [];
  for (const [family, entry] of codes) {
    const provenance = [...entry.provenance].sort().slice(0, 3).join(", ");
    if (!CODE_SHAPE.test(family))
      findings.push(finding("free_form_reason_code", family, `a reason code that is not a code at all: ${provenance}`));
    else if (entry.class === null)
      findings.push(
        finding(
          "unclassified_reason_code",
          family,
          `no declared family matches it (${provenance}): decide which class it belongs to`,
        ),
      );
  }
  return findings;
}

/** 2. The action the refusal was about: one seam owns this for receipts. */
function checkActionIdentity(projection) {
  if (projection.resolvesFromReceiptOrBinding && projection.refusesUnresolved && projection.projectsResolved) return [];
  return [
    finding(
      "action_id_projection",
      SOURCES.bridgeSession,
      "a refused receipt must reach the caller bound to an action id: the projection has to resolve `actionId ?? receipt.ActionId ?? binding?.ActionId` and refuse to project when it cannot",
    ),
  ];
}

/** 3. A failed precondition carries the two values that disagree, rendered into the wire message. */
function checkProgramDiagnostics({ programSites, rendering, classOf, classNeeds }) {
  const findings = [];
  for (const site of programSites) {
    const exempt = VALUE_PAIR_EXEMPT.has(reasonFamilyOf(site.code));
    if (site.valuePair || site.namesValues || exempt) continue;
    if (classNeeds.get(classOf(site.code) ?? "program")?.valuePair === false) continue;
    findings.push(
      finding(
        "program_value_pair_missing",
        `${site.path}:${site.line}`,
        `${site.code} is emitted with no expected/actual pair, so the refusal renders expected=unspecified actual=unspecified`,
        "program",
      ),
    );
  }
  for (const [name, ok] of [
    ["failed_precondition", rendering.rendersPrecondition],
    ["expected", rendering.rendersExpected],
    ["actual", rendering.rendersActual],
  ]) {
    if (!ok)
      findings.push(
        finding(
          "diagnostic_rendering_missing",
          SOURCES.programModels,
          `WireMessage never renders ${name}=, so the cause stays inside the Mod`,
          "program",
        ),
      );
  }
  for (const site of programSites) {
    if (classOf(site.code) !== "program" || site.namesAction) continue;
    if (!ACTION_SCOPED_PROGRAM_CODES.test(reasonFamilyOf(site.code))) continue;
    findings.push(
      finding(
        "program_action_named_missing",
        `${site.path}:${site.line}`,
        `${site.code} does not name the action it refused; the caller cannot tell which node to fix`,
        "program",
      ),
    );
  }
  return findings;
}

/** 4. A class the caller can act on carries the fact it must change. */
function checkReceiptFacts({ sites, classOf, classNeeds, argumentNames }) {
  const findings = [];
  for (const site of sites) {
    const needs = classNeeds.get(classOf(site.code));
    if (needs === undefined || needs.valuePair === false) continue;
    if (site.evidence.kind !== "absent") continue;
    // An argument refusal whose own words name the surface argument already says what to fix.
    if (classOf(site.code) === "argument" && namesSurfaceArgument(site.code, argumentNames)) continue;
    if (classOf(site.code) === "argument" && reasonFamilyOf(site.code).startsWith("missing_")) continue;
    findings.push(
      finding(
        "receipt_fact_missing",
        `${site.path}:${site.line}`,
        `${site.code} is a ${classOf(site.code)} refusal with no evidence: the caller is told it failed and not what the world had`,
        classOf(site.code),
      ),
    );
  }
  return findings;
}

/** 5. Remediation, at the seam that owns it for each class. */
function checkRemediation({ codes, classOf, classNeeds, planSites, remedy, planLexicon, toolActions, targetSites }) {
  const findings = [];
  const bodyCodes = [...codes.values()].filter(
    (entry) => entry.class === "body" || (entry.class === "state" && entry.family.startsWith("body_")),
  );
  for (const entry of bodyCodes) {
    if (remedy.cases.includes(entry.family)) continue;
    if (remedy.fallbackPrefix !== null && entry.family.startsWith(remedy.fallbackPrefix)) continue;
    findings.push(
      finding(
        "body_remediation_missing",
        entry.family,
        "no remedy case answers this hold, so the caller is told the body is held and not how to release it",
        "body",
      ),
    );
  }
  for (const site of planSites) {
    if (classNeeds.get(classOf(site.code))?.remediation !== "plan_vocabulary") continue;
    if (site.carriesRemediation) continue;
    if (PLAN_VOCABULARY_EXEMPT.has(reasonFamilyOf(site.code))) continue;
    findings.push(
      finding(
        "plan_remediation_missing",
        `${site.path}:${site.line}`,
        `${site.code} refuses a caller-actionable request without the vocabulary that would let one attempt teach it`,
        classOf(site.code),
      ),
    );
  }
  for (const action of toolActions) {
    if (typeof action.toolUpgradeRequirement === "string" && action.toolUpgradeRequirement.length > 0) continue;
    findings.push(
      finding(
        "tool_requirement_missing",
        action.actionId,
        "the surface declares a tool category but no upgrade requirement, so a tool refusal cannot say which tool satisfies it",
        "tool",
      ),
    );
  }
  for (const [ok, detail] of [
    [
      planLexicon.unknownActionAnswersWithIds,
      "an unknown action name is refused without the legal action ids, so the caller learns its guess was wrong and not what to name",
    ],
    [
      planLexicon.unknownFamilyAnswersWithFamilies,
      "an unknown family name is refused without the legal families, so the caller learns its guess was wrong and not what to name",
    ],
  ]) {
    if (!ok) findings.push(finding("plan_lexicon_missing", SOURCES.planScript, detail, "program"));
  }
  const targetRemediation = targetReobservationSeam(targetSites, classOf);
  if (!targetRemediation.present)
    findings.push(
      finding(
        "target_remediation_absent",
        targetRemediation.subject,
        "a stale/changed target refusal names the target and stops: nothing in the refusal path tells the caller to re-observe and use the freshly published id",
        "target",
      ),
    );
  return findings;
}

/** Which classes can reach each published action, and how each class reads. */
function buildMatrix(actions, classStatus) {
  return actions.map((action) => {
    const cells = {};
    for (const refusalClass of REFUSAL_CLASSES)
      cells[refusalClass.id] =
        cellApplies(refusalClass.id, action) === false ? "n/a" : classStatus.get(refusalClass.id);
    return Object.freeze({
      actionId: action.actionId,
      targetBound: action.targetBound,
      toolCategory: action.toolCategory,
      cells: Object.freeze(cells),
    });
  });
}

/** Every argument name the surface declares, in the spelling a reason code uses. */
function surfaceArgumentNames(actions) {
  return new Set(actions.flatMap((action) => action.argumentNames.map(toSnakeCase)));
}

/** Whether a class can reach this action at all. `undefined` means "every action can". */
function cellApplies(classId, action) {
  if (classId === "tool") return action.toolCategory !== null;
  if (classId === "target") return action.targetBound;
  return undefined;
}

/**
 * Per-class verdict from the findings that belong to it. A vocabulary or action-identity finding is
 * global: an unclassified code could be any class, and a refusal that names no action breaks every
 * class at once.
 */
function classVerdict(classId, findings) {
  return findings.some((item) => item.class === classId || GLOBAL_FINDINGS.has(item.id))
    ? "not_informative"
    : "informative";
}

/** Findings that are about the contract as a whole rather than one class. */
const GLOBAL_FINDINGS = Object.freeze(
  new Set(["free_form_reason_code", "unclassified_reason_code", "action_id_projection"]),
);

/**
 * The seam that would tell a caller to re-observe after a stale target. It is looked for in the
 * refusal path itself, not in a tool description the caller may never re-read.
 */
function targetReobservationSeam(sites, classOf) {
  const targetSites = sites.filter((site) => classOf(site.code) === "target");
  const naming = targetSites.filter(
    (site) => site.evidence.kind === "expression" && /target|expected|actual/iu.test(site.evidence.text ?? ""),
  );
  if (targetSites.length === 0) return { present: true, subject: "none" };
  const carriesRemedy = targetSites.some((site) =>
    /remediate|re-?observe|fresh|reobserve/iu.test(site.evidence.text ?? ""),
  );
  return {
    present: carriesRemedy,
    subject: `${naming.length}/${targetSites.length} target refusals name the target`,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export function renderReport(report) {
  const lines = [];
  lines.push(`${report.gate} verdict=${report.verdict}`);
  lines.push(
    `actions=${report.counts.actions} reasonFamilies=${report.counts.reasonFamilies} reasonCodes=${report.counts.reasonCodes} receiptSites=${report.counts.receiptSites} programSites=${report.counts.programSites} planSites=${report.counts.planSites} unattributed=${report.unattributed.length}`,
  );
  const classColumns = REFUSAL_CLASSES.map((entry) => entry.id);
  lines.push("");
  lines.push(`class verdicts: ${classColumns.map((id) => `${id}=${report.classVerdicts[id]}`).join(" ")}`);
  lines.push("");
  lines.push(`action x class  (${classColumns.map((id) => `${id}=${id.slice(0, 4)}`).join(" ")})`);
  lines.push(`  ${"action".padEnd(32)} ${classColumns.map((id) => id.slice(0, 4).padStart(5)).join("")}`);
  const mark = { informative: " ok ", not_informative: "BAD ", "n/a": "  - " };
  for (const row of report.matrix)
    lines.push(`  ${row.actionId.padEnd(32)} ${classColumns.map((id) => mark[row.cells[id]].padStart(5)).join("")}`);
  lines.push("");
  lines.push(`cells informative=${report.summary.informative} not_informative=${report.summary.notInformative}`);
  if (report.unattributed.length > 0) {
    lines.push("");
    lines.push(`unattributed sites (not judged; one-hop resolver stopped here): ${report.unattributed.length}`);
    for (const site of report.unattributed.slice(0, 20)) lines.push(`  ${site.path}:${site.line} ${site.expression}`);
  }
  if (report.findings.length === 0) {
    lines.push("");
    lines.push(
      "no findings: every enumerated refusal is a classified code that names its action, its failing values and its remedy",
    );
    return `${lines.join("\n")}\n`;
  }
  lines.push("");
  lines.push(`findings=${report.findings.length}`);
  for (const item of report.findings) lines.push(`  ${item.id} ${item.subject} - ${item.detail}`);
  return `${lines.join("\n")}\n`;
}

export function main() {
  const report = checkRefusalInformativeness();
  process.stdout.write(renderReport(report));
  return report.verdict === "passed" ? 0 : 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
