#!/usr/bin/env node
/**
 * The third live-run loop: memory.
 *
 * The Chat loop closes its assertions inside one session, and the Game ladder
 * proves native mutation. Neither can say WHICH layer loses a fact that the player
 * stated. This runner answers that, using the four-stage funnel
 * (tools/lib/memory-funnel.mjs, design section 10).
 *
 * Topology (design 10.1, verified against the compositions rather than assumed):
 * no single mounted surface holds both halves. `chat-only` mounts
 * chat.submit/chat.cancel/events but NO memory route; `management` mounts
 * memory.read/memory.mutate but no chat submit. So this runner runs the two halves
 * against the SAME principal.continuityId.
 *
 * That the two halves really share storage is not a hope: resolveRuntimePaths()
 * partitions only sessionDir by surfaceSessionId and leaves runtimeCwd keyed by
 * (playerId, companionId, continuityId), and the Memory service consumes exactly
 * that runtimeCwd. What is NOT yet proven end-to-end is whether assembly (L2/L3)
 * sees the seeded fact; this runner exists to find out.
 *
 * Causal ordering is enforced, not hoped for (reviewer discipline): the seed must
 * be confirmed by the durable readback of the management route BEFORE any chat turn
 * starts. A run where the seed did not land reports the L1 gap and stops - it never
 * proceeds to interpret a later miss.
 *
 * Refuses to read the vendor SQLite directly: the harness runs outside the child
 * and a second connection would risk WAL contention and break the evidence-class
 * discipline. L2 therefore reports a gap until a Host-side diagnostic projection
 * exposes the rendered ids (design 10.8 step 3), and this runner never pretends
 * otherwise.
 *
 * Maintenance contract: this is a runner for the REAL product surfaces. It may not
 * be replaced by a fixture that writes memory rows, by a mock provider, or by a
 * hand-authored funnel report - any of those would turn the loop into
 * self-certification. After each real run, audit the trace with the `auditing-runs`
 * skill and dispatch a reviewer subagent; record what it finds in
 * design/handbook/live-run-patterns.md.
 */
import { spawn } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";
import { evaluateProbeReply, loadProbeManifest, openEventStream, probeTurnCommittedGate, probeVerdict } from "./run-chat-live-audit.mjs";
import { attributeMemoryFunnel } from "./lib/memory-funnel.mjs";

const HOST_ROOT = resolve(fileURLToPath(new URL("../host/", import.meta.url)));
const OUTPUT_ROOT = process.env.GAMEBUDDY_MEMORY_LOOP_OUTPUT_ROOT
  ? resolve(process.env.GAMEBUDDY_MEMORY_LOOP_OUTPUT_ROOT)
  : join(HOST_ROOT, "dist");
const REQUEST_TIMEOUT_MS = 15_000;
const START_TIMEOUT_MS = 60_000;

/** Unique per run so each loop gets its own Memory partition, never a stale one. */
function createIdentity() {
  const suffix = randomBytes(6).toString("hex");
  return Object.freeze({
    playerId: `memory_loop_player_${suffix}`,
    companionId: `memory_loop_companion_${suffix}`,
    continuityId: `memory_loop_continuity_${suffix}`,
  });
}

function usage() {
  return "usage: node tools/run-memory-live-loop.mjs --report <path> [--manifest <probe-fixture.json>] [--seed <text>] [--question <text>]";
}

