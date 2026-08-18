/**
 * Node-only tests for `dialogue-web/src/reference-pipeline-api.ts`: the
 * strict closed DTO validators and the frozen `tavern_browser_api/v1`
 * reference-pipeline fetch client.
 *
 * Uses only node:test/node:assert plus a fetch recorder and literal DTOs.
 * Covers: exact frozen routes/headers/credentials/JSON bodies, header
 * absence on status reads, canonical handle/idempotency-key enforcement,
 * closed-shape extra-field rejection, strict eventStream validation, validated problem
 * surfacing and the no-echo rule for opaque protocol errors.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  REFERENCE_PIPELINE_PROFILE_ID,
  TavernProblemError,
  TavernProtocolError,
  createReferencePipelineApi,
  validateDraft,
  validateProblem,
  validateSnapshot,
  validateSubmissionStatus,
  validateSubmitResult,
} from "../src/reference-pipeline-api.ts";

const PROFILE = REFERENCE_PIPELINE_PROFILE_ID;
// Canonical unpadded base64url handle: 43 chars, 43 % 4 === 3, last alphabet
// index 0 ("A") satisfies 0 % 4 === 0.
const HANDLE = "A".repeat(43);
// Canonical 22-char unpadded base64url idempotency key: 22 % 4 === 2, last
// alphabet index 0 ("A") satisfies 0 % 16 === 0.
const KEY = "A".repeat(22);
// 43 % 4 === 3 but last alphabet index 1 ("B") fails 1 % 4 === 0.
const BAD_HANDLE = "B".repeat(43);
// 22 chars but last alphabet index 1 ("B") fails 1 % 16 === 0.
const BAD_KEY = "A".repeat(21) + "B";

const message = {
  handle: HANDLE,
  role: "player",
  text: "Synthetic player request",
  locale: "en",
  order: 1,
  revision: 1,
};

const COMMAND = {
  apiVersion: 1,
  selectionGeneration: 3,
  text: "Synthetic player request",
  locale: "en",
  expectedDraftRevision: 7,
};

function snapshot(overrides = {}) {
  return applyOverrides(
    {
      apiVersion: 1,
      build: { browserContract: "tavern_browser_api/v1", profileId: PROFILE },
      csrfToken: HANDLE,
      browserSession: { expiresAtMs: 0 },
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
      selection: { chatHandle: HANDLE, generation: 3, stateRevision: HANDLE },
      chat: {
        companion: { name: "Mira" },
        title: null,
        transcript: [message],
        draft: { revision: 7, present: true },
        turn: null,
        worldInfo: null,
      },
      memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
      eventStream: null,
    },
    overrides,
  );
}

function turnAndResult(turnOverrides = {}) {
  return {
    apiVersion: 1,
    disposition: "accepted",
    message,
    turn: { handle: HANDLE, state: "queued", projectionRevision: 1, canCancel: false, ...turnOverrides },
  };
}

function applyOverrides(value, overrides) {
  const next = structuredClone(value);
  for (const [key, entry] of Object.entries(overrides)) {
    if (
      entry !== null &&
      typeof entry === "object" &&
      !Array.isArray(entry) &&
      next[key] !== null &&
      typeof next[key] === "object" &&
      !Array.isArray(next[key])
    ) {
      next[key] = { ...next[key], ...entry };
    } else {
      next[key] = entry;
    }
  }
  return next;
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Fetch recorder: pushes each call and serves the queued responses in order. */
function makeTransport(...responses) {
  const calls = [];
  const transport = async (input, init) => {
    calls.push({ input: String(input), init });
    const entry = responses.shift();
    if (entry === undefined) throw new Error("no recorded response");
    return typeof entry === "function" ? entry() : entry;
  };
  return { transport, calls };
}

const PROTOCOL_MESSAGE = "tavern_browser_api/v1 protocol error";

function assertProtocolError(promise) {
  return assert.rejects(promise, (error) => {
    assert.ok(error instanceof TavernProtocolError);
    assert.equal(error.message, PROTOCOL_MESSAGE);
    return true;
  });
}

// --- Fetch client: requests, headers, credentials, bodies. ---

test("bootstrap posts the exact body to the frozen route and validates the snapshot", async () => {
  const { transport, calls } = makeTransport(jsonResponse(snapshot()));
  const api = createReferencePipelineApi(transport);
  const result = await api.bootstrap(HANDLE);
  assert.deepEqual(result, snapshot());
  assert.equal(calls.length, 1);
  const { input, init } = calls[0];
  assert.equal(input, "/api/tavern/v1/bootstrap");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.deepEqual(init.headers, { "Content-Type": "application/json" });
  assert.deepEqual(JSON.parse(init.body), { apiVersion: 1, bootstrapToken: HANDLE });
});

