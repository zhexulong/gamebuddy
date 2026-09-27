import assert from "node:assert/strict";
import crypto from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  CHAT_RUN_AUDIT_CODES_BY_KIND,
  CHAT_RUN_AUDIT_KINDS,
  CHAT_RUN_AUDIT_META_KEYS,
  CHAT_RUN_AUDIT_PROBE_DIMENSIONS,
  CHAT_RUN_AUDIT_PROBE_DISTANCES,
  validateChatRunAudit,
} from "./lib/chat-run-audit.mjs";
import {
  AUDIT_KINDS,
  AUDIT_META_KEYS,
  AUDIT_PROBE_DIMENSIONS,
  AUDIT_PROBE_DISTANCES,
  AUDIT_VOCABULARY,
  buildAuditTrace,
  classifyPresentationMarkers,
  classifyProbeMaterializationMarkers,
  classifyStartupFailure,
  classifyStartupStderr,
  compareReloadSnapshot,
  contentFree,
  createAuditDeploymentManifest,
  createAuditRecorder,
  evaluateProbeReply,
  evaluateProviderPreSendMarker,
  evaluateProviderRuntimeMarker,
  loadProbeManifest,
  parseArguments,
  parseSseFrame,
  prepareReportTarget,
  projectStateSnapshot,
  probeTurnCommittedGate,
  validateAuditEvent,
  validateAuditTrace,
  writeAuditTrace,
} from "./run-chat-live-audit.mjs";

const DIGEST = "a".repeat(64);

async function withRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-chat-audit-test-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function validTrace(events) {
  return buildAuditTrace({
    runId: "run_01",
    startedAt: "2026-09-26T00:00:00.000Z",
    completedAt: "2026-09-26T00:00:10.000Z",
    artifact: { generation: "g-test-01", inventoryDigest: DIGEST },
    providerObserved: true,
    events:
      events ??
      Object.freeze([
        { at: 0, kind: "lifecycle", actor: "harness", code: "run.started", meta: { status: "ready" } },
        { at: 5, kind: "provider", actor: "host", code: "request.sent" },
        { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { status: "collected", providerObservability: "observed" } },
      ]),
  });
}

test("the harness vocabulary and the kernel vocabulary are equivalent in BOTH directions", () => {
  // The load-time drift check inside tools/compare-chat-live-runs.mjs only covers
  // kernel<->compare. Without this test, a change to only one of the two tables
  // (kernel vs harness) would ship: the kernel would accept codes the harness
  // rejects, or the harness would accept codes the kernel silently refuses to
  // analyse. Both directions are asserted so neither table can move alone.
  const kernelLabels = Object.entries(CHAT_RUN_AUDIT_CODES_BY_KIND).flatMap(([kind, codes]) =>
    codes.map((code) => `${kind}.${code}`),
  );
  const harnessLabels = Object.keys(AUDIT_VOCABULARY);
  const kernelOnly = kernelLabels.filter((label) => !harnessLabels.includes(label));
  const harnessOnly = harnessLabels.filter((label) => !kernelLabels.includes(label));
  assert.deepEqual(kernelOnly, [], "kernel codes missing from the harness vocabulary");
  assert.deepEqual(harnessOnly, [], "harness codes the kernel does not freeze");
  assert.equal(kernelLabels.length, harnessLabels.length, "the two tables must have exactly the same size");

  // The frozen kind list, the meta allow-list and the probe domains are part of
  // the same contract and must also agree.
  assert.deepEqual([...CHAT_RUN_AUDIT_KINDS].sort(), [...AUDIT_KINDS].sort());
  assert.deepEqual([...CHAT_RUN_AUDIT_META_KEYS].sort(), [...AUDIT_META_KEYS].sort());
  assert.deepEqual([...CHAT_RUN_AUDIT_PROBE_DISTANCES], [...AUDIT_PROBE_DISTANCES]);
  assert.deepEqual([...CHAT_RUN_AUDIT_PROBE_DIMENSIONS], [...AUDIT_PROBE_DIMENSIONS]);
});

