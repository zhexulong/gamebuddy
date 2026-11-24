import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { cp, mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { driveGuardianRecoveryConversation } from "./desktop-runtime-bootstrap.internal.js";
import { MAX_GUARDIAN_WIRE_BYTES } from "./desktop-runtime-bootstrap.internal.js";
import type {
  DesktopGuardianRecovery,
  DesktopGuardianRecoveryTransport,
  GuardianRecoveryRole,
} from "../../containment/auth/desktop-guardian-session.internal.js";
import { ContainmentRoleAlreadyContainedError } from "../../containment/runtime/contract/game-runtime.js";
// The durable engine on the other side of this wire, imported so the tolerance
// both share is proven against the refusal the engine actually throws instead of
// against a copy of its message.
import { openRecoverableStardewBootstrapOwner } from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.js";
import {
  createStardewChildEnvironment,
  STARDEW_CHILD_ENVIRONMENT_MAX_BYTES,
} from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.js";
import { readStardewGuardianArmBinding } from "../../games/stardew/lifecycle/stardew-private-bootstrap-composer.core.internal.js";
import { probeWindowsStardewGuardianObjects } from "../../composition/stardew/stardew-guardian-object-presence.js";
import { bindWindowsStaleLockReclaimer } from "../../path-lock.js";
import { createTestWindowsStaleLockReclaimer } from "../../windows-stale-lock-reclaimer/index.test-support.js";
import { assertStatementOrder, functionBody } from "../../test-support/function-body-order.test-support.js";
import { readSourceShape } from "../../test-support/source-shape.test-support.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageRoot = findPackageRoot(sourceDirectory);
const sourceRoot = resolve(packageRoot, "src");
const compiledRoot = resolve(sourceDirectory, "..", "..");
/**
 * Resolve one member of the compiled artifact this fixture replays.
 *
 * `compiledRoot` is the directory this file was compiled INTO - the build target is
 * `host/dist-test` and `tsconfig.json` is `noEmit` - so it is the sibling of `src`,
 * never `src` itself. Run against the TypeScript source instead (`bun test src/...`)
 * it names the tree the sources live in, which carries none of the `.js` modules the
 * fixture copies and the wire child imports; the fixture would otherwise die on a
 * bare ENOENT while copying its first module. Name the missing artifact instead.
 */
function compiledArtifact(...segments: readonly string[]): string {
  const path = resolve(compiledRoot, ...segments);
  if (!existsSync(path)) throw new Error(`wire_fixture_compiled_artifact_missing:${path}`);
  return path;
}
/**
 * The Node executable the wire child must run under. node:test's `mock.module()`, the
 * `--experimental-test-module-mocks` flag and a realpath that spells the Windows drive
 * root `C:\` are Node behaviors this fixture depends on, and under `bun test`
 * `process.execPath` is bun. The Host suite's own coordinator (`host/scripts/run-tests.mjs`)
 * publishes the Node it resolved as GAMEBUDDY_HOST_TEST_NODE; `process.execPath` stays the
 * correct fallback whenever this suite itself runs under Node.
 */
const nodeExecutable = process.env.GAMEBUDDY_HOST_TEST_NODE ?? process.execPath;
/**
 * How long a fixture child may take to CLOSE after a failure. The invariant is that it
 * closes at all - a failed boot must tear its composition down and let the process exit -
 * and this bound only exists so a genuine hang fails instead of hanging the suite. It was
 * 2s, which a loaded machine (a full 230-file suite plus parallel lanes) could miss and
 * report as a product failure it was not; no latency assertion lives here.
 */
const CHILD_SETTLE_TIMEOUT_MS = 20_000;

test("desktop bootstrap helper seeds the composed surface from the Host env seam and publishes the launch URL", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  for (const surface of ["composed-reference-game", "chat-only", "management"]) {
    const result = await runWireFixture("success", { surface });
    assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
    assert.match(result.stderr, new RegExp(`wire_assembly_surface:${surface}\\n`));
  }
  const defaulted = await runWireFixture("success");
  assert.equal(JSON.parse(defaulted.acknowledgement!).status, "accepted");
  assert.match(defaulted.stderr, /wire_assembly_surface:default\n/);
  assert.match(defaulted.stderr, /wire_publish_ready:called\n/);
});

test("desktop bootstrap helper announces its bounded status stages before exactly one acknowledgement and nothing else", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("success");

  // The acknowledgement is still exactly what it was, and it is the last frame on the channel.
  assert.equal(schemaOf(result.acknowledgement!), bootstrapSchema);
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  // And it carries exactly the fields the declaration beside the writer states, in the order written.
  // The launcher that reads this frame validates it against this same file, so a field added here
  // without the declaration - which is how `drainDeadlineMs`/`stepHangDeadlineMs` once broke every
  // composed launch while every test stayed green - fails on this side first.
  assert.deepEqual(
    Object.keys(JSON.parse(result.acknowledgement!)),
    JSON.parse(
      readFileSync(resolve(packageRoot, "src", "bootstrap", "wire", "desktop-host-bootstrap-ack.keys.json"), "utf8"),
    ),
  );

  // Everything before it is a well-formed, bounded status frame, in the order the child enters the
  // stages, and the acknowledgement follows them. Nothing else may appear on this channel: an extra
  // frame, a frame after the acknowledgement, or a third schema would leave the launcher's frame
  // loop holding something it cannot dispatch.
  assert.deepEqual(
    result.lines.map((line) => schemaOf(line)),
    [...bootstrapStages.map(() => statusSchema), bootstrapSchema],
  );
  assert.deepEqual(
    result.statuses.map((line) => (JSON.parse(line) as { stage: string }).stage),
    [...bootstrapStages],
  );
  assert.equal(result.statuses.length, bootstrapStages.length);
  for (const [index, line] of result.statuses.entries()) {
    const frame = JSON.parse(line) as Record<string, unknown>;
    // The exact ordinal key sequence the launcher validates. The wait statement is optional and
    // may only be written when the child is about to wait for a human decision; the
    // pre-acknowledgement path has no such decision, so this child never writes it.
    assert.deepEqual(Object.keys(frame), ["schema", "protocolVersion", "stage"]);
    assert.equal(frame.schema, statusSchema);
    assert.equal(frame.protocolVersion, 1);
    assert.equal(frame.stage, bootstrapStages[index]);
    assert.match(String(frame.stage), /^[a-z][a-z0-9-]{0,63}$/);
  }
});

test("desktop bootstrap helper publishes the ready frame the declaration beside it states", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  // `readiness-publication` is the scenario that gives the child the readiness IPC channel the gate launcher
  // opens, so this is the frame the child really publishes - not a copy of the shape it publishes.
  const result = await runWireFixture("readiness-publication");

  assert.equal(result.messages.length, 1, "one ready frame, and nothing else, rides the readiness channel");
  assert.equal(result.messages[0]!.schema, "gamebuddy-desktop-composition-ready/v1");
  // The declaration beside the writer (`publishCompositionReady`), which the gate launcher reads instead of
  // spelling these three keys inline: a field added on one side now fails a test on the other.
  assert.deepEqual(
    Object.keys(result.messages[0]!),
    JSON.parse(
      readFileSync(resolve(packageRoot, "src", "bootstrap", "wire", "desktop-composition-ready.keys.json"), "utf8"),
    ),
  );
});

test("desktop bootstrap helper writes the guardian hello the declaration beside it states", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("success");

  // The first frame the Host really writes over the guardian pipe is its hello request; the Desktop broker
  // reads it in C# and the gate launcher's broker reads it here, both held to this one declaration.
  assert.equal(result.requests[0]?.operation, "hello");
  assert.deepEqual(
    Object.keys(result.requests[0]!),
    JSON.parse(
      readFileSync(
        resolve(packageRoot, "src", "bootstrap", "wire", "desktop-guardian-session-hello.keys.json"),
        "utf8",
      ),
    ),
  );
});

test("desktop bootstrap helper names a failed Mod step and still serves the player", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("success", { modOutcome: "companion-mod-smapi-not-installed" });

  // A game without SMAPI is not a startup failure: the child still reaches its
  // acknowledgement, and the named outcome is the step's own last announced stage.
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  const stages: string[] = [...bootstrapStages];
  stages[stages.indexOf("companion-mod-current")] = "companion-mod-smapi-not-installed";
  assert.deepEqual(
    result.statuses.map((line) => (JSON.parse(line) as { stage: string }).stage),
    stages,
  );
});

test("desktop bootstrap helper fails closed on an invalid composed surface or marker nonce without any guardian contact", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  for (const [scenario, options, reason] of [
    ["invalid-surface", { surface: "bogus" }, "surface_env_invalid"],
    ["invalid-nonce", { nonceSha256: "not-hex" }, "narrative_gate_nonce_env_invalid"],
  ] as const) {
    const result = await runWireFixture(scenario, options);
    assert.equal(result.acknowledgement, undefined);
    assert.deepEqual(result.requests, []);
    // The CI-only admission probe rides BEFORE the bare message whenever the child catches a
    // bootstrap refusal, so a CI log names the root-admission facts instead of only 'unavailable'.
    // The bare message stays the LAST line, which is what the assertion below and
    // verify-self-contained-generation's stderr.trim() both depend on.
    const lastLine = `desktop_runtime_bootstrap_unavailable:${reason}`;
    assert.match(
      result.stderr,
      new RegExp(
        `(?:^|\\n)wire_admission_probe:localappdata=[a-z_]+;localappdata_is_fixture=(?:true|false);program=[a-z_+]+;data=[a-z_+]+;operational=[a-z_+]+;presentation=[a-z_]+\\nwire_admission_deep:[a-z0-9_,]+\\n(?:(?:^|\\n)[^\\n]+\\n)*${lastLine}\\n$`,
      ),
    );
    assert.match(result.stderr, new RegExp(`(?:^|\\n)${lastLine}\\n$`));
  }
});

/**
 * The exact ordinal key sequence `DesktopHostBootstrapBroker.ExactObject`
 * compares for one command frame, copied from the broker's own per-operation key
 * arrays (`TryParseCommand`, DesktopHostBootstrapBroker.cs): the bounded wait (or
 * the launch deadline) follows the binding, and the role precedes the private
 * frame. The broker compares the sequence, not only the set, and the recording
 * peer parses order-agnostically, so nothing but this assertion pins the order.
 */
const commandFrameKeys = (
  timing: "operationWaitBudgetMs" | "deadlineUnixMs",
  ...trailing: readonly string[]
): readonly string[] => [
  "schema",
  "protocolVersion",
  "operation",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
  timing,
  "guardianInstanceId",
  "guardianEpoch",
  "attemptId",
  ...trailing,
];

test("desktop bootstrap helper performs one authenticated guardian wire roundtrip", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("success");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt", "launch_role", "contain_role"],
  );
  assert.equal(Object.hasOwn(result.requests[1]!, "operationWaitBudgetMs"), true);
  assert.equal(Object.hasOwn(result.requests[1]!, "deadlineUnixMs"), false);
  assert.equal(Object.hasOwn(result.requests[2]!, "operationWaitBudgetMs"), false);
  assert.equal(typeof result.requests[2]!.deadlineUnixMs, "number");
  assert.equal(Object.hasOwn(result.requests[3]!, "operationWaitBudgetMs"), true);
  assert.equal(Object.hasOwn(result.requests[3]!, "deadlineUnixMs"), false);
  // Every command frame's key order is protocol: the broker refuses a frame whose
  // keys are not in its own sequence, so a reordered guardianCommandFrame must
  // fail here rather than only against the real broker.
  assert.deepEqual(Object.keys(result.requests[1]!), commandFrameKeys("operationWaitBudgetMs", "privateFrame"));
  assert.deepEqual(Object.keys(result.requests[2]!), commandFrameKeys("deadlineUnixMs", "role", "privateFrame"));
  assert.deepEqual(Object.keys(result.requests[3]!), commandFrameKeys("operationWaitBudgetMs", "role"));
  // The wire carries the real composition-armor frame: the arm private frame
  // must contain the approved executable and the native ParseLaunch-style
  // launch frame must reuse that exact executable (ParseArm/ParseLaunch gate).
  const armFrame = JSON.parse(
    Buffer.from(String(result.requests[1]!.privateFrame), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  const launchFrame = JSON.parse(
    Buffer.from(String(result.requests[2]!.privateFrame), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(armFrame.approvedExecutable, "C:\\Program Files\\GameBuddy\\roles\\RoleRootFixture.exe");
  assert.equal(launchFrame.executable, armFrame.approvedExecutable);
  assert.ok(result.stderr.length >= 0);
});

test("desktop bootstrap helper never sends arm_attempt when the authorization lacks the approved executable", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("missing-arm-executable");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello"],
  );
  assert.match(result.stderr, /(?:^|\n)contained game runtime: arm authorization missing approved executable\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|arm_attempt|armed/);
});

test("desktop bootstrap helper rejects arm when guardian withholds ACK", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("withheld-arm-ack");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt"],
  );
  // The operation budget expired with the acknowledgement never written, so the
  // session closed and named the closure rather than the waiting operation.
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_session_closed\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|success|armed|launch_role|contain_role/);
});

test("desktop bootstrap helper rejects contain when guardian withholds ACK", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("withheld-contain-ack");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt", "contain_role"],
  );
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_session_closed\n$/);
});

test("desktop bootstrap helper rejects launch beyond the local deadline horizon", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("overhorizon-launch");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt"],
  );
  // Refused locally by the launch deadline horizon, before any launch frame is written.
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_command_input_invalid\n$/);
  assert.doesNotMatch(result.stderr, /launch_role|unexpected_launch_success/);
});

test("desktop bootstrap helper times out a delayed arm ACK and rejects a late ACK", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("delayed-arm-ack");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt"],
  );
  assert.equal(typeof result.armReceiptAt, "number");
  assert.equal(typeof result.workerClosedAt, "number");
  assert.ok(
    result.workerClosedAt! - result.armReceiptAt! >= 40,
    "rejection must wait for the operation budget after peer receipt",
  );
  assert.ok(result.workerClosedAt! - result.armReceiptAt! < 2_000, "timed rejection must be bounded");
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_session_closed\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|success|armed|launch_role|contain_role/);
});

test("desktop bootstrap helper does not send expired launch", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("expired-launch");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt"],
  );
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_command_input_invalid\n$/);
});

// The other end of the same fact `peer-disconnect` proves: a session the composition closes
// ITSELF is not a loss of its owner. An attempt that ends - an explicit endgame, or the next
// launch press after a game ended - takes exactly this path (`stardew-guardian-platform.ts:913`
// `settle()` -> `closeSessionOnce()` -> `session.close()`), and the Host must keep serving Chat
// on the same process instead of asking to die. The Desktop then re-offers the one-instance
// pipe (`DesktopHostBootstrapBroker.ServeSessionsAsync`), which the next test spends.
test("desktop bootstrap helper stays alive when its own composition closes the guardian session", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("settled-session");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt", "launch_role", "contain_role"],
  );
  // The session really ended - the peer read the EOF - so this is not a scenario where
  // nothing happened and the process merely had no reason to leave.
  assert.equal(result.guardianClosed, true, "the attempt's authenticated session must really close");
  assert.equal(
    result.exitCodeWhileServing,
    null,
    `the composition closed its own session and the Host asked to die with it (exit ${String(result.exitCodeWhileServing)}); a close this side initiates ends the attempt, not the owner`,
  );
});

// The quit after an attempt ended, on the two channels a quit actually owns.
//
// ADR-0015 §3 makes the guardian session attempt-scoped: the composition closes it when the
// attempt ends, and this Host holds no socket again until the next attempt's first command. A
// tray Quit in that state must still reach it - the owner is leaving, and the Host is the one
// process that has to reclaim before it may go. This is the case where the authenticated broker
// pipe carries no peer: the Desktop closes it, and nothing is connected to receive that EOF.
// The owner-liveness channel is therefore the controller channel (this child's standard input),
// held open by the launcher for the whole run and closed on the quit.
//
test("desktop bootstrap helper leaves when its owner quits after an attempt settled", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("settled-session-owner-quit");

  assert.equal(result.guardianClosed, true, "the attempt's authenticated session must really close");
  assert.notEqual(
    result.controllerQuitExitMs,
    undefined,
    "the Host was still serving 5000 ms after its owner closed the controller channel and the broker pipe " +
      `(exit ${String(result.workerExitCode)}): every normal quit in this state would wait the Host's whole ` +
      "published drain deadline and then terminate it, losing the reclamation the deadline exists for",
  );
  assert.equal(
    result.workerExitCode,
    0,
    `the Host must leave by its own reclamation (exit ${String(result.workerExitCode)})`,
  );
});

// ADR-0012's eight reclamation steps, step 3, on the path where the player is leaving: the drain
// contains the AI role it launched.
//
// `settled-session-owner-quit` above proves the quit reaches the Host when the attempt is already
// over. This is the same quit with the attempt STILL LIVE: her client was launched through the
// Guardian and never contained, so `drain_game_lifecycle` owns the only authenticated way to contain
// it - `contain_role ai_client` on the attempt's session. This peer is the broker, and it stays up
// until the child has left: that is the launcher's order after `3f49bbfd`, and it answers the contain.
test("desktop bootstrap helper drains a live attempt through its broker session on the owner's quit", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("drain-owner-quit");

  // The drain's own frame reached the broker and was answered: the reading is that frame, not the
  // absence of an error.
  assert.match(result.stderr, /wire_drain_contain:role_contained\n/);
  assert.deepEqual(result.containedRoleFrames, ["player_host", "ai_client"]);
  // A drain whose every step settled leaves no record at all: the Host writes one exactly when a step
  // of its own failed, so "no record" is the positive reading of a completed drain.
  assert.equal(result.hostExitRecord, undefined);
  assert.equal(
    result.workerExitCode,
    0,
    `the Host must leave by its own reclamation (exit ${String(result.workerExitCode)})`,
  );
});

// The same quit with the order `3f49bbfd` replaced by the one before it: the broker goes first.
//
// The drain then asks a broker that is gone to contain her client, the step fails, and the Host writes
// the one diagnostic an operator reads. The record asserted here is the production one - the same
// `runDesktopHostReclamation` and exit-record writer a real Host runs - so a drain that could not
// finish is named, in the file, by its own step and its own reason.
test("desktop bootstrap helper names the failed role step when the broker goes before the drain", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("drain-owner-quit-broker-first");

  // The step really tried: the child looked for the session and did not find it (a pipe that is gone
  // - not an EPIPE on a frame it could still write).
  assert.match(result.stderr, /wire_drain_contain:refused:\S+\n/);
  // And the answer never came, so the peer saw no AI containment at all on this quit.
  assert.deepEqual(result.containedRoleFrames, ["player_host"]);
  // The Host's own record: an incomplete exit, the step that failed, and the reason it names.
  const record = result.hostExitRecord;
  assert.ok(record !== undefined, "the failed drain left no host-exit record");
  assert.equal(record.kind, "incomplete_exit");
  assert.equal(record.reason, "stardew_lifecycle_close_incomplete");
  const steps = record.steps as { step: string; status: string; failure: string | null }[];
  const failed = steps.filter((step) => step.status === "failed");
  assert.deepEqual(
    failed.map((step) => step.step),
    ["drain_game_lifecycle"],
    `the record named ${JSON.stringify(failed)} instead of the drain's role step`,
  );
  assert.equal(failed[0]!.failure, "stardew_lifecycle_close_incomplete");
});