function parseArguments(argv) {
  const flags = new Map([
    ["--report", undefined],
    ["--seed", undefined],
    ["--question", undefined],
    ["--manifest", undefined],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") return Object.freeze({ help: true });
    if (!flags.has(flag)) throw new Error(`${usage()} (unknown flag: ${flag})`);
    const value = argv[index + 1];
    // A value that is itself a known flag means the caller forgot it; refusing is
    // better than silently consuming the next flag as text.
    if (value === undefined || flags.has(value)) throw new Error(usage());
    flags.set(flag, value);
    index += 1;
  }
  const reportPath = flags.get("--report");
  if (typeof reportPath !== "string" || reportPath.length === 0) throw new Error(usage());
  return Object.freeze({
    help: false,
    reportPath: resolve(reportPath),
    manifestPath: flags.get("--manifest"),
    seed: flags.get("--seed"),
    question: flags.get("--question"),
  });
}

/**
 * Resolve the seeded fact and the probe question.
 *
 * The preferred source is a `chat_memory_probe_manifest/v1` fixture: probe text is
 * fixture-owned by design and must never be invented by the runner, and consuming the
 * same fixtures the Chat loop uses keeps the two loops' scenarios comparable. Inline
 * text stays available for a one-off decision and is used only when no manifest is
 * given.
 */
async function resolveScenario({ manifestPath, seed, question }) {
  if (manifestPath === undefined) {
    return Object.freeze({
      seed: seed ?? "Remember this for later: I retired after many years delivering the post.",
      question: question ?? "What did I do before I retired?",
      probeId: undefined,
      manifestDigest: undefined,
      dimension: "retention",
      requiredKeywords: ["postman", "mail", "delivering"],
      forbiddenKeywords: ["mine", "haul"],
      minHitRate: 0.5,
    });
  }
  const manifest = loadProbeManifest(await readFile(resolve(manifestPath), "utf8"));
  if (manifest.probes.length !== 1)
    throw new Error("probe_fixture_multi_probe_unsupported");
  const probe = manifest.probes[0];
  const seedStep = probe.steps.find((step) => step.kind === "seed");
  const probeStep = probe.steps.find((step) => step.kind === "probe");
  if (seedStep === undefined || probeStep === undefined) throw new Error("probe_fixture_incomplete");
  return Object.freeze({
    seed: seedStep.text,
    question: probeStep.text,
    probeId: probe.probeId,
    manifestDigest: manifest.manifestDigest,
    dimension: probe.dimension,
    requiredKeywords: probeStep.requiredKeywords,
    forbiddenKeywords: probeStep.forbiddenKeywords ?? [],
    // The fixture's own threshold must survive into scoring (audit finding: the
    // loop hardcoded 0.5, silently over-ruling a manifest that declares 1.0).
    minHitRate: Number.isFinite(probeStep.minHitRate) ? probeStep.minHitRate : 0.5,
  });
}

async function deadlineFetch(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function bootstrap(origin, token) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/bootstrap`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ apiVersion: 1, bootstrapToken: token }),
  });
  const body = await response.json().catch(() => undefined);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (!response.ok || typeof cookie !== "string" || typeof body?.csrfToken !== "string")
    throw new Error(`bootstrap_failed:${response.status}`);
  return Object.freeze({ cookie, csrf: body.csrfToken });
}

async function readMemory(origin, client) {
  const response = await deadlineFetch(`${origin}/api/tavern/v1/memory`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  if (!response.ok) throw new Error(`memory_read_failed:${response.status}`);
  return response.json();
}

/**
 * Phase 1: seed through the management surface and confirm durability from the
 * route's OWN readback. `mutate()` ends with projectRows(await readRows()), so a
 * 200 whose body contains the row IS the durability evidence - no second query and
 * no direct SQLite read is needed or wanted.
 */
async function seedMemory(origin, client, seedText) {
  const before = await readMemory(origin, client);
  if (typeof before?.projectionRevision !== "string") throw new Error("projection_revision_unavailable");
  const response = await deadlineFetch(`${origin}/api/tavern/v1/memory`, {
    method: "PUT",
    headers: {
      Cookie: client.cookie,
      Origin: origin,
      "Content-Type": "application/json",
      "x-csrf-token": client.csrf,
    },
    body: JSON.stringify({
      apiVersion: 1,
      expectedProjectionRevision: before.projectionRevision,
      operation: "create",
      content: seedText,
    }),
  });
  if (!response.ok) throw new Error(`memory_seed_failed:${response.status}`);
  const after = await response.json();
  const seeded = Array.isArray(after?.memories) ? after.memories.some((row) => row?.content === seedText) : false;
  return Object.freeze({
    durable: seeded === true,
    rowCount: Array.isArray(after?.memories) ? after.memories.length : 0,
    // The opaque handle is the ONLY stable cross-phase reference we keep: it is the
    // product's own projection of the row and carries no content.
    seedHandle: seeded ? after.memories.find((row) => row.content === seedText)?.handle : undefined,
    projectionChanged: after?.projectionRevision !== before.projectionRevision,
  });
}

/**
 * Phase 2: run a real turn on the chat-only surface under the SAME continuity and
 * capture the committed companion text. The text is used for keyword scoring and is
 * never written into the report.
 *
 * Route and shapes are taken from the existing harness rather than guessed: the
 * submit route is `/messages` (202 + `disposition`), and the committed reply is the
 * LAST `role: "companion"` transcript entry - not any earlier turn's text, which
 * would make the verdict a statement about the conversation instead of this turn.
 */
async function runChatTurn(origin, client, text) {
  const stateResponse = await deadlineFetch(`${origin}/api/tavern/v1/state`, {
    headers: { Cookie: client.cookie, Origin: origin },
  });
  const state = await stateResponse.json().catch(() => undefined);
  const selectionGeneration = state?.selection?.generation;
  if (!Number.isSafeInteger(selectionGeneration)) throw new Error("selection_generation_unavailable");
  const draftRevision = Number.isSafeInteger(state?.chat?.draft?.revision) ? state.chat.draft.revision : undefined;

  const response = await deadlineFetch(`${origin}/api/tavern/v1/messages`, {
    method: "POST",
    headers: {
      Origin: origin,
      Cookie: client.cookie,
      "X-CSRF-Token": client.csrf,
      "Idempotency-Key": randomBytes(16).toString("base64url"),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      apiVersion: 1,
      selectionGeneration,
      text,
      locale: "en",
      ...(draftRevision === undefined ? {} : { expectedDraftRevision: draftRevision }),
    }),
  });
  if (response.status !== 202) throw new Error(`message_failed:${response.status}`);

  // The terminal wait is SSE-driven with a bounded state cross-check, mirroring
  // the Chat harness (audit finding: the loop used to poll /state every 250 ms for
  // up to 180 s = ~720 authenticated reads for ONE turn; the harness waits on its
  // SSE observation stream and does a bounded state read-back). The stream records
  // nothing here - it exists only as the terminal authority.
  const stream = await openEventStream({ origin, client, recorder: noopRecorder });
  const streamTerminal = stream.ok ? await stream.waitForTerminal(180_000) : "unavailable";
  await stream.close?.().catch(() => undefined);
  // The durable /state read-back stays authoritative either way: when the stream
  // settled it confirms the terminal; when the stream was closed early (a resync
  // the observer itself forced, or a timeout) it is the only authority we have.
  return readTurnOutcome(origin, client, streamTerminal);
}

/**
 * Read the durable /state read-back exactly once and project the outcome. The
 * transcript for a fresh chat-only surface session starts empty, so the companion
 * count IS this turn's delta - there are no earlier turns to leak in.
 */
async function readTurnOutcome(origin, client, streamTerminal) {
  const snapshot = await (
    await deadlineFetch(`${origin}/api/tavern/v1/state`, { headers: { Cookie: client.cookie, Origin: origin } })
  ).json();
  const turnState = snapshot?.chat?.turn?.state ?? null;
  const transcript = Array.isArray(snapshot?.chat?.transcript) ? snapshot.chat.transcript : [];
  const companion = transcript.filter((message) => message?.role === "companion");
  const last = companion.at(-1);
  return Object.freeze({
    turnState,
    streamTerminal: streamTerminal ?? null,
    committedCompanionMessages: companion.length,
    committedCompanionDelta: companion.length,
    committedText: typeof last?.text === "string" ? last.text : undefined,
  });
}

const noopRecorder = Object.freeze({ record() {} });

async function withSurface({ surface, run, root, deploymentManifestPath, gameSessionMode = "fresh" }) {
  if (typeof root !== "string" || root.length === 0) throw new Error("runtime_root_required");
  if (typeof deploymentManifestPath !== "string" || deploymentManifestPath.length === 0)
    throw new Error("deployment_manifest_path_required");
  await mkdir(root, { recursive: true });
  const nonceSha256 = createHash("sha256").update(randomBytes(32)).digest("hex");

  let stderr = "";
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: OUTPUT_ROOT,
    root,
    surface,
    nonceSha256,
    manifestPath: deploymentManifestPath,
    readyTimeoutMs: START_TIMEOUT_MS,
    gameSessionMode,
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
        if (stderr.length < 2_048) stderr = `${stderr}${chunk}`;
      });
      return child;
    },
  });
  try {
    const launchUrl = await launch.waitForReady();
    const url = new URL(launchUrl);
    const origin = `${url.protocol}//${url.host}`;
    const bootstrapToken = new URLSearchParams(url.hash.slice(1)).get("boot");
    if (bootstrapToken === null) throw new Error("bootstrap_token_missing");
    const client = await bootstrap(origin, bootstrapToken);
    return await run(origin, client);
  } catch (error) {
    const diagnostic = stderr.trim();
    throw new Error(
      diagnostic.length > 0
        ? `${surface}:${error?.message ?? "surface_failed"}:${diagnostic}`
        : `${surface}:${error?.message ?? "surface_failed"}`,
    );
  } finally {
    launch.dispose?.();
    await stopChildGracefully(launch.child);
  }
}

