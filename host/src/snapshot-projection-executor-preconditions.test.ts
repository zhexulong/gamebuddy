import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { projectGameSnapshotContext } from "./snapshot-projection.js";
import { projectionReads } from "./snapshot-projection-coverage.js";
import { hostSnapshotKeys } from "./wire-declaration.test-support.js";
import type { Snapshot } from "./protocol.js";

/**
 * Every precondition a projection line states is the EXECUTOR's own condition, not the renderer's opinion of it.
 *
 * <p>
 * THE DEFECT. `snapshot-projection.ts`'s `Sleep:` line said the day ends "from wherever you are", while
 * `SleepAndAdvanceDayLifecycle.TryEnterEligibility` refuses `not_home` outside the farmhouse. The projection was not
 * careless about the code it read: `RequestLocalAdvanceDay` - the dispatch behind `sleep` - checks the bound actor,
 * world readiness and admission and no location at all, answers `accepted`, and the location test runs a few frames
 * later on the game thread. So the one entry point a reader would check says the line was right, and the refusal that
 * contradicts it arrives in a receipt a turn too late to be learned from cheaply. Companion knowledge then carried a
 * floor rule (`sleeping_is_an_action`) whose exit is this fix.
 * </p>
 * <p>
 * WHY THE VERDICT MUST BE A FIELD. `location` cannot answer the condition on this side of the bridge: the executor
 * admits the FarmHouse TYPE (the Farmhand's own Cabin is one) while `location` is the map's own `NameOrUniqueName`. A
 * predicate written from the name would be a second, drifting copy of the executor's rule - the failure `tillable` and
 * `fish_here` were both fixed for (the published fact and the refusal are the same declaration). So the Mod publishes
 * the executor's own answer (`sleepAdmitsHere`, computed by `HomeOf`) and the projection states it.
 * </p>
 * <p>
 * WHAT THIS GATE READS, AND WHAT IT DOES NOT. It reads the executor's declaration, the line that refuses with it, the
 * line that publishes it, the Host's admission of the field, and the projection's derivation from that field; it renders
 * the three verdict states and holds the delivered line to the table it is chosen from. It does NOT read English: no
 * test can decide that a sentence describes FarmHouse rather than a bed tile, so the wording itself is pinned in
 * `snapshot-projection.test.ts` and this gate protects the derivation around it.
 * </p>
 */

const FAILURE_CODE = "projection_states_a_precondition_the_executor_does_not_have";
const PROJECTION = "host/src/snapshot-projection.ts";
const CONTROLLER = "integrations/stardew/farmhandexecutioncontroller.cs";

const repo = (() => {
  let dir = new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  while (!existsSync(join(dir, "integrations"))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error("repository root not found");
    dir = parent;
  }
  return dir;
})();

const read = (relative: string): string => readFileSync(join(repo, relative), "utf8");

/**
 * One line that states an action's admissibility, and the executor declaration its statement must come from.
 *
 * `signature` is a signature rather than a bare name on purpose: a condition that stops being a NAMED declaration is one
 * the projection can no longer derive from, and a check that looked for the name alone would pass a re-inlined test.
 */
type PreconditionClaim = Readonly<{
  /** The action whose admissibility this line talks about. */
  action: string;
  /** The rendered line, exactly as printed, dash included. */
  lineLabel: string;
  /** The snapshot field carrying the producer's verdict, and the one the line's wording is chosen by. */
  field: string;
  /** The reason code the executor refuses with when the condition does not hold. */
  refusal: string;
  /** Where that condition is declared, and the declaration itself. */
  declaration: Readonly<{ source: string; signature: string }>;
  /** The executor member the declaration is, so the refusal and the publication can be read for its use. */
  predicate: string;
  /** Where the executor refuses with it. */
  refusedIn: string;
}>;

const SLEEP: PreconditionClaim = {
  action: "sleep",
  lineLabel: "- Sleep:",
  field: "sleepAdmitsHere",
  refusal: "not_home",
  declaration: {
    source: "integrations/stardew/SleepAndAdvanceDayLifecycle.cs",
    signature: "internal static FarmHouse? HomeOf(GameLocation? location) => location as FarmHouse;",
  },
  predicate: "HomeOf",
  refusedIn: "integrations/stardew/SleepAndAdvanceDayLifecycle.cs",
};