// ADR-0015 §3: attempt = session. The Desktop settles the finished attempt, proves its
// Guardian gone, and only then re-offers the one-instance pipe
// (`DesktopHostBootstrapBroker.ServeSessionsAsync`: `SettleAttemptAsync()`, `Disconnect()`,
// `AcceptSessionAsync()`). This is the Host half of that pair, on a real named pipe and a
// real Host child: the same process serves a second attempt by re-helloing on the same
// pipe, with a session whose arm frame carries none of the first attempt's five names.
test("desktop bootstrap helper serves a second attempt after a settle on the same pipe, in the same process", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("settle-and-rearm");

  // Two authenticated sessions, each opened by a hello and each ended by its own attempt's
  // settle. The second one exists only because the platform's per-attempt latch was released
  // by the second arm; a latch left closed would have served attempt 2 on attempt 1's
  // connection and never closed it.
  assert.deepEqual(
    result.sessions.map((session) => session.map((request) => request.operation)),
    [
      ["hello", "arm_attempt", "launch_role", "contain_role"],
      ["hello", "arm_attempt", "launch_role", "contain_role"],
    ],
  );
  // Attempt 2 is a different attempt, not attempt 1 resumed: its correlation and every arm
  // binding name differ, so nothing of attempt 1 is reachable from it (ADR-0015 §4.2).
  const firstArmFrame = armFrameOf(result.sessions[0]![1]!);
  const secondArmFrame = armFrameOf(result.sessions[1]![1]!);
  assert.notEqual(
    result.sessions[1]![1]!.guardianInstanceId,
    result.sessions[0]![1]!.guardianInstanceId,
    "attempt 2 must not reuse attempt 1's guardian instance",
  );
  assert.notEqual(result.sessions[1]![1]!.attemptId, result.sessions[0]![1]!.attemptId);
  for (const key of ["revision", "leaseName", "playerJobName", "aiJobName"] as const) {
    assert.notEqual(secondArmFrame[key], firstArmFrame[key], `attempt 2 reused attempt 1's ${key}`);
  }
  // And it is the SAME Host process that served both: the pid each attempt armed under, as
  // the Host itself reported it, is the one pid this fixture spawned.
  const attempts = [...result.stderr.matchAll(/wire_attempt_host_pid:(\d+):(\d+):([0-9a-f-]+)/gu)].map((match) => ({
    index: Number(match[1]),
    pid: Number(match[2]),
    attemptId: match[3],
  }));
  assert.equal(attempts.length, 2, `the Host must report both attempts it armed; stderr was ${result.stderr}`);
  assert.equal(attempts[0]!.pid, result.workerPid, "the pid must be the Host child this fixture spawned");
  assert.equal(attempts[1]!.pid, attempts[0]!.pid, "attempt 2 must be served by the same Host process as attempt 1");
  assert.notEqual(attempts[1]!.attemptId, attempts[0]!.attemptId);
  assert.match(result.stderr, /wire_attempts_complete:2/);
  assert.equal(
    result.exitCodeWhileServing,
    null,
    `pid ${String(attempts[0]!.pid)} did not survive its two attempts (exit ${String(result.exitCodeWhileServing)})`,
  );
});

/**
 * The other half of "a second attempt is safe": a settled attempt leaves nothing the next one can pick
 * up (ADR-0015 §4.2, §9.4 U5 items 3 and 4).
 *
 * What protects attempt 2, in the order a reader needs it:
 *
 * 1. The settled attempt's BINDING is unreservable. Its durable owner record is no longer `reserved`, so
 *    `readStardewGuardianArmBinding` refuses attempt 1's own binding with
 *    `stardew_bootstrap_guardian_arm_binding_mismatch` (`stardew-private-bootstrap-composer.core.internal.ts:5718-5742`),
 *    and no launch can be authorized against it. Measured on the record itself in the test below.
 * 2. A frame AFTER a session's arm must carry that arm's correlation
 *    (`DesktopHostBootstrapBroker.ValidateTransition`: `:464` `correlation != next`), and one session
 *    takes exactly one arm (`:458-460`). The peer below applies both because they are the broker's own
 *    rules; what is asserted is the Host's answer when one of them is refused.
 * 3. The native Guardian arms once per process (`Program.cs:82-87`; `GuardianPrivateLaunchIngress`
 *    `ReceiveArmAsync` returns nothing on a second arm) and the broker creates one Guardian per attempt,
 *    so there is never a second arm inside one Guardian. That one is a source reading: the native
 *    Guardian is not this suite's subject.
 * 4. And the asymmetry that makes the three above necessary: an arm frame CARRYING a settled attempt's
 *    correlation is ACCEPTED on a new session, because the arm frame is what establishes the
 *    correlation and `armed`/`correlation` are per session and cleared at settle (`TakeAttempt`,
 *    `:323-334`). ADR-0015 §4.2 used to read as if that frame were refused. It is not: what stops a
 *    settled attempt's authority is 1, not a replay refusal, and this scenario measures the accepted
 *    arm instead of pretending otherwise.
 *
 * The objects are the OS's answer through the production probe, not this fixture's belief: attempt 1's
 * three names are its own arm frame's, the peer holds them as real named objects while the attempt is
 * live, and they are read once before the settle and once after the Guardian that owned them ended.
 * Without the first reading the second would only prove that the probe never looked. The probe's
 * contract names two objects (`playerJob`, `lease`); the third, attempt 1's ai Job, is asked through the
 * same production probe with its name in the Job slot and only that slot's answer read - the contract is
 * not widened, and `OpenJobObjectW` does not care which of the attempt's two Jobs a caller calls it.
 *
 * `instanceGeneration: 2` is the coordinator's durable reading and is proved there
 * (`stardew-production-lifecycle-coordinator-player-host-exit.internal.test.ts`, `baa163ce`). At the wire
 * the equivalent is what this asserts: the next attempt arrives on a fresh authenticated session with a
 * new guardian instance and none of attempt 1's four binding names.
 */
test("a settled attempt leaves no named object behind, and its correlation is refused where it would spend authority", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  if (!existsSync(GUARDIAN_OBJECT_HOLDER))
    return t.skip(
      `not measured: ${GUARDIAN_OBJECT_HOLDER} is absent - build it with \`node scripts/build-windows-bootstrap-guardian.mjs\``,
    );
  const result = await runWireFixture("settle-leaves-nothing");

  // Four authenticated sessions: attempt 1 (a whole attempt), attempt 1's correlation replayed, the fresh
  // attempt with a frame carrying the settled attempt's correlation after it, and the fresh attempt on
  // the session the one-arm-per-session rule left it.
  assert.deepEqual(
    result.sessions.map((session) => session.map((request) => request.operation)),
    [
      ["hello", "arm_attempt", "launch_role", "contain_role"],
      ["hello", "arm_attempt"],
      ["hello", "arm_attempt", "contain_role"],
      ["hello", "arm_attempt", "arm_attempt"],
    ],
  );
  // The peer refused exactly two frames, and each is the rule that refused it.
  assert.deepEqual(
    result.peerRefusals,
    ["contain_role:correlation_mismatch", "arm_attempt:already_armed"],
    `the peer refused ${JSON.stringify(result.peerRefusals)}`,
  );
  const refusalCode = "desktop_runtime_bootstrap_unavailable:guardian_session_closed";
  assert.match(
    result.stderr,
    /wire_replayed_arm:armed/u,
    "a settled attempt's arm frame was refused by this peer - ADR-0015 §4.2's old reading",
  );
  assert.match(result.stderr, /wire_second_arm:armed/u, "the fresh attempt did not arm on its own session");
  assert.equal(
    /wire_stale_correlation:refused:(\S+)/u.exec(result.stderr)?.[1],
    refusalCode,
    `a frame after the arm carrying the settled attempt's correlation must be refused, and the session ends with it: ${result.stderr}`,
  );
  assert.match(result.stderr, /wire_fresh_session_arm:armed/u, "the next session did not arm");
  assert.equal(
    /wire_second_arm_in_session:refused:(\S+)/u.exec(result.stderr)?.[1],
    refusalCode,
    `one session takes one arm: ${result.stderr}`,
  );
  assert.equal(
    result.exitCodeWhileServing,
    null,
    `the Host did not survive all four sessions (exit ${String(result.exitCodeWhileServing)})`,
  );

  // The names probed are the ones attempt 1's own arm frame carries, not a second spelling of them.
  const objects = result.attemptObjects;
  assert.ok(objects !== undefined, "the fixture took no reading of attempt 1's objects");
  const firstArmFrame = armFrameOf(result.sessions[0]![1]!);
  const probed = [objects.binding.leaseName, objects.binding.playerJobName, objects.binding.aiJobName];
  assert.deepEqual(
    probed,
    [firstArmFrame.leaseName, firstArmFrame.playerJobName, firstArmFrame.aiJobName],
    "the objects probed must be the names attempt 1's arm frame carries",
  );
  // The next attempt is a fresh reservation: a new guardian instance and none of attempt 1's four names.
  const secondArmFrame = armFrameOf(result.sessions[2]![1]!);
  assert.notEqual(result.sessions[2]![1]!.guardianInstanceId, result.sessions[0]![1]!.guardianInstanceId);
  for (const key of ["revision", "leaseName", "playerJobName", "aiJobName"] as const)
    assert.notEqual(secondArmFrame[key], firstArmFrame[key], `the fresh attempt reused attempt 1's ${key}`);
  // The replay really did carry attempt 1's own correlation and binding - otherwise the acceptance
  // above would be a statement about a different attempt.
  assert.equal(result.sessions[1]![1]!.attemptId, result.sessions[0]![1]!.attemptId);
  assert.equal(result.sessions[1]![1]!.guardianInstanceId, result.sessions[0]![1]!.guardianInstanceId);
  const replayArmFrame = armFrameOf(result.sessions[1]![1]!);
  assert.deepEqual(
    [replayArmFrame.leaseName, replayArmFrame.playerJobName, replayArmFrame.aiJobName],
    [firstArmFrame.leaseName, firstArmFrame.playerJobName, firstArmFrame.aiJobName],
  );

  if ([...Object.values(objects.whileArmed), ...Object.values(objects.afterSettle)].includes("unmeasured"))
    return t.skip(
      "not measured: the in-box PowerShell probe could not run on this machine, so the OS was never asked about the attempt's objects",
    );
  // The negative that keeps the reading from being theatre: the same probe, on the same names, while the
  // attempt was live.
  assert.deepEqual(
    objects.whileArmed,
    { lease: "opened", playerJob: "opened", aiJob: "opened" },
    "before the settle the attempt's three named objects must be openable; a not_found afterwards would otherwise only prove the probe never looked",
  );
  // And after the settle there is nothing left to open: the Lease mutex and both role Jobs die with the
  // Guardian that owned them.
  assert.deepEqual(
    objects.afterSettle,
    { lease: "not_found", playerJob: "not_found", aiJob: "not_found" },
    "a settled attempt left a named object behind, so the next attempt could meet it",
  );
});

/**
 * The refusal that actually stops a settled attempt's binding from being spent twice.
 *
 * The arm facts a launch needs are read from the durable owner record, and that read accepts one state
 * only: `reserved` (`readStardewGuardianArmBinding`). One record, one binding, two states - the state a
 * live attempt leaves and the state a settled one leaves - so the difference the refusal rests on is the
 * state and nothing else in the fixture.
 */
test("a settled attempt's arm binding is unreservable: the same read succeeds while it is reserved and refuses after it is not", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only durable owner record and its path boundary");
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-settled-binding-"));
  const transactionDirectory = join(root, "stardew-private-bootstrap", "bootstrap-settled");
  const ownerPath = join(transactionDirectory, "owner.json");
  const binding = mintGuardianBinding();
  const guardian = Object.freeze({
    bindingRevision: binding.revision,
    guardianInstanceId: randomUUID(),
    guardianEpoch: 1,
    leaseName: binding.leaseName,
    playerJobName: binding.playerJobName,
    aiJobName: binding.aiJobName,
  });
  // One strict v4 owner record; only the four state fields and the record revision differ between the
  // two readings, and they are the spellings the record's own declaration carries (`reserved` while the
  // attempt may still arm, `contained` once it settled).
  const ownerRecord = (
    states: Readonly<{
      state: string;
      guardianState: string;
      playerHostState: string;
      aiClientState: string;
      ownerRecordRevision: number;
    }>,
  ) =>
    JSON.stringify({
      schema: "gamebuddy-stardew-private-bootstrap-owner/v4",
      bootstrapId: "bootstrap-settled",
      playerId: "player-wire",
      companionId: "companion-wire",
      guardian,
      ownerRecordRevision: states.ownerRecordRevision,
      state: states.state,
      guardianState: states.guardianState,
      playerHostState: states.playerHostState,
      aiClientState: states.aiClientState,
      recoveryInstanceId: null,
      playerHost: { kind: "launch_reserved", launchGeneration: "generation-1" },
      aiClient: { kind: "launch_reserved", launchGeneration: "generation-1" },
      expiresAtMs: Date.now() + 600_000,
      cleanupDisposition: "pending",
      managedPaths: ["owner.json"],
    });
  const read = (expectedOwnerRecordRevision: number) =>
    readStardewGuardianArmBinding({
      ownerPath,
      containmentRoot: root,
      bootstrapId: "bootstrap-settled",
      playerId: "player-wire",
      companionId: "companion-wire",
      expectedRevision: binding.revision,
      expectedOwnerRecordRevision,
      nowMs: Date.now(),
    });
  try {
    await mkdir(transactionDirectory, { recursive: true });
    await writeFile(
      ownerPath,
      ownerRecord({
        state: "reserved",
        guardianState: "reserved",
        playerHostState: "reserved",
        aiClientState: "reserved",
        ownerRecordRevision: 1,
      }),
      "utf8",
    );
    // While the attempt is live its own names ARE the arm facts - which is what makes the second reading
    // a statement about the same binding rather than about a name this test chose.
    const reserved = await read(1);
    assert.deepEqual(
      [reserved.leaseName, reserved.playerJobName, reserved.aiJobName],
      [binding.leaseName, binding.playerJobName, binding.aiJobName],
    );
    await writeFile(
      ownerPath,
      ownerRecord({
        state: "contained",
        guardianState: "contained",
        playerHostState: "contained",
        aiClientState: "contained",
        ownerRecordRevision: 2,
      }),
      "utf8",
    );
    await assert.rejects(
      () => read(2),
      /stardew_bootstrap_guardian_arm_binding_mismatch/,
      "a settled attempt's binding must not be readable for a launch, so nothing of it can be spent again",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("desktop bootstrap helper rejects when guardian peer disconnects", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("peer-disconnect");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt"],
  );
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_session_closed\n$/);
});

// The peer a generation with no resident Guardian runs: it serves the hello and destroys the socket
// on the attempt's first command (`role_broker_hello_only_refused:arm_attempt`, the broker's own
// refusal for a generation that publishes no Guardian). That refusal is what the measured launch
// press met, and the Host left with it: the panel's launch was never answered and every later
// `/state` read was `net::ERR_CONNECTION_REFUSED`.
//
// A refused attempt ends the ATTEMPT. The in-flight command answers the wire's own code, the
// surface publishes that attempt unattached, the process keeps serving, and the next attempt opens
// the next session on the same one-instance pipe with a fresh hello.
test("desktop bootstrap helper survives a refused attempt and serves the next one on a fresh session", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("lost-session-rearm");

  // (a) The command in flight is answered with the wire's own code, not with a dead connection.
  assert.match(
    result.stderr,
    /wire_lost_command_refused:desktop_runtime_bootstrap_unavailable:guardian_session_closed/,
    `the refused attempt's command must answer its own code; stderr was ${result.stderr}`,
  );

  // (b) The surface that attempt belonged to is still served, by the same process.
  assert.equal(
    result.stateReadAfterLoss?.status,
    200,
    `the Host stopped serving its own port with the refused attempt (${String(result.stateReadAfterLoss?.status)}: ${result.stateReadAfterLoss?.body ?? "<no answer>"})`,
  );
  assert.deepEqual(JSON.parse(result.stateReadAfterLoss!.body), { state: "served", pid: result.workerPid });

  // (c) The process was not asked to leave.
  assert.equal(
    result.exitCodeWhileServing,
    null,
    `the Host left with the refused attempt (exit ${String(result.exitCodeWhileServing)}); a session is one attempt, not the owner`,
  );

  // (d) The next attempt opened the NEXT session on the same pipe: its own hello, its own arm, and
  // none of the refused attempt's correlation.
  assert.deepEqual(
    result.sessions.map((session) => session.map((request) => request.operation)),
    [
      ["hello", "arm_attempt"],
      ["hello", "arm_attempt"],
    ],
  );
  assert.notEqual(
    result.sessions[1]![1]!.attemptId,
    result.sessions[0]![1]!.attemptId,
    "the next attempt must not reuse the refused attempt's identity",
  );
});

// The launch frame is the one large document this channel carries: the role's encoded launch plan.
//
// Measured 2026-11-21 on the failing machine: the Host forwarded its own PATH into the role environment,
// and 17 069 characters of PATH made the native plan 19 331 bytes, its base64url 25 775 and the frame
// 26 393 - over the 16 384-byte bound this channel and the Desktop's own broker both enforce. The wire
// answered with `guardian_wire_too_long` and wrote nothing, and ending the authenticated session there
// turned one refused frame into the loss of the Guardian the attempt had just armed (the broker ends the
// Guardian's control session with the socket: `arm_attempt` answered, no `launch_role` ever reached the
// peer, and the Guardian was ended 36 ms after the refusal reached the panel - `.tmp/lane-guardexit.md`).
//
// Two things are read here, and they are different claims:
//   1. a plan too large to send is refused BEFORE it is written and does not cost the attempt its session;
//   2. the plan the product actually builds - with a 17 069+ character PATH in the parent it builds the
//      role environment from - is not that plan, and `launch_role` reaches the peer inside the bound.
// The first uses a plan too large for ANY environment (its arguments are data); the second is the
// product's own environment, built here by the real `createStardewChildEnvironment`.
test("desktop bootstrap helper keeps the authenticated session when it refuses a command it never wrote", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("oversized-launch-frame");

  // The refusal names itself, and it is this side's own bound that refused - not the peer.
  assert.match(
    result.stderr,
    /wire_oversized_launch:refused:desktop_runtime_bootstrap_unavailable:guardian_wire_too_long/,
    `the oversized frame must name the bound that refused it; stderr was ${result.stderr}`,
  );
  assert.doesNotMatch(result.stderr, /wire_oversized_launch:accepted/);

  // And the attempt keeps the session it armed: the peer reads the next command on the SAME
  // authenticated session, so one `hello` serves the whole attempt.
  assert.deepEqual(
    result.sessions.map((session) => session.map((request) => request.operation)),
    [["hello", "arm_attempt", "contain_role"]],
    "a command refused before it was written must not end the session that carried the arm: the peer read " +
      "a replacement session, or the follow-up command never arrived",
  );
  assert.match(result.stderr, /wire_oversized_followup:contained/);
});

/**
 * The parent PATH the failing machine had, as directory entries: 17 069 characters of it reached the
 * role environment before this lane, and that one variable is what made the launch frame unsendable.
 */
function developerMachinePath(): string {
  return Array.from({ length: 560 }, (_, index) => `C:\\Program Files\\toolchain-${index}\\bin`).join(";");
}

