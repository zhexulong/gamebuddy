import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { resolveRuntimePaths } from "../runtime.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { TavernArtifactStore } from "./artifact-store.js";
import { createChatThreadStore } from "./chat-thread-store.js";
import { provisionNewCompanion } from "./new-companion-service.js";
import { readCompanionPostHistoryInstructions } from "./post-history-instructions.js";
import { StCardImportService } from "./st-card-import-service.js";
import { resolveTavernPaths } from "./tavern-paths.js";

test.before(async () => {
  bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());
});

test.after(() => {
  bindWindowsStaleLockReclaimer(undefined);
});

const identity = {
  playerId: "player-post-history",
  companionId: "companion-post-history",
  continuityId: "continuity-post-history",
};

/**
 * The card's own closing direction, as the companion's own record.
 *
 * `post_history_instructions` is the one piece of card prose the ST format places
 * AFTER the history, so it belongs neither in her profile (the cached prefix) nor
 * in the import's discarded remainder: it lives beside her scenario and her
 * openings, verbatim and bounded, and where it is read is a later decision. These
 * tests hold the import half up on the product's own functions - the shipped
 * card, a fixture card, and a card that declares nothing - and assert the exact
 * text, because a decoder that re-wrapped or macro-rendered it would store a
 * directive no author wrote.
 */
test("a card's post_history_instructions reaches the companion's own record byte-for-byte", async () => {
  const root = await canonicalTestRoot("tavern-post-history-");
  const shippedCardText = await readFile(shippedCardPath(), "utf8");
  const shipped = (JSON.parse(shippedCardText) as { data: { post_history_instructions?: string } }).data
    .post_history_instructions;
  assert.ok(
    typeof shipped === "string" && shipped.length > 0,
    "the shipped card must carry the field this test is about",
  );
  // The fixture keeps a `{{user}}` macro, a blank line and CRLF: all three are the
  // author's text, and nothing on this path may rewrite any of them.
  const fixture = "收束前先看一眼{{user}}手上的活，再留一句家常话，不要总结。\r\n第二行保持原样。";
  const cases: Readonly<{ importId: string; cardText: string; expected: string; label: string }>[] = [
    { importId: "shipped", cardText: shippedCardText, expected: shipped, label: "the shipped card" },
    {
      importId: "fixture",
      cardText: JSON.stringify({
        spec: "chara_card_v3",
        data: { name: "Closing Rae", description: "calm", post_history_instructions: fixture },
      }),
      expected: fixture,
      label: "a fixture card",
    },
  ];
  try {
    for (const testCase of cases) {
      const store = new TavernArtifactStore(root);
      const service = new StCardImportService(store, resolveTavernPaths({ root } as never, identity));
      const staged = await service.import(`post_history_${testCase.importId}`, testCase.cardText);
      // It is not a reviewed profile field: nothing of hers is derived from it, so
      // the list the player approves does not grow.
      assert.equal(
        staged.candidate.artifact.fields.some((field) => field.field === "post_history_instructions"),
        false,
        `${testCase.label} must not offer the closing direction as a reviewable profile field`,
      );
      const eligible = staged.candidate.artifact.fields
        .filter((field) => field.eligibility === "profile_eligible_after_explicit_review")
        .map((field) => field.field);
      await service.recordReview(`post_history_${testCase.importId}`, { reviewedFields: eligible, approvedAtMs: 1 });
      const threads = createChatThreadStore(root, `post-history-${testCase.importId}`);
      try {
        const provisioned = await provisionNewCompanion(
          root,
          identity.playerId,
          staged.candidate.artifact,
          await service.confirmedReview(`post_history_${testCase.importId}`),
          threads,
        );
        const companionRoot = resolveTavernPaths(
          resolveRuntimePaths(provisioned.identity, root),
          provisioned.identity,
        ).companionRoot;
        // The card's own text as it came off her durable record: same characters,
        // same bytes, same newlines, with the macro still standing.
        const recorded = await readCompanionPostHistoryInstructions(store, companionRoot);
        assert.equal(typeof recorded, "string", `${testCase.label} must leave a record`);
        assert.deepEqual(recorded, testCase.expected);
        assert.ok(
          Buffer.from(recorded ?? "", "utf8").equals(Buffer.from(testCase.expected, "utf8")),
          `${testCase.label}: the record must be her card's own bytes`,
        );
      } finally {
        threads.close?.();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a card that declares no post_history_instructions leaves no record, so absence stays absence", async () => {
  const root = await canonicalTestRoot("tavern-post-history-absent-");
  let threads: ReturnType<typeof createChatThreadStore> | undefined;
  try {
    const store = new TavernArtifactStore(root);
    const service = new StCardImportService(store, resolveTavernPaths({ root } as never, identity));
    const staged = await service.import(
      "post_history_absent",
      JSON.stringify({ spec: "chara_card_v3", data: { name: "Plain Rae", description: "calm" } }),
    );
    await service.recordReview("post_history_absent", { reviewedFields: ["name", "persona_core"], approvedAtMs: 1 });
    threads = createChatThreadStore(root, "post-history-absent");
    const provisioned = await provisionNewCompanion(
      root,
      identity.playerId,
      staged.candidate.artifact,
      await service.confirmedReview("post_history_absent"),
      threads,
    );
    const companionRoot = resolveTavernPaths(
      resolveRuntimePaths(provisioned.identity, root),
      provisioned.identity,
    ).companionRoot;
    // `null` and no file at all: an empty string would read as a card that said
    // something, and the next reader could not tell the two facts apart.
    assert.equal(await readCompanionPostHistoryInstructions(store, companionRoot), null);
    assert.equal(existsSync(join(companionRoot, "post-history-instructions.json")), false);
  } finally {
    threads?.close?.();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

/** The repo's shipped default companion card, found from whichever root the suite started in. */
function shippedCardPath(): string {
  for (const candidate of [process.cwd(), resolve(process.cwd(), ".."), resolve(process.cwd(), "..", "..")]) {
    const path = join(candidate, "assets", "tavern", "presets", "default-companion", "card.json");
    if (existsSync(path)) return path;
  }
  throw new Error("reviewed_preset_card_not_findable");
}
