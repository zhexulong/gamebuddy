#!/usr/bin/env node
/**
 * The observability-parity gate: every state the companion can be in is either CARRIED by a browser event or DECLARED
 * as debt with an owner and an expiry.
 *
 * WHY THIS EXISTS (measured 2026-11-23). A run's own account counted `worked_silently: 4` of `examined 8` assistant
 * turns (`tools/fixtures/declared-deleted/round66-facts.runner-log`), i.e. the Host knew she acted and the player was
 * shown nothing: 4 of 5 turns in the run that number came from were tool-only. The state is not missing in the Host -
 * `host/src/companion-activity.ts` publishes every transition as a `COMPANION_ACTIVITY` line and
 * `tools/lib/companion-activity.mjs` reads them into the run bundle - and it is missing in the PRODUCT: neither browser
 * contract has a frame that can say she is acting, on what, with what outcome.
 *
 * THE TWO POPULATIONS ARE BOTH DECLARATIONS, neither a list kept here:
 *
 *   the states   `COMPANION_ACTIVITY_STATES` in `host/src/companion-activity.ts` - the closed set a transition enters.
 *   the events   every `eventType: Type.Literal("…")` arm of `BrowserEventV1Schema` (the Chat surface's stream) and
 *                `GameEventV1Schema` (the Game surface's stream) - the frames a player's screen can actually receive.
 *
 * THE PROPERTY. A "she is doing something" state owes the player three facts: `acting` (the fact of it), `action` (which
 * family and target) and `outcome` (a receipt or a settlement). A state that owes a fact must either name the carrier
 * that answers it - `<channel> <eventType>#<field>`, verified against the contract's own arm and the schema its payload
 * names - or have that fact covered by an `OBSERVABILITY_DEBT` row.
 *
 * WHY DEBT AND NOT A PROTOCOL FIELD. Adding a browser event that nothing renders is the same defect one layer down: the
 * Host would publish `activity` and the panel would ignore it. The product decision (a progress/action card and its
 * copy) belongs to the surface owner, so this lane records the gap against that owner instead of inventing the frame.
 * The row EXPIRES: `expiresWhen` names the channel and event type that would carry it, and the moment that arm exists
 * in the contract the row is `observability_debt_expired:<state>` - it cannot outlive the gap it excuses, and it cannot
 * be deleted quietly before the carrier is recorded, either, because the owed fact would then be undeclared.
 *
 * FINDINGS, each naming the drifting member:
 *   parity_fact_undeclared:<state>:<fact>          the state owes the fact and neither a carrier nor a debt row answers
 *   state_without_parity_row:<state>               a declared activity state no row of the table judges
 *   parity_row_for_absent_state:<state>            a row for a state the declaration no longer carries
 *   state_without_owed_facts:<state>               a row that owes nothing - a state nobody said anything about
 *   parity_fact_unknown:<state>:<fact>             an owed fact outside PARITY_FACTS
 *   carrier_not_in_contract:<state>:<fact>:<c>     the named event type is not an arm of that channel's own union
 *   carrier_field_absent:<state>:<fact>:<c>        the named field is in neither the arm nor the schema its payload names
 *   debt_for_absent_state:<state>                  a debt row for a state that is gone
 *   debt_without_owner:<state>                     a debt row with no owner file - nobody owes the next move
 *   debt_owner_unresolved:<state>:<path>           ...and that owner is not on disk
 *   debt_without_expiry:<state>                    a debt row with nothing to expire it
 *   debt_expiry_malformed:<state>:<value>          an expiry that is not `<channel> <eventType>`
 *   debt_covers_unowed_fact:<state>:<fact>         a debt row excusing a fact its state does not owe
 *   observability_debt_expired:<state>             the expiry event exists now: the row must be deleted and recorded
 * BLOCKED, never green (exit 2): `activity_state_population_empty`, `browser_event_population_empty:<channel>`,
 * `turn_account_silent_member_missing` (the measurement this gate exists for left `host/src/event-pump.ts`), and
 * `companion_observability_parity_unreadable:<path>` for any of the four inputs it reads by name.
 *
 * CEILING, printed rather than hidden: a carrier whose payload is not a schema this reader can resolve is counted in
 * `unverified` and its field is not judged. `unverified 0` means every carrier was read to the field.
 *
 * Usage:
 *   node gates/product/check-companion-observability-parity.mjs            # exit 1 on a finding, 2 on no population
 *   node gates/product/check-companion-observability-parity.mjs --json     # every state's disposition
 *   node gates/product/check-companion-observability-parity.mjs --root DIR # the same reading of a copied tree
 *
 * red-proof: history  the tree without this file's `OBSERVABILITY_DEBT` reddens with `parity_fact_undeclared` for all
 *            seven owed facts (`working`×3, `busy`×3, `idle`×1): the gaps were undeclared before this gate recorded
 *            them, and `gates/product/check-companion-observability-parity.test.mjs` replays that reading by passing an
 *            empty table over the real tree.
 * red-proof: inject  a contract copy that gains the arm a debt row's `expiresWhen` names -> exit 1,
 *            `observability_debt_expired:working`, `:busy`, `:idle` (the same suite, on a copied tree).
 * red-proof: inject  a debt row whose `owner` is not on disk -> `debt_owner_unresolved:<state>:<path>`; a row with
 *            `expiresWhen: "the game surface"` -> `debt_expiry_malformed:<state>`; a row excusing a fact its state does
 *            not owe -> `debt_covers_unowed_fact:<state>:<fact>` (the same suite).
 */