test("a role environment built from a 17 069-character PATH still fits the launch frame", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const parentPath = developerMachinePath();
  assert.ok(
    parentPath.length >= 17_069,
    `this gate has to reproduce the measured failure: ${parentPath.length} characters of PATH is not 17 069`,
  );

  // The product's own builder, on the environment the Host really runs in.
  const previousPath = process.env.PATH;
  process.env.PATH = parentPath;
  let environment: Readonly<Record<string, string>>;
  try {
    environment = createStardewChildEnvironment("wire-long-path-generation");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }

  // 1. The role sees no PATH at all, and what it does see is inside its stated budget. Nothing the role
  //    launches resolves a name: the Guardian creates it by absolute image, in the game's own directory.
  assert.equal(
    Object.hasOwn(environment, "PATH"),
    false,
    `the role environment must not carry the Host's PATH: it carried ${environment.PATH?.length} characters`,
  );
  const environmentBytes = Buffer.byteLength(JSON.stringify(environment), "utf8");
  assert.ok(
    environmentBytes <= STARDEW_CHILD_ENVIRONMENT_MAX_BYTES,
    `the role environment is ${environmentBytes} bytes against its stated budget of ${STARDEW_CHILD_ENVIRONMENT_MAX_BYTES}`,
  );

  // 2. The launch reaches the peer on that environment, and the frame it travelled in fits the bound this
  //    channel shares with the Desktop broker - read from the broker's own source, not from a second copy.
  const result = await runWireFixture("long-path-role-environment", { launchEnvironment: environment });
  assert.match(
    result.stderr,
    /wire_long_path_launch:accepted/,
    `the product's launch must be accepted: ${result.stderr}`,
  );
  assert.deepEqual(
    result.sessions.map((session) => session.map((request) => request.operation)),
    [["hello", "arm_attempt", "launch_role", "contain_role"]],
    "the launch must reach the peer the attempt armed: `launch_role` is missing from the operations it read",
  );
  const launchFrame = result.frameBytes.find((frame) => frame.operation === "launch_role");
  assert.ok(launchFrame !== undefined, "the peer read no launch_role frame to measure");
  const brokerBound = desktopBrokerWireBound();
  t.diagnostic(
    `role environment ${environmentBytes} B of ${STARDEW_CHILD_ENVIRONMENT_MAX_BYTES}; launch_role frame ` +
      `${launchFrame.bytes} B of ${brokerBound}; parent PATH ${parentPath.length} characters`,
  );
  assert.ok(
    launchFrame.bytes <= brokerBound,
    `the launch frame is ${launchFrame.bytes} bytes against the ${brokerBound}-byte bound the Host and the ` +
      `Desktop broker share (the role environment is ${environmentBytes}); 17 069 characters of PATH forwarded ` +
      "into the role environment is what made this frame 26 393 bytes and ended one launch before it was written",
  );
});

/** The Desktop broker's own frame bound, read from the file that declares it. */
function desktopBrokerWireBound(): number {
  const source = readFileSync(
    resolve(packageRoot, "..", "desktop", "GameBuddy.Desktop", "DesktopHostBootstrapBroker.cs"),
    "utf8",
  );
  const declared = /private const int MaxWireBytes = ([\d_]+);/u.exec(source);
  if (declared === null) throw new Error("desktop_broker_frame_bound_not_declared");
  assert.equal(
    Number(declared[1]!.replaceAll("_", "")),
    MAX_GUARDIAN_WIRE_BYTES,
    "the Host's session bound and the Desktop broker's own must be one number",
  );
  return MAX_GUARDIAN_WIRE_BYTES;
}

/**
 * The two objects one attempt's arm binding names beyond its revision, plus the third one the binding
 * carries. They are the names a Guardian creates at arm: `GuardianLease.Create` makes the lease mutex
 * and `WindowsJobOwner.Create` makes the two role Jobs.
 */
type WireGuardianNames = Readonly<{ leaseName: string; playerJobName: string; aiJobName: string }>;
type WireGuardianDesignation = WireGuardianNames & Readonly<{ revision: string }>;

/**
 * The three objects of one arm binding, as the OS answered about them through the production probe.
 * `unmeasured` is the probe being unable to run, never an answer about an object.
 */
type WireGuardianObjectAnswers = Readonly<{ lease: string; playerJob: string; aiJob: string }>;

/** The tokenless arm body the Host wrote into one session frame: the binding facts it carries. */
function armFrameOf(request: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(Buffer.from(String(request.privateFrame), "base64url").toString("utf8")) as Record<string, unknown>;
}

/**
 * Mints one attempt's arm binding names the way the attempt mints them: the production composition
 * draws every name from `Local\\GameBuddy-${randomUUID()}` (`createStardewPrivateBootstrapProductionCore`),
 * and `createGuardianBinding` refuses a binding whose three names are not distinct. Minted rather than
 * fixed so an object an earlier run left behind can never make a presence reading ambiguous, and so the
 * reading is of THESE names rather than of two strings hard-coded next to the assertion.
 */
function mintGuardianBinding(): WireGuardianDesignation {
  return Object.freeze({
    revision: randomUUID(),
    leaseName: `Local\\GameBuddy-${randomUUID()}`,
    playerJobName: `Local\\GameBuddy-${randomUUID()}`,
    aiJobName: `Local\\GameBuddy-${randomUUID()}`,
  });
}

/**
 * The native holder that owns a Guardian's named objects in this suite.
 *
 * `--hold-mutex` creates the named lease mutex and `--hold-job` creates the named Job and joins the
 * holder to it: the same two creations a real Guardian performs at arm, from the fixture that
 * `stardew-guardian-object-presence.test.ts` measures the production probe against. Built by
 * `node scripts/build-windows-bootstrap-guardian.mjs`.
 */
const GUARDIAN_OBJECT_HOLDER = resolve(
  packageRoot,
  "native",
  "windows-bootstrap-guardian",
  ".dist",
  "fixtures",
  "RoleRootFixture.exe",
);
const GUARDIAN_OBJECT_HOLDER_TIMEOUT_MS = 30_000;

type WireGuardianObjectHolders = Readonly<{ ready: Promise<void>; end(): Promise<void> }>;

/**
 * Creates one attempt's three named objects and holds them, as its Guardian does.
 *
 * Two holders because one holder process creates one Job and one mutex while the binding names three
 * objects. `ready` resolves once both holders reported the creation, so the arm they belong to is only
 * answered after the objects exist; `end` kills exactly the two processes this fixture started and
 * waits for the OS to report both exits, because an absence reading means nothing before the holders
 * are gone - a named Job dies with the last handle open on it.
 */
function holdGuardianObjects(names: WireGuardianNames): WireGuardianObjectHolders {
  const reports = [0, 1].map(() => join(tmpdir(), `gamebuddy-wire-objects-${process.pid}-${randomUUID()}.txt`));
  const holders = [
    spawn(
      GUARDIAN_OBJECT_HOLDER,
      ["--hold-mutex", names.leaseName, "--hold-job", names.playerJobName, "--signal", reports[0]!],
      { shell: false, windowsHide: true, stdio: "ignore" },
    ),
    spawn(GUARDIAN_OBJECT_HOLDER, ["--hold-job", names.aiJobName, "--signal", reports[1]!], {
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    }),
  ];
  const ready = (async () => {
    for (const [index, report] of reports.entries()) await waitForHolderReport(report, holders[index]!);
  })();
  ready.catch(() => undefined);
  return Object.freeze({
    ready,
    async end() {
      await Promise.all(
        holders.map(async (holder) => {
          if (holder.exitCode !== null) return;
          const exited = new Promise<void>((resolveExit) => holder.once("close", () => resolveExit()));
          holder.kill();
          await exited;
        }),
      );
      await Promise.all(reports.map((report) => rm(report, { force: true })));
    },
  });
}

/** Waits for one holder's readiness report; a holder that exited first is a blocked measurement, named. */
async function waitForHolderReport(report: string, holder: ChildProcess): Promise<void> {
  const deadline = Date.now() + GUARDIAN_OBJECT_HOLDER_TIMEOUT_MS;
  for (;;) {
    try {
      await readFile(report, "utf8");
      return;
    } catch {
      if (holder.exitCode !== null)
        throw new Error(`windows_guardian_object_holder_exited_before_report:${String(holder.exitCode)}`);
      if (Date.now() > deadline) throw new Error("windows_guardian_object_holder_report_timeout");
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }
}

/**
 * The OS's answer about the three objects one attempt's arm binding names.
 *
 * The probe's contract names the two objects the durable reconcile decides on (`playerJob`, `lease`),
 * and widening that contract is the game layer's to do, not this suite's. The binding names a third
 * object (`aiJobName`), so it is asked through the SAME production probe with the ai Job in the Job
 * slot and only that answer is read: `OpenJobObjectW` opens a name and does not care which of the
 * attempt's two Jobs the caller calls it.
 */
async function readAttemptObjects(names: WireGuardianNames): Promise<WireGuardianObjectAnswers> {
  const roles = await probeWindowsStardewGuardianObjects({
    leaseName: names.leaseName,
    playerJobName: names.playerJobName,
  });
  const ai = await probeWindowsStardewGuardianObjects({
    leaseName: names.leaseName,
    playerJobName: names.aiJobName,
  });
  return Object.freeze({ lease: roles.lease, playerJob: roles.playerJob, aiJob: ai.playerJob });
}

test("desktop bootstrap helper rejects malformed arm input before writing arm_attempt", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("malformed-arm");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello"],
  );
  assert.match(result.stderr, /(?:^|\n)desktop_runtime_bootstrap_unavailable:guardian_command_input_invalid\n$/);
  assert.doesNotMatch(result.stderr, /unexpected_arm_success|success|armed|arm_attempt/);
});

test("desktop bootstrap helper closes an authenticated guardian session when composition construction fails", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("composition-failure");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello"],
  );
  assert.equal(result.guardianClosed, true);
  assert.match(result.stderr, /composition_construction_failed/);
});

test("desktop bootstrap helper closes its composition when acknowledgement writing fails", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("ack-write-failure");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello"],
  );
  assert.equal(result.guardianClosed, true);
  assert.match(result.stderr, /ack_write_failed/);
});

test("desktop bootstrap helper closes its composition and leaves by itself when its owner's channel ends", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("readiness-publication");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt", "launch_role", "contain_role"],
  );
  assert.equal(result.guardianClosed, true);
  // The quit here is the product's own - the controller channel ends - and the child closes its
  // composition and leaves by itself: exit 0, not killed. That is the whole trigger the Host has
  // (ADR-0012 §6.3/§9.3); the `message` channel it used to answer on had no producer in the product.
  assert.equal(result.workerExitCode, 0, "the child must close its own composition and exit 0, not be killed");
  assert.equal(result.workerExitedNaturally, true);
});

test("desktop bootstrap helper ignores an inbound IPC message and stays up", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("readiness-publication", { inboundMessage: true });
  // The readiness channel carries one frame OUT and no order IN. Nothing inbound is a quit request:
  // the child has no `message` listener at all, so an unrelated payload cannot drop the composition.
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "arm_attempt", "launch_role", "contain_role"],
  );
  assert.equal(result.exitCodeWhileServing, null, "an inbound message must not drop the composition");
});

// The recovery conversation is the only operation whose read path waits for more
// than one acknowledgement on one session. This drives it through the real named
// pipe so the session's waiter installs, the exact ordinal frame order the
// Desktop broker compares, and the terminal containment are all observed on the
// wire rather than only against a recording transport.
test("desktop bootstrap helper drives the recovery conversation over one authenticated session", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("recovery-success");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    [
      "hello",
      "recover_attempt",
      "recovery_post_cas",
      "recover_attempt",
      "recovery_role_cas_ack",
      "recovery_role_cas_ack",
      "recovery_finalize_ack",
      "release",
    ],
  );
  // The recovery frames speak the recovery role token, and the private bodies are
  // the ones the durable steps produced.
  assert.deepEqual(
    result.requests.filter((request) => request.role !== undefined).map((request) => request.role),
    ["playerHost", "aiClient"],
  );
  const postCas = JSON.parse(
    Buffer.from(String(result.requests[2]!.privateFrame), "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  assert.equal(postCas.ownerRecordRevision, 2);
  assert.doesNotMatch(result.stderr, /desktop_runtime_bootstrap_unavailable/);
});

// The mirror of the resume tolerance: a role CAS the durable record refuses must
// still fail the whole session closed. The rejected role is the first one, so the
// conversation stops before that role's CAS acknowledgement and the peer sees the
// disconnect instead of a containment the record never accepted.
test("desktop bootstrap helper fails the recovery session closed when the durable role CAS refuses a role", async (t) => {
  if (process.platform !== "win32") return t.skip("Windows-only root admission and named-pipe protocol");
  const result = await runWireFixture("recovery-role-rejected");
  assert.equal(JSON.parse(result.acknowledgement!).status, "accepted");
  assert.deepEqual(
    result.requests.map((request) => request.operation),
    ["hello", "recover_attempt", "recovery_post_cas", "recover_attempt"],
  );
  // The durable step ran and refused, the peer saw the live session close, and no
  // containment was ever reported: the wire writes no CAS acknowledgement for the
  // refused role, no finalize and no release frame.
  assert.match(result.stderr, /recovery_role_contained:playerHost/);
  assert.equal(result.guardianClosed, true, "a refused role CAS must close the session rather than leave it live");
  assert.doesNotMatch(result.stderr, /recovery_outcome:/);
});

