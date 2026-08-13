import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContinuityAuthorityRoutingError,
  openContinuityAuthorityRouting,
  type RouteOperationReceipt,
  type RouteRecord,
} from "./continuity-authority-routing.js";

const principal = Object.freeze({ continuityId: "continuity_1", companionId: "companion_1", playerId: "player_1" });
const other = Object.freeze({ continuityId: "continuity_1", companionId: "companion_2", playerId: "player_1" });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const op = (operationId: string, payload: unknown = { kind: operationId }) => ({ operationId, payload });
function fixture() {
  return openContinuityAuthorityRouting(new DatabaseSync(":memory:"), { protocol: 1, schema: 1 });
}
function code(work: () => unknown, expected: string) {
  assert.throws(work, (error: unknown) => error instanceof ContinuityAuthorityRoutingError && error.code === expected);
}
function current(receipt: RouteOperationReceipt): RouteRecord {
  assert.equal(receipt.outcome, "current");
  if (receipt.outcome !== "current") throw new Error("expected current receipt");
  return receipt.route;
}

test("test-only unmounted routing initializes only an explicit exact legacy principal", () => {
  const routing = fixture();
  assert.equal(routing.readRoute(principal), null);
  const route = current(routing.initializeLegacy(principal, op("init")));
  assert.equal(route.state, "LEGACY_ACTIVE");
  assert.equal(route.activeAuthority, "LEGACY");
  assert.equal(route.authorityGeneration, 1);
  assert.equal(routing.readRoute(other), null);
  code(() => routing.beginQuiescing(other, 1, op("unknown")), "authority_generation_conflict");
  code(() => routing.initializeLegacy(principal, op("again")), "route_already_initialized");
  routing.close();
});

test("QUIESCING is strictly unroutable and legal CAS transitions permit only explicit pre-seal cancellation", () => {
  const routing = fixture();
  routing.initializeLegacy(principal, op("init"));
  const quiescing = current(routing.beginQuiescing(principal, 1, op("quiesce")));
  assert.equal(quiescing.state, "QUIESCING");
  assert.equal(quiescing.activeAuthority, null);
  const legacy = current(routing.cancelQuiescing(principal, 2, op("cancel")));
  assert.equal(legacy.authorityGeneration, 3);
  routing.beginQuiescing(principal, 3, op("quiesce-2"));
  const sealed = current(routing.sealLegacy(principal, 4, hash("seal"), op("seal")));
  assert.equal(sealed.state, "LEGACY_SEALED");
  assert.equal(sealed.activeAuthority, null);
  code(() => routing.cancelQuiescing(principal, 5, op("late-cancel")), "illegal_authority_transition");
  code(() => routing.beginQuiescing(principal, 5, op("rollback")), "illegal_authority_transition");
  code(() => routing.stageSemantic(principal, 4, hash("snapshot"), op("stale")), "authority_generation_conflict");
  routing.close();
});

test("replaying a pre-seal cancellation after resealing returns an immutable historical outcome, never current LEGACY authority", () => {
  const routing = fixture();
  routing.initializeLegacy(principal, op("init"));
  routing.beginQuiescing(principal, 1, op("quiesce"));
  const cancelled = current(routing.cancelQuiescing(principal, 2, op("cancel", { reason: "operator" })));
  routing.beginQuiescing(principal, 3, op("quiesce-2"));
  const sealed = current(routing.sealLegacy(principal, 4, hash("seal"), op("seal")));
  const replay = routing.cancelQuiescing(principal, 2, op("cancel", { reason: "operator" }));
  assert.equal(replay.outcome, "historical");
  if (replay.outcome === "historical") {
    assert.deepEqual(replay.historicalRoute, cancelled);
    assert.ok(Object.isFrozen(replay.historicalRoute));
  }
  assert.deepEqual(routing.readRoute(principal), sealed);
  code(
    () => routing.cancelQuiescing(principal, 999, op("cancel", { reason: "operator" })),
    "cutover_operation_payload_conflict",
  );
  code(
    () => routing.cancelQuiescing(principal, 2, op("cancel", { reason: "altered" })),
    "cutover_operation_payload_conflict",
  );
  routing.close();
});

