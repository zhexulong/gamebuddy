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
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { launchDesktopCompositionGateChild } from "./desktop-composition-launch.mjs";
import { evaluateProbeReply, loadProbeManifest, openEventStream, probeTurnCommittedGate, probeVerdict } from "./run-chat-live-audit.mjs";
import { attributeMemoryFunnel, foldCommittedRenderedIdsFromMarkers, renderedMemoryIdsFromMarkers, renderedChaptersFromMarkers } from "./lib/memory-funnel.mjs";
import { openLiveRunCapture, resolveLiveRunRoot } from "./live-run/core/capture.mjs";

// Live-run evidence root (repo-local, git-ignored): every memory loop run keeps
// its own directory with the runtime root's evidence and the child stderr, so a
// reviewer can see what actually reached the model instead of only digest facts.
const LIVE_RUN_ROOT = resolveLiveRunRoot({ repoRoot: new URL("../..", import.meta.url).pathname });

/**
 * The Class B marker Magic Context emits with the ids it assembled into m[0]
 * (owner decision D-1: vendor stderr, never an IPC frame). Declared here rather
 * than imported from `@cortexkit/pi-magic-context/tavern` because these runners
 * resolve their dependencies from the repository root, where Host's vendored
 * package is not linked - and a runner that cannot start is worse than one with a
 * pinned literal. `assertMarkerContract` fails loudly if the vendor ever renames
 * it, so the duplication cannot rot silently.
 */
const PROBE_M0_MEMORY_IDS_PREFIX = "[probe:m0_memory_ids]";
const PROBE_M0_CHAPTERS_PREFIX = "[probe:m0_chapters]";
const PROBE_FOLD_COMMITTED_PREFIX = "[probe:fold_committed]";

