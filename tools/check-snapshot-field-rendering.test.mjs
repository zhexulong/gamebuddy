import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { auditSnapshotRendering, RENDERER_SOURCES, RENDERING_EXEMPTIONS } from "./check-snapshot-field-rendering.mjs";

// red-proof: inject  deleting `formatCarriedCanWater`'s call and its body from a copy of `host/src/fact-brief.ts` ->
//            `fact_not_visible_to_the_companion:wateringCanFacts` (see "a field the prose stops rendering is named").
//
// Also injected, each seen red once (this file): a fact moved out of the companion's renderers and into a
// player-audience module (`fact_not_visible_to_the_companion:stamina` - the other audience printing it is not her
// reading it), a `player_only` exemption with a blank reason (`player_only_without_reason`), one whose field no
// player-audience renderer prints (`player_only_without_a_player_renderer`), a field added to `SNAPSHOT_KEYS` with no
// renderer, an exemption for a field the prose renders now (`stale_rendering_exemption`), an exemption for a field the
// wire no longer publishes (the same code, the other direction), an exemption with nobody's name on it, a mention of the
// field inside a COMMENT (not a rendering), and a wire list with no keys at all (blocked, exit 2 - never green).
//
// PROVENANCE - 2026-11-11, the run this gate exists for: `wateringCanFacts` was published in every observation
// (`water 40, 40, 38, 36, 36` of `40`), validated, coverage-listed and labelled, and `<world-state>` printed the can
// only as `1 份 喷壶` in the pack list. She shook it and narrated a gauge instead: `壶底见底了`, `壶空了正好`.
//
// PROVENANCE - 2026-11-21, the audience defect: `health` was exempted by `printedBy: "host/src/snapshot-hud.ts"`, a
// block whose only consumer is a `typeof` guard (`host/src/host-service.ts:1235`). Her own hit points were printed into a
// string no reader receives, and the gate called the field handled.

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE = join(REPOSITORY_ROOT, "tools", "check-snapshot-field-rendering.mjs");
const SOURCES = {
  protocol: "host/src/protocol.ts",
  factBrief: "host/src/fact-brief.ts",
  vocabulary: "host/src/game-world-vocabulary.ts",
  hud: "host/src/snapshot-hud.ts",
  playerHud: "host/src/player-hud.ts",
};

/** A renderer that reaches the PLAYER's own surface: the audience this tree has none of, declared here for the proofs. */
const PLAYER_HUD_RENDERER = Object.freeze({ path: SOURCES.playerHud, audience: "player" });
const PLAYER_HUD = [
  'import type { Snapshot } from "./protocol.js";',
  "",
  "export function formatPlayerHud(snapshot: Snapshot): string {",
  "  const ripe = Array.isArray(snapshot.harvestWhereabouts) ? snapshot.harvestWhereabouts.length : 0;",
  "  return `stamina ${String(snapshot.stamina)} exhausted ${String(snapshot.exhausted)} ripe ${String(ripe)}`;",
  "}",
  "",
].join("\n");

const readReal = (relative) => readFileSync(join(REPOSITORY_ROOT, ...relative.split("/")), "utf8");