// source-invariant: no compiler can require the browser contract's event union and the companion's activity states to
//   cover each other - they are two declarations in two languages that nothing forces to meet. This file reads both
//   sources because the pair is the invariant.
// source-expiry: when the browser contract's event types are generated from one descriptor that also names the activity
//   state each carries, retire this reading and compare the descriptor with its own generated output.
export const gateDeclaration = {
  id: "check-companion-observability-parity",
  domain: "product",
  tier: "l0",
  kind: "totality",
};

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { bracesFrom, rootFromArgv, withoutComments } from "../../tools/lib/gate-preamble.mjs";
import { repositoryRoot } from "../../tools/lib/repository-root.mjs";

/** The closed set of states the companion can be in, and the publisher of every transition (population A). */
export const ACTIVITY_PATH = "host/src/companion-activity.ts";

/** The Chat surface's browser stream: the frames a mounted Chat panel can receive. */
export const TAVERN_CONTRACT_PATH = "host/src/tavern/browser-contract/index.ts";

/** The Game surface's browser stream: the frames that panel can receive. */
export const GAME_CONTRACT_PATH = "host/src/game-browser-contract/index.ts";

/** The turn account that says a turn worked without narrating - the measurement this gate answers. */
export const TURN_ACCOUNT_PATH = "host/src/event-pump.ts";

/** The surface that would render an activity, and therefore the owner every debt row names. */
export const SURFACE_PATH = "dialogue-web/src/components/GameSurface.tsx";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** The channels a browser event arrives on: the vocabulary a carrier and an expiry are written in. */
export const CHANNELS = Object.freeze({
  tavern: TAVERN_CONTRACT_PATH,
  game: GAME_CONTRACT_PATH,
});

/** The three facts a "she is doing something" state owes the player, in the order they narrow. */
export const PARITY_FACTS = Object.freeze(["acting", "action", "outcome"]);

/**
 * What each activity state owes, and what already carries it.
 *
 * `owes` is a judgment recorded rather than derived: a thinking turn has no action to name, a spoken line needs no
 * receipt, and a settle (`idle`) owes only the outcome that distinguishes it from a crash. `carried` is verified - the
 * gate reads the named arm and the schema its payload declares, so a carrier that stopped carrying is a finding rather
 * than a stale sentence.
 */
export const ACTIVITY_PARITY = Object.freeze({
  thinking: {
    owes: ["acting"],
    carried: { acting: "tavern turn.state_changed#state" },
  },
  speaking: {
    owes: ["acting"],
    carried: { acting: "tavern companion.delta#delta" },
  },
  working: {
    owes: ["acting", "action", "outcome"],
    carried: {},
  },
  busy: {
    owes: ["acting", "action", "outcome"],
    carried: {},
  },
  idle: {
    owes: ["outcome"],
    carried: {},
  },
});

/**
 * The gap, stated against the surface that owes the next move.
 *
 * One row per state in debt. `expiresWhen` is `<channel> <eventType>`: the frame that would carry these facts. The day
 * it exists in the contract this row is `observability_debt_expired:<state>` and must be deleted as the carrier is
 * recorded - an exemption that outlives what it excuses is how a gate stops meaning anything.
 */