async function runWireFixture(
  scenario:
    | "success"
    | "recovery-success"
    | "recovery-role-rejected"
    | "readiness-publication"
    | "missing-arm-executable"
    | "malformed-arm"
    | "withheld-arm-ack"
    | "delayed-arm-ack"
    | "withheld-contain-ack"
    | "expired-launch"
    | "overhorizon-launch"
    | "peer-disconnect"
    | "lost-session-rearm"
    | "oversized-launch-frame"
    | "long-path-role-environment"
    | "settled-session"
    | "settled-session-owner-quit"
    | "drain-owner-quit"
    | "drain-owner-quit-broker-first"
    | "settle-and-rearm"
    | "settle-leaves-nothing"
    | "composition-failure"
    | "ack-write-failure"
    | "invalid-surface"
    | "invalid-nonce",
  options: Readonly<{
    surface?: string;
    nonceSha256?: string;
    modOutcome?: string;
    /** The role environment the product built; the long-PATH scenario passes the real one. */
    launchEnvironment?: Readonly<Record<string, string>>;
    /** Writes an unrelated payload down the readiness channel before the quit, to read whether it was taken as an order. */
    inboundMessage?: boolean;
  }> = {},
): Promise<{
  requests: Record<string, unknown>[];
  acknowledgement: string | undefined;
  lines: readonly string[];
  statuses: readonly string[];
  stderr: string;
  guardianClosed: boolean;
  messages: readonly Record<string, unknown>[];
  armReceiptAt: number | undefined;
  workerClosedAt: number | undefined;
  workerExitCode: number | null;
  workerExitedNaturally: boolean;
  /** The requests of each authenticated session the Host opened, in the order it opened them. */
  sessions: Record<string, unknown>[][];
  /** Every frame the peer read, in order, with its exact size in bytes including the newline. */
  frameBytes: readonly Readonly<{ operation: string; bytes: number }>[];
  /**
   * The child's exit code read while it was still expected to be serving - after the
   * scenario's own session close, before this harness asks it to leave. `null` is
   * "still running", which is the only answer a session close may produce.
   */
  exitCodeWhileServing: number | null;
  /** The pid of the Host child this fixture spawned and served. */
  workerPid: number | undefined;
  /**
   * The Host's own exit record under `<operationalRoot>\host-exit`, or `undefined` when the exit was
   * clean - the production Host writes one exactly when a reclamation step of its own failed.
   */
  hostExitRecord: Record<string, unknown> | undefined;
  /** The role of every `contain_role` frame the peer answered, in the order it answered them. */
  containedRoleFrames: readonly string[];
  /**
   * How long the child took to leave after the quit closed the two channels this launcher owns,
   * or `undefined` when it was still serving at the end of the measured window.
   */
  controllerQuitExitMs: number | undefined;
  /**
   * The Host's own surface, read over HTTP from the port it published, AFTER the peer refused its
   * attempt. `undefined` when the scenario reads no surface of its own.
   */
  stateReadAfterLoss: Readonly<{ status: number; body: string }> | undefined;
  /**
   * The OS's answer about the three objects attempt 1's arm binding names, read while that attempt was
   * live and again once its settle had ended it. `undefined` when the scenario reads no objects.
   */
  attemptObjects:
    | Readonly<{
        binding: WireGuardianNames;
        whileArmed: WireGuardianObjectAnswers;
        afterSettle: WireGuardianObjectAnswers;
      }>
    | undefined;
  /** The frames this peer refused under the broker's own transition rules, named by what broke. */
  peerRefusals: readonly string[];
}> {
  const fixturesWithIpc = scenario === "readiness-publication";
  // The two quit scenarios put a LIVE attempt in front of a quit: her client was launched and never
  // contained, which is the state the production drain's third step exists for.
  const liveDrainQuit = scenario === "drain-owner-quit" || scenario === "drain-owner-quit-broker-first";
  const fixtureRoot = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-wire-"));
  const bootstrapId = (
    scenario === "success"
      ? "d"
      : scenario === "recovery-success"
        ? "1"
        : scenario === "recovery-role-rejected"
          ? "4"
          : scenario === "missing-arm-executable"
            ? "5"
            : scenario === "malformed-arm"
              ? "c"
              : scenario === "withheld-arm-ack"
                ? "b"
                : scenario === "delayed-arm-ack"
                  ? "7"
                  : scenario === "withheld-contain-ack"
                    ? "a"
                    : scenario === "expired-launch"
                      ? "9"
                      : scenario === "overhorizon-launch"
                        ? "6"
                        : scenario === "invalid-surface"
                          ? "2"
                          : scenario === "invalid-nonce"
                            ? "3"
                            : scenario === "oversized-launch-frame"
                              ? "e"
                              : "8"
  ).repeat(64);
  const guardianInstanceId =
    scenario === "success"
      ? "11111111-1111-4111-8111-111111111111"
      : scenario === "malformed-arm"
        ? "33333333-3333-4333-8333-333333333333"
        : "55555555-5555-4555-8555-555555555555";
  const attemptId =
    scenario === "success"
      ? "22222222-2222-4222-8222-222222222222"
      : scenario === "malformed-arm"
        ? "44444444-4444-4444-8444-444444444444"
        : "66666666-6666-4666-8666-666666666666";
  const rootLayout = {
    schema: "gamebuddy-windows-root-layout/v1",
    programRoot: join(fixtureRoot, "Programs", "GameBuddy"),
    dataRoot: join(fixtureRoot, "GameBuddy", "data"),
    operationalRoot: join(fixtureRoot, "GameBuddy", "operational"),
    presentationRoot: join(fixtureRoot, "GameBuddy", "presentation"),
  };
  const moduleDirectory = join(rootLayout.programRoot, "generation");
  const endpoint = `\\\\.\\pipe\\GameBuddy.HostGuardian.${bootstrapId}`;
  // The two attempts' arm bindings. Every scenario draws them the way a reservation does, so no
  // Guardian object name in this suite is a literal an assertion can be written against.
  const firstBinding = mintGuardianBinding();
  const secondBinding = mintGuardianBinding();
  // The one place attempt 1 may settle from: the attempt reads it after `contain_role`, and this
  // harness writes it once it has read the attempt's objects. A settle gate rather than a sleep,
  // because a reading taken after the settle would be a reading of the harness, not of the attempt.
  const probeGate = join(fixtureRoot, "probe-gate.txt");
  let objectHolders: WireGuardianObjectHolders | undefined;
  let objectsBinding: WireGuardianNames | undefined;
  let objectsWhileArmed: WireGuardianObjectAnswers | undefined;
  let objectsAfterSettle: WireGuardianObjectAnswers | undefined;
  let firstArmAckResolve!: () => void;
  const firstArmAck = new Promise<void>((resolveAck) => {
    firstArmAckResolve = resolveAck;
  });
  const peerRefusals: string[] = [];
  const requests: Record<string, unknown>[] = [];
  /**
   * Every frame the peer READ, with its exact size including the newline.
   *
   * The bound this channel enforces is a byte count, so a gate that says a launch fits has to read
   * the bytes the peer actually received rather than re-derive them from the frame's fields.
   */
  const frameBytes: Readonly<{ operation: string; bytes: number }>[] = [];
  const sessions: Record<string, unknown>[][] = [];
  let connected = false;
  let containRoles = 0;
  /**
   * The authenticated sockets this peer has open.
   *
   * A quit that closes the broker destroys the Host-facing pipe (`DesktopHostBootstrapBroker.CloseAsync`
   * -> `server.Dispose()`); `server.close()` alone would only stop accepting while the live session kept
   * serving. The two quit scenarios below take the sockets away themselves, so "the broker is gone" is a
   * real destroyed pipe and not a server that merely stopped listening.
   */
  const liveSockets = new Set<{ destroy(): void }>();
  /** The Host's own `host-exit` record, when the drain did not end cleanly. */
  let hostExitRecord: Record<string, unknown> | undefined;
  let recoveryAttempts = 0;
  let operationsResolve!: () => void;
  const operationsComplete = new Promise<void>((resolve) => {
    operationsResolve = resolve;
  });
  let worker: ReturnType<typeof spawn> | undefined;
  let peerError: Error | undefined;
  let armReceiptAt: number | undefined;
  let exitCodeWhileServing: number | null = null;
  let controllerQuitExitMs: number | undefined;
  let stateReadAfterLoss: Readonly<{ status: number; body: string }> | undefined;
  let guardianClosed = false;
  let guardianClosedResolve!: () => void;
  const guardianPeerClosed = new Promise<void>((resolve) => {
    guardianClosedResolve = resolve;
  });
  // How many authenticated sessions the Host has closed, and a way to wait for the
  // Nth one: the per-attempt scenarios need to observe a close that is not the end of
  // the process.
  let guardianCloses = 0;
  const guardianCloseWatchers = new Map<number, () => void>();
  const waitForGuardianCloses = (target: number): Promise<void> =>
    guardianCloses >= target
      ? Promise.resolve()
      : new Promise<void>((resolve) => guardianCloseWatchers.set(target, resolve));
  const server = createServer((socket) => {
    connected = true;
    // One authenticated session per connection: the Desktop broker serves the Host one
    // session at a time and re-authenticates every connection from scratch, so what the
    // Host says on connection 2 is a fact about its own attempt boundary.
    const session: Record<string, unknown>[] = [];
    sessions.push(session);
    liveSockets.add(socket);
    /** The correlation this session's own arm established, as `ValidateTransition` keeps it. */
    let armedCorrelation: string | undefined;
    socket.once("close", () => {
      liveSockets.delete(socket);
      guardianClosed = true;
      guardianClosedResolve();
      guardianCloses += 1;
      for (const [target, resolve] of [...guardianCloseWatchers]) {
        if (guardianCloses < target) continue;
        guardianCloseWatchers.delete(target);
        resolve();
      }
    });
    socket.on("error", (error) => {
      peerError = error;
    });
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const newline = buffer.indexOf(10);
        if (newline < 0) return;
        const request = JSON.parse(buffer.subarray(0, newline).toString("utf8")) as Record<string, unknown>;
        buffer = buffer.subarray(newline + 1);
        requests.push(request);
        session.push(request);
        const operation = request.operation;
        frameBytes.push(Object.freeze({ operation: String(operation), bytes: newline + 1 }));
        if (scenario === "settle-leaves-nothing" && operation !== "hello") {
          // The rules `DesktopHostBootstrapBroker.ValidateTransition` (:458-470) applies, in the order it
          // applies them: one arm per session (`if (armed) throw new GuardianLaunchUnavailableException()`)
          // and, after it, every frame must carry the correlation that arm established
          // (`correlation != next`). The arm frame itself ESTABLISHES that correlation - which is why an
          // arm carrying a settled attempt's triple is accepted here and is measured as accepted, not
          // refused (ADR-0015 §4.2 revised). A frame the broker refuses ends the broker session, so this
          // peer answers nothing and destroys the socket, the shape `GuardianLaunchUnavailableException`
          // has on the session it was raised in.
          const correlation = `${String(request.guardianInstanceId)}/${String(request.attemptId)}`;
          if (operation === "arm_attempt" && armedCorrelation !== undefined) {
            peerRefusals.push("arm_attempt:already_armed");
            socket.destroy();
            return;
          }
          if (operation !== "arm_attempt" && armedCorrelation !== correlation) {
            peerRefusals.push(`${String(operation)}:correlation_mismatch`);
            socket.destroy();
            return;
          }
          if (operation === "arm_attempt") {
            armedCorrelation = correlation;
            if (sessions.length === 1) {
              // THIS peer is attempt 1's Guardian, so it creates the attempt's named objects when the
              // arm frame arrives and answers `armed` afterwards - the order a real Guardian arms in
              // (`Program.cs:79-82`: the lease mutex and both role Jobs exist before the arm is
              // acknowledged). The names come from the frame the Host wrote, not from an assumption here.
              const binding = armFrameOf(request);
              objectsBinding = Object.freeze({
                leaseName: String(binding.leaseName),
                playerJobName: String(binding.playerJobName),
                aiJobName: String(binding.aiJobName),
              });
              objectHolders = holdGuardianObjects(objectsBinding);
            }
          }
        }
        if ((scenario === "recovery-success" || scenario === "recovery-role-rejected") && operation !== "hello") {
          // Answered at the positions the Desktop broker answers: one
          // acknowledgement for the gate, one for the post-CAS + native recover
          // pair, one per contained role, and one terminal acknowledgement after
          // the release frame. Every acknowledgement carries the recovery actor
          // and no role.
          let status: string | undefined;
          if (operation === "recover_attempt") {
            status = recoveryAttempts === 0 ? "recovery_accepted" : "player_contained";
            recoveryAttempts += 1;
          } else if (operation === "recovery_role_cas_ack")
            status = request.role === "playerHost" ? "ai_contained" : undefined;
          else if (operation === "release") status = "contained";
          if (status !== undefined)
            socket.write(
              `${JSON.stringify({ schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation: "recover_attempt", status, bootstrapId, generation: request.generation, inventoryDigest: request.inventoryDigest, runtimeAdmissionSha256: request.runtimeAdmissionSha256, guardianInstanceId: request.guardianInstanceId, guardianEpoch: request.guardianEpoch, attemptId: request.attemptId, recoveryInstanceId: request.recoveryInstanceId })}\n`,
            );
          // A refused role CAS ends the conversation at that role, so the peer
          // resolves the operations when it answers the role the test refuses
          // instead of on a release frame that must never arrive.
          if (operation === "release" || (scenario === "recovery-role-rejected" && status === "player_contained"))
            operationsResolve();
          continue;
        }
        if (scenario === "delayed-arm-ack" && operation === "arm_attempt") {
          armReceiptAt = performance.now();
          setTimeout(
            () =>
              socket.write(
                `${JSON.stringify({ schema: "gamebuddy-desktop-guardian-session/v1", protocolVersion: 1, operation: "arm_attempt", status: "armed", bootstrapId, generation: request.generation, inventoryDigest: request.inventoryDigest, runtimeAdmissionSha256: request.runtimeAdmissionSha256, guardianInstanceId: request.guardianInstanceId, guardianEpoch: request.guardianEpoch, attemptId: request.attemptId })}\n`,
              ),
            250,
          );
          return;
        }
        if (
          (scenario === "withheld-arm-ack" && operation === "arm_attempt") ||
          (scenario === "withheld-contain-ack" && operation === "contain_role")
        )
          return;
        if (scenario === "peer-disconnect" && operation === "arm_attempt") {
          socket.destroy();
          return;
        }
        // The broker a generation with NO resident Guardian runs
        // (`tools/lib/guardian-role-broker.mjs`: `role_broker_hello_only_refused:<operation>`): the
        // hello is served, and the attempt's first command destroys the socket instead of being
        // answered. That is the peer the measured launch press met.
        if (scenario === "lost-session-rearm" && operation === "arm_attempt" && sessions.length === 1) {
          socket.destroy();
          return;
        }
        const response: Record<string, unknown> = {
          schema: "gamebuddy-desktop-guardian-session/v1",
          protocolVersion: 1,
          operation,
          status:
            operation === "hello"
              ? "accepted"
              : operation === "arm_attempt"
                ? "armed"
                : operation === "launch_role"
                  ? "role_active"
                  : "role_contained",
          bootstrapId,
          generation: request.generation,
          inventoryDigest: request.inventoryDigest,
          runtimeAdmissionSha256: request.runtimeAdmissionSha256,
        };
        if (operation !== "hello")
          Object.assign(response, {
            guardianInstanceId: request.guardianInstanceId,
            guardianEpoch: request.guardianEpoch,
            attemptId: request.attemptId,
            ...(operation !== "arm_attempt" ? { role: request.role } : {}),
          });
        socket.write(`${JSON.stringify(response)}\n`);
        if (scenario === "settle-leaves-nothing" && operation === "arm_attempt" && sessions.length === 1)
          firstArmAckResolve();
        if (scenario === "lost-session-rearm" && operation === "arm_attempt" && sessions.length === 2)
          operationsResolve();
        if (operation === "contain_role") {
          containRoles += 1;
          // Every attempt of the per-attempt scenarios arms, launches and contains its
          // own Player role; the peer has nothing left to answer once the last one did. The quit
          // scenarios are the exception: their attempt is still live at the quit, so the reading that
          // says the attempt is up is the AI role's launch and not a containment.
          if (!liveDrainQuit && containRoles >= (scenario === "settle-and-rearm" ? 2 : 1)) operationsResolve();
        }
        if (liveDrainQuit && operation === "launch_role" && request.role === "ai_client") operationsResolve();
      }
    });
  });
  try {
    await Promise.all(
      [moduleDirectory, rootLayout.dataRoot, rootLayout.operationalRoot, rootLayout.presentationRoot].map((path) =>
        mkdir(path, { recursive: true }),
      ),
    );
    await mkdir(join(moduleDirectory, "bootstrap", "wire"), { recursive: true });
    await writeFile(
      join(moduleDirectory, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js"),
      await readFile(compiledArtifact("bootstrap", "wire", "desktop-runtime-bootstrap.internal.js")),
    );
    await cp(compiledArtifact("windows-reparse-inspector"), join(moduleDirectory, "windows-reparse-inspector-real"), {
      recursive: true,
    });
    // The wire suite's subject is the WIRE: the frames, the status stages, the guardian protocol
    // and the acknowledgement. Its roots must still pass the REAL physical admission - the reparse
    // chain, the volume and the file id, which the native helper reports clean here - but a root's
    // OWNER is a property of the machine, not of the wire: a runner runs as an elevated
    // administrator whose every new directory is owned by BUILTIN\Administrators, so no root the
    // fixture creates there can ever satisfy the current-user-owner predicate (measured on the
    // runner: wire_admission_deep:security_owner_0,security_owner_1,security_owner_2,security_owner_3
    // on all 19 wire cases, with chain, volume and file id clean). Only that one field is
    // normalized, and every other answer stays exactly what the native helper returned, so the suite
    // keeps proving the wire against real ACL data on any machine. The predicate itself is proven
    // where it lives: the helper's own tests.
    await mkdir(join(moduleDirectory, "windows-reparse-inspector"), { recursive: true });
    await writeFile(
      join(moduleDirectory, "windows-reparse-inspector", "index.js"),
      `import {
  createPublishedWindowsReparseInspector,
  inspectWindowsPathIdentityChain,
  inspectWindowsPathSecurity as inspectRealSecurity,
} from "../windows-reparse-inspector-real/index.js";
export { createPublishedWindowsReparseInspector, inspectWindowsPathIdentityChain };
export async function inspectWindowsPathSecurity(capability, absolutePath) {
  const security = await inspectRealSecurity(capability, absolutePath);
  return Object.freeze({ ...security, currentUserOwner: true });
}
`,
    );
    await cp(compiledArtifact("strict-json-reader.js"), join(moduleDirectory, "strict-json-reader.js"));
    await mkdir(join(moduleDirectory, "composition"), { recursive: true });
    await cp(
      compiledArtifact("composition", "desktop-host-composition.js"),
      join(moduleDirectory, "composition", "desktop-host-composition.js"),
    );
    // The bootstrap entry imports the named exit-reclamation contract (the composition's
    // close reports its steps through it) and the exit record it writes for an operator.
    // Both are production modules the copied entry resolves by relative URL, so the
    // fixture ships them exactly like the other seams above.
    await cp(
      compiledArtifact("composition", "desktop-host-reclamation.js"),
      join(moduleDirectory, "composition", "desktop-host-reclamation.js"),
    );
    await cp(
      compiledArtifact("bootstrap", "wire", "desktop-host-exit-record.internal.js"),
      join(moduleDirectory, "bootstrap", "wire", "desktop-host-exit-record.internal.js"),
    );
    // The wire worker drives the real contained runtime platform encoder so the
    // fixture asserts the actual arm frame (approvedExecutable) and the launch
    // frame consistency instead of an opaque placeholder. That module needs the
    // launch-plan encoder and the synchronized contained runtime core; the
    // composer-core import inside it is a Guardian-owner seam the fixture never
    // invokes, so a hermetic throwing stub keeps the fixture self-contained.
    await cp(
      compiledArtifact("composition", "stardew", "stardew-guardian-platform.js"),
      join(moduleDirectory, "composition", "stardew", "stardew-guardian-platform.js"),
    );
    await cp(
      compiledArtifact("composition", "stardew", "stardew-native-role-launch-plan.private.js"),
      join(moduleDirectory, "composition", "stardew", "stardew-native-role-launch-plan.private.js"),
    );
    const containmentCore = join(moduleDirectory, "containment", "runtime", "core", "contained-game-runtime.js");
    await mkdir(dirname(containmentCore), { recursive: true });
    await cp(compiledArtifact("containment", "runtime", "core", "contained-game-runtime.js"), containmentCore);
    // The recovery wire tolerates the durable engine's refusal by the identity the
    // platform contract exports, so the bootstrap module imports that contract at
    // runtime; the fixture copies it the same way it copies the runtime core.
    const containmentContract = join(moduleDirectory, "containment", "runtime", "contract", "game-runtime.js");
    await mkdir(dirname(containmentContract), { recursive: true });
    await cp(compiledArtifact("containment", "runtime", "contract", "game-runtime.js"), containmentContract);
    // The session contract is a runtime import now (the refusal wrapper it declares is what the wire
    // spells and the contained runtime strips), so the fixture ships it like the other modules the
    // artifact entry imports.
    const guardianSessionContract = join(
      moduleDirectory,
      "containment",
      "auth",
      "desktop-guardian-session.internal.js",
    );
    await mkdir(dirname(guardianSessionContract), { recursive: true });
    await cp(compiledArtifact("containment", "auth", "desktop-guardian-session.internal.js"), guardianSessionContract);
    const composerCorePath = join(
      moduleDirectory,
      "games",
      "stardew",
      "lifecycle",
      "stardew-private-bootstrap-composer.core.internal.js",
    );
    await mkdir(dirname(composerCorePath), { recursive: true });
    await writeFile(
      composerCorePath,
      '// Hermetic wire-fixture stub: the contained runtime platform imports these seams but\n// never invokes them; the recovery finalization in particular is only reachable\n// through the launch collaborator factory this fixture never builds. The stub keeps\n// the module graph self-contained instead of dragging in the whole composer core\n// closure. Every seam throws instead of no-oping, so a fixture that ever did reach\n// one fails loudly rather than silently skipping a durable step.\nexport function createStardewBootstrapGuardianOwnerBinding() { throw new Error("wire_fixture_composer_core_stub_unused"); }\nexport function readStardewBootstrapGuardianNativeArmFrame() { throw new Error("wire_fixture_composer_core_stub_unused"); }\nexport function consumeStardewBootstrapGuardianOwnerBinding() { throw new Error("wire_fixture_composer_core_stub_unused"); }\nexport function settleOwnedPlayerHostContainedRuntimeAttempt() { throw new Error("wire_fixture_composer_core_stub_unused"); }\nexport function finalizeRecoveredPlayerHostContainedRuntimeAttempt() { throw new Error("wire_fixture_composer_core_stub_unused"); }\n',
    );
    // Same reasoning for the optional Voice surface the bootstrap entry imports.
    // The fixture never configures GAMEBUDDY_VOICE_PORT/TOKEN, so
    // connectOptionalVoiceSurface() returns before calling into the gateway; a
    // hermetic stub keeps the Voice client closure (and its workspace protocol
    // package) out of this fixture instead of copying a module graph it never
    // drives. Added 2026-09-26: the import arrived in b5ac04c without this
    // fixture being updated, which left all 14 executable cases failing on a
    // clean tree with ERR_MODULE_NOT_FOUND for voice-bootstrap.js.
    await writeFile(
      join(moduleDirectory, "voice-bootstrap.js"),
      '// Hermetic wire-fixture stub: the bootstrap entry imports this seam but the\n// fixture configures no Voice surface, so it is never invoked.\nexport async function connectHealthyVoiceGateway() { throw new Error("wire_fixture_voice_stub_unused"); }\nexport async function connectHealthyVoiceGatewayWith() { throw new Error("wire_fixture_voice_stub_unused"); }\n',
    );
    await cp(compiledArtifact("deployment-manifest.js"), join(moduleDirectory, "deployment-manifest.js"));
    // `deployment-manifest.js` imports the generated principal key set, which is a module of its own:
    // the fixture ships every module the entry resolves by relative URL, so this one travels beside it.
    // Missing it failed all 19 wire cases with ERR_MODULE_NOT_FOUND before their first assertion.
    await cp(
      compiledArtifact("deployment-principal.generated.js"),
      join(moduleDirectory, "deployment-principal.generated.js"),
    );
    // The bootstrap entry imports the presentation-handoff publisher (introduced
    // with the private presentation pipe) . The fixture ships every module the
    // compiled entry actually imports; a missing one fails every wire scenario
    // with ERR_MODULE_NOT_FOUND before the first assertion.
    await cp(
      compiledArtifact("desktop-presentation-handoff.internal.js"),
      join(moduleDirectory, "desktop-presentation-handoff.internal.js"),
    );
    const manifestPath = join(fixtureRoot, "deployment-manifest.json");
    await writeFile(
      manifestPath,
      `${JSON.stringify({
        schemaVersion: 2,
        topology: "independent_chat_and_game_surfaces",
        runtimeRoot: fixtureRoot,
        principal: { continuityId: "continuity-wire", companionId: "companion-wire", playerId: "player-wire" },
        bootstrapOperationId: "bootstrap-wire",
        authorityGeneration: 1,
      })}\n`,
    );
    await cp(
      resolve(packageRoot, "native", "windows-reparse-inspector", ".dist", "win-x64"),
      join(moduleDirectory, "native", "windows-reparse-inspector", "win-x64"),
      { recursive: true },
    );
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once("error", rejectListen);
      server.listen(endpoint, resolveListen);
    });
    const workerPath = join(fixtureRoot, "wire-fixture-worker.mjs");
    const wireFixture = {
      scenario,
      moduleDirectory,
      bootstrapUrl: pathToFileURL(join(moduleDirectory, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.js"))
        .href,
      compositionUrl: pathToFileURL(join(moduleDirectory, "composition", "desktop-host-composition.js")).href,
      platformUrl: pathToFileURL(join(moduleDirectory, "composition", "stardew", "stardew-guardian-platform.js")).href,
      reclamationUrl: pathToFileURL(join(moduleDirectory, "composition", "desktop-host-reclamation.js")).href,
      inspectorUrl: pathToFileURL(join(moduleDirectory, "windows-reparse-inspector", "index.js")).href,
      guardianInstanceId,
      attemptId,
      approvedExecutable: "C:\\Program Files\\GameBuddy\\roles\\RoleRootFixture.exe",
      launchFacts: {
        executable: "C:\\Program Files\\GameBuddy\\roles\\RoleRootFixture.exe",
        cwd: "C:\\Program Files\\GameBuddy",
        arguments: ["--signal", "C:\\tmp\\wire.txt"],
        environment: options.launchEnvironment ?? {
          SystemRoot: "C:\\Windows",
          WINDIR: "C:\\Windows",
          TEMP: "C:\\Windows\\Temp",
          TMP: "C:\\Windows\\Temp",
          USERPROFILE: "C:\\Users\\tester",
          GAMEBUDDY_STARDEW_LAUNCH_GENERATION: "wire-generation",
        },
      },
      armFacts: {
        revision: firstBinding.revision,
        leaseName: firstBinding.leaseName,
        playerJobName: firstBinding.playerJobName,
        aiJobName: firstBinding.aiJobName,
      },
      // The second attempt's reservation draws five fresh opaque names (ADR-0015 §4.2), so
      // its arm frame must carry none of the first attempt's.
      secondGuardianInstanceId: "99999999-9999-4999-8999-999999999999",
      secondAttemptId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      secondArmFacts: {
        revision: secondBinding.revision,
        leaseName: secondBinding.leaseName,
        playerJobName: secondBinding.playerJobName,
        aiJobName: secondBinding.aiJobName,
      },
      recoveryLeaseName: "Local\\GameBuddy-Lease-1",
      probeGate,
      recoveryBindingRevision: "88888888-8888-4888-8888-888888888888",
      modOutcome: options.modOutcome,
      // The admission probe reports the roots the child actually received, so the fixture carries them
      // plus the root the child's LOCALAPPDATA must equal, rather than the child re-deriving a shape.
      rootLayout: {
        probeRoot: fixtureRoot,
        programRoot: rootLayout.programRoot,
        dataRoot: rootLayout.dataRoot,
        operationalRoot: rootLayout.operationalRoot,
        presentationRoot: rootLayout.presentationRoot,
      },
    };
    await writeFile(workerPath, wireFixtureWorkerSource);
    // `readiness-publication` is the scenario that opens the launcher's readiness IPC channel, so the
    // ready frame the child publishes there is read rather than reconstructed.
    const stdio: "pipe"[] | ["pipe", "pipe", "pipe", "ipc"] = fixturesWithIpc
      ? ["pipe", "pipe", "pipe", "ipc"]
      : ["pipe", "pipe", "pipe"];
    worker = spawn(nodeExecutable, ["--experimental-test-module-mocks", workerPath], {
      stdio,
      env: {
        ...process.env,
        GAMEBUDDY_WIRE_FIXTURE: JSON.stringify(wireFixture),
        LOCALAPPDATA: fixtureRoot,
        GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST: manifestPath,
        ...(options.surface === undefined ? {} : { GAMEBUDDY_HOST_SURFACE: options.surface }),
        ...(options.nonceSha256 === undefined
          ? {}
          : { GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256: options.nonceSha256 }),
      },
    });
    const workerClose = waitForClose(worker);
    // The readiness IPC channel the launcher opens (`fixturesWithIpc`). Nothing else in this fixture reads it,
    // so an entry here is a frame the child published - never a frame it answered.
    const messages: Record<string, unknown>[] = [];
    worker.on("message", (message: unknown) => {
      messages.push(message as Record<string, unknown>);
    });
    const failureScenario =
      scenario === "composition-failure" ||
      scenario === "ack-write-failure" ||
      scenario === "invalid-surface" ||
      scenario === "invalid-nonce";
    const output = failureScenario ? undefined : collectFrames(worker.stdout!, worker);
    const stderr = collectBounded(worker.stderr!);
    let workerStderr = "";
    worker.stderr!.on("data", (chunk: Buffer) => {
      workerStderr = (workerStderr + chunk.toString()).slice(-4096);
    });
    // The child narrates the facts this fixture cannot see from the peer side (the code its own
    // command ended with, the port its own surface listens on); a scenario that waits for one of
    // them waits for the line the child actually wrote instead of for a duration.
    const waitForWorkerStderr = async (pattern: RegExp, label: string): Promise<RegExpMatchArray> => {
      const deadline = performance.now() + 10_000;
      for (;;) {
        const match = workerStderr.match(pattern);
        if (match !== null) return match;
        if (performance.now() > deadline)
          throw new Error(
            `${label} never appeared (worker=${worker?.exitCode ?? "running"}); stderr was ${workerStderr || "<empty>"}`,
          );
        await new Promise((resolveTick) => setTimeout(resolveTick, 25));
      }
    };
    // The frame is the controller channel's first line; the channel then STAYS OPEN for the run,
    // because its end is the launcher's one owner-liveness signal (a quit closes it, and a Host
    // that has no attempt session would otherwise never learn that its owner left).
    worker.stdin!.write(
      `${JSON.stringify({ schema: "gamebuddy-desktop-host-bootstrap/v1", protocolVersion: 1, bootstrapId, generation: "g-wire", inventoryDigest: "e".repeat(64), runtimeAdmissionSha256: "f".repeat(64), rootLayout })}\n`,
    );
    const frames =
      output === undefined
        ? undefined
        : await withTimeout(output, 10_000, "bootstrap acknowledgement").catch((error) => {
            throw new Error(
              `${error.message}; worker=${worker?.exitCode ?? "running"}/${worker?.signalCode ?? "none"}; stderr=${workerStderr || "<empty>"}; peer=${peerError?.message ?? "none"}; operations=${requests.map((request) => String(request.operation)).join(",") || "<none>"}`,
            );
          });
    const acknowledgement = frames?.acknowledgement;
    // A failed boot must CLOSE its composition and let the child exit - that is the
    // invariant, and it is not a statement about how fast this machine is. The bound
    // below exists only so a genuine hang fails instead of hanging the suite; it used to
    // be 2s, which a loaded machine (a full suite plus parallel lanes) could miss and
    // turn into a red for the wrong reason. A real failure still names the scenario, the
    // child's exit state and its stderr, so a hang stays diagnosable.
    const settleFailure = (error: unknown) =>
      new Error(
        `${(error as Error).message}; scenario=${scenario}; worker=${worker?.exitCode ?? "running"}/${worker?.signalCode ?? "none"}; stderr=${workerStderr || "<empty>"}`,
      );
    if (failureScenario) {
      await withTimeout(workerClose, CHILD_SETTLE_TIMEOUT_MS, `${scenario} rejection`).catch((error) => {
        throw settleFailure(error);
      });
      if (connected)
        await withTimeout(guardianPeerClosed, CHILD_SETTLE_TIMEOUT_MS, `${scenario} guardian cleanup`).catch(
          (error) => {
            throw settleFailure(error);
          },
        );
    } else if (fixturesWithIpc) {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      if (options.inboundMessage === true) {
        // Nothing inbound on this channel is an order: the child has no `message` listener, so an
        // unrelated payload must leave it serving. Read the process state, not a duration.
        worker.send({ not: "an-order" });
        await new Promise((resolveKeepalive) => setTimeout(resolveKeepalive, 500));
        exitCodeWhileServing = worker.exitCode;
      }
      // The quit is the product's own: the controller channel (this child's stdin) ends, exactly as
      // the launcher's `CloseAsync` ends it, and the child closes its composition and leaves by
      // itself. That is the graceful path the memory loop's phase-2 successor depends on.
      if (!worker.stdin!.destroyed) worker.stdin!.end();
      await withTimeout(workerClose, 10_000, "the owner channel's close");
    } else if (scenario === "lost-session-rearm") {
      // The refusal has to be READ from the child, not inferred from its exit: the peer destroyed
      // the socket, so the only place the attempt's own code exists is the child's own report.
      const port = Number((await waitForWorkerStderr(/wire_state_port:(\d+)/, "the Host's surface port"))[1]);
      const refused = await waitForWorkerStderr(/wire_lost_command_refused:(\S+)/, "the refused attempt");
      assert.equal(refused[1], "desktop_runtime_bootstrap_unavailable:guardian_session_closed");

      // (b) The surface the refused attempt belonged to is still served, from the same process.
      const stateResponse = await fetch(`http://127.0.0.1:${port}/state`);
      stateReadAfterLoss = Object.freeze({ status: stateResponse.status, body: await stateResponse.text() });

      // (d) The next attempt reached the peer, on the next session.
      const nextAttempt = await waitForWorkerStderr(
        /wire_second_attempt_(armed|refused:\S+)/,
        "the next attempt's arm",
      );
      assert.equal(
        nextAttempt[1],
        "armed",
        "the next attempt must reach the Guardian, not answer on the session the peer destroyed",
      );
      await withTimeout(operationsComplete, 10_000, "the next attempt's arm receipt");
      await withTimeout(waitForGuardianCloses(2), 10_000, "both attempt sessions closed");
      await new Promise((resolveSettle) => setTimeout(resolveSettle, 750));
      // (c) The process is still the one serving: read before this harness's own kill.
      exitCodeWhileServing = worker.exitCode;
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "lost-session-rearm cleanup");
    } else if (scenario === "settled-session") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      // The attempt is over. The Host closes its own end of the session and nothing else
      // happens; a wrong termination would be visible immediately, so give it a bounded
      // window and then read the process state rather than the state after this harness's
      // own kill.
      await withTimeout(waitForGuardianCloses(1), 10_000, "attempt session close");
      await new Promise((resolveSettle) => setTimeout(resolveSettle, 750));
      exitCodeWhileServing = worker.exitCode;
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "settled-session cleanup");
    } else if (scenario === "settled-session-owner-quit") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      // The attempt is over and the Host holds no socket. This is the quit: the two channels the
      // launcher owns are closed and nothing is signalled - no SIGTERM, no termination.
      await withTimeout(waitForGuardianCloses(1), 10_000, "attempt session close");
      const quitStarted = performance.now();
      if (!worker.stdin!.destroyed) worker.stdin!.end();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      controllerQuitExitMs = await Promise.race([
        workerClose.then(() => performance.now() - quitStarted),
        new Promise<undefined>((resolveWindow) => setTimeout(() => resolveWindow(undefined), 5_000)),
      ]);
      exitCodeWhileServing = worker.exitCode;
      if (worker.exitCode === null) worker.kill("SIGTERM");
    } else if (liveDrainQuit) {
      await withTimeout(operationsComplete, 15_000, "the live attempt's arm, launch and player containment");
      // The attempt is LIVE and her client is not contained. This is the quit, and the launcher's
      // order is the whole variable: the fixed order closes the controller first and the broker only
      // once the child's drain has had its chance, while the injected old order takes the broker away
      // first - which is what leaves the drain's role step with no peer.
      const quitStarted = performance.now();
      if (scenario === "drain-owner-quit-broker-first") {
        for (const socket of liveSockets) socket.destroy();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        if (!worker.stdin!.destroyed) worker.stdin!.end();
      } else {
        if (!worker.stdin!.destroyed) worker.stdin!.end();
        controllerQuitExitMs = await Promise.race([
          workerClose.then(() => performance.now() - quitStarted),
          new Promise<undefined>((resolveWindow) => setTimeout(() => resolveWindow(undefined), 15_000)),
        ]);
        // The child left on its own; anything still open is this peer's own leftover, not a session
        // the drain needed.
        for (const socket of liveSockets) socket.destroy();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
      }
      await withTimeout(workerClose, 15_000, "the quit's exit").catch(() => undefined);
      controllerQuitExitMs ??= performance.now() - quitStarted;
      exitCodeWhileServing = worker.exitCode;
      if (worker.exitCode === null) worker.kill("SIGTERM");
      const hostExitDirectory = join(rootLayout.operationalRoot, "host-exit");
      const recordNames = existsSync(hostExitDirectory)
        ? (await readdir(hostExitDirectory)).filter((name) => name.startsWith("host-exit-") && name.endsWith(".json"))
        : [];
      hostExitRecord =
        recordNames.length === 0
          ? undefined
          : (JSON.parse(await readFile(join(hostExitDirectory, recordNames[0]!), "utf8")) as Record<string, unknown>);
    } else if (scenario === "settle-and-rearm") {
      await withTimeout(operationsComplete, 15_000, "guardian operations");
      // Both attempts' sessions must close - the first on its settle, the second on the
      // second attempt's own settle - and the Host must still be the one process serving.
      await withTimeout(waitForGuardianCloses(2), 15_000, "both attempt sessions closed");
      await new Promise((resolveSettle) => setTimeout(resolveSettle, 750));
      exitCodeWhileServing = worker.exitCode;
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "settle-and-rearm cleanup");
    } else if (scenario === "settle-leaves-nothing") {
      await withTimeout(firstArmAck, 15_000, "the first attempt's arm");
      const holders = objectHolders;
      const binding = objectsBinding;
      assert.ok(
        holders !== undefined && binding !== undefined,
        "the peer read no arm frame to take attempt 1's object names from",
      );
      // (1) While attempt 1 is live. Taken after the peer answered `armed` and before the gate lets the
      // attempt settle, so this is a reading of the attempt's own objects rather than of a harness that
      // was still holding them open.
      await withTimeout(holders.ready, GUARDIAN_OBJECT_HOLDER_TIMEOUT_MS, "the attempt's named objects");
      objectsWhileArmed = await readAttemptObjects(binding);
      await writeFile(probeGate, "taken\n");
      // (2) The settle ends attempt 1's session, and the Guardian that owned those objects is gone with
      // it. The holders end here and nowhere earlier, and only once the OS reports both exits: a named
      // Job dies with its last handle, so an absence reading before that exit would mean nothing.
      await withTimeout(waitForGuardianCloses(1), 15_000, "the first attempt's session close");
      await holders.end();
      objectsAfterSettle = await readAttemptObjects(binding);
      const ending = await waitForWorkerStderr(/wire_settle_leaves_nothing:done/u, "the scenario's own ending");
      assert.ok(ending.length > 0, "the scenario never reported its own ending");
      exitCodeWhileServing = worker.exitCode;
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "settle-leaves-nothing cleanup");
    } else if (scenario === "success" || scenario === "recovery-success" || scenario === "long-path-role-environment") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      worker.kill("SIGTERM");
    } else if (scenario === "recovery-role-rejected") {
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      // The peer must observe the disconnect while the worker is still running:
      // runDesktopHostBootstrap parks on termination until the fixture signals it,
      // so a closed peer here is the session's own fail-closed path and not the
      // process exiting.
      await withTimeout(guardianPeerClosed, 10_000, "recovery rejection guardian cleanup");
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "recovery rejection close");
    } else if (scenario === "oversized-launch-frame") {
      // The refused frame is the assertion, so this waits for the operations the PEER logged instead of for
      // the child to leave: the containment it reads afterwards is only reachable if the refusal left the
      // session live. The process is still serving, so the harness ends it itself.
      await withTimeout(operationsComplete, 10_000, "guardian operations");
      exitCodeWhileServing = worker.exitCode;
      worker.kill("SIGTERM");
      await withTimeout(workerClose, 10_000, "oversized-launch-frame cleanup");
    } else if (scenario !== "malformed-arm" && scenario !== "missing-arm-executable") {
      await withTimeout(workerClose, 2_000, `${scenario} rejection`);
    }
    const workerClosedAt = scenario === "delayed-arm-ack" ? performance.now() : undefined;
    await withTimeout(workerClose, 10_000, "worker cleanup");
    return {
      requests,
      sessions,
      frameBytes,
      acknowledgement,
      lines: frames?.lines ?? [],
      statuses: frames?.statuses ?? [],
      stderr: await stderr,
      guardianClosed,
      messages,
      armReceiptAt,
      workerClosedAt,
      workerExitCode: worker.exitCode,
      workerExitedNaturally: worker.exitCode === 0,
      exitCodeWhileServing,
      workerPid: worker.pid,
      hostExitRecord,
      containedRoleFrames: requests
        .filter((request) => request.operation === "contain_role")
        .map((request) => String(request.role)),
      controllerQuitExitMs,
      stateReadAfterLoss,
      attemptObjects:
        objectsBinding === undefined || objectsWhileArmed === undefined || objectsAfterSettle === undefined
          ? undefined
          : Object.freeze({ binding: objectsBinding, whileArmed: objectsWhileArmed, afterSettle: objectsAfterSettle }),
      peerRefusals,
    };
  } finally {
    if (worker !== undefined && worker.exitCode === null && !worker.killed) {
      worker.kill("SIGTERM");
      await withTimeout(waitForClose(worker), 10_000, "worker failure cleanup").catch(() => undefined);
    }
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    await rm(fixtureRoot, { recursive: true, force: true });
  }
}

