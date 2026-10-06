import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createStCardImportHistoryService, type StCardImportDispositionClass } from "./st-card-import-history.js";
import { validateTavernArtifact } from "./types.js";
import { resolveTavernPaths } from "./tavern-paths.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const identity = { playerId: "player-history", companionId: "companion-history", continuityId: "continuity-history" };

function dispositions(...classes: readonly StCardImportDispositionClass[]) {
  return classes.map((classification) => Object.freeze({ classification }));
}

test("a confirmed import leaves one durable loss report counting fields by disposition class", async () => {
  const root = await canonicalTestRoot("tavern-import-history-");
  const paths = resolveTavernPaths({ root } as never, identity);
  const store = new TavernArtifactStore(root);
  const history = createStCardImportHistoryService(store, paths.playerRoot);

  const recorded = await history.record({
    importId: "import_history_01",
    occurredAtMs: 1_700_000_000_000,
    cardName: "Safe Rin",
    companionId: "companion-created-01",
    dispositions: dispositions("accepted_typed", "accepted_typed", "preserved_opaque", "dropped_unsupported"),
  });

  assert.deepEqual(recorded, {
    importId: "import_history_01",
    occurredAtMs: 1_700_000_000_000,
    cardName: "Safe Rin",
    companionId: "companion-created-01",
    counts: { accepted_typed: 2, preserved_opaque: 1, dropped_unsupported: 1, rejected_invalid: 0 },
  });

  // The listing is the same durable record read back through the store, so a
  // fresh service (a reload) sees exactly what the confirm wrote.
  const reloaded = createStCardImportHistoryService(new TavernArtifactStore(root), paths.playerRoot);
  assert.deepEqual(await reloaded.list(), [recorded]);

  // The evidence file carries the name, the identifiers and the counts only:
  // no card body text ever reaches it.
  const raw = await readFile(join(paths.playerRoot, "import-history", "import_history_01", "history.json"), "utf8");
  assert.equal(raw.includes("accepted_typed"), true);
  assert.equal(raw.includes("anything the card body said"), false);
});

test("import history is append-only and ordered newest first", async () => {
  const root = await canonicalTestRoot("tavern-import-history-order-");
  const paths = resolveTavernPaths({ root } as never, identity);
  const store = new TavernArtifactStore(root);
  const history = createStCardImportHistoryService(store, paths.playerRoot);

  // An absent history root is an empty history, not an unreadable one.
  assert.deepEqual(await history.list(), []);

  for (const [importId, occurredAtMs] of [
    ["import_history_older", 1_700_000_000_000],
    ["import_history_newer", 1_700_000_500_000],
  ] as const)
    await history.record({
      importId,
      occurredAtMs,
      cardName: `Card ${importId}`,
      companionId: `companion-${importId}`,
      dispositions: dispositions("accepted_typed"),
    });

  assert.deepEqual(
    (await history.list()).map((entry) => entry.importId),
    ["import_history_newer", "import_history_older"],
  );

  // A second record for the same import is a revision conflict: the leaf is
  // written once and only once.
  await assert.rejects(
    history.record({
      importId: "import_history_newer",
      occurredAtMs: 1_700_000_900_000,
      cardName: "Card import_history_newer",
      companionId: "companion-import_history_newer",
      dispositions: dispositions("accepted_typed"),
    }),
    /tavern_revision_conflict/u,
  );
  assert.equal((await history.list()).length, 2);
});

test("import history is scoped to the player root it was written under", async () => {
  const root = await canonicalTestRoot("tavern-import-history-invalid-");
  const paths = resolveTavernPaths({ root } as never, identity);
  const store = new TavernArtifactStore(root);
  const history = createStCardImportHistoryService(store, paths.playerRoot);
  await history.record({
    importId: "import_history_scoped",
    occurredAtMs: 1,
    cardName: "Safe Rin",
    companionId: "companion-scoped",
    dispositions: dispositions("accepted_typed"),
  });

  // The history is scoped to the player root it was created under: another
  // player's root never observes it.
  const otherPaths = resolveTavernPaths({ root } as never, { ...identity, playerId: "player-other" });
  assert.deepEqual(await createStCardImportHistoryService(store, otherPaths.playerRoot).list(), []);
});

test("the durable history artifact is exactly name, identifiers and per-class counts", () => {
  const canonical = {
    schemaVersion: 1,
    revision: 1,
    importId: "import_history_01",
    occurredAtMs: 1_700_000_000_000,
    cardName: "Safe Rin",
    companionId: "companion-created-01",
    counts: { accepted_typed: 2, preserved_opaque: 0, dropped_unsupported: 1, rejected_invalid: 0 },
  } as const;
  assert.deepEqual(validateTavernArtifact(canonical), canonical);
  // A card body, a raw field value or a partial class count is not a history
  // record: the loss report can never grow into a copy of the card.
  for (const invalid of [
    { ...canonical, body: "anything the card body said" },
    { ...canonical, counts: { ...canonical.counts, accepted_typed: -1 } },
    { ...canonical, counts: { accepted_typed: 2, preserved_opaque: 0, dropped_unsupported: 1 } },
    { ...canonical, cardName: "" },
    { ...canonical, companionId: "companion with spaces" },
  ])
    assert.throws(() => validateTavernArtifact(invalid), /invalid_tavern_artifact/u);
});