export const OBSERVABILITY_DEBT = Object.freeze({
  working: {
    carries: ["acting", "action", "outcome"],
    what:
      "A tool call of hers is executing: whether one is running, which action family and target it names, and the " +
      "receipt that settles it. The Host holds all three per fact (`event-pump.ts` `FactKind.execution_receipt`, the " +
      "Mod's action label, the receipt's own state) and nothing publishes them to a surface.",
    owner: SURFACE_PATH,
    expiresWhen: "game game.activity_changed",
  },
  busy: {
    carries: ["acting", "action", "outcome"],
    what:
      "An execution she started is still in flight in the world. This is the state `worked_silently` is spent in: the " +
      "turn is over, the world is still moving, and the screen shows an attached game with nothing happening in it.",
    owner: SURFACE_PATH,
    expiresWhen: "game game.activity_changed",
  },
  idle: {
    carries: ["outcome"],
    what:
      "The turn ended with nothing pending. Without a settlement the player cannot tell `idle` from a crashed runtime - " +
      "the `round39` reading this state machine was built for (709 s of nothing in front of the player).",
    owner: SURFACE_PATH,
    expiresWhen: "game game.activity_changed",
  },
});

const read = (root, path) => {
  try {
    return readFileSync(resolve(root, path), "utf8");
  } catch {
    return null;
  }
};

