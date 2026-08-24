import test from "node:test";
import assert from "node:assert/strict";
import { fc } from "./test-support/fast-check.js";
import {
  type ExecutionRequestDto,
  type ExecutionReceiptDto,
  EXECUTION_STATE_DTOS,
  EXECUTION_ACTION_DTOS,
  serializeExecutionRequest,
  deserializeExecutionRequest,
  serializeExecutionReceipt,
  deserializeExecutionReceipt,
} from "./protocol.generated.js";

test("Functorial Naturality Invariant: ExecutionRequest JSON roundtrip preserves exact identity", () => {
  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: 0, max: 1000000 }),
        deadlineMs: fc.integer({ min: 1000, max: 10000000 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      (request: ExecutionRequestDto) => {
        const json = serializeExecutionRequest(request);
        const deserialized = deserializeExecutionRequest(json);
        assert.deepEqual(deserialized, request);
      },
    ),
    { numRuns: 100 },
  );
});

test("Functorial Naturality Invariant: ExecutionReceipt JSON roundtrip preserves all 12 production states and null evidence", () => {
  fc.assert(
    fc.property(
      fc.record({
        executionId: fc.string({ minLength: 1, maxLength: 36 }),
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        state: fc.constantFrom(...EXECUTION_STATE_DTOS),
        reasonCode: fc.string({ minLength: 1, maxLength: 128 }),
        revision: fc.integer({ min: 0, max: 1000000 }),
        evidence: fc.oneof(
          fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
          fc.constant(null),
        ),
      }),
      (receipt: ExecutionReceiptDto) => {
        const json = serializeExecutionReceipt(receipt);
        const deserialized = deserializeExecutionReceipt(json);
        assert.deepEqual(deserialized, receipt);
      },
    ),
    { numRuns: 100 },
  );
});

test("Negative Fuzzing PBT: Malformed execution request payloads fail-closed", () => {
  const requiredKeys = ["requestId", "idempotencyKey", "action", "expectedRevision", "deadlineMs", "args"] as const;

  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: 0, max: 1000000 }),
        deadlineMs: fc.integer({ min: 1000, max: 10000000 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      fc.constantFrom(...requiredKeys),
      (validReq, keyToOmit) => {
        const mutated = { ...validReq };
        delete (mutated as any)[keyToOmit];
        assert.throws(() => deserializeExecutionRequest(JSON.stringify(mutated)));
      },
    ),
    { numRuns: 100 },
  );
});

test("Negative Fuzzing PBT: Unregistered or invalid action names fail-closed", () => {
  const invalidReq = {
    requestId: "req_1",
    idempotencyKey: "idem_1",
    action: "invalid_unregistered_action",
    expectedRevision: 1,
    deadlineMs: 5000,
    args: {},
  };
  assert.throws(
    () => deserializeExecutionRequest(JSON.stringify(invalidReq)),
    /invalid_action:invalid_unregistered_action/,
  );
});

test("Negative Fuzzing PBT: ExecutionReceipt missing evidence key fails closed", () => {
  const validReceipt: ExecutionReceiptDto = {
    executionId: "exec_1",
    requestId: "req_1",
    state: "succeeded",
    reasonCode: "ok",
    revision: 1,
    evidence: null,
  };

  const withoutEvidence = { ...validReceipt };
  delete (withoutEvidence as any).evidence;
  assert.throws(() => deserializeExecutionReceipt(JSON.stringify(withoutEvidence)), /missing_required_field:evidence/);
});

test("Negative Numeric Fuzzing PBT: Non-positive deadlines and negative revisions fail-closed", () => {
  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: -10000, max: -1 }),
        deadlineMs: fc.integer({ min: 1000, max: 10000000 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      (invalidReq) => {
        assert.throws(() => deserializeExecutionRequest(JSON.stringify(invalidReq)), /invalid_expectedRevision/);
      },
    ),
    { numRuns: 50 },
  );

  fc.assert(
    fc.property(
      fc.record({
        requestId: fc.string({ minLength: 1, maxLength: 36 }),
        idempotencyKey: fc.string({ minLength: 1, maxLength: 36 }),
        action: fc.constantFrom(...EXECUTION_ACTION_DTOS),
        expectedRevision: fc.integer({ min: 0, max: 1000000 }),
        deadlineMs: fc.integer({ min: -10000, max: 0 }),
        args: fc.dictionary(fc.string({ minLength: 1, maxLength: 20 }), fc.jsonValue()),
      }),
      (invalidReq) => {
        assert.throws(() => deserializeExecutionRequest(JSON.stringify(invalidReq)), /invalid_deadlineMs/);
      },
    ),
    { numRuns: 50 },
  );
});

test("ExecutionRequest deserializer fails closed on invalid or malformed payload", () => {
  assert.throws(() => deserializeExecutionRequest("invalid json"), /invalid_request_json/);
  assert.throws(() => deserializeExecutionRequest(JSON.stringify(null)), /invalid_request_json/);
  assert.throws(() => deserializeExecutionRequest(JSON.stringify({ requestId: "" })), /missing_required_field/);
  assert.throws(
    () =>
      deserializeExecutionRequest(
        JSON.stringify({
          requestId: "r1",
          idempotencyKey: "k1",
          action: "till_soil",
          expectedRevision: "not_a_number",
        }),
      ),
    /invalid_expectedRevision/,
  );
});

test("ExecutionReceipt deserializer fails closed on invalid state or missing fields", () => {
  assert.throws(() => deserializeExecutionReceipt("null"), /invalid_receipt_json/);
  assert.throws(
    () => deserializeExecutionReceipt(JSON.stringify({ executionId: "e1", requestId: "r1", state: "unknown_state" })),
    /missing_required_field/,
  );
});

test("Functorial Immutability Invariant: Deserialized DTOs and their nested structures are deeply frozen", () => {
  const req = deserializeExecutionRequest(
    JSON.stringify({
      requestId: "req_1",
      idempotencyKey: "idem_1",
      action: "till_soil",
      expectedRevision: 1,
      deadlineMs: 5000,
      args: { nested: { prop: 42 } },
    }),
  );
  assert.ok(Object.isFrozen(req));
  assert.ok(Object.isFrozen(req.args));
  assert.ok(Object.isFrozen((req.args as any).nested));

  const rec = deserializeExecutionReceipt(
    JSON.stringify({
      executionId: "exec_1",
      requestId: "req_1",
      state: "succeeded",
      reasonCode: "ok",
      revision: 1,
      evidence: { subEvidence: { value: "ok" } },
    }),
  );
  assert.ok(Object.isFrozen(rec));
  assert.ok(Object.isFrozen(rec.evidence));
  assert.ok(Object.isFrozen((rec.evidence as any).subEvidence));
});