/** A throwaway tree at the real relative paths, so the gate reads the product's own file names. */
async function withFixtureRoot(specs, run) {
  const root = mkdtempSync(join(tmpdir(), "snapshot-field-rendering-"));
  try {
    for (const [relativePath, contents] of Object.entries(specs)) {
      const path = join(root, ...relativePath.split("/"));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, contents);
    }
    return await run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

/** The sources this gate reads, each optionally rewritten, as one fixture tree. */
function tree({ protocol, factBrief, vocabulary, hud } = {}) {
  return {
    [SOURCES.protocol]: protocol ?? readReal(SOURCES.protocol),
    [SOURCES.factBrief]: factBrief ?? readReal(SOURCES.factBrief),
    [SOURCES.vocabulary]: vocabulary ?? readReal(SOURCES.vocabulary),
    [SOURCES.hud]: hud ?? readReal(SOURCES.hud),
  };
}

/** The tree as it would be if a player-facing surface existed: the fixture renderer that prints two wire fields. */
const treeWithAPlayerSurface = (specs = {}) => ({ ...tree(specs), [SOURCES.playerHud]: PLAYER_HUD });

/** The prose as it read before the water line existed: the call, and the function that produced it, gone. */
function withoutWaterLine(source) {
  return source
    .replace(
      / {2}const canWater = formatCarriedCanWater\(world\);\n {2}if \(canWater !== ""\) parts\.push\(canWater\);\n/u,
      "",
    )
    .replace(/function formatCarriedCanWater\(world: Snapshot\): string \{[\s\S]*?\n\}\n/u, "");
}

/**
 * The environment line without its body facts: the one call that hands `stamina` (and the `exhausted` flag beside it) to
 * the text she reads, gone. Both are still on the wire, and a player surface may print them - neither is her reading it.
 */
function withoutStaminaFact(source) {
  const before = source.split("\n").length;
  const rewritten = source.replace(
    / {4}bodyFact\(formatGameStamina\(source\.stamina, source\.exhausted, zh\)\),\n/u,
    "",
  );
  assert.equal(rewritten.split("\n").length, before - 1, "the stamina fact is one line of the environment composition");
  return rewritten;
}

const codes = (violations) => violations.map((violation) => violation.code);
const dispositionOf = (reading, field) => reading.dispositions.find((entry) => entry.field === field);

test("every wire field is in her view or carries an owner, and the reading states both other audiences", () => {
  const reading = auditSnapshotRendering({ root: REPOSITORY_ROOT });
  assert.deepEqual(codes(reading.violations), [], "the tree's own fields are all accounted for");
  assert.ok(reading.examined >= 100, `examined ${String(reading.examined)} fields, too few to be the wire's own list`);
  assert.equal(
    reading.rendered + reading.exempt,
    reading.examined,
    "each field is exactly one of rendered-to-her and exempt, so the three numbers describe one population",
  );
  // The figure that would have prevented the run: the can's own water, rendered by the prose composer.
  const can = dispositionOf(reading, "wateringCanFacts");
  assert.equal(can?.renderedBy, SOURCES.factBrief, "wateringCanFacts is rendered by the composer she reads");
  assert.equal(can?.renderedTo, "model", "and the report says the audience is hers");
  // Every exemption names its owner and its reason, which is what makes it a debt rather than a silence.
  for (const field of Object.keys(RENDERING_EXEMPTIONS)) {
    const entry = RENDERING_EXEMPTIONS[field];
    assert.ok(typeof entry.owedBy === "string" && entry.owedBy.trim() !== "", `${field}: an exemption needs an owner`);
    assert.ok(typeof entry.reason === "string" && entry.reason.trim() !== "", `${field}: an exemption needs a reason`);
  }
  // THE AUDIENCE THIS UNIT ADDED: the HUD block's fields are printed and reach NOBODY, so they clear nothing. The
  // disposition says so per field, which is what the exemption's prose used to claim without a check.
  const ripe = dispositionOf(reading, "harvestWhereabouts");
  assert.equal(ripe?.renderedBy, null, "harvestWhereabouts is not in the text she reads");
  assert.equal(ripe?.renderedTo, "neither", "and the report does not pretend the HUD block is an audience of hers");
  assert.equal(ripe?.printedBy, SOURCES.hud, "it names the module that prints it");
  assert.equal(ripe?.printedTo, "unread", "and where that module's text goes");
  // Nothing in the tree prints a wire key on the player's own surface: `dialogue-web`'s Game panel reads
  // `game_browser_api/v1` (connection, instance, compatibility, capabilities, outcome), not a `Snapshot`. The zero is
  // measured and reported rather than assumed, so the day a player surface prints one, this line changes.
  assert.equal(reading.printedToThePlayer, 0, "no player-audience renderer prints a wire field today");
  assert.ok(
    reading.printedToNoReader >= 2,
    `printed into text with no reader ${String(reading.printedToNoReader)}, too few to include the exempted fields`,
  );
  process.stdout.write(
    `snapshot_field_rendering examined ${String(reading.examined)} · in her view ${String(reading.rendered)} · ` +
      `exempt ${String(reading.exempt)} · for the player ${String(reading.printedToThePlayer)} · ` +
      `for no reader ${String(reading.printedToNoReader)}\n`,
  );
});

test("a field the prose stops rendering is named, so a published fact cannot go quiet again", async () => {
  const reading = await withFixtureRoot(tree({ factBrief: withoutWaterLine(readReal(SOURCES.factBrief)) }), (root) =>
    auditSnapshotRendering({ root }),
  );
  assert.deepEqual(
    codes(reading.violations),
    ["fact_not_visible_to_the_companion:wateringCanFacts"],
    "exactly the field the prose stopped rendering, named",
  );
  assert.equal(reading.status, "failed");
});

test("a fact printed only for the player is named, because the player's surface is not her view", async () => {
  const reading = await withFixtureRoot(
    treeWithAPlayerSurface({ vocabulary: withoutStaminaFact(readReal(SOURCES.vocabulary)) }),
    (root) => auditSnapshotRendering({ root, renderers: [...RENDERER_SOURCES, PLAYER_HUD_RENDERER] }),
  );
  assert.deepEqual(
    codes(reading.violations),
    ["fact_not_visible_to_the_companion:stamina", "fact_not_visible_to_the_companion:exhausted"],
    "the two fields the player's panel prints and the companion's text does not",
  );
  assert.equal(dispositionOf(reading, "stamina")?.renderedTo, "player", "the report names the audience that got it");
  assert.equal(dispositionOf(reading, "stamina")?.printedBy, SOURCES.playerHud, "and the surface that printed it");
});

test("a player_only declaration must say why, and the player surface must really print the field", async () => {
  const declared = { reason: "the player's panel shows it", owedBy: "host/src/fact-brief.ts", player_only: " " };
  const blank = await withFixtureRoot(treeWithAPlayerSurface(), (root) =>
    auditSnapshotRendering({
      root,
      renderers: [...RENDERER_SOURCES, PLAYER_HUD_RENDERER],
      exemptions: { ...RENDERING_EXEMPTIONS, harvestWhereabouts: declared },
    }),
  );
  assert.deepEqual(
    codes(blank.violations),
    ["player_only_without_reason:harvestWhereabouts"],
    "a declaration with no reason is the defect it was meant to document",
  );

  const unbacked = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: {
        ...RENDERING_EXEMPTIONS,
        harvestWhereabouts: { ...declared, player_only: "the player's panel counts the ripe crops; she walks to them" },
      },
    }),
  );
  assert.deepEqual(
    codes(unbacked.violations),
    ["player_only_without_a_player_renderer:harvestWhereabouts"],
    "no player-audience renderer prints it, so 'the player has it' is a claim nothing holds",
  );

  // The declaration holds only where BOTH are true: a written reason, and a player surface that prints the field.
  const backed = await withFixtureRoot(treeWithAPlayerSurface(), (root) =>
    auditSnapshotRendering({
      root,
      renderers: [...RENDERER_SOURCES, PLAYER_HUD_RENDERER],
      exemptions: {
        ...RENDERING_EXEMPTIONS,
        harvestWhereabouts: {
          ...declared,
          player_only:
            "the player's panel counts the ripe crops in words; she walks to them, so the number she needs is the one " +
            "beside the tiles she can reach",
        },
      },
    }),
  );
  assert.deepEqual(codes(backed.violations), [], "a reason and a real player rendering make the declaration hold");
});