/**
 * Stop the child the way the product intends: SIGTERM first, and WAIT for the
 * process to exit.
 *
 * The audit's successor path proved this is not a nicety. `known` mount writes a
 * `select_chat` successor bridge that the store admits ONLY after the exact
 * predecessor achat-runtime teardown has committed - and teardown commits on the
 * child's own termination path. The first version of this runner killed the child
 * outright, so nothing committed, and phase 2 died with
 * `chat_runtime_reentry_selection_invalid`. The Chat narrative gate already stops
 * children exactly this way (`run-tavern-narrative-gate.mjs:237`).
 */
async function stopChildGracefully(child, timeoutMs = 30_000) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(true))),
    new Promise((resolveExit) => setTimeout(() => resolveExit(false), timeoutMs)),
  ]);
  if (exited) return;
  child.kill("SIGKILL");
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", () => resolveExit(undefined))),
    new Promise((resolveExit) => setTimeout(resolveExit, 1_000)),
  ]);
}

/**
 * One disposable root for the WHOLE memory loop, shared across both phases.
 *
 * A reviewer of the first memory-loop runs proved this was the fatal design flaw:
 * `withSurface` used to `mkdtemp` per phase, so the management phase and the
 * chat-only phase resolved DIFFERENT `runtimeCwd`s (resolveRuntimePaths keys the
 * cwd by identity, but under the phase's OWN root). The seed row was written to one
 * SQLite file and the chat turn read another - the loop could not have measured
 * cross-phase memory even in principle. One root for both phases is what makes
 * "seed on management, ask on chat-only" a real storage-identity claim.
 *
 * The root is also removed here, not leaked: the old code never cleaned it, so
 * every run left two generation copies rotting in %TEMP%.
 */