test("readState and readDraft use GET routes with same-origin credentials and no headers or body", async () => {
  const draft = { apiVersion: 1, revision: 7, text: null };
  const { transport, calls } = makeTransport(jsonResponse(snapshot()), jsonResponse(draft));
  const api = createReferencePipelineApi(transport);
  const state = await api.readState();
  const saved = await api.readDraft();
  assert.deepEqual(state, snapshot());
  assert.deepEqual(saved, draft);
  assert.equal(calls.length, 2);
  const [stateCall, draftCall] = calls;
  assert.equal(stateCall.input, "/api/tavern/v1/state");
  assert.equal(draftCall.input, "/api/tavern/v1/draft");
  for (const { init } of calls) {
    assert.equal(init.method, "GET");
    assert.equal(init.credentials, "same-origin");
    assert.equal(init.headers, undefined);
    assert.equal(init.body, undefined);
  }
});

test("submit posts JSON with content-type, csrf and idempotency headers and decodes the 202 result", async () => {
  const result = turnAndResult();
  const { transport, calls } = makeTransport(jsonResponse(result, 202));
  const api = createReferencePipelineApi(transport);
  const decoded = await api.submit(COMMAND, { csrfToken: HANDLE, idempotencyKey: KEY });
  assert.deepEqual(decoded, result);
  assert.equal(calls.length, 1);
  const { input, init } = calls[0];
  assert.equal(input, "/api/tavern/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.deepEqual(init.headers, {
    "Content-Type": "application/json",
    "x-csrf-token": HANDLE,
    "idempotency-key": KEY,
  });
  assert.deepEqual(JSON.parse(init.body), COMMAND);
});

test("submission status posts the query with content-type only and never CSRF/idempotency headers", async () => {
  const status = { apiVersion: 1, disposition: "unknown" };
  const query = { apiVersion: 1, idempotencyKey: KEY, selectionGeneration: 3 };
  const { transport, calls } = makeTransport(jsonResponse(status));
  const api = createReferencePipelineApi(transport);
  const decoded = await api.readSubmissionStatus(query);
  assert.deepEqual(decoded, status);
  assert.equal(calls.length, 1);
  const { input, init } = calls[0];
  assert.equal(input, "/api/tavern/v1/message-submission-status");
  assert.equal(init.method, "POST");
  assert.equal(init.credentials, "same-origin");
  assert.equal(init.body, JSON.stringify(query));
  const headerNames = Object.keys(init.headers);
  assert.deepEqual(headerNames, ["Content-Type"]);
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.ok(!("x-csrf-token" in init.headers));
  assert.ok(!("csrf" in init.headers));
  assert.ok(!("idempotency-key" in init.headers));
  assert.ok(!("Idempotency-Key" in init.headers));
});

test("bootstrap rejects a non-canonical token before any fetch", async () => {
  const { transport, calls } = makeTransport();
  const api = createReferencePipelineApi(transport);
  await assertProtocolError(api.bootstrap("short"));
  await assertProtocolError(api.bootstrap(BAD_HANDLE));
  await assertProtocolError(api.bootstrap(`${HANDLE}=`));
  assert.equal(calls.length, 0);
});

test("submit rejects non-canonical csrf/idempotency and invalid commands before any fetch", async () => {
  const { transport, calls } = makeTransport();
  const api = createReferencePipelineApi(transport);
  await assertProtocolError(api.submit(COMMAND, { csrfToken: HANDLE, idempotencyKey: BAD_KEY }));
  await assertProtocolError(api.submit(COMMAND, { csrfToken: BAD_HANDLE, idempotencyKey: KEY }));
  await assertProtocolError(api.submit({ ...COMMAND, extra: true }, { csrfToken: HANDLE, idempotencyKey: KEY }));
  await assertProtocolError(api.submit({ ...COMMAND, locale: "und" }, { csrfToken: HANDLE, idempotencyKey: KEY }));
  await assertProtocolError(api.submit({ ...COMMAND, selectionGeneration: 0 }, { csrfToken: HANDLE, idempotencyKey: KEY }));
  await assertProtocolError(
    api.submit({ ...COMMAND, text: "e\u0301" }, { csrfToken: HANDLE, idempotencyKey: KEY }),
  );
  await assertProtocolError(
    api.submit({ ...COMMAND, memoryDelegation: "write" }, { csrfToken: HANDLE, idempotencyKey: KEY }),
  );
  assert.equal(calls.length, 0);
});

