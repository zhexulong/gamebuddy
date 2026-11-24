/**
 * The falsifiers for `check-companion-observability-parity.mjs`.
 *
 * Each case asks the gate for its verdict over either the real tree, the real tree with an injected table, or a COPY
 * of the files it reads with one thing changed. The claims:
 *
 *   1. THE TWO POPULATIONS ARE THE DECLARATIONS, not lists kept here: five activity states from
 *      `COMPANION_ACTIVITY_STATES`, the event types each contract's own union declares.
 *   2. THE TREE PASSES WITH EVERY STATE DISPOSED OF, and prints what it examined: `states examined 5 · carried 2 ·
 *      in debt 0 · at the boundary 3`, with `working`/`busy`/`idle` at the boundary and `thinking`/`speaking` carried
 *      by a frame that was read to the field. The boundary rows name the facts their retired debt rows carried, an
 *      owner on disk, and a heading the handbook really has.
 *   3. THE TREE WITHOUT THE RECORD IS RED for every owed fact - seven of them - and for the three states, each named:
 *      that is what this tree's disposition was before the gap was written down.
 *   4. THE BOUNDARY CANNOT BE QUIETLY RE-OPENED. A debt row beside a boundary state is
 *      `debt_for_a_state_at_the_boundary`; a carrier for a fact the boundary covers is `boundary_expired`; a state the
 *      boundary drops with nothing carrying it is `state_without_a_disposition`.
 *   5. THE RULING MUST STAY WHERE A READER MEETS IT: deleting the handbook heading its rows cite is
 *      `boundary_anchor_missing:<state>` on a copied tree, and a tree whose `design/` mount is absent says
 *      `boundary document unread:` instead of passing a check it never ran.
 *   6. AN EXEMPTION STILL EXPIRES BY NAME. A debt row whose `expiresWhen` names an event type is
 *      `observability_debt_expired:<state>` the moment that arm exists in the contract - shown on a copied tree that
 *      gains the arm - and a row that names no owner, no readable expiry, or a fact its state does not owe names itself.
 *   7. A CARRIER THAT STOPPED CARRYING IS A FINDING: an event type the contract does not declare, or a field the arm
 *      and the schema its payload names do not carry, is red rather than a stale sentence.
 *
 * red-proof: inject  the copied handbook with the heading its boundary rows cite deleted ->
 *   `boundary_anchor_missing:working`, `:busy`, `:idle` (the "the ruling has to stay where a reader meets it" case).
 * red-proof: inject  a debt row for `working` beside the boundary that covers it ->
 *   `debt_for_a_state_at_the_boundary:working`; and a boundary table that drops `working` with nothing carrying it ->
 *   `state_without_a_disposition:working` (the "the boundary cannot be quietly re-opened" case).
 * red-proof: inject  an empty `OBSERVABILITY_DEBT` and `OBSERVABILITY_BOUNDARY` over the real tree ->
 *   `parity_fact_undeclared` for all seven owed facts (the "tree without the record" case).
 * red-proof: inject  a copied contract that gains the arm a fixture debt row's `expiresWhen` names ->
 *   `observability_debt_expired:working` (the "an exemption still expires by name" case).
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
  boundaryDocumentPath,
  CHANNELS,
  documentStates,
  GAME_CONTRACT_PATH,
  OBSERVABILITY_BOUNDARY,
  OBSERVABILITY_DEBT,
  PARITY_FACTS,
  TAVERN_CONTRACT_PATH,
  TURN_ACCOUNT_PATH,
} from "./check-companion-observability-parity.mjs";

const REPOSITORY_ROOT = repositoryRoot(import.meta.url);

/**
 * Every file the gate reads, plus the owners the boundary rows name: a copy needs all of them or it is a different
 * question. The handbook is written into the copy rather than copied, so a checkout without the `design/` mount can
 * still drive the anchor mechanism (and the real document is read by the case that owns that claim).
 */
const READ_PATHS = [
  ...new Set([
    ACTIVITY_PATH,
    TAVERN_CONTRACT_PATH,
    GAME_CONTRACT_PATH,
    TURN_ACCOUNT_PATH,
    ...Object.values(OBSERVABILITY_BOUNDARY).map((row) => row.owner),
  ]),
];

/** The real handbook, or null when this checkout has no `design/` mount. */
const BOUNDARY_DOCUMENT = readFileSafe(join(REPOSITORY_ROOT, boundaryDocumentPath));

