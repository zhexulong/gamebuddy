import assert from "node:assert/strict";
import test from "node:test";
import {
  PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA,
  PlayerMemoryNextRoundEvidenceCoordinator,
} from "./player-memory-next-round-evidence.js";

const nonce = "a".repeat(64);
function marker(correlation: string, overrides: Record<string, unknown> = {}): unknown {
  return {
    schema: PLAYER_MEMORY_NEXT_ROUND_MARKER_SCHEMA,
    sessionId: "pi_chat",
    nonceSha256: nonce,
    surface: "chat",
    operationCorrelation: correlation,
    committedMemoryMutationId: 7,
    materializedM1MaxMemoryMutationId: 7,
    providerRoundGeneration: 1,
    covered: true,
    oneShot: true,
    ...overrides,
  };
}

test("evidence coordinator generates opaque correlations and rejects a second mutation before source admission", () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const evidence = coordinator.beginMutation();
  assert.match(evidence.operationCorrelation, /^[A-Za-z0-9_-]{43}$/);
  assert.throws(() => coordinator.beginMutation(), { message: "memory_next_round_evidence_pending" });
  coordinator.rejectMutation(new Error("failed"));
});

test("active Chat rejects mutation before correlation mint/source admission", () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  assert.throws(() => coordinator.beginMutation(() => true), { message: "memory_next_round_evidence_chat_active" });
  // A subsequent idle attempt is the first mint/admission and remains valid.
  assert.match(coordinator.beginMutation(() => false).operationCorrelation, /^[A-Za-z0-9_-]{43}$/);
});

test("message admission deterministically waits for commit activation", async () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const evidence = coordinator.beginMutation();
  let admitted = false;
  const wait = coordinator.admitMessage().then(() => {
    admitted = true;
  });
  await Promise.resolve();
  assert.equal(admitted, false);
  coordinator.commitMutation({ operationCorrelation: evidence.operationCorrelation, committedMemoryMutationId: 7 });
  await wait;
  assert.equal(admitted, true);
});

test("source callback clears the pending receipt and permits a later independent mutation", () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const first = coordinator.beginMutation();
  coordinator.commitMutation({ operationCorrelation: first.operationCorrelation, committedMemoryMutationId: 7 });
  const onSourceMarker = (sourceMarker: unknown): void => {
    coordinator.collectMarker(sourceMarker);
  };
  onSourceMarker(marker(first.operationCorrelation));
  assert.match(coordinator.beginMutation().operationCorrelation, /^[A-Za-z0-9_-]{43}$/);
});

test("collector fails closed for wrong and replayed markers and close rejects an admitted wait", async () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const evidence = coordinator.beginMutation();
  coordinator.commitMutation({ operationCorrelation: evidence.operationCorrelation, committedMemoryMutationId: 7 });
  assert.equal(
    coordinator.collectMarker(marker(evidence.operationCorrelation, { nonceSha256: "b".repeat(64) })),
    false,
  );
  assert.equal(coordinator.collectMarker(marker(evidence.operationCorrelation)), true);
  assert.equal(coordinator.collectMarker(marker(evidence.operationCorrelation)), false);
  const closing = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  closing.beginMutation();
  const wait = closing.admitMessage();
  closing.close();
  await assert.rejects(wait, { message: "memory_next_round_evidence_closed" });
});

test("close race locks both mutation and prompt admission paths", async () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const evidence = coordinator.beginMutation();
  const waitingPrompt = coordinator.admitPrompt();
  coordinator.close();
  await assert.rejects(waitingPrompt, { message: "memory_next_round_evidence_closed" });
  assert.throws(() => coordinator.beginMutation(), { message: "memory_next_round_evidence_closed" });
  assert.throws(
    () =>
      coordinator.commitMutation({ operationCorrelation: evidence.operationCorrelation, committedMemoryMutationId: 7 }),
    { message: "memory_next_round_evidence_admission_invalid" },
  );
});

test("collector accepts source-owned coverage independently of the aggregate cursor", () => {
  const lowerCursor = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const first = lowerCursor.beginMutation();
  lowerCursor.commitMutation({ operationCorrelation: first.operationCorrelation, committedMemoryMutationId: 7 });
  // Exact selected-entry provenance can cover the commit after trimming leaves
  // an aggregate materialized cursor below it.
  assert.equal(
    lowerCursor.collectMarker(
      marker(first.operationCorrelation, {
        materializedM1MaxMemoryMutationId: 6,
        covered: true,
      }),
    ),
    true,
  );

  const higherCursor = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const second = higherCursor.beginMutation();
  higherCursor.commitMutation({ operationCorrelation: second.operationCorrelation, committedMemoryMutationId: 7 });
  // A cached/higher cursor does not prove the exact selected entry was covered.
  // Source coverage remains mandatory even though the Host does not derive it
  // from the aggregate cursor.
  assert.equal(
    higherCursor.collectMarker(
      marker(second.operationCorrelation, {
        materializedM1MaxMemoryMutationId: 8,
        covered: false,
      }),
    ),
    false,
  );
  assert.equal(
    higherCursor.collectMarker(
      marker(second.operationCorrelation, {
        materializedM1MaxMemoryMutationId: 8,
        covered: true,
      }),
    ),
    true,
  );
});

test("collector rejects stale provider rounds without clearing a pending expectation", () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const first = coordinator.beginMutation();
  coordinator.commitMutation({ operationCorrelation: first.operationCorrelation, committedMemoryMutationId: 7 });
  assert.equal(coordinator.collectMarker(marker(first.operationCorrelation, { providerRoundGeneration: 2 })), true);
  const second = coordinator.beginMutation();
  coordinator.commitMutation({ operationCorrelation: second.operationCorrelation, committedMemoryMutationId: 8 });
  assert.equal(
    coordinator.collectMarker(
      marker(second.operationCorrelation, {
        committedMemoryMutationId: 8,
        materializedM1MaxMemoryMutationId: 8,
        providerRoundGeneration: 2,
      }),
    ),
    false,
  );
  assert.equal(
    coordinator.collectMarker(
      marker(second.operationCorrelation, {
        committedMemoryMutationId: 8,
        materializedM1MaxMemoryMutationId: 8,
        providerRoundGeneration: 3,
      }),
    ),
    true,
  );
});

test("collector accepts metadata-only marker schema and rejects content-bearing payloads", () => {
  const coordinator = new PlayerMemoryNextRoundEvidenceCoordinator({ sessionId: "pi_chat", nonceSha256: nonce });
  const evidence = coordinator.beginMutation();
  coordinator.commitMutation({ operationCorrelation: evidence.operationCorrelation, committedMemoryMutationId: 7 });
  assert.equal(coordinator.collectMarker(marker(evidence.operationCorrelation, { prompt: "secret" })), false);
});