test("status read rejects a non-canonical idempotency key before any fetch", async () => {
  const { transport, calls } = makeTransport();
  const api = createReferencePipelineApi(transport);
  await assertProtocolError(
    api.readSubmissionStatus({ apiVersion: 1, idempotencyKey: BAD_KEY, selectionGeneration: 3 }),
  );
  await assertProtocolError(
    api.readSubmissionStatus({ apiVersion: 1, idempotencyKey: KEY, selectionGeneration: 0 }),
  );
  await assertProtocolError(
    api.readSubmissionStatus({ apiVersion: 1, idempotencyKey: KEY, selectionGeneration: 3, extra: 1 }),
  );
  assert.equal(calls.length, 0);
});

test("network failure propagates unchanged (never a protocol error)", async () => {
  const api = createReferencePipelineApi(async () => {
    throw new TypeError("failed to fetch");
  });
  await assert.rejects(api.readState(), (error) => error instanceof TypeError && error.message === "failed to fetch");
});

// --- Validators: canonicality, closed shapes, unions, eventStream denial. ---

test("validateSnapshot accepts the canonical reference-profile literal", () => {
  assert.doesNotThrow(() => validateSnapshot(snapshot()));
  const withProblemTurn = validateSnapshot(
    snapshot({
      chat: {
        turn: {
          handle: HANDLE,
          state: "failed",
          projectionRevision: 1,
          canCancel: false,
          problemCode: "runtime_unavailable",
        },
      },
    }),
  );
  assert.equal(withProblemTurn.chat.turn.problemCode, "runtime_unavailable");
});

test("validateSnapshot rejects extra and missing fields", async () => {
  const cases = [
    snapshot({ extra: true }),
    snapshot({ build: { extra: true } }),
    snapshot({ browserSession: { extra: 1 } }),
    snapshot({ selection: { extra: "x" } }),
    snapshot({ chat: { extra: true } }),
    snapshot({ chat: { companion: { extra: true } } }),
    snapshot({ chat: { draft: { extra: true } } }),
    snapshot({ chat: { worldInfo: { state: "selected", items: [], extra: true } } }),
    snapshot({ memory: { extra: true } }),
    snapshot({ operations: [snapshot().operations[0], { ...snapshot().operations[0], extra: true }] }),
    snapshot({ navigation: [{ ...snapshot().navigation[0], extra: true }] }),
    snapshot({
      chat: {
        turn: {
          handle: HANDLE,
          state: "failed",
          projectionRevision: 1,
          canCancel: false,
          problemCode: "runtime_unavailable",
          extra: true,
        },
      },
    }),
    // navigation item with an extra key
    snapshot({ navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available", extra: 1 }] }),
  ];
  for (const value of cases) {
    assert.throws(() => validateSnapshot(value), TavernProtocolError);
  }
});

test("validateSnapshot accepts the strict eventStream cursor and rejects malformed values", () => {
  assert.throws(() => validateSnapshot(snapshot({ eventStream: {} })), TavernProtocolError);
  assert.throws(
    () => validateSnapshot(snapshot({ eventStream: { epoch: HANDLE, cursor: HANDLE, extra: true } })),
    TavernProtocolError,
  );
  assert.doesNotThrow(() => validateSnapshot(snapshot({ eventStream: { epoch: HANDLE, cursor: HANDLE } })));
  assert.doesNotThrow(() => validateSnapshot(snapshot({ eventStream: null })));
});

test("validateSnapshot rejects non-canonical opaque handles", () => {
  const cases = [
    snapshot({ csrfToken: BAD_HANDLE }),
    snapshot({ csrfToken: "short" }),
    snapshot({ csrfToken: `${HANDLE}=` }),
    snapshot({ selection: { chatHandle: BAD_HANDLE } }),
    snapshot({ selection: { stateRevision: BAD_HANDLE } }),
    snapshot({ selection: { generation: 0 } }),
    snapshot({ selection: { generation: 1.5 } }),
    snapshot({ chat: { transcript: [{ ...message, handle: BAD_HANDLE }] } }),
    snapshot({ chat: { turn: { handle: "too-short", state: "queued", projectionRevision: 1, canCancel: false } } }),
    snapshot({ chat: { worldInfo: { state: "selected", items: [{ handle: BAD_HANDLE, title: "t", summary: null }] } } }),
    snapshot({ memory: { projectionRevision: BAD_HANDLE } }),
    snapshot({ browserSession: { expiresAtMs: -1 } }),
    snapshot({ chat: { draft: { revision: -1 } } }),
  ];
  for (const value of cases) {
    assert.throws(() => validateSnapshot(value), TavernProtocolError);
  }
});

test("validateSnapshot enforces exact union variants", () => {
  const cases = [
    snapshot({ chat: { transcript: [{ ...message, role: "system" }] } }),
    snapshot({ chat: { transcript: [{ ...message, locale: "fr" }] } }),
    snapshot({ chat: { turn: { state: "in_progress", projectionRevision: 1, canCancel: false } } }),
    snapshot({ chat: { turn: { state: "failed", problemCode: "bogus", projectionRevision: 1, canCancel: false } } }),
    snapshot({ chat: { worldInfo: { state: "unknown", items: [] } } }),
    snapshot({ operations: [{ operationId: "chat.send", labelKey: "tavern.nav.chat", availability: "available", routeId: "x" }] }),
    snapshot({ operations: [{ operationId: "chat.submit", labelKey: "tavern.nav.chat", availability: "maybe", routeId: "chat.submit" }] }),
    snapshot({ operations: [{ operationId: "chat.submit", labelKey: "tavern.nav.chat", availability: "available", routeId: "UPPER" }] }),
    snapshot({ navigation: [{ itemId: "settings", labelKey: "tavern.nav.chat", availability: "available" }] }),
    snapshot({ navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "busy" }] }),
  ];
  for (const value of cases) {
    assert.throws(() => validateSnapshot(value), TavernProtocolError);
  }
});