async function withMemoryLoopRoot(run) {
  const root = await mkdtemp(join(tmpdir(), "gamebuddy-memory-loop-"));
  // Diagnosis escape hatch: keep the root so the authority DB can be inspected after
  // a failure (which is how the storage-identity claims get checked). Unset means the
  // normal path, where the root is removed.
  const keepRoot = process.env.GAMEBUDDY_MEMORY_LOOP_KEEP_ROOT === "1";
  try {
    return await run(root);
  } finally {
    if (!keepRoot) await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Score the reply with the FROZEN kernel rule, not a second implementation.
 *
 * The Chat loop already owns probe scoring (`evaluateProbeReply` + `probeVerdict`: the
 * threshold, the dimension routing, and the two causes of `distractor.confused`).
 * Re-implementing it here - even "better", with word boundaries - would let the two
 * loops disagree about the same reply, which is exactly the drift the frozen
 * vocabulary exists to prevent.
 */
function scoreReply({ committedText, scenario, chat }) {
  // A keyword verdict may ONLY be scored against a turn that durably committed a
  // companion reply for THIS turn (the same gate the Chat harness uses). A turn that
  // failed, was cancelled, or committed no new companion text is an observability
  // gap, NEVER a scored miss - the audit's finding: the loop used to hardcode
  // `gate: { ok: true }`, so a failed turn was scored as needle.miss and (once L2
  // gets a producer) mis-attributed to presentation admission.
  const gate = probeTurnCommittedGate({
    terminal: chat.turnState !== null && chat.turnState !== undefined,
    committedCompanionDelta: chat.committedCompanionDelta ?? 0,
  });
  if (!gate.ok) return verdict_gap(gate.reason);
  const keywords = evaluateProbeReply({
    transcriptText: committedText,
    step: {
      requiredKeywords: scenario.requiredKeywords,
      forbiddenKeywords: scenario.forbiddenKeywords,
      minHitRate: scenario.minHitRate ?? 0.5,
    },
  });
  return probeVerdict({ gate: { ok: true }, keywords, dimension: scenario.dimension });
}

function verdict_gap(reason) {
  return Object.freeze({ event: "observability_gap", reason });
}

export async function runMemoryLiveLoop({ reportPath, manifestPath, seed, question } = {}) {
  if (typeof reportPath !== "string" || reportPath.length === 0) throw new Error("report_path_required");
  const scenario = await resolveScenario({ manifestPath, seed, question });
  const identity = createIdentity();

  // One root for BOTH phases. A reviewer of the first runs proved this is the fatal
  // invariant: with a fresh root per phase, the management write and the chat read
  // lived in different SQLite files (runtimeCwd is identity-keyed UNDER the phase's
  // own root), so the loop could not measure cross-phase memory even in principle.
  return withMemoryLoopRoot(async (root) => {
    // ONE deployment manifest and ONE bootstrap operation for the whole loop. The
    // authority marker records the bootstrap operation, and `known` open validates it
    // exactly - so writing a second manifest with a fresh bootstrapOperationId made
    // phase 2 fail with `production_authority_artifact_present`. One loop is one
    // deployment identity.
    const deploymentManifestPath = join(root, "memory-loop.json");
    await writeFile(
      deploymentManifestPath,
      JSON.stringify(
        {
          schemaVersion: 2,
          topology: "independent_chat_and_game_surfaces",
          runtimeRoot: root,
          principal: { ...identity },
          bootstrapOperationId: `memory_loop_${randomBytes(12).toString("hex")}`,
          authorityGeneration: 1,
        },
        null,
        2,
      ),
      "utf8",
    );
    // Phase 1 - management surface: seed and confirm durability.
    process.stderr.write(`[memory-loop] phase1 management launching (root=${root})\n`);
    const seeded = await withSurface({
      surface: "management",
      root,
      deploymentManifestPath,
      run: async (origin, client) => seedMemory(origin, client, scenario.seed),
    });
    process.stderr.write(`[memory-loop] phase1 durable=${seeded.durable}\n`);

    const observation = {
      distance: "turn",
      seedRequired: true,
      seedPresentInReadback: seeded.durable,
    };

    // Causal gate: a seed we could not confirm durable means L1 is unproven, so the
    // run reports that and stops. Proceeding would let a later miss be blamed on
    // recall when the fact may never have been stored.
    if (!seeded.durable) {
      const attributed = attributeMemoryFunnel(observation);
      const report = Object.freeze({
        schema: "memory_live_loop/v1",
        identity: Object.freeze({ continuityId: identity.continuityId }),
        seed: Object.freeze({ durable: false, rowCount: seeded.rowCount }),
        chat: Object.freeze({ attempted: false, reason: "seed_not_durable" }),
        funnel: attributed,
      });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return report;
    }

    // Phase 2 - chat-only surface, SAME root, SAME continuity: ask the question.
    // Session mode `known` OPENS the authority that phase 1's management surface
    // provisioned, instead of provisioning a fresh one. This is the storage-identity
    // core of the whole loop: a fresh second phase would create an EMPTY second
    // SQLite and the seeded row could never be seen (the audit's finding).
    //
    // KNOWN BOUNDARY (measured, not assumed): the product admits a `known` mount as a
    // terminal SUCCESSOR, which requires the predecessor chat-runtime teardown to have
    // COMMITTED, and that commit happens only inside the child's own close path
    // (desktop-runtime-bootstrap finally -> composition.close()). This launcher has no
    // way to ask a composed child to close: child.kill("SIGTERM") forcibly terminates
    // and the handler never runs (proved by probe: exit signal SIGTERM, handler not
    // invoked), and disposing the guardian peer alone does not make the child exit
    // (probe: no_exit_after_dispose, teardown_intent stays empty). The memory loop
    // therefore reports this as a bounded, attributable BLOCKED state rather than
    // crashing with a raw child-exit error or pretending the phase ran.
    process.stderr.write(`[memory-loop] phase2 chat-only launching known\n`);
    let chat;
    try {
      chat = await withSurface({
        surface: "chat-only",
        root,
        deploymentManifestPath,
        gameSessionMode: "known",
        run: async (origin, client) => runChatTurn(origin, client, scenario.question),
      });
    } catch (error) {
      const message = String(error?.message ?? error);
      const reentryBlocked = message.includes("chat_runtime_reentry_selection_invalid");
      if (!reentryBlocked) throw error;
      const attributed = attributeMemoryFunnel({
        distance: "turn",
        seedRequired: true,
        seedPresentInReadback: true,
      });
      const report = Object.freeze({
        schema: "memory_live_loop/v1",
        identity: Object.freeze({ continuityId: identity.continuityId }),
        runtimeRootKey: createHash("sha256").update(identity.continuityId).digest("hex").slice(0, 16),
        scenario: Object.freeze({
          ...(scenario.probeId === undefined ? {} : { probeId: scenario.probeId }),
          ...(scenario.manifestDigest === undefined ? {} : { manifestDigest: scenario.manifestDigest }),
          dimension: scenario.dimension,
        }),
        seed: Object.freeze({ durable: true, rowCount: seeded.rowCount, projectionChanged: seeded.projectionChanged }),
        chat: Object.freeze({
          attempted: true,
          launched: false,
          reason: "phase2_reentry_requires_predecessor_teardown",
        }),
        funnel: attributed,
      });
      await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
      return report;
    }

    const verdict = scoreReply({ committedText: chat.committedText, scenario, chat });

    const attributed = attributeMemoryFunnel({
      ...observation,
      probeEvent: verdict.event,
      ...(verdict.reason === undefined ? {} : { probeReason: verdict.reason }),
    });

    const report = Object.freeze({
      schema: "memory_live_loop/v1",
      identity: Object.freeze({ continuityId: identity.continuityId }),
      // The one storage fact that lets a reader SEE that both phases shared a root.
      runtimeRootKey: createHash("sha256").update(identity.continuityId).digest("hex").slice(0, 16),
      scenario: Object.freeze({
        ...(scenario.probeId === undefined ? {} : { probeId: scenario.probeId }),
        ...(scenario.manifestDigest === undefined ? {} : { manifestDigest: scenario.manifestDigest }),
        dimension: scenario.dimension,
      }),
      seed: Object.freeze({ durable: true, rowCount: seeded.rowCount, projectionChanged: seeded.projectionChanged }),
      chat: Object.freeze({
        attempted: true,
        turnState: chat.turnState ?? null,
        committedCompanionDelta: chat.committedCompanionDelta ?? 0,
        committed: typeof chat.committedText === "string" && chat.committedText.length > 0,
        // Content-free: the reply text is scored here and never persisted.
        verdict: verdict.event,
        ...(verdict.reason === undefined ? {} : { verdictReason: verdict.reason }),
      }),
      funnel: attributed,
    });
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    return report;
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    const report = await runMemoryLiveLoop({
      reportPath: parsed.reportPath,
      manifestPath: parsed.manifestPath,
      seed: parsed.seed,
      question: parsed.question,
    });
    process.stdout.write(
      `${JSON.stringify({
        state: report.seed.durable ? "collected" : "blocked",
        verdict: report.chat.verdict ?? null,
        stages: report.funnel.stages.map((row) => `${row.stage}:${row.status}`),
        findings: report.funnel.findings.length,
      })}\n`,
    );
  }
}