function assertMarkerContract() {
  const source = resolve(
    fileURLToPath(new URL(".", import.meta.url)),
    "..",
    "vendor",
    "magic-context",
    "packages",
    "pi-plugin",
    "src",
    "probe-materialization-marker.ts",
  );
  if (!existsSync(source)) return;
  const declared = readFileSync(source, "utf8");
  if (!declared.includes(`export const PROBE_M0_MEMORY_IDS_PREFIX = "${PROBE_M0_MEMORY_IDS_PREFIX}"`)) {
    throw new Error("memory_loop_probe_marker_contract_drift");
  }
  if (!declared.includes(`export const PROBE_M0_CHAPTERS_PREFIX = "${PROBE_M0_CHAPTERS_PREFIX}"`)) {
    throw new Error("memory_loop_probe_marker_contract_drift");
  }
  if (!declared.includes(`export const PROBE_FOLD_COMMITTED_PREFIX = "${PROBE_FOLD_COMMITTED_PREFIX}"`)) {
    throw new Error("memory_loop_probe_marker_contract_drift");
  }
}
assertMarkerContract();

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
    const inlineSeed =
      seed ?? "Remember this for later: I retired after many years delivering the post.";
    return Object.freeze({
      seeds: Object.freeze([inlineSeed]),
      seed: inlineSeed,
      question: question ?? "What did I do before I retired?",
      probeId: undefined,
      manifestDigest: undefined,
      dimension: "retention",
      distance: "turn",
      requiredKeywords: ["postman", "mail", "delivering"],
      forbiddenKeywords: ["mine", "haul"],
      minHitRate: 0.5,
    });
  }
  const manifest = loadProbeManifest(await readFile(resolve(manifestPath), "utf8"));
  if (manifest.probes.length !== 1)
    throw new Error("probe_fixture_multi_probe_unsupported");
  const probe = manifest.probes[0];
  const probeStep = probe.steps.find((step) => step.kind === "probe");
  // EVERY seed step, in order - not just the first.
  //
  // Taking only `find(kind === "seed")` silently truncated multi-seed fixtures and
  // then reported the consequence as a product result. It produced a false
  // supersede.fail/old_retained: the supersede fixture's SECOND seed is the whole
  // point of that scenario ("scratch that - parsnips are out, amethyst now"), so with
  // it dropped the overwrite never happened and "old fact retained" was guaranteed.
  // Same for the retention fixture, whose second seed is the distractor: without it
  // the probe was being asked about a world where the distractor never existed.
  const seedSteps = probe.steps.filter((step) => step.kind === "seed");
  if (seedSteps.length === 0 || probeStep === undefined) throw new Error("probe_fixture_incomplete");
  // Which seed does L2 compare against? The one that carries the fact the probe asks
  // about - i.e. a required keyword appears in it. Position alone is wrong in both
  // directions: the supersede fixture puts the asked-about fact LAST (the overwrite),
  // while the retention fixture puts it FIRST and uses the later seed as a distractor
  // that is deliberately NOT the answer.
  const required = probeStep.requiredKeywords ?? [];
  const askedSeed =
    seedSteps.find((step) =>
      required.some((keyword) => step.text.toLowerCase().includes(String(keyword).toLowerCase())),
    ) ?? seedSteps.at(-1);
  // Supersession is modelled as REPLACEMENT, because that is the only overwrite the
  // authenticated management route can express. The route exposes create/update/archive;
  // the vendor's supersede link is a Historian-internal promotion step and is not part
  // of the player API (verified in browser-contract's MemoryMutationCommandV1Schema).
  //
  // This distinction is evidence, not cosmetic: seeding a second fact with `create`
  // leaves BOTH rows active and independently rendered, so a reply naming both is the
  // correct reading of the store - yet the probe's forbidden set scores it
  // `supersede.fail/old_retained`, which would be read as a memory regression. The run
  // that exposed this reported renderedIdCount: 2 with the asked-about fact present.
  const supersedes =
    probe.dimension === "supersession" && seedSteps.length > 1 ? askedSeed.text : undefined;
  const initialSeeds =
    supersedes === undefined ? seedSteps.map((step) => step.text) : [seedSteps[0].text];
  return Object.freeze({
    seeds: Object.freeze(initialSeeds),
    ...(supersedes === undefined ? {} : { supersedes }),
    // The seed carrying the asked-about fact; used for L2's id comparison so the
    // funnel answers "was THIS fact rendered?".
    seed: askedSeed.text,
    question: probeStep.text,
    probeId: probe.probeId,
    manifestDigest: manifest.manifestDigest,
    dimension: probe.dimension,
    // The fixture's declared distance decides which funnel stages are even applicable.
    // `session` (design 3.4, P-restart) is the distance this loop is structurally
    // ALREADY running: phase 1 seeds through one Host child, that child's teardown
    // commits, and phase 2 mounts as its terminal successor on the same root. Declaring
    // it here is what lets L3 report on the restart instead of staying not_applicable.
    distance: probe.distance,
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
export async function seedMemory(origin, client, seedTexts, supersedeText) {
  let projectionRevision;
  let last;
  let firstHandle;
  let supersededHandle;
  const texts = supersedeText === undefined ? seedTexts : [...seedTexts, supersedeText];
  for (const [index, seedText] of texts.entries()) {
    const before = await readMemory(origin, client);
    if (typeof before?.projectionRevision !== "string") throw new Error("projection_revision_unavailable");
    projectionRevision = before.projectionRevision;
    // A supersession is expressed as an `update` of the row it replaces. The route has
    // no supersede verb (create/update/archive only), and `update` is the operation that
    // actually overwrites the stored fact, so the store ends with ONE active row for
    // this topic - which is what the probe's forbidden set assumes. Reaching this with
    // two independent `create`s instead leaves both rows active and the scenario
    // unfalsifiable in the direction the probe cares about.
    const replacing = supersedeText !== undefined && index === texts.length - 1;
    if (replacing && supersededHandle === undefined) throw new Error("memory_supersede_handle_missing");
    const response = await deadlineFetch(`${origin}/api/tavern/v1/memory`, {
      method: "PUT",
      headers: {
        Cookie: client.cookie,
        Origin: origin,
        "Content-Type": "application/json",
        "x-csrf-token": client.csrf,
      },
      body: JSON.stringify(
        replacing
          ? {
              apiVersion: 1,
              expectedProjectionRevision: before.projectionRevision,
              operation: "update",
              handle: supersededHandle,
              content: seedText,
            }
          : {
              apiVersion: 1,
              expectedProjectionRevision: before.projectionRevision,
              operation: "create",
              content: seedText,
            },
      ),
    });
    if (!response.ok) throw new Error(`memory_seed_failed:${response.status}`);
    const after = await response.json();
    const rows = Array.isArray(after?.memories) ? after.memories : [];
    const seeded = rows.some((row) => row?.content === seedText);
    if (!seeded) {
      // Stop at the first unproven write: later seeds would otherwise be reported
      // against a store that never received the earlier ones.
      return Object.freeze({ durable: false, rowCount: rows.length, projectionChanged: after?.projectionRevision !== before.projectionRevision });
    }
    if (!replacing) {
      firstHandle ??= rows.find((row) => row.content === seedText)?.handle;
      supersededHandle = rows.find((row) => row.content === seedText)?.handle;
    }
    last = after;
  }
  return Object.freeze({
    durable: true,
    rowCount: Array.isArray(last?.memories) ? last.memories.length : 0,
    // The opaque handle is the ONLY stable cross-phase reference we keep: it is the
    // product's own projection of the row and carries no content.
    seedHandle: firstHandle,
    projectionChanged: projectionRevision !== undefined,
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

/**
 * Seed memory facts through a REAL management-surface child and return the
 * same durability evidence `runMemoryLiveLoop` uses, without running any
 * chat turn. This lets other live carriers (the Stardew ladder runner) plant
 * a fact under a product continuity and then observe whether a Game runtime
 * on the SAME root/continuity renders it into m[0] — the cross-surface
 * embodiment path that a chat-only memory loop cannot close by itself.
 */
export async function seedMemoriesViaManagementSurface({ root, deploymentManifestPath, seeds, supersedes, outputRoot, readyTimeoutMs }) {
  const markers = [];
  const launch = await launchDesktopCompositionGateChild({
    outputRoot: outputRoot ?? OUTPUT_ROOT,
    root,
    surface: "management",
    nonceSha256: createHash("sha256").update(randomBytes(32)).digest("hex"),
    manifestPath: deploymentManifestPath,
    readyTimeoutMs: readyTimeoutMs ?? START_TIMEOUT_MS,
    gameSessionMode: "fresh",
    spawnImpl: (command, args, options) => {
      const child = spawn(command, args, options);
      child.stderr?.setEncoding?.("utf8");
      child.stderr?.on?.("data", (chunk) => {
      		for (const line of String(chunk).split("\n")) {
			if (
				line.startsWith(PROBE_M0_MEMORY_IDS_PREFIX) ||
				line.startsWith(PROBE_M0_CHAPTERS_PREFIX) ||
				line.startsWith(PROBE_FOLD_COMMITTED_PREFIX)
			)
				markers.push(line.trim());
		}
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
    const result = await seedMemory(origin, client, seeds, supersedes);
    return Object.freeze({ result, markers: Object.freeze([...markers]) });
  } finally {
    launch.dispose?.();
    await stopChildGracefully(launch.child);
  }
}

/**
 * Close the run capture and return a bounded summary for the report JSON.
 *
 * The report itself is recorded inside the run directory before closing, so
 * evidence and verdict travel together. Never throws: a broken capture becomes
 * a `capture` field with `failures`, not a crashed loop.
 */
async function closeIntoReport(capture, root, report) {
  if (capture === null || capture === undefined) return null;
  try {
    await capture.record("report.json", report);
    await capture.captureRuntimeRoot(root);
    const summary = await capture.close();
    return Object.freeze({
      schema: "gamebuddy_live_run_capture/v1",
      dir: summary.dir,
      filesWritten: summary.filesWritten,
      skipped: summary.skipped,
      failures: summary.failures,
    });
  } catch (error) {
    return Object.freeze({
      schema: "gamebuddy_live_run_capture/v1",
      dir: capture.dir ?? null,
      failures: [{ op: "capture_close", error: String(error instanceof Error ? error.message : error) }],
    });
  }
}

async function withSurface({ surface, run, root, deploymentManifestPath, gameSessionMode = "fresh", capture }) {
  if (typeof root !== "string" || root.length === 0) throw new Error("runtime_root_required");
  if (typeof deploymentManifestPath !== "string" || deploymentManifestPath.length === 0)
    throw new Error("deployment_manifest_path_required");
  await mkdir(root, { recursive: true });
  const nonceSha256 = createHash("sha256").update(randomBytes(32)).digest("hex");

  let stderr = "";
  // Marker channel (Class B, owner decision D-1): Magic Context reports its own
  // materialization facts on stderr, including which memory ids it assembled into
  // m[0]. We collect the lines here instead of only keeping a bounded diagnostic
  // tail, because those markers are the ONLY observability the L2 (assembly) stage
  // has - the Host never sees m[0] bytes and the persistence row is not exposed.
 	const markers = [];
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
 				// Harness-level capture: full child stderr lands in the run directory
 				// (git-ignored, local only), so a reviewer can see the real
 				// materialization narration instead of only the marker lines.
 				if (capture !== undefined && capture !== null)
 					capture.append(`child-${surface}.stderr.log`, String(chunk)).catch(() => {});
 				for (const line of String(chunk).split("\n")) {
 					// Strictly prefixed and parsed: an unrelated stderr line can never be
 					// mistaken for a materialization fact.
 					if (
 						line.startsWith(PROBE_M0_MEMORY_IDS_PREFIX) ||
 						line.startsWith(PROBE_M0_CHAPTERS_PREFIX) ||
 						line.startsWith(PROBE_FOLD_COMMITTED_PREFIX)
 					)
 						markers.push(line.trim());
 				}
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
    const result = await run(origin, client);
    return Object.freeze({ result, markers: Object.freeze([...markers]) });
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
 * Ask a composed child to close itself, and wait for it to actually exit.
 *
 * This is the whole reason the memory loop can have a second phase. The product
 * admits a `known` mount as a terminal SUCCESSOR, which requires the predecessor
 * chat-runtime teardown to have COMMITTED, and that commit happens only inside the
 * child's own close path (desktop-runtime-bootstrap finally -> composition.close()).
 *
 * On Windows there is no way to make that path run from outside: `child.kill("SIGTERM")`
 * is TerminateProcess and the handler never executes (probe: exit reported
 * `signal SIGTERM`, handler not invoked), and disposing the guardian peer leaves the
 * child running. So the child now accepts a cooperative request on the IPC channel the
 * gate already opens for readiness, and this asks politely before ever escalating.
 */
export const SHUTDOWN_REQUEST_SCHEMA = "gamebuddy-desktop-shutdown-request/v1";

async function stopChildGracefully(child, timeoutMs = 30_000) {
  if (child === undefined || child === null || child.exitCode !== null) return;
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  // The request only reaches a child that was spawned with an IPC channel and has
  // not disconnected. `connected` is the product's own gate: a child without the
  // channel (production Desktop) simply never gets asked, which is correct - it is
  // stopped by its supervisor.
  const canRequest = typeof child.send === "function" && child.connected === true;
  if (canRequest) {
    try {
      child.send(Object.freeze({ schema: SHUTDOWN_REQUEST_SCHEMA, protocolVersion: 1 }));
    } catch {
      // A send failure is not fatal: the escalation below still guarantees exit.
    }
  }
  const closed = await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), timeoutMs)),
  ]);
  if (closed === true) return;
  // Escalate. `kill` without a signal is the portable hard stop; SIGTERM is
  // equivalent on Windows and unreliable elsewhere, so it is not used as a fallback.
  child.kill();
  await Promise.race([
    exited,
    new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 5_000)),
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
 * Resolve the numeric id of the row this run seeded.
 *
 * The product deliberately hides it: the management projection returns an HMAC
 * `handle` (memory-management.ts `projectHandle`), not the vendor's `stateToken`,
 * so the id cannot be read back through the API. The harness therefore resolves it
 * from its OWN disposable runtime root - never the player's - and only AFTER
 * phase 1 has exited, so there is no concurrent writer to contend with.
 *
 * This is a lookup key, not evidence: what the run asserts about assembly comes
 * from the vendor's own marker, never from this read.
 */
function resolveSeededMemoryId(root, seedText) {
  // Locate the store by directory shape rather than by recomputing Host's
  // `identityKey`: a re-implementation here would silently drift from the
  // product's partition function and start reading a different (or no) database.
  // This disposable root holds exactly one context, so the shape is unambiguous.
  const contextsRoot = join(root, "contexts");
  if (!existsSync(contextsRoot)) return undefined;
  const contextKeys = readdirSync(contextsRoot);
  if (contextKeys.length !== 1) return undefined;
  const dbPath = join(contextsRoot, contextKeys[0], "data", "cortexkit", "magic-context", "context.db");
  if (!existsSync(dbPath)) return undefined;
  let db;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row = db.prepare("SELECT id FROM memories WHERE content = ? ORDER BY id LIMIT 1").get(seedText);
    return typeof row?.id === "number" ? row.id : undefined;
  } catch {
    // A missing id leaves the comparison key unknown, so L2 stays a gap rather
    // than claiming the seed was absent. The marker still reports what happened.
    return undefined;
  } finally {
    db?.close?.();
  }
}

/**
 * Parse the vendor's rendered-memory markers using the FROZEN funnel rule, not a
 * second implementation: the two loops must never disagree about whether L2 was
 * observed.
 */
function renderedIdsForRun(markers) {
  return renderedMemoryIdsFromMarkers(markers);
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
    // One local evidence directory for this run (git-ignored, harness-level):
    // child stderr narration, the runtime root's own evidence, and the report
    // travel together so a reviewer can see what actually reached the model.
    const capture = await openLiveRunCapture({ kind: "memory-loop", label: scenario.probeId, root: LIVE_RUN_ROOT });
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
    const seededResult = await withSurface({
      surface: "management",
      root,
      deploymentManifestPath,
      capture,
      run: async (origin, client) => seedMemory(origin, client, scenario.seeds, scenario.supersedes),
    });
    const seeded = seededResult.result;
    process.stderr.write(`[memory-loop] phase1 durable=${seeded.durable}\n`);

    // Resolve the seed's vendor id AFTER phase 1 exited: the product hides it behind
    // an HMAC handle, and reading while the child still runs would contend with its
    // writer. Phase 1 has committed its teardown by this point, so the DB is quiet.
    const seededMemoryId = seeded.durable ? resolveSeededMemoryId(root, scenario.seed) : undefined;

    const observation = {
      distance: scenario.distance,
      seedRequired: true,
      seedPresentInReadback: seeded.durable,
      // Restart evidence for a `session`-distance probe. The successor mount is the
      // product's OWN statement that the predecessor committed terminal teardown: the
      // child refuses a `known` mount otherwise (`chat_runtime_reentry_selection_invalid`,
      // handled below). Reaching phase 2 therefore means the persistence partition was
      // reopened, not that an in-process cache survived.
      ...(scenario.distance === "session" ? { foldObserved: true } : {}),
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
      const finalReport = Object.freeze({ ...report, capture: await closeIntoReport(capture, root, report) });
      await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
      return finalReport;
    }

    // Phase 2 - chat-only surface, SAME root, SAME continuity: ask the question.
    // Session mode `known` OPENS the authority that phase 1's management surface
    // provisioned, instead of provisioning a fresh one. This is the storage-identity
    // core of the whole loop: a fresh second phase would create an EMPTY second
    // SQLite and the seeded row could never be seen (the audit's finding).
    //
    // The child accepts a cooperative shutdown request over the IPC channel
    // (desktop-runtime-bootstrap `waitForTermination`), which is what lets that
    // teardown commit and this phase mount as a successor. Without it the product
    // rejects the mount with `chat_runtime_reentry_selection_invalid`; see the
    // blocked branch below for that case.
    process.stderr.write(`[memory-loop] phase2 chat-only launching known\n`);
    let chatResult;
    try {
      chatResult = await withSurface({
        surface: "chat-only",
        root,
        deploymentManifestPath,
        gameSessionMode: "known",
        capture,
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
      const finalReport = Object.freeze({ ...report, capture: await closeIntoReport(capture, root, report) });
      await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
      return finalReport;
    }

    const chat = chatResult.result;
    const verdict = scoreReply({ committedText: chat.committedText, scenario, chat });

    // L2 (assembly): did the fact reach the context the model was given? The vendor
    // reports which memory ids it rendered into m[0]; we compare that against the id
    // of the row we seeded. Absent marker -> the funnel reports a gap, never a miss.
    //
    // An unresolved seed id is ALSO a gap, not a break: without the comparison key we
    // cannot say whether the id was missing or we simply asked the wrong question.
    // Resolve the chapters rendered into m[0] (v1 chapter rollup marker).
    const chapters = renderedChaptersFromMarkers(chatResult.markers);

    const renderedIds = renderedIdsForRun(chatResult.markers);
    // Real-fold evidence for a `fold`-distance probe: the vendor's fold-commit
    // marker shares its revision with the rendered-memory marker of the SAME
    // materialization, so the ids observed at that revision ARE the post-fold
    // rendered set. A session-distance probe keeps using the restart substitute
    // (postFoldAssembly) below; a fold probe passes the real commit evidence.
    const realFold = foldCommittedRenderedIdsFromMarkers(chatResult.markers);
    const attributed = attributeMemoryFunnel({
      ...observation,
      renderedMemoryIdsObserved: renderedIds !== undefined && seededMemoryId !== undefined,
      ...(seededMemoryId === undefined ? {} : { seedIdRendered: renderedIds?.has(seededMemoryId) === true }),
      // L3 for a session-distance probe: the fact must still be rendered in the NEW
      // process. Same marker, post-restart phase - which is exactly the difference the
      // stage is asking about. An unresolved seed id leaves this undefined so L3 reports
      // a gap ("we could not compare") instead of claiming the fact was dropped.
      ...(scenario.distance === "session" && seededMemoryId !== undefined && renderedIds !== undefined
        ? { postFoldAssembly: renderedIds.has(seededMemoryId) ? "present" : "absent" }
        : {}),
      // L3 for a `fold`-distance probe: the REAL fold-commit evidence (revision +
      // post-fold rendered set) when the vendor actually reported a fold this run;
      // absent otherwise so L3 reports a gap instead of a fabricated fold.
      ...(scenario.distance === "fold" && realFold !== undefined
        ? { realFold: { ...realFold, ...(seededMemoryId === undefined ? {} : { seedId: seededMemoryId }) } }
        : {}),
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
      // The L2 comparison facts, content-free but auditable: which side of the
      // comparison was even available. Without these a `broken` L2 is not
      // distinguishable from an unresolved comparison key, which would be a harness
      // defect reported as a product defect.
      assembly: Object.freeze({
        seededIdResolved: seededMemoryId !== undefined,
        markerObserved: renderedIds !== undefined,
        renderedIdCount: renderedIds === undefined ? null : renderedIds.size,
        seedIdRendered: seededMemoryId !== undefined && renderedIds?.has(seededMemoryId) === true,
      }),
      // Chapter rollup observation (v1): did sealed chapters reach m[0], and
      // is the chapter block byte-stable? `null` means the vendor never
      // emitted the marker; a number (possibly 0) means it did.
      chapters: Object.freeze({
        markerObserved: chapters !== undefined,
        renderedCount: chapters?.count ?? null,
        ...(chapters?.digest === undefined ? {} : { blockDigest: chapters.digest }),
      }),
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
    const finalReport = Object.freeze({ ...report, capture: await closeIntoReport(capture, root, report) });
    await writeFile(reportPath, `${JSON.stringify(finalReport, null, 2)}\n`, "utf8");
    return finalReport;
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