test("validateDraft is strict and closed", () => {
  assert.doesNotThrow(() => validateDraft({ apiVersion: 1, revision: 7, text: null }));
  assert.doesNotThrow(() => validateDraft({ apiVersion: 1, revision: 0, text: "Saved locally by Host." }));
  const cases = [
    { apiVersion: 1, revision: 7, text: null, extra: true },
    { apiVersion: 1, revision: -1, text: null },
    { apiVersion: 1, revision: 1.5, text: null },
    { apiVersion: 1, revision: 1, text: "" },
    { apiVersion: 1, revision: 1, text: "e\u0301" },
    { apiVersion: 1, revision: 1, text: "\uD800" },
    { apiVersion: 1, revision: 1, text: "x".repeat(16_385) },
    { apiVersion: 2, revision: 1, text: null },
  ];
  for (const value of cases) {
    assert.throws(() => validateDraft(value), TavernProtocolError);
  }
});

test("validateSubmitResult is strict and closed", () => {
  assert.doesNotThrow(() => validateSubmitResult(turnAndResult()));
  assert.doesNotThrow(() => validateSubmitResult({ ...turnAndResult(), disposition: "duplicate" }));
  const cases = [
    { ...turnAndResult(), extra: true },
    { ...turnAndResult(), disposition: "rejected" },
    { ...turnAndResult(), message: { ...message, extra: true } },
    { ...turnAndResult(), turn: { handle: HANDLE, state: "queued", projectionRevision: 1, canCancel: false, extra: true } },
    { ...turnAndResult(), message: { ...message, locale: "fr" } },
  ];
  for (const value of cases) {
    assert.throws(() => validateSubmitResult(value), TavernProtocolError);
  }
});

test("validateSubmissionStatus is strict on dispositions and committedResult", () => {
  const result = turnAndResult();
  assert.doesNotThrow(() => validateSubmissionStatus({ apiVersion: 1, disposition: "unknown" }));
  assert.doesNotThrow(() => validateSubmissionStatus({ apiVersion: 1, disposition: "pending" }));
  assert.doesNotThrow(() => validateSubmissionStatus({ apiVersion: 1, disposition: "accepted", committedResult: result }));
  assert.doesNotThrow(() => validateSubmissionStatus({ apiVersion: 1, disposition: "terminal", committedResult: result }));
  assert.doesNotThrow(() => validateSubmissionStatus({ apiVersion: 1, disposition: "expired" }));
  const cases = [
    { apiVersion: 1, disposition: "pending_something" },
    { apiVersion: 2, disposition: "unknown" },
    { apiVersion: 1, disposition: "unknown", extra: true },
    { apiVersion: 1, disposition: "terminal", committedResult: { ...result, extra: true } },
  ];
  for (const value of cases) {
    assert.throws(() => validateSubmissionStatus(value), TavernProtocolError);
  }
});