/**
 * One FIXED worker module, replayed unchanged for every scenario. All per-case
 * variation is delivered as the `GAMEBUDDY_WIRE_FIXTURE` JSON document on the
 * child environment - scenario, correlation ids, module URLs, launch facts,
 * arm facts and the recovery binding/lease literals - so no harness value is
 * ever interpolated into code position. This is the sink the CodeQL `
 * js/bad-code-sanitization` finding flagged (the former `` ${`operation`} `` splice
 * inside `workerSource`); keeping the module a constant string makes the
 * code/data split explicit and auditable.
 */
const wireFixtureWorkerSource = `import { mock } from "node:test";

const fixture = JSON.parse(process.env.GAMEBUDDY_WIRE_FIXTURE);
if (fixture === null || typeof fixture !== "object" || Array.isArray(fixture)) throw new Error("wire_fixture_invalid");
const scenario = fixture.scenario;

if (scenario === "ack-write-failure") {
  process.stdout.end = (() => {
    process.nextTick(() => process.stdout.emit("error", new Error("ack_write_failed")));
    return process.stdout;
  });
}

function reportAndStop(error) {
  process.stderr.write(String(error?.message ?? error) + "\\n");
  process.kill(process.pid, "SIGTERM");
}

async function waitForProbeGate(path) {
  const { readFile: read } = await import("node:fs/promises");
  const deadline = Date.now() + 60000;
  for (;;) {
    try { await read(path); return; } catch {}
    if (Date.now() > deadline) throw new Error("wire_probe_gate_timeout");
    await new Promise((resolveWait) => setTimeout(resolveWait, 25));
  }
}

async function drive(session) {
  if (scenario === "long-path-role-environment") {
    // The launch exactly as the product performs it, on the environment the product itself builds for
    // a Host whose own PATH is a developer machine's: runWireFixture builds it from a 17 069+ character
    // parent PATH through the real createStardewChildEnvironment. The peer counts the bytes of the
    // frame it reads, so "the launch reached the peer and fits" is a measurement here.
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    await platform.arm({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      armFacts: fixture.armFacts,
      authorization: { executable: fixture.approvedExecutable },
    });
    try {
      await platform.launch({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        deadlineUnixMs: Date.now() + 60000,
        role: "player_host",
        authorization: fixture.launchFacts,
      });
      process.stderr.write("wire_long_path_launch:accepted\\n");
    } catch (error) {
      process.stderr.write("wire_long_path_launch:refused:" + String(error && error.message ? error.message : error) + "\\n");
    }
    try {
      await platform.contain({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 123,
        role: "player_host",
      });
      process.stderr.write("wire_long_path_followup:contained\\n");
    } catch (error) {
      process.stderr.write("wire_long_path_followup:refused:" + String(error && error.message ? error.message : error) + "\\n");
    }
    return;
  }
  if (scenario === "success" || scenario === "readiness-publication") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    await platform.arm({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      armFacts: fixture.armFacts,
      authorization: { executable: fixture.approvedExecutable },
    });
    await platform.launch({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      deadlineUnixMs: Date.now() + 60000,
      role: "player_host",
      authorization: fixture.launchFacts,
    });
    await platform.contain({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      role: "player_host",
    });
    return;
  }
  if (scenario === "settled-session" || scenario === "settled-session-owner-quit") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    await platform.arm({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      armFacts: fixture.armFacts,
      authorization: { executable: fixture.approvedExecutable },
    });
    await platform.launch({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      deadlineUnixMs: Date.now() + 60000,
      role: "player_host",
      authorization: fixture.launchFacts,
    });
    await platform.contain({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      role: "player_host",
    });
    // The attempt is over. This is the production seam an explicit endgame and the next
    // launch press both reach, and it closes only this attempt's authenticated session.
    await platform.settle({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      launchedRoles: ["player_host"],
    });
    return;
  }
  if (scenario === "drain-owner-quit" || scenario === "drain-owner-quit-broker-first") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    await platform.arm({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      armFacts: fixture.armFacts,
      authorization: { executable: fixture.approvedExecutable },
    });
    await platform.launch({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      deadlineUnixMs: Date.now() + 60000,
      role: "player_host",
      authorization: fixture.launchFacts,
    });
    await platform.contain({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      role: "player_host",
    });
    // Her client is in the world and NOT contained. That is the state the production drain's third
    // step exists for: an attempt that is still live when the player leaves, whose AI role may only
    // be contained through this authenticated session.
    await platform.launch({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      deadlineUnixMs: Date.now() + 60000,
      role: "ai_client",
      authorization: fixture.launchFacts,
    });
    return;
  }
  if (scenario === "settle-and-rearm") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    const attempts = [
      { guardianInstanceId: fixture.guardianInstanceId, attemptId: fixture.attemptId, armFacts: fixture.armFacts },
      { guardianInstanceId: fixture.secondGuardianInstanceId, attemptId: fixture.secondAttemptId, armFacts: fixture.secondArmFacts },
    ];
    for (const [index, attempt] of attempts.entries()) {
      // The Host's own reading of who is serving: both attempts must name the same pid.
      process.stderr.write("wire_attempt_host_pid:" + index + ":" + process.pid + ":" + attempt.attemptId + "\\n");
      await platform.arm({
        guardianInstanceId: attempt.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: attempt.attemptId,
        operationWaitBudgetMs: 123,
        armFacts: attempt.armFacts,
        authorization: { executable: fixture.approvedExecutable },
      });
      await platform.launch({
        guardianInstanceId: attempt.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: attempt.attemptId,
        deadlineUnixMs: Date.now() + 60000,
        role: "player_host",
        authorization: fixture.launchFacts,
      });
      await platform.contain({
        guardianInstanceId: attempt.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: attempt.attemptId,
        operationWaitBudgetMs: 123,
        role: "player_host",
      });
      await platform.settle({
        guardianInstanceId: attempt.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: attempt.attemptId,
        operationWaitBudgetMs: 123,
        launchedRoles: ["player_host"],
      });
    }
    process.stderr.write("wire_attempts_complete:" + attempts.length + "\\n");
    return;
  }
  if (scenario === "recovery-success" || scenario === "recovery-role-rejected") {
    const recoveryInstanceId = "77777777-7777-4777-8777-777777777777";
    const preCasFrame = new TextEncoder().encode(JSON.stringify({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      bindingRevision: fixture.recoveryBindingRevision,
      leaseName: fixture.recoveryLeaseName,
    }));
    const postCasFrame = new TextEncoder().encode(JSON.stringify({ ownerRecordRevision: 2 }));
    const outcome = await session.recover({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 123,
      recoveryInstanceId,
      preCasFrame,
      beginRecovery: async () => postCasFrame,
      roleContained: async (role) => {
        process.stderr.write("recovery_role_contained:" + role + "\\n");
        if (scenario === "recovery-role-rejected") throw new Error("stardew_bootstrap_owner_transition_mismatch");
      },
    });
    process.stderr.write("recovery_outcome:" + outcome.outcome + "\\n");
    return;
  }
  if (scenario === "missing-arm-executable") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    try {
      await platform.arm({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 100,
        authorization: { role: "player_host", revision: "33333333-3333-4333-8333-333333333333" },
      });
      throw new Error("unexpected_arm_success");
    } catch (error) {
      reportAndStop(error);
    }
    return;
  }
  if (scenario === "withheld-contain-ack") {
    try {
      await session.arm({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 100,
        privateFrame: new Uint8Array([1]),
      });
      await session.contain({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 50,
        role: "player_host",
      });
      throw new Error("unexpected_contain_success");
    } catch (error) {
      reportAndStop(error);
    }
    return;
  }
  if (scenario === "expired-launch") {
    try {
      await session.arm({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 100,
        privateFrame: new Uint8Array([1]),
      });
      await session.launch({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        deadlineUnixMs: Date.now() - 1,
        role: "player_host",
        privateFrame: new Uint8Array([2]),
      });
      throw new Error("unexpected_launch_success");
    } catch (error) {
      reportAndStop(error);
    }
    return;
  }
  if (scenario === "overhorizon-launch") {
    try {
      await session.arm({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 100,
        privateFrame: new Uint8Array([1]),
      });
      await session.launch({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        deadlineUnixMs: Date.now() + 600000,
        role: "player_host",
        privateFrame: new Uint8Array([2]),
      });
      throw new Error("unexpected_launch_success");
    } catch (error) {
      reportAndStop(error);
    }
    return;
  }
  if (scenario === "lost-session-rearm") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    try {
      await platform.arm({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 5000,
        armFacts: fixture.armFacts,
        authorization: { executable: fixture.approvedExecutable },
      });
      process.stderr.write("wire_lost_command_accepted\\n");
    } catch (error) {
      process.stderr.write("wire_lost_command_refused:" + String(error && error.message ? error.message : error) + "\\n");
    }
    // The next attempt: its own correlation, its own authenticated session, the same
    // one-instance pipe (ADR-0015 §5.1 U4b).
    try {
      await platform.arm({
        guardianInstanceId: fixture.secondGuardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.secondAttemptId,
        operationWaitBudgetMs: 5000,
        armFacts: fixture.secondArmFacts,
        authorization: { executable: fixture.approvedExecutable },
      });
      process.stderr.write("wire_second_attempt_armed\\n");
    } catch (error) {
      process.stderr.write("wire_second_attempt_refused:" + String(error && error.message ? error.message : error) + "\\n");
    }
    await platform.settle();
    return;
  }
  if (scenario === "oversized-launch-frame") {
    // A launch plan the product CAN build and this channel cannot carry: a plan's arguments are data
    // (a transaction path, a flag value), and enough of them put the frame over the bound. What this
    // scenario reads is the consequence - guardian_wire_too_long is decided before a byte is
    // written, so the session that armed the attempt has to survive it.
    const launchFacts = Object.freeze({
      ...fixture.launchFacts,
      arguments: Object.freeze([
        ...fixture.launchFacts.arguments,
        ...Array.from({ length: 6 }, () => "x".repeat(3_000)),
      ]),
    });
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    await platform.arm({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: 5000,
      armFacts: fixture.armFacts,
      authorization: { executable: fixture.approvedExecutable },
    });
    process.stderr.write("wire_oversized_arm:armed\\n");
    try {
      await platform.launch({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        deadlineUnixMs: Date.now() + 60000,
        role: "player_host",
        authorization: launchFacts,
      });
      process.stderr.write("wire_oversized_launch:accepted\\n");
    } catch (error) {
      process.stderr.write("wire_oversized_launch:refused:" + String(error && error.message ? error.message : error) + "\\n");
    }
    // A refusal that never touched the socket leaves the session exactly as it was, so the next command
    // still reaches the peer that armed this attempt.
    try {
      await platform.contain({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 5000,
        role: "player_host",
      });
      process.stderr.write("wire_oversized_followup:contained\\n");
    } catch (error) {
      process.stderr.write("wire_oversized_followup:refused:" + String(error && error.message ? error.message : error) + "\\n");
    }
    return;
  }
  if (scenario === "settle-leaves-nothing") {
    const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    const first = { guardianInstanceId: fixture.guardianInstanceId, guardianEpoch: 1, attemptId: fixture.attemptId };
    const second = { guardianInstanceId: fixture.secondGuardianInstanceId, guardianEpoch: 1, attemptId: fixture.secondAttemptId };
    const arm = async (attempt) =>
      await platform.arm({
        ...attempt,
        operationWaitBudgetMs: 5000,
        armFacts: attempt === first ? fixture.armFacts : fixture.secondArmFacts,
        authorization: { executable: fixture.approvedExecutable },
      });
    const contain = async (correlation) =>
      await platform.contain({ ...correlation, operationWaitBudgetMs: 5000, role: "player_host" });
    const record = async (label, accepted, operation) =>
      await operation().then(
        () => process.stderr.write(label + ":" + accepted + "\\n"),
        (error) => process.stderr.write(label + ":refused:" + String(error && error.message ? error.message : error) + "\\n"),
      );
    const settle = async (correlation) =>
      await platform.settle({ ...correlation, operationWaitBudgetMs: 5000, launchedRoles: ["player_host"] });
    // The whole attempt, on its own session, up to the settle.
    await arm(first);
    await platform.launch({
      ...first,
      deadlineUnixMs: Date.now() + 60000,
      role: "player_host",
      authorization: fixture.launchFacts,
    });
    await contain(first);
    process.stderr.write("wire_first_attempt_contained\\n");
    await waitForProbeGate(fixture.probeGate);
    await settle(first);
    process.stderr.write("wire_first_attempt_settled\\n");
    await record("wire_replayed_arm", "armed", () => arm(first));
    await settle(first);
    // The fresh attempt, on its own session and its own reservation.
    await record("wire_second_arm", "armed", () => arm(second));
    // A frame AFTER that arm carrying the settled attempt's correlation: this one the broker's own
    // correlation rule refuses, and the refusal ends the session it arrived on.
    await record("wire_stale_correlation", "accepted", () => contain(first));
    // The other half of the same rule, on a session of its own: one arm per session.
    await record("wire_fresh_session_arm", "armed", () => arm(second));
    await record("wire_second_arm_in_session", "accepted", () => arm(second));
    await platform.settle();
    process.stderr.write("wire_settle_leaves_nothing:done\\n");
    return;
  }
  if (scenario === "peer-disconnect" || scenario === "delayed-arm-ack") {
    try {
      await session.arm({
        guardianInstanceId: fixture.guardianInstanceId,
        guardianEpoch: 1,
        attemptId: fixture.attemptId,
        operationWaitBudgetMs: 100,
        privateFrame: new Uint8Array([1]),
      });
      throw new Error("unexpected_arm_success");
    } catch (error) {
      reportAndStop(error);
    }
    return;
  }
  // malformed-arm | withheld-arm-ack: the last two authenticated arm failures.
  try {
    await session.arm({
      guardianInstanceId: fixture.guardianInstanceId,
      guardianEpoch: 1,
      attemptId: fixture.attemptId,
      operationWaitBudgetMs: scenario === "withheld-arm-ack" ? 50 : 123,
      ...(scenario === "malformed-arm" ? { deadlineUnixMs: Date.now() + 60000 } : {}),
      privateFrame: new Uint8Array([1]),
    });
    throw new Error("unexpected_arm_success");
  } catch (error) {
    reportAndStop(error);
  }
}

async function mockPrepareDesktopHostLaunch() {
  return Object.freeze({ stage: "companion-mod", outcome: fixture.modOutcome ?? "companion-mod-current" });
}

function mockComposition(_rootLayoutCapability, session, assemblyInput) {
  if (scenario === "composition-failure") {
    throw new Error("composition_construction_failed");
  }
  // The composition's close reports the named per-step reclamation outcome rather
  // than a bare rejection. This fixture never reclaims a real child, so every
  // order it can reach is the clean one; the bootstrap still consumes the exact
  // report shape the production composition returns.
  const cleanExitReason = Object.freeze({ schema: "gamebuddy-desktop-host-exit/v1", outcome: "clean", reason: "clean_exit", steps: [] });
  if (scenario === "ack-write-failure") {
    return { async close() { await session.close(); return cleanExitReason; } };
  }
  process.stderr.write("wire_assembly_surface:" + (assemblyInput?.surface === undefined ? "default" : assemblyInput.surface) + "\\n");
  assemblyInput?.publishLaunchUrl?.("http://127.0.0.1:4444/#profile=reference&boot=fixture");
  process.stderr.write("wire_publish_ready:called\\n");
  const operationTask = (async () => { await drive(session); })();
  operationTask.catch(() => undefined);
  if (scenario === "lost-session-rearm") return mountStateSurface(session, operationTask, assemblyInput);
  if (scenario === "drain-owner-quit" || scenario === "drain-owner-quit-broker-first")
    return { close: () => closeWithLiveDrain(session, operationTask) };
  return { async close() { await operationTask; await session.close(); return cleanExitReason; } };
}

/**
 * The quit's drain, as the Host runs it: the REAL reclamation runner over the composition's own step
 * order, with the third step spelled the one way production spells it - an authenticated
 * contain_role ai_client on this attempt's session (stardew-guardian-platform.ts:560,
 * containAiClient), whose refusal the lifecycle coordinator turns into
 * stardew_lifecycle_close_incomplete.
 *
 * The steps this fixture never mounted carry no close and are reported not_applicable, not
 * completed: a composition that never had a Chat runtime must not claim it drained one.
 */
async function closeWithLiveDrain(session, operationTask) {
  await operationTask;
  const reclamation = await import(fixture.reclamationUrl);
  const { createDesktopGuardianGameRuntimePlatform } = await import(fixture.platformUrl);
  const platform = createDesktopGuardianGameRuntimePlatform(session);
  const outcomes = await reclamation.runDesktopHostReclamation([
    { step: "release_shared_authority" },
    { step: "reflect_session" },
    {
      step: "drain_game_lifecycle",
      close: async () => {
        try {
          await platform.contain({
            guardianInstanceId: fixture.guardianInstanceId,
            guardianEpoch: 1,
            attemptId: fixture.attemptId,
            operationWaitBudgetMs: 123,
            role: "ai_client",
          });
          process.stderr.write("wire_drain_contain:role_contained\\n");
        } catch (error) {
          process.stderr.write("wire_drain_contain:refused:" + String(error && error.message ? error.message : error) + "\\n");
          throw new Error("stardew_lifecycle_close_incomplete");
        }
      },
    },
    { step: "drain_chat_runtime" },
    { step: "stop_admission" },
  ]);
  await session.close();
  return reclamation.buildDesktopHostExitReason(outcomes);
}

/**
 * The Host's own surface, for the one scenario that reads it: a real listener on a real loopback
 * port, so "the Host was still serving after its peer refused its attempt" is a socket answer and
 * not a field this fixture wrote down.
 */
async function mountStateSurface(session, operationTask, assemblyInput) {
  const { createServer } = await import("node:http");
  const server = createServer((request, response) => {
    if (request.url !== "/state") {
      response.writeHead(404, { "cache-control": "no-store" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ state: "served", pid: process.pid }));
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = server.address().port;
  process.stderr.write("wire_state_port:" + port + "\\n");
  assemblyInput?.publishLaunchUrl?.("http://127.0.0.1:" + port + "/#profile=composed-reference-game");
  return {
    async close() {
      await operationTask;
      await new Promise((resolveClose) => server.close(() => resolveClose()));
      await session.close();
      return Object.freeze({ schema: "gamebuddy-desktop-host-exit/v1", outcome: "clean", reason: "clean_exit", steps: [] });
    },
  };
}

await mock.module(fixture.compositionUrl, { namedExports: { createDesktopProductComposition: mockComposition, prepareDesktopHostLaunch: mockPrepareDesktopHostLaunch } });
const { runDesktopHostBootstrap } = await import(fixture.bootstrapUrl);
try {
  await runDesktopHostBootstrap(fixture.moduleDirectory);
} catch (error) {
  // CI-only diagnostic. Ten of this fixture's cases pass on a developer machine and fail on the CI
  // runner with desktop_runtime_bootstrap_unavailable, whose only source is the root-layout
  // admission. That admission reads LOCALAPPDATA, the four root spellings and each root's physical
  // chain, so report exactly those bounded facts - a shape token per path, never a path - BEFORE
  // the bare message. The bare message stays the LAST line, so every consumer that reads it as one
  // bounded code (assert.match(...$), verify-self-contained-generation's stderr.trim()) is unaffected.
  const sepChar = String.fromCharCode(92);
  const shapeOf = (value) =>
    typeof value !== "string" || value.length === 0
      ? "absent"
      : !/^[A-Za-z]:/.test(value)
        ? "not_a_drive_path"
        : value.endsWith(sepChar + "AppData" + sepChar + "Local")
          ? "appdata_local"
          : "other_drive_path";
  const kindOf = async (value) => {
    try {
      const { lstatSync } = await import("node:fs");
      const info = lstatSync(value);
      return (info.isDirectory() ? "dir" : info.isFile() ? "file" : "other") + (info.isSymbolicLink() ? "+link" : "");
    } catch (probeError) {
      return "stat_" + String((probeError && probeError.code) || "failed").toLowerCase();
    }
  };
  const wireLayout = fixture.rootLayout;
  process.stderr.write(
    "wire_admission_probe:" +
      [
        "localappdata=" + shapeOf(process.env.LOCALAPPDATA),
        "localappdata_is_fixture=" + (process.env.LOCALAPPDATA === wireLayout.probeRoot),
        "program=" + (await kindOf(wireLayout.programRoot)),
        "data=" + (await kindOf(wireLayout.dataRoot)),
        "operational=" + (await kindOf(wireLayout.operationalRoot)),
        "presentation=" + (await kindOf(wireLayout.presentationRoot)),
      ].join(";") +
      "\\n",
  );
  // The deep probe: the shallow shapes above cannot distinguish a clean tree from one whose
  // roots fail the physical chain or security checks, which is the only remaining source of
  // this refusal. It drives the SAME compiled native inspector the product drives, over the
  // same roots, and reports the first predicate that refuses - still as bounded tokens.
  try {
    const inspectorModule = await import(fixture.inspectorUrl);
    const { createPublishedWindowsReparseInspector, inspectWindowsPathIdentityChain, inspectWindowsPathSecurity } = inspectorModule;
    const deepInspector = await createPublishedWindowsReparseInspector(fixture.moduleDirectory);
    const deepRoots = [wireLayout.programRoot, wireLayout.dataRoot, wireLayout.operationalRoot, wireLayout.presentationRoot];
    const chains = await Promise.all(deepRoots.map((root) => inspectWindowsPathIdentityChain(deepInspector, root)));
    const securities = await Promise.all(deepRoots.map((root) => inspectWindowsPathSecurity(deepInspector, root)));
    const expectedChain = (value) => value.slice(3).split(sepChar).length + 1;
    const volume = chains[0]?.at(-1)?.volumeIdentity;
    const deepFindings = [];
    if (volume === undefined) deepFindings.push("volume_missing");
    chains.forEach((chain, index) => {
      if (chain.length !== expectedChain(deepRoots[index])) deepFindings.push("chain_length_" + index);
      if (chain.some((entry) => entry.objectKind !== "directory")) deepFindings.push("chain_kind_" + index);
      const reparseAt = chain.findIndex((entry) => entry.isReparsePoint);
      if (reparseAt >= 0) deepFindings.push("chain_reparse_" + index + "_" + reparseAt);
      if (chain.at(-1)?.volumeIdentity !== volume) deepFindings.push("chain_volume_" + index);
    });
    securities.forEach((security, index) => {
      if (!security.currentUserOwner) deepFindings.push("security_owner_" + index);
      if (security.objectKind !== "directory") deepFindings.push("security_kind_" + index);
      if (security.isReparsePoint) deepFindings.push("security_reparse_" + index);
      if (security.volumeIdentity !== volume) deepFindings.push("security_volume_" + index);
      if (security.fileId !== chains[index]?.at(-1)?.fileId) deepFindings.push("security_fileid_" + index);
    });
    process.stderr.write("wire_admission_deep:" + (deepFindings.length === 0 ? "clean" : deepFindings.join(",")) + "\\n");
  } catch (deepError) {
    process.stderr.write("wire_admission_deep:threw_" + String((deepError && deepError.name) || "unknown").toLowerCase() + "\\n");
  }
  process.stderr.write(String((error instanceof Error ? error.message : error) ?? "desktop_runtime_bootstrap_unavailable") + "\\n");
  process.exit(1);
}
`;