const PRECONDITIONS: readonly PreconditionClaim[] = [SLEEP];

/**
 * Every other line the projection renders, and why it states no admissibility precondition.
 *
 * A reason here is the record that someone looked, for the same reason `WITHHELD_SNAPSHOT_KEYS` carries one: an
 * unclassified line is a line nobody decided about. The population is the RENDER, not this table, so a line added to the
 * projection is a named failure here rather than a fact nobody noticed.
 */
const NO_PRECONDITION_STATED: Readonly<Record<string, string>> = Object.freeze({
  "[Game Snapshot Projection v1:":
    "The block's own header. It names the schema and nothing about the world, so there is no condition to disagree with.",
  "Snapshot Revision:":
    "The snapshot's own revision number. It is identity, not admissibility: nothing is refused because of it.",
  "Time:":
    "The clock and calendar, read straight from the game's own values. The hour decides nothing about an action - `sleep` ends the day on request at any hour - so no condition is being stated here.",
  "Location:":
    "The map's own `NameOrUniqueName` and tile. The map is where the actor IS; it states no requirement on where an action may run, and the line that does (`Sleep:`) names its own verdict field.",
  "Farming:":
    "Stamina, health, soil count and the `canTill`/`canWater` flags. Those two are the surface's own ADVERTISEMENT (`capabilities`, published by `FarmhandCapabilityPublication`), not a per-tile admission: whether a particular tile may be tilled is `till_soil`'s own refusal (`not_tillable`), and this line claims nothing about a tile.",
  "Tools:":
    "The tool slots and the equipped tool. Identity, count and the slot the tool-family actions address; no condition is stated about the world.",
  "Carrying:":
    "What the pack holds outside the tool slots, with the slot and the id each row action addresses. It lists addresses, not permissions.",
  "Pets:":
    "The pets in range and whether each is stationary. Situational context for `pet_animal`; that action's own range test is the executor's.",
});

/**
 * The modal line names a STATE the Mod publishes, plus the countermeasures, without ruling on any one action's
 * admissibility - so it is classified here rather than verified as a precondition. Named rather than left out: this is
 * the shape a gate of this class decides least well, and leaving it out would be the same defect as the Sleep line.
 */
/** The register key a rendered line is matched by: the line without its bullet. */
function registerKey(lineLabel: string): string {
  return lineLabel.startsWith("- ") ? lineLabel.slice(2) : lineLabel;
}

const MODAL_LINE = Object.freeze({
  lineLabel: "- Modal:",
  fields: ["actorDispositionKind", "actorDispositionDetail"] as const,
});

/**
 * Whether the line that refuses with `refusal` reads `predicate`. Both names on ONE line: that is what makes the
 * refusal and the published verdict the same condition rather than two rules that happen to agree today.
 */
function refusalNamesDeclaration(source: string, predicate: string, refusal: string): boolean {
  const refusing = source.split("\n").filter((line) => line.includes(`reason = "${refusal}"`));
  return refusing.some((line) => line.includes(`${predicate}(`));
}

/** Whether the snapshot argument that publishes `field` reads `predicate`, rather than computing its own answer. */
function publicationReadsDeclaration(source: string, field: string, predicate: string): boolean {
  const argument = `${field.charAt(0).toUpperCase()}${field.slice(1)}:`;
  const publishing = source.split("\n").filter((line) => line.trim().startsWith(argument));
  return publishing.some((line) => line.includes(`${predicate}(`));
}

/** A Snapshot the projection renders in full, so every line shape is in the population. */
const SOURCE: Snapshot = {
  revision: 1_019,
  location: "Farm",
  tile: { x: 12, y: 7 },
  stamina: 240,
  exhausted: false,
  health: 100,
  actionable: true,
  capabilities: ["sleep", "till_soil"],
  catalogRevision: 4,
  enabledActionIds: ["sleep"],
  presentationLocale: "en-US",
  timeOfDay: 2_200,
  dayOfMonth: 5,
  seasonIndex: 0,
  year: 1,
  weather: "sunny",
};

/**
 * A snapshot carrying a verdict for a field the Host may not admit yet.
 *
 * The cast is what lets this gate run against the tree BEFORE the field exists - which is the only way the red it
 * produced can be believed - and it is narrow: the field's own type is held by `declaration-agreement.test.ts` and by the
 * three verdict states below.
 */