test("the HUD block printing a field is not the companion reading it", async () => {
  // The HUD still prints `harvestWhereabouts`, and the field is still exempt - but the exemption no longer rests on the
  // HUD. Deleting every trace of the module from the tree changes nothing about her view, and that is the point.
  const reading = await withFixtureRoot(tree({ hud: "/** a HUD that prints nothing */\nexport {};\n" }), (root) =>
    auditSnapshotRendering({ root }),
  );
  const ripe = dispositionOf(reading, "harvestWhereabouts");
  assert.equal(ripe?.renderedTo, "neither");
  assert.equal(ripe?.printedBy, null, "no module prints it now");
  assert.deepEqual(codes(reading.violations), [], "and the exemption is what holds the field, not a rendering claim");
});

test("a field the wire grows is named on the day it arrives, with no edit here", async () => {
  const protocol = readReal(SOURCES.protocol).replace(
    "export const SNAPSHOT_KEYS = [",
    'export const SNAPSHOT_KEYS = [\n  "brandNewFamily",',
  );
  const reading = await withFixtureRoot(tree({ protocol }), (root) => auditSnapshotRendering({ root }));
  assert.deepEqual(codes(reading.violations), ["fact_not_visible_to_the_companion:brandNewFamily"]);
});

test("an exemption expires both ways: rendered now, or no longer published", async () => {
  const rendered = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: { ...RENDERING_EXEMPTIONS, stamina: RENDERING_EXEMPTIONS.harvestWhereabouts },
    }),
  );
  assert.deepEqual(
    codes(rendered.violations),
    ["stale_rendering_exemption:stamina"],
    "a field she reads needs no exemption",
  );
  const gone = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: { ...RENDERING_EXEMPTIONS, retiredField: RENDERING_EXEMPTIONS.harvestWhereabouts },
    }),
  );
  assert.deepEqual(
    codes(gone.violations),
    ["stale_rendering_exemption:retiredField"],
    "an exemption for a field the wire dropped exempts nothing",
  );
});

test("an exemption with nobody's name on it is a fact quietly left out", async () => {
  const reading = await withFixtureRoot(tree(), (root) =>
    auditSnapshotRendering({
      root,
      exemptions: { ...RENDERING_EXEMPTIONS, catalogRevision: { reason: "someone looked", owedBy: " " } },
    }),
  );
  assert.deepEqual(
    codes(reading.violations),
    ["exemption_without_owner:catalogRevision"],
    "the exemption is not accepted on a blank owner",
  );
});

test("a mention inside a comment is not a rendering", async () => {
  const commented = tree({
    factBrief: `${withoutWaterLine(readReal(SOURCES.factBrief))}\n// wateringCanFacts: the can's water is rendered elsewhere\n`,
  });
  const reading = await withFixtureRoot(commented, (root) => auditSnapshotRendering({ root }));
  assert.deepEqual(
    codes(reading.violations),
    ["fact_not_visible_to_the_companion:wateringCanFacts"],
    "the gate reads code, not its own documentation",
  );
});

test("a wire list with no keys is blocked, not green", async () => {
  const protocol = readReal(SOURCES.protocol).replace(
    /export const SNAPSHOT_KEYS = \[[\s\S]*?\] as const;/u,
    "export const SNAPSHOT_KEYS = [] as const;",
  );
  const reading = await withFixtureRoot(tree({ protocol }), (root) => auditSnapshotRendering({ root }));
  assert.equal(reading.status, "blocked", "an unreadable population cannot pass");
  assert.equal(reading.examined, 0);

  await withFixtureRoot(tree({ protocol }), (root) => {
    const result = spawnSync(process.execPath, [GATE, "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 2, `the CLI exits 2 on no population, printed: ${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /no snapshot field was examined/u);
    return null;
  });
});
