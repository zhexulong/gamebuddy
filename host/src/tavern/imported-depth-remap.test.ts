import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { decodeStCard } from "../st-card-import.js";
import { type WorldBook, validateWorldBook, worldBookMetadata } from "../worldbook.js";
import { buildGameSurfaceAuthoredCatalog } from "./catalog-service.js";

/**
 * The cache claim the at-depth remap rests on, measured on the production path rather than argued.
 *
 * An imported card's `at_depth` entries are re-placed into one of two cache-safe regions by their own
 * fields (`st-card-import.ts` `depthRemapRegion`): standing background into the stable prefix, a triggered
 * entry into the per-turn volatile selection. The claim is that this is free for prefix caching - the m[0]
 * bytes are a function of the catalogue's stable half alone, so two consecutive turns render the SAME
 * prefix, while the triggered entry rides m[1] only on the turn whose words it answers.
 *
 * The two turns below are chosen to disagree about nothing except the player's text: the same catalogue,
 * the same session, the same vendor publication. Turn 1 says nothing the card gated; turn 2 says the
 * trigger word. If the volatile half ever leaked into the prefix, the two `renderedBlock` values would
 * differ and this test would go red - which is the whole point of not inserting entries at a depth.
 *
 * m[1] membership is read from the vendor's own per-turn selection (`materializeVolatileForTurn`) and the
 * sources it binds are the ones `renderM1PiWithMetadata` renders, so no second selection rule is written here.
 */
test("an imported at-depth entry costs the prefix nothing: m[0] is byte-identical across two turns, the triggered entry rides only its own turn", async () => {
  const report = decodeStCard(
    JSON.stringify({
      spec: "chara_card_v3",
      data: {
        name: "磨坊主",
        description: "话不多。",
        character_book: {
          entries: [
            {
              comment: "常驻",
              content: "磨坊比村子还老。",
              position: "at_depth",
              depth: 4,
              role: "system",
            },
            {
              comment: "上油",
              content: "磨坊的轮子在天亮前上过油。",
              keys: ["磨坊"],
              position: "at_depth",
              depth: 2,
              role: "system",
            },
          ],
        },
      },
    }),
  );
  const entries = report.candidate?.worldBookCandidates ?? [];
  assert.equal(entries.length, 2);
  assert.equal(entries[0]?.constant, true, "the standing entry was remapped into the prefix by the import");
  assert.equal(entries[1]?.constant, undefined, "the triggered entry was not promoted into the prefix");

  const book: WorldBook = validateWorldBook({
    schemaVersion: 1,
    worldBookId: "imported-mill",
    revision: 1,
    alwaysOnPremise: "",
    entries,
  });
  const scope = Object.freeze({
    continuityId: "continuity-depth",
    sessionId: "pi-session-depth",
    surface: "game" as const,
    threadId: "thread-depth",
    profile: Object.freeze({ profileId: "profile", revision: 1, canonicalHash: "a".repeat(64) }),
  });
  const catalog = buildGameSurfaceAuthoredCatalog(scope, {
    metadata: worldBookMetadata(book),
    book,
  });
  assert.equal(catalog.stableSources.length, 1);
  assert.match(catalog.stableSources[0]!.content, /磨坊比村子还老。/u);
  assert.doesNotMatch(catalog.stableSources[0]!.content, /上过油/u, "the triggered entry is not in the prefix");
  assert.deepEqual(
    catalog.volatileSources.map((source) => source.content),
    ["磨坊的轮子在天亮前上过油。"],
    "the triggered entry is the one per-turn candidate",
  );

  const { materializeGameBuddyAuthoredStableCatalog, publishGameBuddyAuthoredStableCatalog } = await import(
    "@cortexkit/pi-magic-context/tavern"
  );
  const capability = publishGameBuddyAuthoredStableCatalog(scope, catalog);
  try {
    // Turn 1: nothing the card gated is said.
    const quietRefs = capability.materializeVolatileForTurn("depth-turn-1", "今天先做什么？", "");
    const quietPrefix = materializeGameBuddyAuthoredStableCatalog(catalog, scope).renderedBlock;
    capability.clearVolatileForTurn("depth-turn-1");
    // Turn 2: the trigger word.
    const millRefs = capability.materializeVolatileForTurn("depth-turn-2", "磨坊的轮子今天转吗？", "");
    const millPrefix = materializeGameBuddyAuthoredStableCatalog(catalog, scope).renderedBlock;

    assert.deepEqual(
      quietRefs.refs.map((ref) => ref.sourceId),
      [],
      "turn 1 binds no volatile source",
    );
    assert.deepEqual(
      millRefs.refs.map((ref) => ref.sourceId),
      catalog.volatileSources.map((source) => source.sourceId),
      "turn 2 binds the entry whose word it says",
    );
    // The prefix is what two consecutive turns pay for once. Equality is over the exact bytes.
    assert.equal(
      millPrefix,
      quietPrefix,
      "the cached prefix changed between turns; the volatile region is not outside the cache after all",
    );
    assert.equal(
      createHash("sha256").update(millPrefix, "utf8").digest("hex"),
      createHash("sha256").update(quietPrefix, "utf8").digest("hex"),
    );
    // And the difference between the turns is entirely in the per-turn block.
    const volatileContent = (sourceIds: readonly string[]): string =>
      catalog.volatileSources
        .filter((source) => sourceIds.includes(source.sourceId))
        .map((source) => source.content)
        .join("\n");
    assert.equal(volatileContent(quietRefs.refs.map((ref) => ref.sourceId)), "");
    assert.equal(volatileContent(millRefs.refs.map((ref) => ref.sourceId)), "磨坊的轮子在天亮前上过油。");
  } finally {
    await capability.clear();
  }
});