/*
 * The two frame types the child may write on its standard output before it serves, and the one
 * channel they share. The status frame is informational and bounded to a stage token (plus the
 * token naming a player decision the child is waiting for); the acknowledgement keeps its own
 * schema, its own exact key order and its meaning as the ONLY success signal.
 */
const bootstrapSchema = "gamebuddy-desktop-host-bootstrap/v1";
const statusSchema = "gamebuddy-desktop-host-bootstrap-status/v1";
// The stages the wire announces, in the order the child enters them. This list is the contract of
// the status channel: every frame is emitted immediately before the call it names, none of them
// is emitted from a loop, and the child's own writer can produce no other stage.
const bootstrapStages = [
  "bootstrap-frame",
  "root-layout",
  "voice-surface",
  "deployment-manifest",
  "companion-mod",
  "companion-mod-current",
  "guardian-session",
  "provisioning",
] as const;

function schemaOf(line: string): string | undefined {
  try {
    const value = JSON.parse(line) as { schema?: unknown };
    return typeof value.schema === "string" ? value.schema : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Collects the frames the child writes on its standard output, stopping at the acknowledgement:
 * the child keeps that channel open for as long as it serves, so waiting for its end would wait
 * for the whole product to stop.
 */
function collectFrames(
  stream: NodeJS.ReadableStream,
  child?: ReturnType<typeof spawn>,
): Promise<Readonly<{ lines: readonly string[]; statuses: readonly string[]; acknowledgement: string }>> {
  return new Promise((resolveFrames, rejectFrames) => {
    const lines: string[] = [];
    let pending = "";
    let settled = false;
    stream.on("data", (chunk: Buffer) => {
      if (settled) return;
      pending += chunk.toString();
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) return;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        lines.push(line);
        if (schemaOf(line) !== bootstrapSchema) continue;
        settled = true;
        resolveFrames(
          Object.freeze({
            lines: Object.freeze([...lines]),
            statuses: Object.freeze(lines.filter((candidate) => schemaOf(candidate) === statusSchema)),
            acknowledgement: line,
          }),
        );
        return;
      }
    });
    stream.once("error", rejectFrames);
    child?.once("close", (code) => {
      if (!settled && code !== 0) rejectFrames(new Error(`wire_worker_exit_${code}`));
    });
  });
}

