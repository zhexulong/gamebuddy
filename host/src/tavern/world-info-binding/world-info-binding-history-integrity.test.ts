import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import test from "node:test";
import { canonicalHash } from "../artifact-store.js";
import type { AcceptedTurnAuthoredContextPlan } from "../chat-thread-store.js";
import type { PublicWorldInfoProjection, WorldInfoManagementRepository } from "../world-info-management/world-info-management.js";
import { verifyManagedWorldInfoHistoryIntegrity } from "./world-info-binding-history-integrity.js";

const projection: PublicWorldInfoProjection = Object.freeze({
  revision: 2,
  publicTitle: "Pelican Town",
  summary: "The revised town facts.",
  entries: Object.freeze([{ scope: "setting" as const, publicTitle: "Square", summary: "The town center." }]),
});

function sourceId(publicTitle: string, revision: number, hash: string): string {
  return `managed_world_info_${createHash("sha256")
    .update(`${publicTitle}\u001f${revision}\u001f${hash}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function repository(history: readonly PublicWorldInfoProjection[]): WorldInfoManagementRepository {
  return Object.freeze({
    async create() { throw new Error("not_used"); },
    async list() { return Object.freeze(history); },
    async detail() { return null; },
    async update() { throw new Error("not_used"); },
    async history() { return Object.freeze(history); },
    validateCreateRequest() { throw new Error("not_used"); },
  });
}

function planFor(hash: string): Pick<AcceptedTurnAuthoredContextPlan, "stableSources"> {
  return {
    stableSources: Object.freeze([
      Object.freeze({
        sourceId: sourceId("Pelican Town", 2, hash),
        kind: "lorebook_constant" as const,
        revision: "2",
        canonicalHash: hash,
        totalOrderKey: "0001",
      }),
    ]),
  };
}

test("detached verifier validates opaque managed source against exact retained revision and never imports bridge", async () => {
  const hash = canonicalHash({
    revision: projection.revision,
    publicTitle: projection.publicTitle,
    summary: projection.summary,
    entries: projection.entries,
  });
  const result = await verifyManagedWorldInfoHistoryIntegrity(planFor(hash), repository([projection]));
  assert.deepEqual(result, {
    intact: true,
    facts: [{ sourceId: sourceId("Pelican Town", 2, hash), revision: "2", canonicalHash: hash, present: true, hashMatches: true }],
  });

  let source: string;
  try {
    source = await readFile(new URL("./world-info-binding-history-integrity.ts", import.meta.url), "utf8");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    source = await readFile(
      new URL("../../../src/tavern/world-info-binding/world-info-binding-history-integrity.ts", import.meta.url),
      "utf8",
    );
  }
  assert.doesNotMatch(source, /authored-context-bridge|publishGameBuddy|assertInstall/);
});

test("detached verifier reports missing and tampered retained history without installing anything", async () => {
  const hash = canonicalHash({
    revision: projection.revision,
    publicTitle: projection.publicTitle,
    summary: projection.summary,
    entries: projection.entries,
  });
  const missing = await verifyManagedWorldInfoHistoryIntegrity(planFor(hash), repository([]));
  assert.equal(missing.intact, false);
  assert.equal(missing.facts[0]?.present, false);

  const tampered = Object.freeze({ ...projection, summary: "Tampered town facts." });
  const mismatch = await verifyManagedWorldInfoHistoryIntegrity(planFor(hash), repository([tampered]));
  assert.equal(mismatch.intact, false);
  assert.deepEqual(mismatch.facts[0], {
    sourceId: sourceId("Pelican Town", 2, hash),
    revision: "2",
    canonicalHash: hash,
    present: true,
    hashMatches: false,
  });
});

test("detached verifier fails closed on forged sourceId, stale revision, and tampered canonicalHash", async () => {
  const hash = canonicalHash({
    revision: projection.revision,
    publicTitle: projection.publicTitle,
    summary: projection.summary,
    entries: projection.entries,
  });
  // A forged sourceId that names the right title/revision/hash inputs but a
  // different opaque id resolves no history and reports absent.
  const forged = await verifyManagedWorldInfoHistoryIntegrity(
    {
      stableSources: Object.freeze([
        Object.freeze({
          sourceId: sourceId("Stardew Valley", 2, hash),
          kind: "lorebook_constant" as const,
          revision: "2",
          canonicalHash: hash,
          totalOrderKey: "0001",
        }),
      ]),
    },
    repository([projection]),
  );
  assert.equal(forged.intact, false);
  assert.equal(forged.facts[0]?.present, false);

  // A stale revision that no longer exists in retained history reports absent.
  const stale = await verifyManagedWorldInfoHistoryIntegrity(
    {
      stableSources: Object.freeze([
        Object.freeze({
          sourceId: sourceId("Pelican Town", 1, hash),
          kind: "lorebook_constant" as const,
          revision: "1",
          canonicalHash: hash,
          totalOrderKey: "0001",
        }),
      ]),
    },
    repository([projection]),
  );
  assert.equal(stale.intact, false);
  assert.equal(stale.facts[0]?.present, false);

  // A tampered canonicalHash resolves the same revision snapshot but no
  // longer binds it: the source is present, the derived hash mismatches, and
  // the verifier fails closed on intact.
  const wrongHash = await verifyManagedWorldInfoHistoryIntegrity(
    {
      stableSources: Object.freeze([
        Object.freeze({
          sourceId: sourceId("Pelican Town", 2, "f".repeat(64)),
          kind: "lorebook_constant" as const,
          revision: "2",
          canonicalHash: "f".repeat(64),
          totalOrderKey: "0001",
        }),
      ]),
    },
    repository([projection]),
  );
  assert.equal(wrongHash.intact, false);
  assert.deepEqual(wrongHash.facts[0], {
    sourceId: sourceId("Pelican Town", 2, "f".repeat(64)),
    revision: "2",
    canonicalHash: "f".repeat(64),
    present: true,
    hashMatches: false,
  });
});