test("every frozen code is accepted by BOTH validators with its obligations satisfied", () => {
  // The equivalence test above proves the two tables agree; this one proves each
  // frozen code is actually usable — the kernel accepts it and the harness would
  // accept a trace carrying it — so no table entry is dead.
  for (const [label, actor] of Object.entries(AUDIT_VOCABULARY)) {
    const [kind, ...codeParts] = label.split(".");
    const code = codeParts.join(".");
    const meta = {};
    if (code === "turn.terminal") meta.state = "completed";
    if (code === "run.finished") meta.providerObservability = "observed";
    if (kind === "probe") Object.assign(meta, { probeId: "p-turn-01", manifestDigest: DIGEST });
    if (code === "isolation.breach") Object.assign(meta, { distance: "turn", dimension: "isolation" });
    const events = [
      { at: 0, kind: "lifecycle", actor: "harness", code: "run.started" },
      { at: 5, kind, actor, code, meta },
      { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
    ];
    assert.deepEqual(validateAuditEvent(events[1]), { ok: true, reasonCode: undefined }, `${label} harness`);
    const validation = validateChatRunAudit(validTrace(events));
    assert.equal(validation.valid, true, `${label} kernel: ${JSON.stringify(validation.errors)}`);
  }
});

test("probe events require their manifest binding and a breach names its distance and dimension", () => {
  const trace = (meta, code = "needle.hit", kind = "probe") =>
    validTrace([
      { at: 0, kind: "lifecycle", actor: "harness", code: "run.started" },
      { at: 5, kind, actor: "harness", code, meta },
      { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
    ]);
  const bound = { probeId: "p-turn-01", manifestDigest: DIGEST };
  // A probe result without its manifest binding is schema-invalid on both sides.
  for (const meta of [{}, { probeId: "p-turn-01" }, { manifestDigest: DIGEST }, { ...bound, manifestDigest: "not-a-digest" }, { ...bound, probeId: "has space" }]) {
    assert.equal(validateChatRunAudit(trace(meta)).valid, false, JSON.stringify(meta));
  }
  // A breach additionally has to place itself: distance + dimension=isolation.
  for (const meta of [{ ...bound }, { ...bound, distance: "turn" }, { ...bound, dimension: "isolation" }, { ...bound, dimension: "retention", distance: "turn" }, { ...bound, dimension: "isolation", distance: "week" }]) {
    assert.equal(validateChatRunAudit(trace(meta, "isolation.breach")).valid, false, JSON.stringify(meta));
  }
  assert.equal(
    validateChatRunAudit(trace({ ...bound, dimension: "isolation", distance: "turn" }, "isolation.breach")).valid,
    true,
  );
  // Non-breach codes may omit distance/dimension but not invent them.
  assert.equal(validateChatRunAudit(trace(bound)).valid, true);
  assert.equal(validateChatRunAudit(trace({ ...bound, distance: "turn", dimension: "retention" })).valid, true);
  assert.equal(validateChatRunAudit(trace({ ...bound, distance: "week" })).valid, false);
  assert.equal(validateChatRunAudit(trace({ ...bound, dimension: "naturalness" })).valid, false);
});

test("the harness validator mirrors every probe obligation the kernel enforces", () => {
  const base = { at: 0, kind: "probe", actor: "harness", code: "needle.hit" };
  const bound = { probeId: "p-turn-01", manifestDigest: DIGEST };
  assert.deepEqual(validateAuditEvent({ ...base, meta: bound }), { ok: true, reasonCode: undefined });
  assert.deepEqual(validateAuditEvent(base), { ok: false, reasonCode: "event_probe_metadata_missing" });
  assert.deepEqual(validateAuditEvent({ ...base, meta: { manifestDigest: DIGEST } }), {
    ok: false,
    reasonCode: "event_probe_id_invalid",
  });
  assert.deepEqual(validateAuditEvent({ ...base, meta: { probeId: "p-turn-01" } }), {
    ok: false,
    reasonCode: "event_probe_manifest_digest_invalid",
  });
  assert.deepEqual(validateAuditEvent({ ...base, meta: { ...bound, distance: "week" } }), {
    ok: false,
    reasonCode: "event_probe_distance_invalid",
  });
  assert.deepEqual(validateAuditEvent({ ...base, meta: { ...bound, dimension: "naturalness" } }), {
    ok: false,
    reasonCode: "event_probe_dimension_invalid",
  });
  const breach = { ...base, code: "isolation.breach", meta: bound };
  assert.deepEqual(validateAuditEvent(breach), { ok: false, reasonCode: "event_probe_breach_distance_missing" });
  assert.deepEqual(validateAuditEvent({ ...breach, meta: { ...bound, distance: "turn" } }), {
    ok: false,
    reasonCode: "event_probe_breach_dimension_invalid",
  });
  assert.deepEqual(validateAuditEvent({ ...breach, meta: { ...bound, distance: "turn", dimension: "isolation" } }), {
    ok: true,
    reasonCode: undefined,
  });
});

test("audit trace self-validation agrees with the consumer on every malformed trace", async () => {
  // The harness writes only what it itself accepts, but the audit kernel is the
  // consumer that decides whether anything is analysed at all. If the two
  // validators disagree, the harness would persist a trace the kernel then
  // rejects with exit 2 and nothing analysed. This test pins parity for the
  // cases that actually differ in shape, not just for the happy path.
  const shapes = [
    // Valid: the harness must accept what the kernel accepts.
    [validTrace(), true],
    // A terminal must carry one of the three durable terminal states.
    [
      validTrace([
        { at: 0, kind: "lifecycle", actor: "harness", code: "run.started", meta: { status: "ready" } },
        { at: 5, kind: "lifecycle", actor: "harness", code: "turn.submitted" },
        { at: 6, kind: "lifecycle", actor: "harness", code: "turn.terminal", meta: { state: "stopping" } },
        { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
      ]),
      false,
    ],
    // `run.finished` must self-report provider observability.
    [
      validTrace([
        { at: 0, kind: "lifecycle", actor: "harness", code: "run.started", meta: { status: "ready" } },
        { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { status: "collected" } },
      ]),
      false,
    ],
    // A meta value outside the allow-list must be refused by both.
    [
      validTrace([
        { at: 0, kind: "lifecycle", actor: "harness", code: "run.started", meta: { status: "ready" } },
        { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed", prompt: "x" } },
      ]),
      false,
    ],
  ];
  for (const [trace, expected] of shapes) {
    const harness = validateAuditTrace(trace).ok;
    const kernel = validateChatRunAudit(trace).valid;
    assert.equal(harness, expected, `harness verdict for ${JSON.stringify(trace.events.at(-1))}`);
    assert.equal(harness, kernel, "the harness validator and the audit kernel disagree on the same trace");
  }
});

test("a trace whose run never started is never accepted", async () => {
  // Without run.started the trace describes no run at all, so every turn
  // detector is vacuously silent and it would audit as a clean pass.
  const neverStarted = buildAuditTrace({
    runId: "run_02",
    startedAt: "2026-09-26T00:00:00.000Z",
    completedAt: "2026-09-26T00:00:10.000Z",
    artifact: { generation: "g-test-01", inventoryDigest: DIGEST },
    providerObserved: false,
    events: [
      { at: 0, kind: "provider", actor: "harness", code: "observability_gap", meta: { status: "unobserved" } },
      {
        at: 9,
        kind: "lifecycle",
        actor: "harness",
        code: "run.finished",
        meta: { status: "boundary_failed", providerObservability: "unobserved" },
      },
    ],
  });
  // The kernel refuses it outright, so it can never be read as a passed run.
  assert.equal(validateChatRunAudit(neverStarted).valid, false);
});

test("audit harness accepts only its optional create-only report argument", () => {
  assert.deepEqual(parseArguments([]), { reportPath: undefined });
  assert.throws(() => parseArguments(["--report"]), /usage:/);
  assert.throws(() => parseArguments(["--unknown", "report.json"]), /usage:/);
  assert.throws(() => parseArguments(["--report", ""]), /usage:/);
  assert.deepEqual(parseArguments(["--report", "a.json", "--probe-manifest", "manifest.json"]), {
    reportPath: join(process.cwd(), "a.json"),
    probeManifestPath: join(process.cwd(), "manifest.json"),
  });
  assert.throws(() => parseArguments(["--report", "a.json", "--probe-manifest"]), /usage:/);
});

function validProbeManifest(overrides = {}) {
  const base = {
    schema: "chat_memory_probe_manifest/v1",
    manifestId: "man-test-01",
    continuityTopology: "single",
    probes: [
      {
        probeId: "p-turn-short",
        distance: "turn",
        dimension: "retention",
        seedClass: "conversational",
        steps: [
          { kind: "seed", role: "player", text: "I used to be a postman for 8 years.", persistVia: "conversation" },
          { kind: "filler", role: "player", text: "Chowder and lighthouse duty?", persistVia: "conversation" },
          { kind: "probe", role: "player", text: "What did I do before retiring?", requiredKeywords: ["postman"], forbiddenKeywords: ["mine", "truck"], minHitRate: 0.5 },
        ],
      },
    ],
  };
  const merged = { ...base, ...overrides };
  // When the caller does not supply an explicit digest, compute it from the
  // exact canonical JSON so the fixture agrees with the loader by construction.
  // An explicit digest override (for mismatch tests) is preserved.
  if (overrides.manifestDigest === undefined) {
    const canonical = JSON.stringify({ schema: "chat_memory_probe_manifest/v1", manifestId: merged.manifestId, continuityTopology: merged.continuityTopology, probes: merged.probes });
    merged.manifestDigest = crypto.createHash("sha256").update(canonical).digest("hex");
  }
  return JSON.stringify(merged);
}

test("probe manifest loading validates the fixture sidecar shape and digest", () => {
  const loaded = loadProbeManifest(validProbeManifest());
  assert.equal(loaded.schema, "chat_memory_probe_manifest/v1");
  assert.equal(loaded.probes.length, 1);
  assert.equal(loaded.probes[0].steps.length, 3);
  assert.throws(() => loadProbeManifest("not json"), /probe_manifest_invalid_json/);
  assert.throws(() => loadProbeManifest(JSON.stringify({ schema: "other" })), /probe_manifest_schema_mismatch/);
  assert.throws(() => loadProbeManifest(validProbeManifest({ manifestDigest: "b".repeat(64) })), /probe_manifest_digest_mismatch/);
  assert.throws(() => loadProbeManifest(validProbeManifest({ probes: [] })), /probe_manifest_probes_missing/);
  assert.throws(() => loadProbeManifest(validProbeManifest({ probes: [{ probeId: "x", distance: "week" }] })), /probe_manifest_probe_distance_invalid/);
});

test("probe reply evaluation uses required + forbidden keywords at the design thresholds", () => {
  const step = { requiredKeywords: ["postman", "mail"], forbiddenKeywords: ["mine", "truck"], minHitRate: 0.5 };
  assert.deepEqual(evaluateProbeReply({ transcriptText: "I was a postman delivering mail.", step }), { hit: true, forbiddenCount: 0 });
  // Half of required suffices at the short-distance threshold.
  assert.deepEqual(evaluateProbeReply({ transcriptText: "mail is what I did.", step }), { hit: true, forbiddenCount: 0 });
  // Below the threshold is a miss.
  assert.deepEqual(evaluateProbeReply({ transcriptText: "I delivered parcels.", step }), { hit: false, forbiddenCount: 0 });
  // Any forbidden keyword is a confused, regardless of required hits.
  assert.deepEqual(evaluateProbeReply({ transcriptText: "I was a postman and I loved the mine.", step }), { hit: true, forbiddenCount: 1 });
  assert.deepEqual(evaluateProbeReply({ transcriptText: "", step }), { hit: false, forbiddenCount: 0, reason: "no_presentation_text" });
  // No reply text at all must never be scored as a hit.
  assert.deepEqual(evaluateProbeReply({ transcriptText: undefined, step }), { hit: false, forbiddenCount: 0, reason: "no_presentation_text" });
});

test("the probe committed-presentation gate requires a durable delta, never a stderr marker", () => {
  // The gate is the ONLY authority for "was there a reply for THIS turn". A
  // Class B stderr marker may be `admitted` or `rejected`; it is not the
  // durable fact. A turn with no durable committed delta must be a gap — never
  // a keyword match scored against older transcript text.
  //
  // No terminal at all is a gap.
  assert.deepEqual(probeTurnCommittedGate(undefined), { ok: false, reason: "probe_turn_not_terminal" });
  assert.deepEqual(probeTurnCommittedGate({ terminal: false }), { ok: false, reason: "probe_turn_not_terminal" });
  // Terminal but zero committed delta (admission rejected / commit never landed)
  // is a gap, even though a marker might have been seen.
  assert.deepEqual(probeTurnCommittedGate({ terminal: true, committedCompanionDelta: 0 }), {
    ok: false,
    reason: "probe_turn_no_committed_presentation",
  });
  assert.deepEqual(probeTurnCommittedGate({ terminal: true, committedCompanionDelta: -1 }), {
    ok: false,
    reason: "probe_turn_no_committed_presentation",
  });
  // Missing delta is also a gap (an older outcome shape has no durable delta).
  assert.deepEqual(probeTurnCommittedGate({ terminal: true }), {
    ok: false,
    reason: "probe_turn_no_committed_presentation",
  });
  // Only a positive durable delta opens keyword scoring.
  assert.deepEqual(probeTurnCommittedGate({ terminal: true, committedCompanionDelta: 1 }), { ok: true });
  assert.deepEqual(probeTurnCommittedGate({ terminal: true, committedCompanionDelta: 3 }), { ok: true });
});

test("audit harness writes the exact frozen schema-v2 deployment manifest for a chat-only run", () => {
  const principal = { playerId: "player_01", companionId: "companion_01", continuityId: "continuity_01" };
  assert.deepEqual(createAuditDeploymentManifest("C:/fresh-runtime", principal, "bootstrap_01"), {
    schemaVersion: 2,
    topology: "independent_chat_and_game_surfaces",
    runtimeRoot: "C:/fresh-runtime",
    principal,
    bootstrapOperationId: "bootstrap_01",
    authorityGeneration: 1,
  });
});

test("audit recorder emits monotonic offsets and fails closed on an unknown code", () => {
  let clock = 1_000;
  const recorder = createAuditRecorder({ startedAtMs: 1_000, now: () => clock });
  assert.deepEqual(recorder.record("lifecycle", "harness", "run.started", { status: "ready" }), {
    at: 0,
    kind: "lifecycle",
    actor: "harness",
    code: "run.started",
    meta: { status: "ready" },
  });
  assert.throws(() => recorder.record("lifecycle", "harness", "run.invented"), /audit_event_emitted_invalid:event_code_unknown/);
  // A clock that moves backwards cannot produce a non-monotonic trace.
  clock = 900;
  assert.equal(recorder.record("http", "harness", "state.read").at, 0);
  clock = 1_250;
  assert.equal(recorder.record("http", "harness", "state.read").at, 250);
  assert.deepEqual(
    recorder.events().map((event) => event.at),
    [0, 0, 250],
  );
});

test("audit event validation freezes the vocabulary, actor, and metadata surface", () => {
  assert.equal(validateAuditEvent({ at: 0, kind: "provider", actor: "host", code: "boundary_unsettled" }).ok, false);
  assert.equal(validateAuditEvent({ at: 0, kind: "presentation", actor: "host", code: "committed" }).ok, true);
  // The frozen table binds each code to exactly one actor.
  assert.deepEqual(validateAuditEvent({ at: 0, kind: "presentation", actor: "harness", code: "committed" }), {
    ok: false,
    reasonCode: "event_actor_mismatch",
  });
  // Only the frozen `meta` key set is expressible; a ninth key fails closed.
  assert.deepEqual(validateAuditEvent({ at: 0, kind: "presentation", actor: "harness", code: "admitted", meta: { detail: "x" } }), {
    ok: false,
    reasonCode: "event_meta_key_unknown",
  });
  assert.equal(validateAuditEvent({ at: 0, kind: "presentation", actor: "harness", code: "admitted", meta: { status: "admission_ok" } }).ok, true);
  assert.deepEqual(
    validateAuditEvent({
      at: 0,
      kind: "http",
      actor: "harness",
      code: "state.read",
      meta: { state: 1, reason: "a", problemCode: "b", disposition: "c", status: "d", count: 1, cursor: "e", generation: 1, providerObservability: "f", extra: 1 },
    }),
    { ok: false, reasonCode: "event_meta_too_many_keys" },
  );
  assert.deepEqual(validateAuditEvent({ at: -1, kind: "http", actor: "harness", code: "state.read" }), {
    ok: false,
    reasonCode: "event_at_invalid",
  });
  assert.deepEqual(validateAuditEvent({ at: 0, kind: "http", actor: "harness", code: "state.read", extra: 1 }), {
    ok: false,
    reasonCode: "event_unknown_field",
  });
  assert.deepEqual(validateAuditEvent({ at: 0, kind: "http", actor: "harness", code: "state.read", meta: { reason: "x".repeat(161) } }), {
    ok: false,
    reasonCode: "event_meta_value_invalid",
  });
});

test("audit trace self-validation rejects malformed traces so none can be written", async () => {
  assert.equal(validateAuditTrace(validTrace()).ok, true);
  const cases = [
    [{ ...validTrace(), schema: "chat_run_audit/v2" }, "trace_schema_invalid"],
    [{ ...validTrace(), runId: "" }, "trace_run_id_invalid"],
    [{ ...validTrace(), surface: "composed-reference-game" }, "trace_surface_invalid"],
    [{ ...validTrace(), originMs: 1 }, "trace_origin_invalid"],
    [{ ...validTrace(), artifact: { generation: "g-test-01", inventoryDigest: "nope" } }, "trace_artifact_invalid"],
    [{ ...validTrace(), provider: { embedded: true, observed: false } }, "trace_provider_observability_inconsistent"],
    [{ ...validTrace(), extra: true }, "trace_category_invalid"],
    [{ ...validTrace(), events: [] }, "trace_events_invalid"],
  ];
  for (const [trace, reasonCode] of cases) {
    assert.deepEqual(validateAuditTrace(trace), { ok: false, reasonCode }, reasonCode);
  }
  // A trace whose `at` moves backwards, or that lacks exactly one `run.finished`
  // carrying the observability self-report, is not writable.
  assert.deepEqual(
    validateAuditTrace(
      validTrace([
        { at: 5, kind: "http", actor: "harness", code: "state.read" },
        { at: 1, kind: "http", actor: "harness", code: "state.read" },
        { at: 9, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
      ]),
    ),
    { ok: false, reasonCode: "trace_at_not_monotonic" },
  );
  assert.deepEqual(
    validateAuditTrace(validTrace([{ at: 0, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { status: "collected" } }])),
    { ok: false, reasonCode: "event_provider_observability_missing" },
  );
  assert.deepEqual(
    validateAuditTrace(
      validTrace([
        { at: 0, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
        { at: 1, kind: "lifecycle", actor: "harness", code: "run.finished", meta: { providerObservability: "observed" } },
      ]),
    ),
    { ok: false, reasonCode: "trace_run_finished_invalid" },
  );
});

test("content guard rejects a trace that leaked prompt material, message bodies, or credentials", async () =>
  withRoot(async (root) => {
    assert.equal(contentFree(JSON.stringify(validTrace())), true);
    for (const leaked of [
      { schema: "chat_run_audit/v1", prompt: "private prompt" },
      { schema: "chat_run_audit/v1", body: "The player prefers tea" },
      { schema: "chat_run_audit/v1", header: "Authorization: Bearer abc" },
      { schema: "chat_run_audit/v1", key: "sk-abcdefghijklmnopqrstuvwxyz" },
    ]) {
      assert.equal(contentFree(JSON.stringify(leaked)), false, JSON.stringify(leaked));
    }
    const target = await prepareReportTarget(join(root, "leaked.json"));
    await assert.rejects(writeAuditTrace(target, { ...validTrace(), leaked: "private prompt" }), /audit_trace_invalid:trace_category_invalid/);
    // A trace whose only defect is a smuggled content line is refused by the
    // content guard, and the refused trace leaves no file behind.
    await assert.rejects(
      writeAuditTrace(target, {
        ...validTrace(),
        artifact: { generation: "g-test-01", inventoryDigest: DIGEST, note: "private prompt" },
      }),
      /audit_trace_invalid:trace_artifact_invalid/,
    );
    await assert.rejects(readFile(target, "utf8"), { code: "ENOENT" });
  }));

test("audit trace writer is create-only and refuses an invalid trace without writing a file", async () =>
  withRoot(async (root) => {
    const target = await prepareReportTarget(join(root, "trace.json"));
    await writeAuditTrace(target, validTrace());
    const onDisk = JSON.parse(await readFile(target, "utf8"));
    assert.equal(onDisk.schema, "chat_run_audit/v1");
    assert.deepEqual(validateAuditTrace(onDisk).ok, true);
    // Second write to the same target is refused, never overwritten.
    await assert.rejects(writeAuditTrace(target, validTrace()), { code: "EEXIST" });
    // A malformed trace is refused before any file handle is opened.
    const invalidTarget = await prepareReportTarget(join(root, "invalid.json"));
    await assert.rejects(writeAuditTrace(invalidTarget, { ...validTrace(), provider: { embedded: true, observed: "yes" } }), /audit_trace_invalid:/);
    await assert.rejects(readFile(invalidTarget, "utf8"), { code: "ENOENT" });
    // `console` path only returns the serialized trace without touching disk.
    assert.match(await writeAuditTrace(undefined, validTrace()), /"schema": "chat_run_audit\/v1"/);
  }));

test("report target preparation fails closed for a missing or non-directory parent", async () =>
  withRoot(async (root) => {
    await assert.rejects(prepareReportTarget(join(root, "missing", "trace.json")), /report_parent_missing_or_unresolvable/);
    const parentFile = join(root, "not-a-directory");
    await writeFile(parentFile, "not a directory");
    await assert.rejects(prepareReportTarget(join(parentFile, "trace.json")), /report_parent_not_real_directory/);
  }));

test("audit harness classifies bounded startup stderr for exit-before-ready failures", () => {
  assert.equal(
    classifyStartupStderr("Error: dialogue_deployment_manifest_path_required\n"),
    "dialogue_start_stderr:dialogue_deployment_manifest_path_required",
  );
  assert.equal(
    classifyStartupFailure(new Error("dialogue_exited_before_ready:1"), "desktop_compose_runtime_admission_mismatch\n"),
    "dialogue_start_stderr:desktop_compose_runtime_admission_mismatch",
  );
  assert.equal(classifyStartupFailure(new Error("desktop_compose_bootstrap_ack_invalid"), ""), "desktop_compose_bootstrap_ack_invalid");
  // Runtime content never becomes a reason code.
  assert.equal(classifyStartupStderr("Error: private prompt text\n"), undefined);
  assert.equal(classifyStartupFailure(new Error("dialogue_exited_before_ready:1"), ""), "dialogue_exited_before_ready:1");
});

test("provider evidence requires the exact session identity, digest, and marker schema", () => {
  assert.deepEqual(evaluateProviderRuntimeMarker({ schema: "gamebuddy-tavern-narrative-gate-runtime/v1", piSessionId: "pi_01" }), {
    observed: true,
    piSessionId: "pi_01",
  });
  assert.deepEqual(evaluateProviderRuntimeMarker(undefined), { observed: false, reasonCode: "provider_runtime_session_unavailable" });
  assert.deepEqual(evaluateProviderPreSendMarker(undefined, DIGEST, "pi_01"), {
    observed: false,
    reasonCode: "provider_marker_unavailable",
  });
  assert.deepEqual(
    evaluateProviderPreSendMarker({ schema: "gamebuddy-tavern-narrative-gate-marker/v1", sessionId: "pi_01", nonceSha256: DIGEST }, DIGEST, "pi_01"),
    { observed: true, preSendSerialized: true },
  );
  assert.equal(
    evaluateProviderPreSendMarker({ schema: "gamebuddy-tavern-narrative-gate-marker/v1", sessionId: "pi_01", nonceSha256: DIGEST }, DIGEST, "pi_02").reasonCode,
    "provider_marker_digest_mismatch",
  );
  assert.equal(
    evaluateProviderPreSendMarker({ schema: "gamebuddy-tavern-narrative-gate-marker/v1", sessionId: "pi_01", nonceSha256: "bad" }, DIGEST, "pi_01").reasonCode,
    "provider_marker_schema_invalid",
  );
});

test("presentation diagnostics read only the frozen production stderr markers", () => {
  assert.deepEqual(
    classifyPresentationMarkers("[DEBUG-chat-live-p4c] admission_ok\n[DEBUG-chat-live-p4c] commit_done\n[DEBUG-chat-live-p4c] commit_rejected\n"),
    [{ code: "admitted", status: "admission_ok" }, { code: "rejected", reason: "commit_rejected" }],
  );
  // `native_final` and `commit_done` are not admission evidence and never become
  // a Class B fact; only the frozen marker shapes are read.
  assert.deepEqual(classifyPresentationMarkers("[DEBUG-chat-live-p4c] native_final\n"), []);
  assert.deepEqual(classifyPresentationMarkers("ordinary stderr line\n"), []);
  assert.deepEqual(classifyPresentationMarkers(undefined), []);
});

test("probe materialization markers are parsed strictly and never become frozen codes", () => {
  const digest = "a".repeat(64);
  assert.deepEqual(
    classifyProbeMaterializationMarkers(
      `[probe:m0_digest] ${digest} rev_7\n[probe:fold_committed] rev_123\n`,
    ),
    [
      { code: "m0_digest", digest, revision: "rev_7" },
      { code: "fold_committed", revision: "rev_123" },
    ],
  );
  // Malformed values are ignored (marker absence is a gap, never an error).
  assert.deepEqual(classifyProbeMaterializationMarkers("[probe:m0_digest] not-hex\n"), []);
  assert.deepEqual(classifyProbeMaterializationMarkers("[probe:fold_committed] rev with spaces\n"), []);
  assert.deepEqual(classifyProbeMaterializationMarkers("[probe:unknown] x\n"), []);
  assert.deepEqual(classifyProbeMaterializationMarkers("ordinary stderr\n"), []);
  assert.deepEqual(classifyProbeMaterializationMarkers(undefined), []);
  // A digest without its revision cannot support §5.4's "same revision, same
  // digest" comparison, so it is not reported as evidence at all.
  assert.deepEqual(classifyProbeMaterializationMarkers(`[probe:m0_digest] ${digest}\n`), []);
  // The revision token must itself be well-formed.
  assert.deepEqual(classifyProbeMaterializationMarkers(`[probe:m0_digest] ${digest} rev with spaces\n`), []);
});

test("SSE frames are parsed strictly and rejected frames are reported rather than dropped", () => {
  assert.deepEqual(parseSseFrame('id: cur_01\nevent: turn.state_changed\ndata: {"eventType":"turn.state_changed","payload":{"state":"completed"}}'), {
    ok: true,
    cursor: "cur_01",
    eventType: "turn.state_changed",
    payload: { eventType: "turn.state_changed", payload: { state: "completed" } },
  });
  assert.deepEqual(parseSseFrame("event: turn.state_changed\n"), { ok: false, reason: "incomplete_frame" });
  assert.deepEqual(parseSseFrame("event: x\ndata: not-json"), { ok: false, reason: "invalid_json" });
  assert.deepEqual(parseSseFrame('event: x\ndata: {"eventType":"y"}'), { ok: false, reason: "event_type_mismatch" });
  assert.deepEqual(parseSseFrame("malformed\nevent: x\ndata: {}"), { ok: false, reason: "malformed_line" });
});

test("durable state projection and reload comparison use only the authoritative snapshot", () => {
  const snapshot = {
    selection: { generation: 7 },
    chat: {
      draft: { revision: 3 },
      turn: { handle: "turn_01", state: "completed", projectionRevision: 1, canCancel: false },
      transcript: [
        { role: "player" },
        { role: "companion" },
        { role: "companion" },
      ],
    },
    memory: { readAvailable: true, mutationAvailable: false, projectionRevision: "h" },
  };
  const projection = projectStateSnapshot(snapshot);
  assert.deepEqual(projection, {
    selectionGeneration: 7,
    draftRevision: 3,
    turnHandle: "turn_01",
    turnState: "completed",
    problemCode: undefined,
    canCancel: false,
    transcriptLength: 3,
    committedCompanionMessages: 2,
    memoryReadAvailable: true,
  });
  assert.equal(projectStateSnapshot({ chat: null }), undefined);
  assert.equal(projectStateSnapshot({ selection: { generation: 1 }, chat: {} }).turnState, undefined);

  // Probe keyword matching sees ONLY the last committed companion reply. Joining
  // the transcript would let an earlier turn satisfy a keyword match, so a
  // `distractor.confused` could not be attributed to the probe turn at all.
  const withHistory = projectStateSnapshot({
    selection: { generation: 7 },
    chat: {
      turn: { handle: "turn_02", state: "completed", canCancel: false },
      transcript: [
        { role: "companion", text: "an earlier reply mentioning the mine" },
        { role: "player", text: "a later question" },
        { role: "companion", text: "the reply to the probe turn" },
      ],
    },
  });
  assert.equal(withHistory.committedCompanionText, "the reply to the probe turn");
  // A trailing non-text companion message must not resurrect earlier text.
  const nonTextLast = projectStateSnapshot({
    selection: { generation: 7 },
    chat: {
      turn: { handle: "turn_03", state: "completed", canCancel: false },
      transcript: [
        { role: "companion", text: "earlier text" },
        { role: "companion" },
      ],
    },
  });
  assert.equal(Object.hasOwn(nonTextLast, "committedCompanionText"), false);

  assert.deepEqual(compareReloadSnapshot(projection, projection), { consistent: true, reason: undefined });
  assert.deepEqual(compareReloadSnapshot(projection, { ...projection, turnHandle: "turn_02" }), {
    consistent: false,
    reason: "turn_handle_changed",
  });
  assert.deepEqual(compareReloadSnapshot(projection, { ...projection, turnState: "failed" }), {
    consistent: false,
    reason: "turn_state_changed",
  });
  assert.deepEqual(compareReloadSnapshot(projection, { ...projection, transcriptLength: 2 }), {
    consistent: false,
    reason: "transcript_truncated",
  });
  assert.deepEqual(compareReloadSnapshot(projection, { ...projection, committedCompanionMessages: 1 }), {
    consistent: false,
    reason: "committed_presentation_lost",
  });
  assert.deepEqual(compareReloadSnapshot(projection, { ...projection, selectionGeneration: 8 }), {
    consistent: false,
    reason: "selection_generation_changed",
  });
});

test("audit harness stays on the composition bootstrap and authenticated Chat API and never fabricates a completed turn", async () => {
  const source = await readFile(new URL("./run-chat-live-audit.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /node:sqlite|DatabaseSync|sqlite3/i);
  assert.doesNotMatch(source, /page\.route|autoPromote|auto_promote\s*:\s*true/i);
  assert.match(source, /from "\.\/desktop-composition-launch\.mjs"/);
  assert.match(source, /launchDesktopCompositionGateChild\(/);
  assert.match(source, /surface: AUDIT_SURFACE/);
  assert.match(source, /const AUDIT_SURFACE = "chat-only";/);
  assert.match(source, /outputRoot: join\(HOST_ROOT, "dist"\)/);
  assert.match(source, /\/api\/tavern\/v1\/bootstrap/);
  assert.match(source, /\/api\/tavern\/v1\/messages/);
  assert.match(source, /\/api\/tavern\/v1\/events\?apiVersion=1/);
  assert.match(source, /\/api\/tavern\/v1\/turns\/\$\{encodeURIComponent\(turnHandle\)\}\/cancel/);
  assert.match(source, /X-CSRF-Token/);
  assert.match(source, /Idempotency-Key/);
  assert.match(source, /chat_run_audit\/v1/);
  assert.match(source, /provider\.boundary_unsettled|"boundary_unsettled"/);
  assert.doesNotMatch(source, /"provider_boundary_unsettled"/);
  // The authoritative presentation fact may only come from the durable
  // transcript projection, never from a Class B stderr marker.
  assert.match(source, /committedCompanionMessages/);
  assert.doesNotMatch(source, /commit_done[\s\S]{0,120}"committed"/);
  assert.doesNotMatch(source, /GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256/);
  assert.doesNotMatch(source, /presentation_admission|admission-marker/);
  // The observation reader must carry its SSE cursor across turns and must stop
  // waiting for a terminal when the host closes a resync response — otherwise the
  // harness manufactures a `gap` and then reports its own 180 s wait as a product
  // idle stall (which is exactly how the first two live runs read).
  assert.match(source, /cursor: environment\.streamCursor/);
  assert.match(source, /environment\.streamCursor = stream\.cursor\(\)/);
  assert.match(source, /settleTerminal\("resync"\)/);
  // The probe "is there a committed presentation" gate must use the DURABLE
  // committed-companion delta, never the Class B stderr marker count (a marker
  // can be a rejection, and is not the durable fact). Otherwise a turn that only
  // produced an admission rejection would read older transcript text and score a
  // distractor/needle verdict against it.
  assert.match(source, /committedCompanionDelta/);
  assert.match(source, /outcome\.committedCompanionDelta/);
  assert.doesNotMatch(source, /const committed = environment\.presentationMarkers > before/);
});