test("authority generation is monotonic and active route mapping remains state-consistent", () => {
  const routing = fixture();
  routing.initializeLegacy(principal, op("init"));
  routing.beginQuiescing(principal, 1, op("q"));
  routing.sealLegacy(principal, 2, hash("seal"), op("seal"));
  routing.stageSemantic(principal, 3, hash("snapshot"), op("stage"));
  const active = current(
    routing.activateSemantic(
      principal,
      4,
      {
        snapshotHash: hash("snapshot"),
        sealManifestHash: hash("seal"),
        projectionHash: hash("projection"),
        readbackHash: hash("projection"),
      },
      op("activate"),
    ),
  );
  assert.deepEqual(
    [active.state, active.activeAuthority, active.authorityGeneration],
    ["SEMANTIC_ACTIVE", "SEMANTIC", 5],
  );
  const quarantined = current(routing.quarantine(principal, 5, op("quarantine")));
  assert.deepEqual(
    [quarantined.state, quarantined.activeAuthority, quarantined.authorityGeneration],
    ["QUARANTINED", null, 6],
  );
  routing.close();
});

test("operation identity canonically binds kind, exact principal, generation, transition inputs, and payload", () => {
  const routing = fixture();
  const first = current(routing.initializeLegacy(principal, op("init", { b: 2, a: 1 })));
  const replay = routing.initializeLegacy(principal, op("init", { a: 1, b: 2 }));
  assert.equal(replay.outcome, "historical");
  code(() => routing.initializeLegacy(principal, op("init", { a: 2, b: 2 })), "cutover_operation_payload_conflict");
  routing.beginQuiescing(principal, 1, op("q"));
  current(routing.sealLegacy(principal, 2, hash("seal-a"), op("seal")));
  code(() => routing.sealLegacy(principal, 2, hash("seal-b"), op("seal")), "cutover_operation_payload_conflict");
  assert.equal(first.state, "LEGACY_ACTIVE");
  routing.close();
});

test("reopen preserves route and emits a historical immutable operation receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "continuity-authority-routing-"));
  const path = join(root, "routing.sqlite");
  try {
    const first = openContinuityAuthorityRouting(new DatabaseSync(path), { protocol: 1, schema: 1 });
    const initial = current(first.initializeLegacy(principal, op("init")));
    first.close();
    const reopened = openContinuityAuthorityRouting(new DatabaseSync(path), { protocol: 1, schema: 1 });
    assert.deepEqual(reopened.readRoute(principal), initial);
    const replay = reopened.initializeLegacy(principal, op("init"));
    assert.equal(replay.outcome, "historical");
    if (replay.outcome === "historical") assert.deepEqual(replay.historicalRoute, initial);
    reopened.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("semantic activation requires matching staged snapshot, seal manifest, and projection/readback evidence without legacy fallback", () => {
  const routing = fixture();
  routing.initializeLegacy(principal, op("init"));
  routing.beginQuiescing(principal, 1, op("q"));
  routing.sealLegacy(principal, 2, hash("seal"), op("seal"));
  routing.stageSemantic(principal, 3, hash("snapshot"), op("stage"));
  code(
    () =>
      routing.activateSemantic(
        principal,
        4,
        {
          snapshotHash: hash("wrong"),
          sealManifestHash: hash("seal"),
          projectionHash: hash("p"),
          readbackHash: hash("p"),
        },
        op("bad-snapshot"),
      ),
    "semantic_activation_evidence_mismatch",
  );
  code(
    () =>
      routing.activateSemantic(
        principal,
        4,
        {
          snapshotHash: hash("snapshot"),
          sealManifestHash: hash("seal"),
          projectionHash: hash("p"),
          readbackHash: hash("readback"),
        },
        op("bad-readback"),
      ),
    "semantic_activation_evidence_mismatch",
  );
  const active = current(
    routing.activateSemantic(
      principal,
      4,
      {
        snapshotHash: hash("snapshot"),
        sealManifestHash: hash("seal"),
        projectionHash: hash("p"),
        readbackHash: hash("p"),
      },
      op("activate"),
    ),
  );
  assert.equal(active.activeAuthority, "SEMANTIC");
  routing.close();
});

test("protocol/schema mismatch and malformed persisted state fail closed", () => {
  const db = new DatabaseSync(":memory:");
  code(() => openContinuityAuthorityRouting(db, { protocol: 2, schema: 1 }), "protocol_schema_mismatch");
  const routing = openContinuityAuthorityRouting(db, { protocol: 1, schema: 1 });
  routing.initializeLegacy(principal, op("init"));
  assert.throws(() =>
    db.prepare("UPDATE authority_route SET state='BROKEN' WHERE continuity_id=?").run(principal.continuityId),
  );
  assert.throws(() =>
    db.prepare("UPDATE authority_route SET authority_generation=0 WHERE continuity_id=?").run(principal.continuityId),
  );
  routing.close();
});
