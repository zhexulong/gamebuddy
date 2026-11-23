/**
 * The falsifiers for `check-companion-observability-parity.mjs`.
 *
 * Each case asks the gate for its verdict over either the real tree, the real tree with an injected table, or a COPY
 * of the files it reads with one thing changed. The claims:
 *
 *   1. THE TWO POPULATIONS ARE THE DECLARATIONS, not lists kept here: five activity states from
 *      `COMPANION_ACTIVITY_STATES`, the event types each contract's own union declares.
 *   2. THE TREE PASSES ONCE EVERY GAP IS DECLARED, and prints what it examined: `states examined 5 · carried 2 ·
 *      declared debt 3`, with `working`/`busy`/`idle` answered by debt and `thinking`/`speaking` by a carrier that was
 *      read to the field.
 *   3. THE TREE WITHOUT THE RECORD IS RED for every owed fact - seven of them. That is what this tree's disposition was
 *      before the debt was written down: the gaps were undeclared, not absent.
 *   4. AN EXEMPTION EXPIRES BY NAME. A debt row whose `expiresWhen` names an event type is
 *      `observability_debt_expired:<state>` the moment that arm exists in the contract - shown on a copied tree that
 *      gains the arm - and a row that names no owner, no readable expiry, or a fact its state does not owe names
 *      itself.
 *   5. A CARRIER THAT STOPPED CARRYING IS A FINDING: an event type the contract does not declare, or a field the arm
 *      and the schema its payload names do not carry, is red rather than a stale sentence.
 *
 * red-proof: inject  a copied contract that gains the arm a debt row's `expiresWhen` names ->
 *   `observability_debt_expired:working`, `:busy`, `:idle` (the "an exemption expires by name" case below).
 * red-proof: inject  an empty `OBSERVABILITY_DEBT` over the real tree -> `parity_fact_undeclared` for all seven owed
 *   facts (the "tree without the record" case below).
 */
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { repositoryRoot } from "../../tools/lib/repository-root.mjs";
import {
  ACTIVITY_PARITY,
  ACTIVITY_PATH,
  auditObservabilityParity,
  CHANNELS,
  GAME_CONTRACT_PATH,
  OBSERVABILITY_DEBT,
  SURFACE_PATH,
  TAVERN_CONTRACT_PATH,
  TURN_ACCOUNT_PATH,
} from "./check-companion-observability-parity.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/** Every file the gate reads, plus the owner a debt row names: a copy needs all of them or it is a different question. */
const READ_PATHS = [ACTIVITY_PATH, TAVERN_CONTRACT_PATH, GAME_CONTRACT_PATH, TURN_ACCOUNT_PATH, SURFACE_PATH];