function withVerdict(field: string, value: boolean | undefined): Snapshot {
  return { ...SOURCE, [field]: value } as unknown as Snapshot;
}

/** The one line this projection renders under `lineLabel`, or "" when it rendered none. */
function renderedLine(snapshot: Snapshot, lineLabel: string): string {
  const projection = projectGameSnapshotContext(snapshot, 1_000, 1_250);
  if (!projection.available) throw new Error("projection_unavailable");
  return projection.text.split("\n").find((line) => line.startsWith(lineLabel)) ?? "";
}

/** Every line label the projection renders across the shapes that change its text. */
function renderedLabels(): readonly string[] {
  const shapes: Snapshot[] = [
    SOURCE,
    withVerdict(SLEEP.field, true),
    withVerdict(SLEEP.field, false),
    { ...SOURCE, timeOfDay: 600 },
    { ...SOURCE, actorDispositionKind: "modal", actorDispositionDetail: "ShippingMenu", actorDispositionActionOwned: false },
    { ...SOURCE, inventoryItemFacts: [{ slot: 20, qualifiedItemId: "(O)24", displayName: "Parsnip", stack: 4 }] },
    {
      ...SOURCE,
      petTargets: [
        { targetId: "pet-1", x: 3, y: 4, petType: "Cat", friendship: 400, pettedToday: false, stationary: true },
      ],
    },
  ];
  const labels = new Set<string>();
  for (const shape of shapes) {
    const projection = projectGameSnapshotContext(shape, 1_000, 1_250);
    if (!projection.available) throw new Error("projection_unavailable");
    for (const line of projection.text.split("\n")) {
      const bullet = line.startsWith("- ") ? line.slice(2) : line;
      const colon = bullet.indexOf(":");
      labels.add(colon < 0 ? bullet : bullet.slice(0, colon + 1));
    }
  }
  return [...labels];
}