/** The declared activity states, from the one declaration that defines them. */
export function activityStates(source) {
  const code = withoutComments(source);
  const declaration = /const\s+COMPANION_ACTIVITY_STATES\s*=\s*Object\.freeze\(\[([\s\S]*?)\]/u.exec(code);
  if (declaration === null) throw new Error("COMPANION_ACTIVITY_STATES is not declared: this gate reads it by name");
  const states = [...declaration[1].matchAll(/"([a-z][a-z0-9_]*)"/gu)].map((match) => match[1]);
  return [...new Set(states)];
}

/**
 * Each event type a contract's own union declares, mapped to the arm that declares it.
 *
 * The arm is found by walking back to the nearest `strictObject(`, which is the arm's own wrapper in both unions - the
 * tavern arms spread `EventBase` and name their payload inline or by reference, and the Game arms declare it inline.
 */
export function browserEvents(source) {
  const code = withoutComments(source);
  const events = new Map();
  for (const match of code.matchAll(/eventType:\s*Type\.Literal\("([^"]+)"\)/gu)) {
    const wrapper = code.lastIndexOf("strictObject(", match.index);
    const open = wrapper < 0 ? -1 : code.indexOf("{", wrapper);
    const arm = open < 0 ? null : bracesFrom(code, open);
    events.set(match[1], arm ?? "");
  }
  return events;
}

/**
 * The text a carrier's field may be declared in: the arm, plus every declaration in the same file that the arm NAMES.
 *
 * One level, because that is the depth both carriers use: `turn.state_changed`'s `payload: BrowserTurnV1Schema` and
 * `companion.delta`'s `CompanionDeltaV1Schema` are module-level `strictObject` declarations in their own contract file.
 * A payload that resolves to neither is reported as unverified rather than judged, so the reading states its ceiling
 * instead of passing a field it never saw.
 */
export function carrierText(code, arm) {
  let text = arm;
  let resolved = 0;
  for (const match of arm.matchAll(/\b([A-Za-z_$][\w$]*)\b/gu)) {
    const name = match[1];
    const at = code.search(new RegExp(`const\\s+${name}\\s*=\\s*strictObject\\(`, "u"));
    if (at < 0) continue;
    const open = code.indexOf("{", at);
    const body = open < 0 ? null : bracesFrom(code, open);
    if (body === null) continue;
    text += `\n${body}`;
    resolved += 1;
  }
  return { text, resolved };
}

/** `<channel> <eventType>#<field>`, or null when the carrier is not written that way. */
export function parseCarrier(carrier) {
  if (typeof carrier !== "string") return null;
  const match = /^([a-z]+) ([A-Za-z0-9_.]+)#([A-Za-z_$][\w$]*)$/u.exec(carrier.trim());
  return match === null ? null : { channel: match[1], eventType: match[2], field: match[3] };
}

/** `<channel> <eventType>`, or null when the expiry is not written that way. */
export function parseExpiry(expiresWhen) {
  if (typeof expiresWhen !== "string") return null;
  const match = /^([a-z]+) ([A-Za-z0-9_.]+)$/u.exec(expiresWhen.trim());
  return match === null ? null : { channel: match[1], eventType: match[2] };
}

const blank = (value) => typeof value !== "string" || value.trim() === "";

/**
 * How one carried fact answers: the frame and field it was verified against, the fact that its payload could not be
 * read, or the finding that says why the claim does not hold.
 *
 * `unverified` is a CEILING and is counted rather than passed: a payload this reader cannot resolve is not evidence
 * that the field is absent, and it is not evidence that it is present either, so the reading prints how many carriers
 * it could not read to the field.
 */
function judgeCarrier({ state, fact, carrier, events, codes }) {
  const parsed = parseCarrier(carrier);
  if (parsed === null || !(parsed.channel in events))
    return {
      finding: {
        code: `carrier_not_in_contract:${state}:${fact}:${String(carrier)}`,
        detail: `\`${carrier}\` is not \`<channel> <eventType>#<field>\` over ${Object.keys(events).join(" | ")}`,
      },
    };
  const arm = events[parsed.channel].get(parsed.eventType);
  if (arm === undefined)
    return {
      finding: {
        code: `carrier_not_in_contract:${state}:${fact}:${parsed.eventType}`,
        detail:
          `\`${state}\`/\`${fact}\` names \`${parsed.eventType}\`, which ${CHANNELS[parsed.channel]} does not ` +
          "declare: the claim points at a frame no surface can receive",
      },
    };
  const answer = `${parsed.channel} ${parsed.eventType}#${parsed.field}`;
  const { text, resolved } = carrierText(codes[parsed.channel], arm);
  if (resolved === 0) return { answer: `${answer} (payload unreadable)`, unverified: true };
  if (!new RegExp(`\\b${parsed.field}\\b`, "u").test(text))
    return {
      finding: {
        code: `carrier_field_absent:${state}:${fact}:${answer}`,
        detail:
          `\`${parsed.eventType}\` declares no \`${parsed.field}\` in the arm or the schema its payload names, ` +
          `so the fact \`${fact}\` is not on that frame`,
      },
    };
  return { answer };
}

/** Every finding one debt row raises, or none while it still earns its place. */
function judgeDebtRow({ state, row, owes, events, root }) {
  const findings = [];
  const add = (code, detail) => findings.push({ code, detail });
  const carries = Array.isArray(row.carries) ? row.carries : [];
  if (carries.length === 0) add(`debt_covers_unowed_fact:${state}:none`, `the row for \`${state}\` carries no fact`);
  for (const fact of carries)
    if (!owes.includes(fact))
      add(
        `debt_covers_unowed_fact:${state}:${fact}`,
        `\`${state}\` does not owe \`${fact}\`, so this excuse covers nothing and must be deleted`,
      );
  if (blank(row.what))
    add(`debt_without_owner:${state}`, `the row for \`${state}\` says nothing about what would have to be carried`);
  if (blank(row.owner))
    add(`debt_without_owner:${state}`, `the row for \`${state}\` names no owner: nobody owes the next move`);
  else if (!existsSync(resolve(root, row.owner)))
    add(
      `debt_owner_unresolved:${state}:${row.owner}`,
      `the owner \`${row.owner}\` is not on disk, so the debt is filed against a file that cannot pay it`,
    );
  if (blank(row.expiresWhen)) {
    add(`debt_without_expiry:${state}`, `the row for \`${state}\` has nothing that would expire it`);
    return findings;
  }
  const expiry = parseExpiry(row.expiresWhen);
  if (expiry === null || !(expiry.channel in events)) {
    add(
      `debt_expiry_malformed:${state}:${row.expiresWhen}`,
      `\`${row.expiresWhen}\` is not \`<channel> <eventType>\` over ${Object.keys(events).join(" | ")}`,
    );
    return findings;
  }
  if (events[expiry.channel].has(expiry.eventType))
    add(
      `observability_debt_expired:${state}`,
      `\`${expiry.eventType}\` is an arm of ${CHANNELS[expiry.channel]} now, so this row has expired: record the ` +
        "carrier in ACTIVITY_PARITY and delete the row",
    );
  return findings;
}

/**
 * One state's disposition: what each owed fact answered, and the findings that say why an answer is not one.
 *
 * `carried` counts the facts a carrier was VERIFIED for, and `declared` the facts a carrier merely names - the two
 * differ only when the reading is already red, and keeping both means the printed counts never claim verification it
 * did not do.
 */
function judgeState({ state, row, excused, events, codes }) {
  const owes = Array.isArray(row.owes) ? row.owes : [];
  const carried = row.carried ?? {};
  const findings = [];
  const asked = {};
  let verified = 0;
  let unverified = 0;
  for (const fact of owes) {
    const carrier = carried[fact];
    if (carrier === undefined) {
      if (excused.includes(fact)) asked[fact] = `debt:${state}`;
      else {
        asked[fact] = "missing";
        findings.push({
          code: `parity_fact_undeclared:${state}:${fact}`,
          detail:
            `\`${state}\` owes \`${fact}\` and neither a carrier records it in ACTIVITY_PARITY nor a row of ` +
            "OBSERVABILITY_DEBT excuses it: the player is shown nothing for a state the Host publishes",
        });
      }
      continue;
    }
    const judged = judgeCarrier({ state, fact, carrier, events, codes });
    if (judged.finding !== undefined) {
      findings.push(judged.finding);
      continue;
    }
    if (judged.unverified === true) unverified += 1;
    else verified += 1;
    asked[fact] = judged.answer;
  }
  return {
    owes,
    asked,
    findings,
    verified,
    unverified,
    declared: owes.filter((fact) => carried[fact] !== undefined).length,
  };
}

/**
 * The two populations, or the reason there is none: an input missing, a declaration unreadable, or a set that came
 * back empty - the three zeroes this reading tells apart, and no one of them is a pass.
 */
function readPopulations(root) {
  const sources = Object.fromEntries(Object.entries(CHANNELS).map(([channel, path]) => [channel, read(root, path)]));
  const activitySource = read(root, ACTIVITY_PATH);
  const turnAccountSource = read(root, TURN_ACCOUNT_PATH);

  const unreadable = [];
  if (activitySource === null) unreadable.push(ACTIVITY_PATH);
  for (const [channel, path] of Object.entries(CHANNELS)) if (sources[channel] === null) unreadable.push(path);
  if (turnAccountSource === null) unreadable.push(TURN_ACCOUNT_PATH);
  if (unreadable.length > 0) return { blocked: [], unreadable };

  let states;
  const events = {};
  try {
    states = activityStates(activitySource);
    for (const [channel, source] of Object.entries(sources)) events[channel] = browserEvents(source);
  } catch (error) {
    return { blocked: [], unreadable: [`${ACTIVITY_PATH}: ${error.message}`] };
  }

  const blocked = [];
  if (states.length === 0) blocked.push("activity_state_population_empty");
  for (const [channel, byType] of Object.entries(events))
    if (byType.size === 0) blocked.push(`browser_event_population_empty:${channel}`);
  if (!/workedSilently:\s*"worked_silently"/u.test(withoutComments(turnAccountSource)))
    blocked.push("turn_account_silent_member_missing");
  if (blocked.length > 0) return { blocked };

  const codes = Object.fromEntries(
    Object.entries(sources).map(([channel, source]) => [channel, withoutComments(source)]),
  );
  return { states, events, codes };
}

/**
 * The reading: whether every owed fact is carried or excused, and whether every excuse still earns its place.
 *
 * `parity` and `debt` are injectable so the falsifier can drive the mechanism over the real tree without editing it;
 * the CLI always passes the two declarations above.
 */
export function auditObservabilityParity({
  root = REPOSITORY_ROOT,
  parity = ACTIVITY_PARITY,
  debt = OBSERVABILITY_DEBT,
} = {}) {
  const { states, events, codes, blocked, unreadable } = readPopulations(root);
  if (blocked !== undefined || unreadable !== undefined)
    return {
      status: "blocked",
      blocked: blocked ?? [],
      findings: [],
      unreadable: unreadable ?? [],
      dispositions: [],
    };

  const findings = [];
  const find = (code, detail) => findings.push({ code, detail });

  const known = new Set(states);
  const dispositions = [];
  let factsOwed = 0;
  let carriedFacts = 0;
  let unverified = 0;

  for (const state of states) {
    const row = parity[state];
    if (row === undefined) {
      find(
        `state_without_parity_row:${state}`,
        `\`${state}\` is a declared activity state and ACTIVITY_PARITY says nothing about it: a state nobody judged ` +
          "is a state nobody owes the player",
      );
      continue;
    }
    const owes = Array.isArray(row.owes) ? row.owes : [];
    if (owes.length === 0)
      find(
        `state_without_owed_facts:${state}`,
        `\`${state}\` declares no owed fact, so nothing can be judged against it`,
      );
    for (const fact of owes)
      if (!PARITY_FACTS.includes(fact))
        find(`parity_fact_unknown:${state}:${fact}`, `\`${fact}\` is not one of ${PARITY_FACTS.join(" | ")}`);
    const judged = judgeState({
      state,
      row,
      excused: Array.isArray(debt[state]?.carries) ? debt[state].carries : [],
      events,
      codes,
    });
    for (const finding of judged.findings) find(finding.code, finding.detail);
    factsOwed += owes.length;
    carriedFacts += judged.verified;
    unverified += judged.unverified;
    dispositions.push({ state, owes, asked: judged.asked, carriedFacts: judged.declared });
  }

  for (const state of Object.keys(parity))
    if (!known.has(state))
      find(
        `parity_row_for_absent_state:${state}`,
        `ACTIVITY_PARITY judges \`${state}\`, which is no longer a state: the row must be deleted`,
      );

  for (const [state, row] of Object.entries(debt)) {
    if (!known.has(state)) {
      find(`debt_for_absent_state:${state}`, `OBSERVABILITY_DEBT excuses \`${state}\`, which is no longer a state`);
      continue;
    }
    for (const finding of judgeDebtRow({ state, row, owes: parity[state]?.owes ?? [], events, root }))
      find(finding.code, finding.detail);
  }

  const debtRows = Object.keys(debt).length;
  const carriedStates = dispositions.filter((entry) => entry.carriedFacts === entry.owes.length).length;
  return {
    status: findings.length === 0 ? "passed" : "failed",
    blocked: [],
    findings,
    unreadable: [],
    dispositions,
    counts: {
      states: states.length,
      carriedStates,
      debtRows,
      factsOwed,
      carriedFacts,
      debtFacts: factsOwed - carriedFacts,
      unverified,
      events: Object.fromEntries(Object.entries(events).map(([channel, byType]) => [channel, byType.size])),
    },
  };
}

function main(argv) {
  const root = rootFromArgv(argv, REPOSITORY_ROOT);
  const reading = auditObservabilityParity({ root });
  const counts = reading.counts ?? {};

  if (reading.status === "blocked") {
    for (const code of reading.blocked) process.stderr.write(`✖ ${code}\n`);
    for (const path of reading.unreadable)
      process.stderr.write(`✖ companion_observability_parity_unreadable: ${path}\n`);
    if (reading.blocked.length === 0 && reading.unreadable.length === 0)
      process.stderr.write("✖ observability_parity_blocked_without_a_reason\n");
    process.stdout.write(
      `${JSON.stringify({ gate: "companion-observability-parity", status: "blocked", population: 0 })}\n`,
    );
    process.exitCode = 2;
    return;
  }

  const line = `companion_observability_parity states examined ${String(counts.states)} · carried ${String(
    counts.carriedStates,
  )} · declared debt ${String(counts.debtRows)} · facts owed ${String(counts.factsOwed)} · carried facts ${String(
    counts.carriedFacts,
  )} · in debt ${String(counts.debtFacts)} · events examined ${Object.entries(counts.events)
    .map(([channel, size]) => `${channel} ${String(size)}`)
    .join(" · ")} · carrier fields unverified ${String(counts.unverified)}`;
  process.stdout.write(`${line}\n`);
  for (const entry of reading.dispositions) {
    const facts = PARITY_FACTS.map((fact) => `${fact}=${entry.asked[fact] ?? "-"}`).join(" · ");
    process.stdout.write(`  ${entry.state}: owes ${entry.owes.join(",")} · ${facts}\n`);
  }
  for (const finding of reading.findings) process.stderr.write(`✖ ${finding.code}: ${finding.detail}\n`);

  const report = {
    gate: "companion-observability-parity",
    status: reading.status,
    population: counts.states,
    examined: counts.states,
    carried: counts.carriedStates,
    declaredDebt: counts.debtRows,
    factsOwed: counts.factsOwed,
    carriedFacts: counts.carriedFacts,
    debtFacts: counts.debtFacts,
    unverified: counts.unverified,
    events: counts.events,
    findings: reading.findings.map((finding) => finding.code),
  };
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify({ ...report, dispositions: reading.dispositions }, null, 2)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(report)}\n`);
  }
  process.exitCode = reading.status === "passed" ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)))
  main(process.argv.slice(2));