function fixtureTree(t) {
  const root = mkdtempSync(join(tmpdir(), "observability-parity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of READ_PATHS) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, file), join(root, file));
  }
  return root;
}

function rewrite(root, path, replace) {
  const target = join(root, path);
  const before = readFileSync(target, "utf8");
  const after = replace(before);
  assert.notEqual(after, before, `the fixture injection changed nothing in ${path}, so the case proves nothing`);
  writeFileSync(target, after);
}

const codes = (reading) => reading.findings.map((finding) => finding.code);

test("the states are the declaration's own five, and the events are the two contracts' own arms", () => {
  const reading = auditObservabilityParity({ root: REPOSITORY_ROOT });
  assert.equal(reading.status, "passed", `the real tree is red: ${codes(reading).join(", ")}`);
  assert.deepEqual(
    reading.dispositions.map((entry) => entry.state),
    ["thinking", "speaking", "working", "busy", "idle"],
    "the population is COMPANION_ACTIVITY_STATES, in its own order",
  );
  assert.deepEqual(
    reading.counts.events,
    { tavern: 5, game: 2 },
    "the two unions declare five and two event types; a new arm joins this population without an edit here",
  );
  assert.ok(reading.counts.factsOwed > 0, "no state owes a fact, so nothing was judged");
});

test("every owed fact is carried or declared, and the counts say which", () => {
  const reading = auditObservabilityParity({ root: REPOSITORY_ROOT });
  const byState = Object.fromEntries(reading.dispositions.map((entry) => [entry.state, entry]));
  // The carriers, read to the field: the arm and the schema its payload names.
  assert.equal(byState.thinking.asked.acting, "tavern turn.state_changed#state");
  assert.equal(byState.speaking.asked.acting, "tavern companion.delta#delta");
  // The debt, stated against the surface that owes the next move.
  for (const fact of ["acting", "action", "outcome"]) assert.equal(byState.working.asked[fact], "debt:working");
  assert.equal(byState.idle.asked.outcome, "debt:idle");
  assert.deepEqual(
    {
      states: reading.counts.states,
      carried: reading.counts.carriedStates,
      declaredDebt: reading.counts.debtRows,
      factsOwed: reading.counts.factsOwed,
      carriedFacts: reading.counts.carriedFacts,
      debtFacts: reading.counts.debtFacts,
      unverified: reading.counts.unverified,
    },
    { states: 5, carried: 2, declaredDebt: 3, factsOwed: 9, carriedFacts: 2, debtFacts: 7, unverified: 0 },
    "states examined 5 · carried 2 · declared debt 3 · facts owed 9 · carried 2 · in debt 7",
  );
  // Every debt row still earns its place: a fact it carries its state really owes, an owner on disk, an expiry that
  // parses and an arm that could still arrive.
  for (const [state, row] of Object.entries(OBSERVABILITY_DEBT)) {
    for (const fact of row.carries)
      assert.ok(ACTIVITY_PARITY[state].owes.includes(fact), `${state} does not owe ${fact}`);
    assert.equal(row.owner, SURFACE_PATH, "the owner is the surface that would render it");
    assert.match(row.expiresWhen, /^(?:game|tavern) [a-z][\w]*\.[a-z][\w]*$/u);
  }
  assert.deepEqual(Object.keys(CHANNELS).sort(), ["game", "tavern"]);
});

test("the tree without the record is red for every owed fact: this is what was undeclared before the gate", () => {
  const reading = auditObservabilityParity({ root: REPOSITORY_ROOT, debt: {} });
  assert.equal(reading.status, "failed", "an empty debt table over this tree must be red");
  assert.deepEqual(
    codes(reading).sort(),
    [
      "parity_fact_undeclared:busy:acting",
      "parity_fact_undeclared:busy:action",
      "parity_fact_undeclared:busy:outcome",
      "parity_fact_undeclared:idle:outcome",
      "parity_fact_undeclared:working:acting",
      "parity_fact_undeclared:working:action",
      "parity_fact_undeclared:working:outcome",
    ],
    "seven owed facts, each named with the state that owes it",
  );
});

test("an exemption expires by name: the arm its expiry names makes the row red", (t) => {
  const root = fixtureTree(t);
  assert.equal(auditObservabilityParity({ root }).status, "passed", "the copied tree is a faithful copy");
  const original = readFileSync(join(root, GAME_CONTRACT_PATH), "utf8");

  // `game.activity_changed` is the frame each row says would carry it. Adding that arm IS the expiry.
  rewrite(root, GAME_CONTRACT_PATH, () =>
    original.replace(
      "export const GameEventV1Schema = Type.Union([",
      "export const GameEventV1Schema = Type.Union([\n  strictObject({\n" +
        "    apiVersion: ApiVersion,\n    epoch: OpaqueHandle,\n    sequence: Revision,\n" +
        '    eventType: Type.Literal("game.activity_changed"),\n    payload: strictObject({ activity: Type.String() }),\n' +
        "  }),",
    ),
  );
  const expired = codes(auditObservabilityParity({ root }));
  for (const state of ["working", "busy", "idle"])
    assert.ok(
      expired.includes(`observability_debt_expired:${state}`),
      `${state}'s row must expire when its carrier exists: ${expired.join(", ")}`,
    );

  // Restore the copy and the reading is green again: expiry is the arm, not the run.
  writeFileSync(join(root, GAME_CONTRACT_PATH), original);
  assert.equal(auditObservabilityParity({ root }).status, "passed", "restoring the copy restores the verdict");
});

test("a debt row that names no owner, no readable expiry, or a fact its state does not owe names itself", () => {
  const cases = [
    {
      code: "debt_owner_unresolved:working",
      debt: {
        ...OBSERVABILITY_DEBT,
        working: { ...OBSERVABILITY_DEBT.working, owner: "dialogue-web/src/components/Gone.tsx" },
      },
    },
    {
      code: "debt_expiry_malformed:working",
      debt: { ...OBSERVABILITY_DEBT, working: { ...OBSERVABILITY_DEBT.working, expiresWhen: "the game surface" } },
    },
    {
      code: "debt_covers_unowed_fact:idle:speech",
      debt: { ...OBSERVABILITY_DEBT, idle: { ...OBSERVABILITY_DEBT.idle, carries: ["outcome", "speech"] } },
    },
    {
      code: "debt_without_owner:working",
      debt: { ...OBSERVABILITY_DEBT, working: { ...OBSERVABILITY_DEBT.working, owner: "" } },
    },
    {
      code: "debt_for_absent_state:arriving",
      debt: { ...OBSERVABILITY_DEBT, arriving: OBSERVABILITY_DEBT.working },
    },
  ];
  for (const { code, debt } of cases) {
    const found = codes(auditObservabilityParity({ root: REPOSITORY_ROOT, debt }));
    assert.ok(
      found.some((entry) => entry.startsWith(code)),
      `${code} was not reported: ${found.join(", ")}`,
    );
  }
});

test("a carrier that stopped carrying is a finding, not a stale sentence", () => {
  const cases = [
    { code: "carrier_not_in_contract:working:acting", carried: "game game.activity_changed#state" },
    { code: "carrier_field_absent:working:acting", carried: "tavern turn.state_changed#activity" },
    { code: "carrier_not_in_contract:speaking:acting", carried: "game.voice" },
  ];
  for (const { code, carried } of cases) {
    const parity = {
      ...ACTIVITY_PARITY,
      working: { owes: ["acting"], carried: { acting: carried } },
      speaking: { owes: ["acting"], carried: { acting: carried } },
    };
    const found = codes(
      auditObservabilityParity({
        root: REPOSITORY_ROOT,
        parity,
        debt: { busy: OBSERVABILITY_DEBT.busy, idle: OBSERVABILITY_DEBT.idle },
      }),
    );
    assert.ok(
      found.some((entry) => entry.startsWith(code)),
      `${code} was not reported: ${found.join(", ")}`,
    );
  }
});

test("a state nobody judged, and a row for a state that is gone, are both named", () => {
  const { working, ...withoutWorking } = ACTIVITY_PARITY;
  assert.ok(working !== undefined, "the fixture needs the row it removes");
  const missingRow = codes(auditObservabilityParity({ root: REPOSITORY_ROOT, parity: withoutWorking }));
  assert.ok(missingRow.includes("state_without_parity_row:working"), missingRow.join(", "));
  assert.ok(
    missingRow.includes("debt_for_absent_state:working") === false,
    "working is still a declared state, so its row is a missing judgement and not a stale row",
  );

  const goneState = codes(
    auditObservabilityParity({
      root: REPOSITORY_ROOT,
      parity: { ...ACTIVITY_PARITY, ghost: { owes: ["acting"], carried: {} } },
      debt: { ...OBSERVABILITY_DEBT, ghost: OBSERVABILITY_DEBT.working },
    }),
  );
  assert.ok(goneState.includes("parity_row_for_absent_state:ghost"), goneState.join(", "));
  assert.ok(goneState.includes("debt_for_absent_state:ghost"), goneState.join(", "));
});

test("the reading is blocked, never green, when a population or its premise is missing", (t) => {
  const empty = auditObservabilityParity({ root: join(REPOSITORY_ROOT, "design") });
  assert.equal(empty.status, "blocked", "a root without the files blocks instead of passing");
  assert.ok(empty.unreadable.length > 0, "a blocked reading names what it could not read");

  const root = fixtureTree(t);
  rewrite(root, ACTIVITY_PATH, (source) =>
    source.replace(/Object\.freeze\(\[[\s\S]*?\] as const\)/u, "Object.freeze([] as const)"),
  );
  assert.deepEqual(
    auditObservabilityParity({ root }).blocked,
    ["activity_state_population_empty"],
    "no declared activity state is a blocked reading, not a clean one",
  );

  writeFileSync(join(root, ACTIVITY_PATH), readFileSync(join(REPOSITORY_ROOT, ACTIVITY_PATH), "utf8"));
  rewrite(root, TURN_ACCOUNT_PATH, (source) =>
    source.replace('workedSilently: "worked_silently",', 'workedSilently: "silent",'),
  );
  assert.ok(
    auditObservabilityParity({ root }).blocked.includes("turn_account_silent_member_missing"),
    "the measurement this gate answers left the turn account, so the reading names its own premise",
  );
});