test("every projection line's precondition is the executor's own", async (t) => {
  const protocol = read("host/src/protocol.ts");
  const projectionSource = read(PROJECTION);
  const wire = JSON.parse(read("protocol/bridge-v1.schema.json")) as {
    $defs: { snapshot: { properties: Record<string, unknown> } };
  };
  const admitted = hostSnapshotKeys(protocol);

  const findings: string[] = [];
  let agree = 0;

  for (const claim of PRECONDITIONS) {
    const code = `${FAILURE_CODE}:${claim.field}:${PROJECTION}:${claim.declaration.source}#${claim.predicate}`;
    const problems: string[] = [];

    // 1. The wire publishes the field and this Host admits it: a verdict the frame refuses is one no projection reads.
    if (!(claim.field in wire.$defs.snapshot.properties))
      problems.push(`the wire schema does not publish ${claim.field}`);
    if (!admitted.has(claim.field)) problems.push(`SNAPSHOT_KEYS does not admit ${claim.field}`);
    // 2. The Mod publishes it from that same declaration, not from a second rule.
    if (!publicationReadsDeclaration(read(CONTROLLER), claim.field, claim.predicate))
      problems.push(`${CONTROLLER} publishes no ${claim.field} argument that reads ${claim.predicate}`);
    // 3. The declaration exists, as a declaration.
    if (!read(claim.declaration.source).includes(claim.declaration.signature))
      problems.push(`${claim.declaration.source} does not declare \`${claim.declaration.signature}\``);
    // 4. And it is the decision the refusal makes.
    if (!refusalNamesDeclaration(read(claim.refusedIn), claim.predicate, claim.refusal))
      problems.push(
        `the \`${claim.refusal}\` refusal in ${claim.refusedIn} does not read ${claim.predicate}: the line states a condition the executor does not enforce`,
      );
    // 5. The projection derives from that field rather than deciding for itself.
    if (!projectionReads(projectionSource, claim.field))
      problems.push(`${PROJECTION} never reads ${claim.field}, so \`${claim.lineLabel}\` states its own opinion`);

    if (problems.length === 0) agree += 1;
    else findings.push(`${code} - ${problems.join("; ")}`);

    // 6. The verdict reaches the line in all three states, and each state is distinguishable from the others.
    await t.test(`the ${claim.action} line follows the published verdict`, () => {
      const admits = renderedLine(withVerdict(claim.field, true), claim.lineLabel);
      const refuses = renderedLine(withVerdict(claim.field, false), claim.lineLabel);
      const unmeasured = renderedLine(withVerdict(claim.field, undefined), claim.lineLabel);
      for (const [state, line] of [
        ["admits", admits],
        ["refuses", refuses],
        ["unmeasured", unmeasured],
      ] as const)
        assert.notEqual(line, "", `${claim.lineLabel} rendered nothing in the ${state} state`);

      // THE VERDICT IS A FUNCTION OF THE FIELD. A line that did not derive from it would read the same in all three
      // states, which is exactly the pre-fix defect: "from wherever you are" was true of every tile.
      assert.equal(new Set([admits, refuses, unmeasured]).size, 3, "the three verdict states must read differently");
      // The executor's own word for the refusal, so she can recognize the receipt she would get.
      assert.match(refuses, new RegExp(claim.refusal, "u"), "the refused form must name the executor's reason code");
      // INSIDE the room the line reads as satisfied; outside it, the line does not claim she can sleep - and the only
      // difference the admitted form is allowed to carry is the verdict, never the room it names.
      assert.doesNotMatch(admits, new RegExp(claim.refusal, "u"), "the admitted form must not name the refusal");
      assert.notEqual(refuses, admits, "outside the room the line must not read as the admitted one");
      assert.notEqual(unmeasured, admits, "an unpublished verdict must not read as the admitted one");
    });
  }

  await t.test("every rendered line is a verified precondition or a line declared to state none", () => {
    const labels = renderedLabels();
    const unclassified = labels.filter(
      (label) =>
        !PRECONDITIONS.some((claim) => registerKey(claim.lineLabel) === label) &&
        label !== registerKey(MODAL_LINE.lineLabel) &&
        !(label in NO_PRECONDITION_STATED),
    );
    assert.deepEqual(
      unclassified,
      [],
      `these rendered lines are in neither register: ${unclassified.join(", ")}. A line that states a precondition must declare the executor's condition; one that does not must say why in NO_PRECONDITION_STATED.`,
    );
    // The modal line is classified, not verified - but its own fields must still be the ones the projection reads.
    for (const field of MODAL_LINE.fields)
      assert.equal(projectionReads(projectionSource, field), true, `the modal line names a state it does not read: ${field}`);
    for (const [label, reason] of Object.entries(NO_PRECONDITION_STATED))
      assert.ok(reason.trim().length > 0, `${label} is declared to state no precondition with an empty reason`);
  });

  await t.test("the population is non-empty and reported", () => {
    assert.ok(PRECONDITIONS.length > 0, "a gate with no precondition examined agrees with itself");
    assert.ok(
      renderedLabels().length >= 9,
      `the render must have been read: ${String(renderedLabels().length)} line shapes, fewer than this projection prints`,
    );
    console.error(
      `projection_preconditions:preconditions examined ${String(PRECONDITIONS.length)} · agree ${String(agree)} · disagree ${String(findings.length)} · lines examined ${String(renderedLabels().length)}`,
    );
    assert.deepEqual(findings, [], findings.join("\n"));
  });
});

test("the readings that decide a claim go red on a line the executor does not enforce", () => {
  const claim = SLEEP;
  // The pre-fix shape, verbatim: the type test inlined, so the condition is in the gate and nowhere shareable.
  const inlined = `        if (Game1.currentLocation is not FarmHouse) { reason = "not_home"; return false; }`;
  assert.equal(
    refusalNamesDeclaration(inlined, claim.predicate, claim.refusal),
    false,
    "an inlined type test must not satisfy the refusal check",
  );
  // A publication that answered from the map's NAME instead of the declaration - the second rule this fix forbids.
  const named = `            SleepAdmitsHere: player.currentLocation?.Name == "FarmHouse"`;
  assert.equal(
    publicationReadsDeclaration(named, claim.field, claim.predicate),
    false,
    "a publication computed from the location name must not satisfy the publication check",
  );
  // And both readings are true on this tree, so the checks are not simply always red.
  assert.equal(refusalNamesDeclaration(read(claim.refusedIn), claim.predicate, claim.refusal), true);
  assert.equal(publicationReadsDeclaration(read(CONTROLLER), claim.field, claim.predicate), true);
});