test("validateProblem is strict and closed", () => {
  const problem = {
    type: "about:blank",
    title: "Selection conflict",
    status: 409,
    code: "selection_conflict",
    requestId: HANDLE,
    retryable: false,
  };
  assert.doesNotThrow(() => validateProblem(problem));
  const cases = [
    { ...problem, extra: true },
    { ...problem, code: "bogus_code" },
    { ...problem, status: 399 },
    { ...problem, status: 600 },
    { ...problem, status: 409.5 },
    { ...problem, requestId: BAD_HANDLE },
    { ...problem, title: "" },
    { ...problem, retryable: "yes" },
  ];
  for (const value of cases) {
    assert.throws(() => validateProblem(value), TavernProtocolError);
  }
});

// --- Response handling: problem surfacing, exact success status, no echo. ---

test("validated non-2xx surfaces TavernProblemError with the frozen fields", async () => {
  const problem = {
    type: "about:blank",
    title: "Turn is busy",
    status: 409,
    code: "turn_busy",
    requestId: HANDLE,
    retryable: false,
  };
  const api = createReferencePipelineApi(async () => jsonResponse(problem, 409));
  await assert.rejects(api.readState(), (error) => {
    assert.ok(error instanceof TavernProblemError);
    assert.equal(error.type, "about:blank");
    assert.equal(error.title, "Turn is busy");
    assert.equal(error.message, "Turn is busy");
    assert.equal(error.status, 409);
    assert.equal(error.code, "turn_busy");
    assert.equal(error.requestId, HANDLE);
    assert.equal(error.retryable, false);
    return true;
  });
});

test("submit surfaces a validated problem on non-2xx", async () => {
  const problem = {
    type: "about:blank",
    title: "Unauthorized",
    status: 401,
    code: "unauthorized",
    requestId: HANDLE,
    retryable: false,
  };
  const api = createReferencePipelineApi(async () => jsonResponse(problem, 401));
  await assert.rejects(api.submit(COMMAND, { csrfToken: HANDLE, idempotencyKey: KEY }), (error) => {
    assert.ok(error instanceof TavernProblemError);
    assert.equal(error.code, "unauthorized");
    return true;
  });
});

test("submit requires the exact 202 success status", async () => {
  const api = createReferencePipelineApi(async () => jsonResponse(turnAndResult(), 200));
  await assertProtocolError(api.submit(COMMAND, { csrfToken: HANDLE, idempotencyKey: KEY }));
});

test("2xx with an invalid DTO is an opaque protocol error", async () => {
  const api = createReferencePipelineApi(async () => jsonResponse(snapshot({ extra: true })));
  await assertProtocolError(api.readState());
});

test("2xx with a valid eventStream is accepted through the client", async () => {
  const api = createReferencePipelineApi(async () =>
    jsonResponse(snapshot({ eventStream: { epoch: HANDLE, cursor: HANDLE } })),
  );
  assert.deepEqual((await api.readState()).eventStream, { epoch: HANDLE, cursor: HANDLE });
});

test("opaque protocol errors never echo raw body or text", async () => {
  // Non-JSON error body.
  const textApi = createReferencePipelineApi(async () => new Response("raw server secret", { status: 500 }));
  await assertProtocolError(textApi.readState());
  // JSON body that is not a validated problem.
  const jsonApi = createReferencePipelineApi(async () => jsonResponse({ error: "raw server detail" }, 502));
  await assertProtocolError(jsonApi.readState());
  // Valid JSON but a problem with an extra field is not a validated problem.
  const openProblem = () =>
    Promise.resolve(
      jsonResponse(
        {
          type: "about:blank",
          title: "Raw title",
          status: 503,
          code: "storage_unavailable",
          requestId: HANDLE,
          retryable: true,
          extra: "raw extra",
        },
        503,
      ),
    );
  await assertProtocolError(createReferencePipelineApi(openProblem).readSubmissionStatus({ apiVersion: 1, idempotencyKey: KEY, selectionGeneration: 3 }));
  // The fixed protocol message must not contain any raw body text.
  await assert.rejects(createReferencePipelineApi(async () => new Response("secret detail", { status: 500 })).readDraft(), (error) => {
    assert.ok(error instanceof TavernProtocolError);
    assert.ok(!error.message.includes("secret"));
    assert.ok(!error.message.includes("raw"));
    return true;
  });
});

test("factory defaults to a usable client without touching the network", async () => {
  const api = createReferencePipelineApi();
  assert.equal(typeof api.bootstrap, "function");
  assert.equal(typeof api.readState, "function");
  assert.equal(typeof api.readDraft, "function");
  assert.equal(typeof api.submit, "function");
  assert.equal(typeof api.readSubmissionStatus, "function");
  assert.throws(() => createReferencePipelineApi(null), /fetch-like/);
});