function readFileSafe(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** A copy of the tree the gate reads, with a handbook that states every boundary the declaration claims. */
function fixtureTree(t, { headings = Object.values(OBSERVABILITY_BOUNDARY).map((row) => row.anchor) } = {}) {
  const root = mkdtempSync(join(tmpdir(), "observability-parity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const file of READ_PATHS) {
    mkdirSync(dirname(join(root, file)), { recursive: true });
    cpSync(join(REPOSITORY_ROOT, file), join(root, file));
  }
  writeBoundaryDocument(root, headings);
  return root;
}

/** The handbook as a fixture: one heading per claim, so deleting one is the only difference from a tree that passes. */
function writeBoundaryDocument(root, headings) {
  const target = join(root, boundaryDocumentPath);
  mkdirSync(dirname(target), { recursive: true });
  const body = headings.map((heading) => `## ${heading}\n\nfixture prose\n`).join("\n");
  writeFileSync(target, `# fixture handbook\n\n${body}`);
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

test("every owed fact is carried or at the boundary, and the counts say which", () => {
  const reading = auditObservabilityParity({ root: REPOSITORY_ROOT });
  const byState = Object.fromEntries(reading.dispositions.map((entry) => [entry.state, entry]));
  // The carriers, read to the field: the arm and the schema its payload names.
  assert.equal(byState.thinking.asked.acting, "tavern turn.state_changed#state");
  assert.equal(byState.speaking.asked.acting, "tavern companion.delta#delta");
  // The boundary: retired as a product boundary, not owed to a browser surface.
  for (const fact of ["acting", "action", "outcome"]) assert.equal(byState.working.asked[fact], "boundary:working");
  assert.equal(byState.idle.asked.outcome, "boundary:idle");
  assert.deepEqual(
    {
      states: reading.counts.states,
      carried: reading.counts.carriedStates,
      inDebt: reading.counts.debtRows,
      atBoundary: reading.counts.boundaryRows,
      factsOwed: reading.counts.factsOwed,
      carriedFacts: reading.counts.carriedFacts,
      excusedFacts: reading.counts.excusedFacts,
      unverified: reading.counts.unverified,
    },
    { states: 5, carried: 2, inDebt: 0, atBoundary: 3, factsOwed: 9, carriedFacts: 2, excusedFacts: 7, unverified: 0 },
    "states examined 5 · carried 2 · in debt 0 · at the boundary 3 · facts owed 9 · excused 7",
  );
  // Every boundary row still earns its place: facts its state really owes, an owner on disk, a heading the handbook has.
  assert.deepEqual(
    Object.keys(byState)
      .filter((state) => byState[state].atBoundary)
      .sort(),
    ["busy", "idle", "working"],
  );
  for (const [state, row] of Object.entries(OBSERVABILITY_BOUNDARY)) {
    assert.ok(row.carries.length > 0, `${state}'s boundary covers no fact`);
    for (const fact of row.carries)
      assert.ok(ACTIVITY_PARITY[state].owes.includes(fact), `${state} does not owe ${fact}`);
    for (const fact of row.carries) assert.ok(PARITY_FACTS.includes(fact), `${fact} is not a parity fact`);
    assert.ok(row.what.length > 0, `the boundary row for ${state} says nothing about what it covers`);
    assert.match(row.owner, /^(?:host|tools|dialogue-web)\//u, `${state}'s owner is a path in this tree`);
    if (BOUNDARY_DOCUMENT !== null)
      assert.ok(
        documentStates(BOUNDARY_DOCUMENT, row.anchor),
        `the real handbook no longer carries a \`${row.anchor}\` heading, so ${state}'s boundary cites a section a reader cannot find`,
      );
  }
  assert.deepEqual(Object.keys(OBSERVABILITY_DEBT), [], "no state is in debt: the ruling put them all at the boundary");
  assert.deepEqual(Object.keys(CHANNELS).sort(), ["game", "tavern"]);
});

test("the tree without the record is red for every owed fact: this is what was undeclared before the gate", () => {
  const reading = auditObservabilityParity({
    root: REPOSITORY_ROOT,
    debt: {},
    boundary: {},
  });
  assert.equal(reading.status, "failed", "an empty record over this tree must be red");
  const found = codes(reading);
  for (const state of ["working", "busy", "idle"])
    assert.ok(found.includes(`state_without_a_disposition:${state}`), `${state} was not named: ${found.join(", ")}`);
  assert.deepEqual(
    found.filter((code) => code.startsWith("parity_fact_undeclared:")).sort(),
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

test("the ruling has to stay where a reader meets it: a deleted heading is a finding by name", (t) => {
  const root = fixtureTree(t);
  assert.equal(auditObservabilityParity({ root }).status, "passed", "the copied tree is a faithful copy");

  // The heading every boundary row cites. Deleting it is the whole defect: the rows now cite a section nobody finds.
  const anchor = OBSERVABILITY_BOUNDARY.working.anchor;
  writeBoundaryDocument(
    root,
    Object.values(OBSERVABILITY_BOUNDARY)
      .map((row) => row.anchor)
      .filter((heading) => heading !== anchor),
  );
  const found = codes(auditObservabilityParity({ root }));
  for (const state of ["working", "busy", "idle"])
    assert.ok(
      found.includes(`boundary_anchor_missing:${state}:${anchor}`),
      `${state}'s boundary must name the missing heading: ${found.join(", ")}`,
    );

  // Restoring the heading restores the green: the reading is of the document, not of the run.
  writeBoundaryDocument(
    root,
    Object.values(OBSERVABILITY_BOUNDARY).map((row) => row.anchor),
  );
  assert.equal(auditObservabilityParity({ root }).status, "passed", "restoring the copy restores the verdict");
});

test("a checkout without the design mount says the anchors were not measured, and does not pass itself off as having read one", (t) => {
  const root = fixtureTree(t);
  rmSync(join(root, boundaryDocumentPath), { force: true });
  const reading = auditObservabilityParity({ root });
  assert.equal(reading.status, "passed", `an absent mount is a ceiling, not a finding: ${codes(reading).join(", ")}`);
  assert.deepEqual(reading.boundaryDocument, { status: "unread", path: boundaryDocumentPath });
});

test("the boundary cannot be quietly re-opened: debt beside it, or a carrier for a fact it covers", () => {
  const debtRow = {
    carries: ["acting", "action", "outcome"],
    what: "fixture",
    owner: "host/src/event-pump.ts",
    expiresWhen: "game game.activity_changed",
  };

  const reopenedAsDebt = codes(
    auditObservabilityParity({ root: REPOSITORY_ROOT, debt: { ...OBSERVABILITY_DEBT, working: debtRow } }),
  );
  assert.ok(
    reopenedAsDebt.includes("debt_for_a_state_at_the_boundary:working"),
    `a debt row beside the boundary must name itself: ${reopenedAsDebt.join(", ")}`,
  );

  const carriedAgain = codes(
    auditObservabilityParity({
      root: REPOSITORY_ROOT,
      parity: {
        ...ACTIVITY_PARITY,
        working: { owes: ["acting", "action", "outcome"], carried: { acting: "tavern turn.state_changed#state" } },
      },
    }),
  );
  assert.ok(
    carriedAgain.includes("boundary_expired:working") === false,
    "one carried fact of three is not the surface showing her actions, so the boundary still stands",
  );
  const fullyCarried = codes(
    auditObservabilityParity({
      root: REPOSITORY_ROOT,
      parity: {
        ...ACTIVITY_PARITY,
        working: {
          owes: ["acting"],
          carried: { acting: "tavern turn.state_changed#state" },
        },
      },
      boundary: {
        ...OBSERVABILITY_BOUNDARY,
        working: { ...OBSERVABILITY_BOUNDARY.working, carries: ["acting"] },
      },
    }),
  );
  assert.ok(
    fullyCarried.includes("boundary_expired:working"),
    `a frame that now answers what the boundary covered is a new product decision: ${fullyCarried.join(", ")}`,
  );
});

test("a state the boundary drops, with nothing carrying it, is named rather than falling through", () => {
  const { working, ...withoutWorking } = OBSERVABILITY_BOUNDARY;
  assert.ok(working !== undefined, "the fixture needs the row it removes");
  const found = codes(auditObservabilityParity({ root: REPOSITORY_ROOT, boundary: withoutWorking }));
  assert.ok(found.includes("state_without_a_disposition:working"), found.join(", "));
  for (const fact of ["acting", "action", "outcome"])
    assert.ok(found.includes(`parity_fact_undeclared:working:${fact}`), `${fact} was not named: ${found.join(", ")}`);
});

test("a boundary row with no owner on disk, no anchor, or an unowed fact names itself", () => {
  const cases = [
    {
      code: "boundary_owner_unresolved:busy",
      boundary: {
        ...OBSERVABILITY_BOUNDARY,
        busy: { ...OBSERVABILITY_BOUNDARY.busy, owner: "host/src/gone.ts" },
      },
    },
    {
      code: "boundary_without_owner:busy",
      boundary: { ...OBSERVABILITY_BOUNDARY, busy: { ...OBSERVABILITY_BOUNDARY.busy, owner: "" } },
    },
    {
      code: "boundary_without_anchor:busy",
      boundary: { ...OBSERVABILITY_BOUNDARY, busy: { ...OBSERVABILITY_BOUNDARY.busy, anchor: "" } },
    },
    {
      code: "boundary_covers_unowed_fact:idle:action",
      boundary: {
        ...OBSERVABILITY_BOUNDARY,
        idle: { ...OBSERVABILITY_BOUNDARY.idle, carries: ["outcome", "action"] },
      },
    },
    {
      code: "boundary_for_absent_state:arriving",
      boundary: { ...OBSERVABILITY_BOUNDARY, arriving: OBSERVABILITY_BOUNDARY.busy },
    },
  ];
  for (const { code, boundary } of cases) {
    const found = codes(auditObservabilityParity({ root: REPOSITORY_ROOT, boundary }));
    assert.ok(
      found.some((entry) => entry.startsWith(code)),
      `${code} was not reported: ${found.join(", ")}`,
    );
  }
});

test("an exemption still expires by name: the arm its expiry names makes the row red", (t) => {
  const root = fixtureTree(t);
  // The debt mechanism, driven with a fixture row over a tree where `working` is NOT at the boundary: the two cannot
  // coexist, so the row has to be read against a boundary that leaves the state out.
  const { working, ...boundaryWithoutWorking } = OBSERVABILITY_BOUNDARY;
  assert.ok(working !== undefined, "the fixture needs the boundary row it removes");
  const debt = {
    working: {
      carries: ["acting", "action", "outcome"],
      what: "fixture: the row a new state would write",
      owner: "host/src/event-pump.ts",
      expiresWhen: "game game.activity_changed",
    },
  };
  const before = auditObservabilityParity({ root, debt, boundary: boundaryWithoutWorking });
  assert.equal(
    codes(before).some((code) => code.startsWith("observability_debt_expired:")),
    false,
    `the copied tree has no such arm yet: ${codes(before).join(", ")}`,
  );

  // `game.activity_changed` is the frame the row says would carry it. Adding that arm IS the expiry.
  const original = readFileSync(join(root, GAME_CONTRACT_PATH), "utf8");
  rewrite(root, GAME_CONTRACT_PATH, () =>
    original.replace(
      "export const GameEventV1Schema = Type.Union([",
      "export const GameEventV1Schema = Type.Union([\n  strictObject({\n" +
        "    apiVersion: ApiVersion,\n    epoch: OpaqueHandle,\n    sequence: Revision,\n" +
        '    eventType: Type.Literal("game.activity_changed"),\n    payload: strictObject({ activity: Type.String() }),\n' +
        "  }),",
    ),
  );
  const expired = codes(auditObservabilityParity({ root, debt, boundary: boundaryWithoutWorking }));
  assert.ok(
    expired.includes("observability_debt_expired:working"),
    `the row must expire when its carrier exists: ${expired.join(", ")}`,
  );

  // Restore the copy and the reading is green again: expiry is the arm, not the run.
  writeFileSync(join(root, GAME_CONTRACT_PATH), original);
  assert.equal(
    codes(auditObservabilityParity({ root, debt, boundary: boundaryWithoutWorking })).some((code) =>
      code.startsWith("observability_debt_expired:"),
    ),
    false,
    "restoring the copy restores the verdict",
  );
});

test("a debt row that names no owner, no readable expiry, or a fact its state does not owe names itself", () => {
  // The debt table is empty on this tree, so every case supplies the row it breaks.
  const row = (overrides) => ({
    working: {
      carries: ["acting", "action", "outcome"],
      what: "fixture",
      owner: "host/src/event-pump.ts",
      expiresWhen: "game game.activity_changed",
      ...overrides,
    },
  });
  const boundary = { ...OBSERVABILITY_BOUNDARY };
  delete boundary.working;
  const cases = [
    { code: "debt_owner_unresolved:working", debt: row({ owner: "host/src/gone.ts" }) },
    { code: "debt_expiry_malformed:working", debt: row({ expiresWhen: "the game surface" }) },
    { code: "debt_covers_unowed_fact:working:speech", debt: row({ carries: ["acting", "speech"] }) },
    { code: "debt_without_owner:working", debt: row({ owner: "" }) },
    { code: "debt_without_expiry:working", debt: row({ expiresWhen: "" }) },
    { code: "debt_for_absent_state:arriving", debt: { arriving: row({}).working } },
  ];
  for (const { code, debt } of cases) {
    const found = codes(auditObservabilityParity({ root: REPOSITORY_ROOT, debt, boundary }));
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
    const boundary = { busy: OBSERVABILITY_BOUNDARY.busy, idle: OBSERVABILITY_BOUNDARY.idle };
    const found = codes(auditObservabilityParity({ root: REPOSITORY_ROOT, parity, boundary }));
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
      debt: {
        ...OBSERVABILITY_DEBT,
        ghost: {
          carries: ["acting"],
          what: "fixture",
          owner: "host/src/event-pump.ts",
          expiresWhen: "game game.activity_changed",
        },
      },
      boundary: { ...OBSERVABILITY_BOUNDARY, phantom: OBSERVABILITY_BOUNDARY.busy },
    }),
  );
  for (const code of [
    "parity_row_for_absent_state:ghost",
    "debt_for_absent_state:ghost",
    "boundary_for_absent_state:phantom",
  ])
    assert.ok(goneState.includes(code), `${code} was not reported: ${goneState.join(", ")}`);
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