function collectBounded(stream: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolveOutput) => {
    let data = "";
    stream.on("data", (chunk) => {
      data = (data + chunk.toString()).slice(-4096);
    });
    stream.once("close", () => resolveOutput(data));
  });
}

function waitForClose(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolveClose, rejectClose) => {
    child.once("error", rejectClose);
    child.once("close", resolveClose);
  });
}

/**
 * The one place this suite bounds a wait.
 *
 * A run that gives up here does NOT take the fixture child with it: the child keeps the one-instance
 * pipe it serves (`\\\\.\\pipe\\GameBuddy.HostGuardian.<id>`, `maxInstances: 1`), so every later scenario
 * fails with `EADDRINUSE` on that name or with `timeout_guardian operations` - which reads like a product
 * defect and is not one. The remedy is exact: list node processes, keep only the ones whose command line
 * names this test file or a `wire-fixture-worker.mjs`, end those PIDs and nothing else, then re-run.
 * Measured 2026-11-21.
 */
async function withTimeout<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout_${label}`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test("desktop bootstrap helper remains private and has no entrypoint", async () => {
  const { raw: source, shape: sourceShape } = readSourceShape(
    resolve(sourceRoot, "bootstrap", "wire", "desktop-runtime-bootstrap.internal.ts"),
  );

  assert.match(sourceShape, /export async function runDesktopHostBootstrap\(artifactRoot: string\)/);
  assert.doesNotMatch(source, /import.meta.main/);
  assert.doesNotMatch(source, /desktop-host-entry.internal.js/);
  // The private bootstrap factory is invoked once, positionally, through the three
  // authorities it consumes. Pin the call and its argument order, not the line breaks or the
  // trailing comma the formatter chooses between them (the source broke the call across lines in
  // e891adee, which is what left this assertion reading a call that no longer exists).
  const compositionCall =
    /createDesktopProductCompositionForBootstrap\(\s*rootAuthority,\s*guardianAuthority,\s*assemblyInput,?\s*\)/;
  assert.match(source, compositionCall);
  // The launch preparation belongs to the composition root: this wire receives the stage and the
  // outcome as two bounded tokens and publishes them, so the file that must stay game-free names
  // no game, no installation and no Mod. `tools/check-host-game-physical-seam.mjs` reads the same
  // property from the imported names and call sites, which is what survives a rename.
  assert.match(sourceShape, /const preparation = await prepareDesktopHostLaunch\(artifactRoot\);/);
  assert.match(sourceShape, /await writeStatus\(preparation\.stage\);/);
  assert.match(sourceShape, /await writeStatus\(preparation\.outcome\);/);
  assert.doesNotMatch(source, /deployCompanionGameMod|CompanionGameModDeploymentOutcome/);
  assert.doesNotMatch(sourceShape, /"companion-mod"/);
  assert.match(sourceShape, /new WeakSet<object>\(\)/);
  assert.match(sourceShape, /new WeakMap<object, DesktopRootLayout>\(\)/);
  assert.match(source, /consumeDesktopRootLayoutCapability\(rootAuthority\)/);
  // The Host-owned env seam selects the composed surface and the narrative-gate
  // marker nonce digest; every invalid value fails closed before any guardian contact.
  assert.match(source, /GAMEBUDDY_HOST_SURFACE/);
  assert.match(sourceShape, /surface !== "composed-reference-game"/);
  assert.match(source, /GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256/);
  assert.ok(source.includes("/^[a-f0-9]{64}$/.test(tavernNarrativeGateNonceSha256)"));
  // The composed launch URL is published over the child IPC channel only; the
  // production Desktop spawn carries no IPC channel so the publication is a no-op.
  assert.match(source, /gamebuddy-desktop-composition-ready\/v1/);
  assert.match(sourceShape, /typeof process\.send !== "function" \|\| process\.connected !== true\)/);
  assert.match(source, /consumeDesktopGuardianSessionCapability\(guardianAuthority\)/);
  assert.doesNotMatch(source, /stardew/);
  // The recovery wire tolerates the durable engine's refusal by the identity the
  // platform contract exports: it keeps no message to compare and no game-name
  // literal to fall back on, because a message match is exactly what silently
  // re-broke a resumed recovery.
  assert.match(
    sourceShape,
    /import \{ ContainmentRoleAlreadyContainedError \} from "\.\.\/\.\.\/containment\/runtime\/contract\/game-runtime\.js"/,
  );
  assert.doesNotMatch(source, /role_already_contained/);
  assert.doesNotMatch(source, /stardew-production-lifecycle-coordinator/);
  assert.doesNotMatch(source, /stardew-player-host-process-owner/);
  assert.doesNotMatch(source, /stardew-ai-client-process-owner/);
  assert.doesNotMatch(source, /node:child_process/);
  // One statement order, read from inside the ONE function that runs it. The
  // composition call and the acknowledgement are both statements of
  // runAdmittedHostBootstrap, so their source order is their execution order; the
  // assertion is scoped to that body because the same text also occurs in the
  // factory's declaration (line-level) and in comments, and an `indexOf` over the
  // whole module would silently compare the wrong occurrence - or pass on a `-1`
  // after the call was extracted into a helper.
  //
  // The body is the one below `runDesktopHostBootstrap` because that outer function owns exactly
  // one thing this body must not: the controller channel's lifetime. The `bootstrap-frame` status
  // therefore precedes the channel in the outer function, which is asserted there instead.
  const bootstrapBody = functionBody(source, "runAdmittedHostBootstrap");
  assertStatementOrder(
    bootstrapBody,
    ["createDesktopProductCompositionForBootstrap(", "await writeAcknowledgement(frame)"],
    "the composition must be built before bootstrap readiness is published",
  );
  // The consumed authority stays inside the factory that consumes it, one level
  // below the call site: the bootstrap passes the minted capability across and
  // never reads the layout back out of it.
  const factoryBody = functionBody(source, "createDesktopProductCompositionForBootstrap");
  assert.match(factoryBody, /consumeDesktopRootLayoutCapability\(rootAuthority\)/);
  assert.doesNotMatch(bootstrapBody, /consumeDesktopRootLayoutCapability\(/);
  // The status channel is one more frame type on the SAME channel and the SAME framing (one JSON
  // object plus one newline), announced immediately before the step it names and always before the
  // acknowledgement; the acknowledgement keeps its own schema and stays the only frame that ends
  // the channel.
  assert.match(sourceShape, /const statusSchema = "gamebuddy-desktop-host-bootstrap-status\/v1"/);
  assert.match(sourceShape, /const statusToken = \/\^\[a-z\]\[a-z0-9-\]\{0,63\}\$\//);
  // Formatting-tolerant: the write callback is a block the formatter may break across lines.
  assert.match(
    sourceShape,
    /process\.stdout\.write\(\s*bytes,\s*\(\) => \{\s*process\.stdout\.off\("error", onError\);\s*resolveWrite\(\);\s*\}\);/,
  );
  assert.match(source, /process\.stdout\.end\(acknowledgement/);
  // Everything the pre-acknowledgement path does, in one ordered list read from
  // runDesktopHostBootstrap's own body. The two later stages (`guardian-session`,
  // `provisioning`) are written by the private composition factory that this body
  // calls, so they are ordered by the call above rather than positionally here; the
  // runtime status sequence itself is pinned exactly by the statuses test.
  assertStatementOrder(
    bootstrapBody,
    [
      ...["root-layout", "voice-surface", "deployment-manifest"].map((stage) => `await writeStatus("${stage}")`),
      "prepareDesktopHostLaunch(artifactRoot)",
      "createDesktopProductCompositionForBootstrap(",
      "await writeAcknowledgement(frame)",
    ],
    "every pre-acknowledgement step must precede the acknowledgement",
  );
  // The controller channel is the launcher's owner-liveness signal, so it is opened before the
  // first step that reads the frame and closed on EVERY way out of the bootstrap - which is only
  // true in a `finally`. A channel released on the clean path alone would leave a refused launch
  // holding a live handle instead of exiting with its own bounded code.
  assertStatementOrder(
    functionBody(source, "runDesktopHostBootstrap"),
    [
      'await writeStatus("bootstrap-frame")',
      "const controller = await openDesktopControllerChannel()",
      "await runAdmittedHostBootstrap(artifactRoot, controller)",
    ],
    "the controller channel must be opened before anything reads it, and the admitted body must be the guarded call",
  );
  assert.match(
    functionBody(source, "runDesktopHostBootstrap"),
    /finally\s*\{\s*controller\.close\(\);\s*\}/,
    "the controller channel must be released on every path out of the bootstrap, not only the clean one",
  );
  // No status frame is written from inside a loop, and none of them carries a wait statement: the
  // pre-acknowledgement path waits for no human decision.
  assert.doesNotMatch(sourceShape, /for \([^)]*\)\s*\{[^}]*writeStatus\(/s);
  assert.doesNotMatch(source, /writeStatus\([^)]*,\s*"/);
  assert.doesNotMatch(sourceShape, /export (function|async function) (mint|create|consume)Desktop/);
  assert.doesNotMatch(source, /DesktopGuardianSession(?:Capability|Binding)?\s*\}\s*from/);
  assert.doesNotMatch(source, /installDesktopGuardianSessionFactoryForTest/);
  // The composition call site inside runDesktopHostBootstrap precedes the
  // acknowledgement: the formal bootstrap builds the product composition
  // before publishing bootstrap readiness (asserted with the step order above).
  // The composition must stay a static binding: a deferred relative dynamic
  // import would be rejected by the production artifact validator, and the
  // release closure already weaves the whole product chain at build time.
  assert.match(sourceShape, /from "\.\.\/\.\.\/composition\/desktop-host-composition\.js"/);
  assert.doesNotMatch(sourceShape, /await import\("\.\.\/\.\.\/composition/);
});

function findPackageRoot(directory: string): string {
  let candidate = directory;
  while (!existsSync(resolve(candidate, "package.json"))) {
    const parent = dirname(candidate);
    if (parent === candidate) throw new Error("desktop_bootstrap_test_package_root_not_found");
    candidate = parent;
  }
  return candidate;
}

/**
 * The recovery conversation is a pure protocol: the five frames, their exact
 * ordinal key order, the four acknowledgement positions and the durable
 * callbacks are asserted against a recording transport, so no socket, named
 * pipe, Windows root layout or production artifact is involved.
 */
const recoveryBinding = Object.freeze({
  bootstrapId: "a".repeat(64),
  generation: "generation-1",
  inventoryDigest: "b".repeat(64),
  runtimeAdmissionSha256: "c".repeat(64),
});
const recoveryCorrelation = Object.freeze({
  guardianInstanceId: "11111111-1111-4111-8111-111111111111",
  guardianEpoch: 1,
  attemptId: "22222222-2222-4222-8222-222222222222",
});
const recoveryInstance = "33333333-3333-4333-8333-333333333333";
const recoveryPreCas = new TextEncoder().encode(
  '{"guardianInstanceId":"11111111-1111-4111-8111-111111111111","guardianEpoch":1,"attemptId":"22222222-2222-4222-8222-222222222222","bindingRevision":"44444444-4444-4444-8444-444444444444","leaseName":"Local\\GameBuddy-Lease-1"}',
);
const recoveryPostCas = new TextEncoder().encode('{"ownerRecordRevision":2}');

/** The exact ordinal key sequence `DesktopHostBootstrapBroker.ExactObject` compares. */
const recoveryFrameKeys = (...trailing: readonly string[]): readonly string[] => [
  "schema",
  "protocolVersion",
  "operation",
  "bootstrapId",
  "generation",
  "inventoryDigest",
  "runtimeAdmissionSha256",
  "operationWaitBudgetMs",
  "guardianInstanceId",
  "guardianEpoch",
  "attemptId",
  "recoveryInstanceId",
  ...trailing,
];

function recoveryAcknowledgement(
  status: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    schema: "gamebuddy-desktop-guardian-session/v1",
    protocolVersion: 1,
    operation: "recover_attempt",
    status,
    ...recoveryBinding,
    ...recoveryCorrelation,
    recoveryInstanceId: recoveryInstance,
    ...overrides,
  };
}

function recoveryHarness(acknowledgements: readonly Readonly<Record<string, unknown>>[]): Readonly<{
  transport: DesktopGuardianRecoveryTransport;
  events: string[];
  frames: Array<Record<string, unknown>>;
}> {
  const events: string[] = [];
  const frames: Array<Record<string, unknown>> = [];
  const pending = [...acknowledgements];
  const transport: DesktopGuardianRecoveryTransport = Object.freeze({
    write: (frame) => {
      events.push(`write:${String(frame.operation)}`);
      frames.push({ ...frame });
    },
    receive: () => {
      // Fails closed instead of hanging: a conversation that waits for an
      // acknowledgement the broker would never write is a protocol violation.
      events.push("receive");
      const acknowledgement = pending.shift();
      return acknowledgement === undefined
        ? Promise.reject(new Error("unexpected_receive"))
        : Promise.resolve(acknowledgement);
    },
  });
  return { transport, events, frames };
}

/** The conversation one test drives; every durable step is recorded in `events` in place. */
function recoveryInput(events: string[]): DesktopGuardianRecovery {
  return Object.freeze({
    guardianInstanceId: recoveryCorrelation.guardianInstanceId,
    guardianEpoch: recoveryCorrelation.guardianEpoch,
    attemptId: recoveryCorrelation.attemptId,
    operationWaitBudgetMs: 1_000,
    recoveryInstanceId: recoveryInstance,
    preCasFrame: recoveryPreCas,
    beginRecovery: async (): Promise<Uint8Array> => {
      events.push("beginRecovery");
      return recoveryPostCas;
    },
    roleContained: async (role: GuardianRecoveryRole): Promise<void> => {
      events.push(`roleContained:${role}`);
    },
  });
}

test("recovery conversation writes the five Desktop frames in exact ordinal key order and reaches containment", async () => {
  const harness = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
    recoveryAcknowledgement("contained"),
  ]);
  const outcome = await driveGuardianRecoveryConversation(
    harness.transport,
    recoveryBinding,
    recoveryInput(harness.events),
  );

  assert.deepEqual(outcome, { outcome: "contained" });
  assert.deepEqual(
    harness.frames.map((frame) => frame.operation),
    [
      "recover_attempt",
      "recovery_post_cas",
      "recover_attempt",
      "recovery_role_cas_ack",
      "recovery_role_cas_ack",
      "recovery_finalize_ack",
      "release",
    ],
  );
  const gate = harness.frames[0]!;
  const postCas = harness.frames[1]!;
  const recover = harness.frames[2]!;
  const playerCas = harness.frames[3]!;
  const aiCas = harness.frames[4]!;
  const finalize = harness.frames[5]!;
  const release = harness.frames[6]!;
  // The Desktop compares the key SEQUENCE, so the ordinal order is protocol, not
  // formatting: the bounded wait precedes the correlation, and the private body
  // or the role follows the recovery actor.
  assert.deepEqual(Object.keys(gate), recoveryFrameKeys("privateFrame"));
  assert.deepEqual(Object.keys(postCas), recoveryFrameKeys("privateFrame"));
  assert.deepEqual(Object.keys(recover), recoveryFrameKeys());
  assert.deepEqual(Object.keys(playerCas), recoveryFrameKeys("role"));
  assert.deepEqual(Object.keys(aiCas), recoveryFrameKeys("role"));
  assert.deepEqual(Object.keys(finalize), recoveryFrameKeys());
  assert.deepEqual(Object.keys(release), recoveryFrameKeys());
  // Only the two recovery bodies are private frames: the broker rebuilds the
  // native recover attempt from the correlation, so that frame carries none.
  assert.equal(Object.hasOwn(recover, "privateFrame"), false);
  assert.equal(Object.hasOwn(finalize, "privateFrame"), false);
  assert.equal(Object.hasOwn(release, "privateFrame"), false);
  // The bytes the native ingress validates are exactly the frames the durable
  // steps produced, not a re-encoding of them.
  assert.deepEqual(Buffer.from(String(gate.privateFrame), "base64url"), Buffer.from(recoveryPreCas));
  assert.deepEqual(Buffer.from(String(postCas.privateFrame), "base64url"), Buffer.from(recoveryPostCas));
  assert.equal(String(recover.privateFrame ?? ""), "");
  // The recovery wire names the OS roles `playerHost`/`aiClient`; the containment
  // spelling belongs to arm/launch/contain and must never appear here.
  assert.deepEqual(
    harness.frames.filter((frame) => frame.role !== undefined).map((frame) => frame.role),
    ["playerHost", "aiClient"],
  );
  // Every durable step runs in the only order the broker accepts: the recovering
  // CAS strictly after the gate acknowledgement, each role durably recorded
  // before its CAS acknowledgement, and the waiter installed before the frames it
  // answers. One acknowledgement answers the post-CAS and native recover frames,
  // which is why this conversation cannot use the single request/ack helper.
  assert.deepEqual(harness.events, [
    "receive",
    "write:recover_attempt",
    "beginRecovery",
    "receive",
    "write:recovery_post_cas",
    "write:recover_attempt",
    "roleContained:playerHost",
    "receive",
    "write:recovery_role_cas_ack",
    "roleContained:aiClient",
    "receive",
    "write:recovery_role_cas_ack",
    "write:recovery_finalize_ack",
    "write:release",
  ]);
});

/**
 * The durable role CAS refusal that means "this record already holds this role as
 * contained" (`containRecoveringRole`, stardew-private-bootstrap-composer.core.internal).
 * A resumed recovery meets it for every role the crashed conversation had already
 * recorded before its CAS acknowledgement was written, and it reaches the wire as
 * the platform contract's typed identity rather than as this message: the message
 * text carries no authority, so nothing here may depend on it.
 */
const recoveryRoleAlreadyContained = (): Error =>
  new ContainmentRoleAlreadyContainedError("stardew_bootstrap_owner_recovery_role_already_contained");

/** The same conversation input, with the durable role step replaced by the test's own. */
function resumedRecoveryInput(
  events: string[],
  roleContained: (role: GuardianRecoveryRole) => Promise<void>,
): DesktopGuardianRecovery {
  return Object.freeze({ ...recoveryInput(events), roleContained });
}

test("recovery completes a resume whose first role the record already holds as contained", async () => {
  const harness = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
    recoveryAcknowledgement("contained"),
  ]);
  // The crash happened after the Player role's durable CAS and before its CAS
  // acknowledgement, so the native side classifies that role contained again while
  // the durable record already holds it and refuses the transition.
  const outcome = await driveGuardianRecoveryConversation(
    harness.transport,
    recoveryBinding,
    resumedRecoveryInput(harness.events, async (role) => {
      harness.events.push(`roleContained:${role}`);
      if (role === "playerHost") throw recoveryRoleAlreadyContained();
    }),
  );

  assert.deepEqual(outcome, { outcome: "contained" });
  // The remaining role is still durably recorded, and the resume repeats nothing:
  // the frames and durable steps are exactly the ones an uninterrupted
  // conversation produces, so no native step and no frame is retried.
  assert.deepEqual(harness.events, [
    "receive",
    "write:recover_attempt",
    "beginRecovery",
    "receive",
    "write:recovery_post_cas",
    "write:recover_attempt",
    "roleContained:playerHost",
    "receive",
    "write:recovery_role_cas_ack",
    "roleContained:aiClient",
    "receive",
    "write:recovery_role_cas_ack",
    "write:recovery_finalize_ack",
    "write:release",
  ]);
  assert.deepEqual(
    harness.frames.map((frame) => frame.operation),
    [
      "recover_attempt",
      "recovery_post_cas",
      "recover_attempt",
      "recovery_role_cas_ack",
      "recovery_role_cas_ack",
      "recovery_finalize_ack",
      "release",
    ],
  );
});

test("recovery completes a resume whose every recorded role is already contained", async () => {
  // The crash happened after the AI role's durable CAS and before the finalize
  // acknowledgement, so both roles are already recorded and both are refused.
  const harness = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
    recoveryAcknowledgement("contained"),
  ]);
  const outcome = await driveGuardianRecoveryConversation(
    harness.transport,
    recoveryBinding,
    resumedRecoveryInput(harness.events, async (role) => {
      harness.events.push(`roleContained:${role}`);
      throw recoveryRoleAlreadyContained();
    }),
  );

  assert.deepEqual(outcome, { outcome: "contained" });
  assert.deepEqual(
    harness.frames.map((frame) => frame.operation),
    [
      "recover_attempt",
      "recovery_post_cas",
      "recover_attempt",
      "recovery_role_cas_ack",
      "recovery_role_cas_ack",
      "recovery_finalize_ack",
      "release",
    ],
  );
  assert.deepEqual(
    harness.events.filter((event) => event.startsWith("roleContained")),
    ["roleContained:playerHost", "roleContained:aiClient"],
  );
});

test("recovery still fails closed on a durable role CAS that was not already recorded", async () => {
  // A role the record never accepted is not a containment: the refused CAS must
  // stop the conversation before that role's acknowledgement and never reach a
  // terminal frame.
  const playerRefused = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
  ]);
  await assert.rejects(
    () =>
      driveGuardianRecoveryConversation(
        playerRefused.transport,
        recoveryBinding,
        resumedRecoveryInput(playerRefused.events, async (role) => {
          playerRefused.events.push(`roleContained:${role}`);
          throw new Error("stardew_bootstrap_owner_transition_mismatch");
        }),
      ),
    /stardew_bootstrap_owner_transition_mismatch/,
  );
  assert.deepEqual(
    playerRefused.frames.map((frame) => frame.operation),
    ["recover_attempt", "recovery_post_cas", "recover_attempt"],
  );
  assert.deepEqual(
    playerRefused.events.filter((event) => event.startsWith("roleContained")),
    ["roleContained:playerHost"],
  );

  // Tolerating the first role's already-recorded CAS must not make the second
  // role's refusal tolerable: the Player acknowledgement is written, and nothing
  // after it is.
  const aiRefused = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("ai_contained"),
  ]);
  await assert.rejects(
    () =>
      driveGuardianRecoveryConversation(
        aiRefused.transport,
        recoveryBinding,
        resumedRecoveryInput(aiRefused.events, async (role) => {
          aiRefused.events.push(`roleContained:${role}`);
          if (role === "aiClient") throw new Error("stardew_bootstrap_owner_transition_mismatch");
          throw recoveryRoleAlreadyContained();
        }),
      ),
    /stardew_bootstrap_owner_transition_mismatch/,
  );
  assert.deepEqual(
    aiRefused.frames.map((frame) => frame.operation),
    ["recover_attempt", "recovery_post_cas", "recover_attempt", "recovery_role_cas_ack"],
  );
  assert.deepEqual(
    aiRefused.events.filter((event) => event.startsWith("roleContained")),
    ["roleContained:playerHost", "roleContained:aiClient"],
  );
});

/**
 * The guard this lane exists for: the refusal the durable engine throws and the
 * refusal the recovery wire tolerates are connected by one test that runs both
 * real sides, not by two tests that each restate their own.
 *
 * The engine is driven against a real crashed record, the error it actually
 * throws drives the real recovery conversation, and the wire is then asked for
 * the same refusal rebuilt as a plain Error - exactly what the retired message
 * match accepted. Renaming the engine's refusal, re-typing it, or widening the
 * wire back to a message comparison fails here and nowhere else.
 */
test("the durable composer refusal and the recovery wire share one identity, not one message", async () => {
  // Every `withPathLock` the durable engine runs goes through the bound
  // stale-lock reclaimer capability, so the guard binds the test-only one.
  bindWindowsStaleLockReclaimer(createTestWindowsStaleLockReclaimer(simulatedLockHelper));
  const root = await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-recovery-identity-"));
  const recoveryInstanceId = "66666666-6666-4666-8666-666666666666";
  try {
    const persistedOwner = join(root, "stardew-private-bootstrap", "bootstrap-1", "owner.json");
    await mkdir(dirname(persistedOwner), { recursive: true });
    // A crash that left the durable attempt mid-recovery with the Player role
    // already contained and its CAS acknowledgement unwritten: the exact predecessor
    // a resumed recovery opens, in the composer's strict v4 record shape.
    await writeFile(
      persistedOwner,
      JSON.stringify({
        schema: "gamebuddy-stardew-private-bootstrap-owner/v4",
        bootstrapId: "bootstrap-1",
        playerId: "player-1",
        companionId: "companion-1",
        guardian: {
          bindingRevision: "44444444-4444-4444-8444-444444444444",
          guardianInstanceId: "11111111-1111-4111-8111-111111111111",
          guardianEpoch: 1,
          leaseName: "Local\\GameBuddy-Lease-1",
          playerJobName: "Local\\GameBuddy-PlayerJob-1",
          aiJobName: "Local\\GameBuddy-AiJob-1",
        },
        ownerRecordRevision: 4,
        state: "recovering",
        guardianState: "recovering",
        playerHostState: "contained",
        aiClientState: "active",
        recoveryInstanceId,
        playerHost: { kind: "external_unattested" },
        aiClient: { kind: "launch_reserved", launchGeneration: "generation-1" },
        expiresAtMs: 1_000_000,
        cleanupDisposition: "pending",
        managedPaths: ["owner.json"],
      }),
      "utf8",
    );

    const opened = await openRecoverableStardewBootstrapOwner({
      transactionRoot: root,
      bootstrapFacts: { bootstrapId: "bootstrap-1", playerId: "player-1", companionId: "companion-1" },
    });
    let engineRefusal: unknown;
    try {
      await opened.transitions.recoveryRoleContained("playerHost", recoveryInstanceId);
    } catch (error) {
      engineRefusal = error;
    }
    assert.ok(
      engineRefusal instanceof ContainmentRoleAlreadyContainedError,
      `the durable engine must refuse an already contained role with the shared platform identity, got ${String(engineRefusal)}`,
    );
    const engineRefusalMessage = (engineRefusal as Error).message;

    // The wire tolerates the refusal the engine really threw...
    const tolerated = recoveryHarness([
      recoveryAcknowledgement("recovery_accepted"),
      recoveryAcknowledgement("player_contained"),
      recoveryAcknowledgement("ai_contained"),
      recoveryAcknowledgement("contained"),
    ]);
    assert.deepEqual(
      await driveGuardianRecoveryConversation(
        tolerated.transport,
        recoveryBinding,
        resumedRecoveryInput(tolerated.events, async (role) => {
          tolerated.events.push(`roleContained:${role}`);
          if (role === "playerHost") throw engineRefusal;
        }),
      ),
      { outcome: "contained" },
    );

    // ...and only that identity: the same refusal rebuilt as a plain Error - what a
    // message comparison accepted - still closes the recovery session, before the
    // refused role's acknowledgement is written.
    const lookAlike = recoveryHarness([
      recoveryAcknowledgement("recovery_accepted"),
      recoveryAcknowledgement("player_contained"),
      recoveryAcknowledgement("ai_contained"),
    ]);
    await assert.rejects(
      () =>
        driveGuardianRecoveryConversation(
          lookAlike.transport,
          recoveryBinding,
          resumedRecoveryInput(lookAlike.events, async () => {
            throw new Error(engineRefusalMessage);
          }),
        ),
      (error: unknown) => error instanceof Error && error.message === engineRefusalMessage,
    );
    assert.deepEqual(
      lookAlike.frames.map((frame) => frame.operation),
      ["recover_attempt", "recovery_post_cas", "recover_attempt"],
    );
  } finally {
    bindWindowsStaleLockReclaimer(undefined);
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * Minimal stale-lock reclaimer helper process for the path-lock release step.
 *
 * The real helper is a signed native artifact; its protocol version 1 admits
 * `release_owned_lock` with the exact owning token, and the test-only capability
 * exists precisely so focused suites can stand in for it. Only the release step
 * of the guard's `withPathLock` reaches this, and it must delete the lock leaf
 * while the token still matches, so the helper speaks that one operation.
 */
function simulatedLockHelper(): ChildProcess {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => true,
  });
  child.stdin.on("data", (chunk: Buffer) => {
    void (async () => {
      const request = JSON.parse(chunk.toString("utf8")) as Readonly<{
        operation: string;
        token?: string;
        root: string;
        segments: readonly string[];
      }>;
      const lockPath = resolve(request.root, ...request.segments);
      let result = "indeterminate";
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as Readonly<{ token?: unknown }>;
        if (request.operation === "release_owned_lock" && owner.token === request.token) {
          await rm(lockPath, { force: true });
          result = "released";
        } else {
          result = "kept_token_mismatch";
        }
      } catch (error) {
        result = (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "kept_not_regular";
      }
      child.stdout.end(`{"schemaVersion":1,"result":"${result}"}\n`);
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    })();
  });
  return child as unknown as ChildProcess;
}

test("recovery reads the shared `unavailable` status by position, never by its text", async () => {
  // At the gate position the same text means the Guardian refused to open the
  // gate: the previous lease stays authority and no durable CAS may run.
  const held = recoveryHarness([recoveryAcknowledgement("unavailable")]);
  assert.deepEqual(
    await driveGuardianRecoveryConversation(held.transport, recoveryBinding, recoveryInput(held.events)),
    { outcome: "gate_held" },
  );
  assert.deepEqual(
    held.frames.map((frame) => frame.operation),
    ["recover_attempt"],
  );
  assert.deepEqual(held.events, ["receive", "write:recover_attempt"]);

  // At a role position it is a native classification: the recovery ran and that
  // exact role was not contained.
  const playerFailed = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("unavailable"),
  ]);
  assert.deepEqual(
    await driveGuardianRecoveryConversation(
      playerFailed.transport,
      recoveryBinding,
      recoveryInput(playerFailed.events),
    ),
    { outcome: "role_classified", role: "playerHost", classification: "unavailable" },
  );
  assert.deepEqual(
    playerFailed.frames.map((frame) => frame.operation),
    ["recover_attempt", "recovery_post_cas", "recover_attempt"],
  );
  assert.deepEqual(
    playerFailed.events.filter((event) => event.startsWith("roleContained")),
    [],
  );

  const aiFailed = recoveryHarness([
    recoveryAcknowledgement("recovery_accepted"),
    recoveryAcknowledgement("player_contained"),
    recoveryAcknowledgement("quarantined"),
  ]);
  assert.deepEqual(
    await driveGuardianRecoveryConversation(aiFailed.transport, recoveryBinding, recoveryInput(aiFailed.events)),
    { outcome: "role_classified", role: "aiClient", classification: "quarantined" },
  );
  // Only the Player role was acknowledged, so only it reached durable
  // containment; the AI role's CAS acknowledgement is never written.
  assert.deepEqual(
    aiFailed.events.filter((event) => event.startsWith("roleContained")),
    ["roleContained:playerHost"],
  );
  assert.deepEqual(
    aiFailed.frames.map((frame) => frame.operation),
    ["recover_attempt", "recovery_post_cas", "recover_attempt", "recovery_role_cas_ack"],
  );
});

test("recovery rejects an acknowledgement the broker would never write at that position", async () => {
  const withoutActor = recoveryAcknowledgement("recovery_accepted");
  delete withoutActor.recoveryInstanceId;
  const cases: ReadonlyArray<readonly [string, ReadonlyArray<Readonly<Record<string, unknown>>>, string]> = [
    [
      "gate acknowledgement carrying a containment role",
      [recoveryAcknowledgement("recovery_accepted", { role: "player_host" })],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "gate acknowledgement without the recovery actor",
      [withoutActor],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "gate acknowledgement for another recovery actor",
      [recoveryAcknowledgement("recovery_accepted", { recoveryInstanceId: "55555555-5555-4555-8555-555555555555" })],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "gate acknowledgement for another attempt",
      [recoveryAcknowledgement("recovery_accepted", { attemptId: "66666666-6666-4666-8666-666666666666" })],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "gate acknowledgement for another guardian epoch",
      [recoveryAcknowledgement("recovery_accepted", { guardianEpoch: 2 })],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "gate acknowledgement from the role CAS operation",
      [recoveryAcknowledgement("recovery_accepted", { operation: "recovery_role_cas_ack" })],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "gate position answered with a role containment status",
      [recoveryAcknowledgement("player_contained")],
      "guardian_recovery_gate_acknowledgement_invalid",
    ],
    [
      "role position answered with a gate status",
      [recoveryAcknowledgement("recovery_accepted"), recoveryAcknowledgement("recovery_accepted")],
      "guardian_recovery_player_acknowledgement_invalid",
    ],
    [
      "terminal position answered with a role status",
      [
        recoveryAcknowledgement("recovery_accepted"),
        recoveryAcknowledgement("player_contained"),
        recoveryAcknowledgement("ai_contained"),
        recoveryAcknowledgement("ai_contained"),
      ],
      "guardian_recovery_settled_acknowledgement_invalid",
    ],
    [
      "terminal position answered with the gate-held status",
      [
        recoveryAcknowledgement("recovery_accepted"),
        recoveryAcknowledgement("player_contained"),
        recoveryAcknowledgement("ai_contained"),
        recoveryAcknowledgement("unavailable"),
      ],
      "guardian_recovery_settled_acknowledgement_invalid",
    ],
  ];
  for (const [label, acknowledgements, reason] of cases) {
    const harness = recoveryHarness(acknowledgements);
    await assert.rejects(
      () => driveGuardianRecoveryConversation(harness.transport, recoveryBinding, recoveryInput(harness.events)),
      new RegExp(`desktop_runtime_bootstrap_unavailable:${reason}$`),
      label,
    );
  }
});

test("recovery refuses malformed input and a missing post-CAS binding without inventing an outcome", async () => {
  const harness = recoveryHarness([recoveryAcknowledgement("recovery_accepted")]);
  const input = recoveryInput(harness.events);
  // A recovery actor the native ingress cannot parse, an empty gate body, and a
  // zero wait budget are all refused before any frame reaches the wire.
  await assert.rejects(
    () =>
      driveGuardianRecoveryConversation(harness.transport, recoveryBinding, {
        ...input,
        recoveryInstanceId: "gamebuddy-stardew-token",
      }),
    /desktop_runtime_bootstrap_unavailable:guardian_recovery_input_invalid$/,
  );
  await assert.rejects(
    () =>
      driveGuardianRecoveryConversation(harness.transport, recoveryBinding, {
        ...input,
        preCasFrame: new Uint8Array(0),
      }),
    /desktop_runtime_bootstrap_unavailable:guardian_recovery_input_invalid$/,
  );
  await assert.rejects(
    () => driveGuardianRecoveryConversation(harness.transport, recoveryBinding, { ...input, operationWaitBudgetMs: 0 }),
    /desktop_runtime_bootstrap_unavailable:guardian_recovery_input_invalid$/,
  );
  assert.deepEqual(harness.frames, []);
  assert.deepEqual(harness.events, []);

  // A durable CAS that produced no post-CAS binding cannot be continued: the
  // native ingress would refuse the frame, so the conversation stops after the
  // gate frame instead of writing an empty binding.
  const shortCas = recoveryHarness([recoveryAcknowledgement("recovery_accepted")]);
  await assert.rejects(
    () =>
      driveGuardianRecoveryConversation(shortCas.transport, recoveryBinding, {
        ...recoveryInput(shortCas.events),
        beginRecovery: async () => new Uint8Array(0),
      }),
    /desktop_runtime_bootstrap_unavailable:guardian_recovery_post_cas_frame_invalid$/,
  );
  assert.deepEqual(
    shortCas.frames.map((frame) => frame.operation),
    ["recover_attempt"],
  );
});
