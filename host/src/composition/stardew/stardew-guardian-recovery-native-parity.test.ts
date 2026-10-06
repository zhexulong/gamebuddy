/**
 * Cross-language recovery parity: the Host's own encoder output in front of the
 * real compiled native Guardian.
 *
 * The native live harness (`native/windows-bootstrap-guardian/guardian-live.test.mjs`)
 * drives the compiled Guardian with hand-built JSON: those objects are a copy of
 * what the Host believes the native expects, so the native PARSER is proven
 * against hand-written bytes and the Host's ENCODER is proven against nothing.
 * This test closes that gap by driving the composition's real recovery path —
 * `createDesktopGuardianGameRuntimePlatform(...).recover(...)`, which runs
 * `encodeRecoveryPreCasFrame`/`encodeRecoveryPostCasFrame`, and the wire's real
 * recovery conversation (`driveGuardianRecoveryConversation`, the only place the
 * private frame becomes a base64url `privateFrame` on the session frame) — with
 * the Desktop supervisor replaced by a thin stand-in that performs exactly the
 * supervisor's own steps (`GuardianPrivateIngress.InjectRecoveryToken`, write to
 * the native pipe, read the native's answer back) against the real child.
 *
 * No Host frame is re-implemented here: every byte the native parses comes out of
 * the production encoders. The stand-in relays bytes and mirrors the supervisor's
 * sequencing; it builds no recovery body of its own.
 *
 * Route 1 was used (the real factory is reachable from a TypeScript test). The
 * companion `.mjs` harness cannot host it: it is plain JavaScript, and the Host
 * modules it would need are TypeScript with a `.js`-specifier module graph, so a
 * `.mjs` file cannot import them.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { driveGuardianRecoveryConversation } from "../../bootstrap/wire/desktop-runtime-bootstrap.internal.js";
import type {
  DesktopGuardianRecovery,
  DesktopGuardianRecoveryTransport,
  DesktopGuardianSession,
  GuardianRecoveryAck,
} from "../../containment/auth/desktop-guardian-session.internal.js";
import type { TypedPrivateGameFacts } from "../../containment/runtime/contract/game-runtime.js";
import { createDesktopGuardianGameRuntimePlatform } from "./stardew-guardian-platform.js";

const hostRoot = fileURLToPath(new URL("../../../", import.meta.url));
const guardianExecutable = resolve(hostRoot, "native", "windows-bootstrap-guardian", ".dist", "win-x64", "GameBuddy.WindowsBootstrapGuardian.exe");
const fixtureExecutable = resolve(hostRoot, "native", "windows-bootstrap-guardian", ".dist", "fixtures", "RoleRootFixture.exe");
const isWindows = process.platform === "win32";
const winOnly = { skip: !isWindows ? "BLOCKED: the native recovery parity test needs Windows" : false };

/** The four session-binding fields every Desktop guardian frame carries. */
type GuardianSessionBinding = Readonly<{
  bootstrapId: string;
  generation: string;
  inventoryDigest: string;
  runtimeAdmissionSha256: string;
}>;

type RecoveryCorrelation = Readonly<{
  guardianInstanceId: string;
  guardianEpoch: number;
  attemptId: string;
}>;

const binding: GuardianSessionBinding = Object.freeze({
  bootstrapId: "a".repeat(64),
  generation: "generation-1",
  inventoryDigest: "b".repeat(64),
  runtimeAdmissionSha256: "c".repeat(64),
});

type NativeRecoveryRun = Readonly<{
  native: NativeRecoveryChild;
  standIn: DesktopSupervisorStandIn;
  /** The exact `preCasFrame` bytes the Host's own encoder handed the supervisor. */
  preCasFrame: Uint8Array;
  /** The exact `postCasFrame` bytes the Host's own encoder handed the supervisor. */
  postCasFrame: Uint8Array;
}>;

test("the compiled native Guardian accepts the Host's own recovery frames, refuses a held gate, and refuses a tampered frame", { ...winOnly, timeout: 180_000 }, async (t) => {
  for (const executable of [guardianExecutable, fixtureExecutable]) {
    try {
      await access(executable);
    } catch {
      t.skip(`published Guardian/fixture is missing; run the Windows Guardian builder first: ${executable}`);
      return;
    }
  }

  const correlation: RecoveryCorrelation = Object.freeze({ guardianInstanceId: randomUUID(), guardianEpoch: 1, attemptId: randomUUID() });
  const recoveryInstanceId = randomUUID();
  // One durable gate binding. The pre-CAS frame the native parses is built from
  // exactly these facts, so the accepted run and the held run below send the
  // byte-identical Host-encoded gate body.
  const bindingRevision = randomUUID();
  const leaseName = `Local\\RecoveryParityLease-${randomUUID()}`;
  const playerJobName = `Local\\RecoveryParityPlayer-${randomUUID()}`;
  const aiJobName = `Local\\RecoveryParityAi-${randomUUID()}`;
  const gateFacts: TypedPrivateGameFacts = Object.freeze({ bindingRevision, leaseName });
  // A wrong-DACL Job is the only AI classification that proves the Host's
  // encoded `aiJobName` reached the native verbatim: a corrupted name would be
  // "file not found" and therefore `contained`, never `quarantined`.
  const successorFacts: TypedPrivateGameFacts = Object.freeze({
    bindingRevision,
    ownerRecordRevision: 2,
    leaseName,
    playerJobName,
    aiJobName,
    playerHostState: "armed",
    aiClientState: "armed",
  });

  const root = await mkdtemp(resolve(tmpdir(), "gamebuddy-guardian-parity-"));
  const ready = resolve(root, "ai-job.ready");
  const aiJobHolder = spawn(fixtureExecutable, ["--recovery-job", aiJobName, "wrong-dacl", "--signal", ready], {
    windowsHide: true,
    shell: false,
    stdio: "ignore",
  });
  let acceptedPreCasFrame: Uint8Array | undefined;
  let acceptedPostCasFrame: Uint8Array | undefined;
  try {
    await waitForFile(ready);

    // (a) + (b): the Host's real recovery conversation, end to end against the
    // real native child.
    const accepted = await runHostRecoveryConversation({ correlation, recoveryInstanceId, gateFacts, successorFacts });
    acceptedPreCasFrame = accepted.preCasFrame;
    acceptedPostCasFrame = accepted.postCasFrame;
    const acceptedAnswers = accepted.standIn.nativeAnswers;
    t.diagnostic(`Host pre-CAS body: ${Buffer.from(acceptedPreCasFrame).toString("utf8")}`);
    t.diagnostic(`Host post-CAS body: ${Buffer.from(acceptedPostCasFrame).toString("utf8")}`);
    t.diagnostic(`native answers: ${JSON.stringify(acceptedAnswers)}`);
    assert.deepEqual(
      acceptedAnswers,
      ["acquired", "unavailable", "quarantined"],
      `(a/b) the native's own answers to the Host-encoded frames were ${JSON.stringify(acceptedAnswers)}; the first must be the gate's \`acquired\`, and the later two exist only once the native parsed the Host's post-CAS body and ran its Job classifier`,
    );
    assert.deepEqual(
      accepted.standIn.outcome,
      { outcome: "role_classified", role: "playerHost", classification: "unavailable" },
      "(b/a) the conversation terminal must be the native's own player classification, because the native never adopts the player world",
    );
    assert.equal(await accepted.native.release(), true, "the native did not exit after the Host-encoded post-CAS conversation reached its release step");
    assert.equal(accepted.native.exitCode, 0, `the native exited ${String(accepted.native.exitCode)} instead of its clean recovery termination`);
    assert.equal(accepted.native.stderr, "", `the native refused something: ${accepted.native.stderr}`);

    // (c) the exclusion gate: the same Host-encoded pre-CAS bytes, but a live
    // handle already exists at the lease name.
    const held = await runHostRecoveryConversation({ correlation, recoveryInstanceId, gateFacts, successorFacts, holdLease: { leaseName, ready: resolve(root, "lease.ready") } });
    t.diagnostic(`held native answers: ${JSON.stringify(held.standIn.nativeAnswers)}`);
    assert.equal(held.standIn.nativeAnswers[0], "held", `(c) the native answered ${String(held.standIn.nativeAnswers[0])} for a pre-held same-name gate`);
    assert.deepEqual(held.standIn.outcome, { outcome: "gate_held" }, "(c) a held gate must surface as the conversation's separate `gate_held`, never as a recovery");
    assert.equal(await held.native.waitForExit(10_000), true, "the native did not exit after refusing the gate");
    assert.equal(held.native.exitCode, 0, `the native exited ${String(held.native.exitCode)} for a held gate`);
    // The task's own claim: it is the SAME frame. Both runs were encoded by the
    // production encoder from the identical facts, so the bytes must match.
    assert.deepEqual(
      Buffer.from(held.preCasFrame),
      Buffer.from(acceptedPreCasFrame),
      "(c) the held run must send the byte-identical Host-encoded pre-CAS frame the accepted run sent",
    );

    // (d) the falsification: a Host-encoded frame with one extra key must be
    // REFUSED rather than accepted, which is what proves this parity test is not
    // vacuous.
    const tamperedPreCas = withExtraKey(acceptedPreCasFrame);
    const controlRun = await openNativeRecovery();
    try {
      assert.equal(
        await controlRun.sendPreCas(acceptedPreCasFrame),
        "acquired",
        "(d control) the untampered Host-encoded pre-CAS frame must be accepted by a fresh native",
      );
    } finally {
      await controlRun.destroy();
    }
    const tamperedRun = await openNativeRecovery();
    try {
      const answer = await tamperedRun.sendPreCas(tamperedPreCas);
      assert.equal(answer, undefined, `(d) a Host-encoded pre-CAS frame with one extra key was answered ${String(answer)} instead of being refused`);
      assert.equal(await tamperedRun.waitForExit(10_000), true, "(d) the native did not fail closed on a tampered Host-encoded frame");
      assert.equal(tamperedRun.exitCode, 1, `(d) the native exited ${String(tamperedRun.exitCode)} instead of its fail-closed status`);
      assert.match(tamperedRun.stderr, /windows_bootstrap_guardian_invalid_request/, "(d) the native's fail-closed diagnostic is the observation that it refused the frame");
    } finally {
      await tamperedRun.destroy();
    }
    // The same falsification on the second Host-encoded body: the native must
    // accept the Host's pre-CAS body and then refuse a tampered post-CAS body.
    const tamperedPostRun = await openNativeRecovery();
    try {
      assert.equal(await tamperedPostRun.sendPreCas(acceptedPreCasFrame), "acquired", "(d) the pre-CAS body of the tampered-post run must be accepted first");
      await tamperedPostRun.sendPostCas(withExtraKey(acceptedPostCasFrame));
      assert.equal(await tamperedPostRun.waitForExit(10_000), true, "(d) the native did not fail closed on a tampered Host-encoded post-CAS frame");
      assert.equal(tamperedPostRun.exitCode, 1, `(d) the native exited ${String(tamperedPostRun.exitCode)} instead of its fail-closed status for a tampered post-CAS body`);
      assert.match(tamperedPostRun.stderr, /windows_bootstrap_guardian_invalid_request/, "(d) the native's fail-closed diagnostic for the tampered post-CAS body");
    } finally {
      await tamperedPostRun.destroy();
    }

    // (e) The Host's new int32 bound mirrors a real native limit rather than a
    // guess. The native reads `guardianEpoch` and `ownerRecordRevision` with
    // `TryGetInt32`, so the exact value the Host now refuses is one the native
    // answers with its generic invalid-request failure, while the value below it
    // is one the native parses. Both sides of both boundaries are observed here.
    const outOfDomainEpoch = await openNativeRecovery();
    try {
      const answer = await outOfDomainEpoch.sendPreCas(withReplacedInteger(acceptedPreCasFrame, "guardianEpoch", 2_147_483_648));
      assert.equal(answer, undefined, `(e) the native answered ${String(answer)} for guardianEpoch 2147483648 instead of refusing it`);
      assert.equal(await outOfDomainEpoch.waitForExit(10_000), true, "(e) the native did not fail closed on an out-of-int32 guardianEpoch");
      assert.equal(outOfDomainEpoch.exitCode, 1, "(e) the native must fail closed on an out-of-int32 guardianEpoch");
      assert.match(outOfDomainEpoch.stderr, /windows_bootstrap_guardian_invalid_request/, "(e) the native's own refusal of an out-of-int32 guardianEpoch");
      t.diagnostic(`(e) native refusal for out-of-int32 guardianEpoch: ${outOfDomainEpoch.stderr.trim()}`);
    } finally {
      await outOfDomainEpoch.destroy();
    }
    const maxEpoch = await openNativeRecovery();
    try {
      assert.equal(await maxEpoch.sendPreCas(withReplacedInteger(acceptedPreCasFrame, "guardianEpoch", 2_147_483_647)), "acquired", "(e) the int32 max guardianEpoch must still be inside the native's domain");
    } finally {
      await maxEpoch.destroy();
    }
    const outOfDomainRevision = await openNativeRecovery();
    try {
      assert.equal(await outOfDomainRevision.sendPreCas(acceptedPreCasFrame), "acquired", "(e) the unmutated pre-CAS body must acquire the gate before the post-CAS boundary is probed");
      await outOfDomainRevision.sendPostCas(withReplacedInteger(acceptedPostCasFrame, "ownerRecordRevision", 2_147_483_648));
      assert.equal(await outOfDomainRevision.waitForExit(10_000), true, "(e) the native did not fail closed on an out-of-int32 ownerRecordRevision");
      assert.equal(outOfDomainRevision.exitCode, 1, "(e) the native must fail closed on an out-of-int32 ownerRecordRevision");
      assert.match(outOfDomainRevision.stderr, /windows_bootstrap_guardian_invalid_request/, "(e) the native's own refusal of an out-of-int32 ownerRecordRevision");
      t.diagnostic(`(e) native refusal for out-of-int32 ownerRecordRevision: ${outOfDomainRevision.stderr.trim()}`);
    } finally {
      await outOfDomainRevision.destroy();
    }
    const maxRevision = await openNativeRecovery();
    try {
      assert.equal(await maxRevision.sendPreCas(acceptedPreCasFrame), "acquired", "(e) the unmutated pre-CAS body must acquire the gate before the post-CAS boundary is probed");
      await maxRevision.sendPostCas(withReplacedInteger(acceptedPostCasFrame, "ownerRecordRevision", 2_147_483_647));
      await maxRevision.sendRecoverAttempt({ ...correlation, recoveryInstanceId });
      const classification = await maxRevision.classify("playerHost");
      assert.equal(classification, "unavailable", `(e) the int32 max ownerRecordRevision must still be inside the native's domain; the native answered ${String(classification)}`);
      t.diagnostic(`(e) in-domain boundary answers: guardianEpoch 2147483647 -> acquired, ownerRecordRevision 2147483647 -> ${String(classification)}`);
    } finally {
      await maxRevision.destroy();
    }
  } finally {
    aiJobHolder.kill();
    await removeRoot(root);
  }
});

/**
 * Runs one complete Host recovery conversation against a fresh native child and
 * returns the run's observations. The Desktop supervisor is the stand-in:
 * everything else — the platform's encoder, the wire's private-frame path, the
 * native process — is production code.
 */
async function runHostRecoveryConversation(input: Readonly<{
  correlation: RecoveryCorrelation;
  recoveryInstanceId: string;
  gateFacts: TypedPrivateGameFacts;
  successorFacts: TypedPrivateGameFacts;
  holdLease?: Readonly<{ leaseName: string; ready: string }>;
}>): Promise<NativeRecoveryRun> {
  const leaseHolder = input.holdLease === undefined
    ? undefined
    : spawn(fixtureExecutable, ["--hold-mutex", input.holdLease.leaseName, "--signal", input.holdLease.ready], {
      windowsHide: true,
      shell: false,
      stdio: "ignore",
    });
  const native = new NativeRecoveryChild();
  try {
    // The exclusion gate only exists once the fixture holds the mutex, so the
    // native child is started after that holder signs readiness.
    if (input.holdLease !== undefined) await waitForFile(input.holdLease.ready);
    await native.connect();
    const standIn = new DesktopSupervisorStandIn(native, binding, input.correlation, input.recoveryInstanceId);
    const session = standInDesktopGuardianSession(standIn);
    const platform = createDesktopGuardianGameRuntimePlatform(session);
    const roleContained: string[] = [];
    standIn.outcome = await platform.recover({
      ...input.correlation,
      operationWaitBudgetMs: 60_000,
      recoveryInstanceId: input.recoveryInstanceId,
      gateFacts: input.gateFacts,
      beginRecovery: async () => input.successorFacts,
      roleContained: async (role) => { roleContained.push(role); },
    });
    standIn.assertHealthy();
    // The native never adopts the player world (`ClassifyPlayer` is a fixed
    // `unavailable`), so the conversation must stop at that role and must never
    // record one as contained.
    assert.deepEqual(roleContained, [], "a player the native never adopted must not be recorded as contained");
    return Object.freeze({
      native,
      standIn,
      preCasFrame: standIn.hostPreCasFrame!,
      postCasFrame: standIn.hostPostCasFrame!,
    });
  } catch (error) {
    await native.destroy();
    throw error;
  } finally {
    leaseHolder?.kill();
  }
}

/**
 * The Desktop supervisor's thin stand-in.
 *
 * It performs only the supervisor's own steps, faithfully mirroring
 * `GuardianRecoverySupervisorLease` (@ :426-504) and
 * `DesktopHostBootstrapBroker.RelayRecoveryAsync` (@ :173-233): inject the
 * recovery token into the Host's tokenless gate body, write it to the native
 * pipe, read `acquired`/`held`, relay the Host's post-CAS body, relay the native
 * recover command on the child's stdin, classify each role, and answer the wire
 * with the native's own result. It builds no recovery body and re-encodes no
 * Host frame.
 */
class DesktopSupervisorStandIn implements DesktopGuardianRecoveryTransport {
  public readonly nativeAnswers: string[] = [];
  public outcome: GuardianRecoveryAck | undefined;
  public hostPreCasFrame: Uint8Array | undefined;
  public hostPostCasFrame: Uint8Array | undefined;
  private readonly queue: Array<Record<string, unknown>> = [];
  private readonly waiters: Array<{ resolve(frame: Record<string, unknown>): void; reject(error: Error): void }> = [];
  private readonly ready: Array<Record<string, unknown>> = [];
  private failure: Error | undefined;
  private draining = false;

  public constructor(
    private readonly native: NativeRecoveryChild,
    private readonly sessionBinding: GuardianSessionBinding,
    private readonly correlation: RecoveryCorrelation,
    private readonly recoveryInstanceId: string,
  ) {}

  public write(frame: Readonly<Record<string, unknown>>): void {
    this.queue.push({ ...frame });
    void this.drain();
  }

  public receive(): Promise<Record<string, unknown>> {
    const pending = this.ready.shift();
    if (pending !== undefined) return Promise.resolve(pending);
    if (this.failure !== undefined) return Promise.reject(this.failure);
    return new Promise<Record<string, unknown>>((resolveAck, rejectAck) => {
      this.waiters.push({ resolve: resolveAck, reject: rejectAck });
    });
  }

  public assertHealthy(): void {
    if (this.failure !== undefined) throw this.failure;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const frame = this.queue.shift();
        if (frame === undefined) break;
        await this.relay(frame);
      }
    } catch (error) {
      this.fail(error);
    } finally {
      this.draining = false;
    }
  }

  /** The supervisor's relay for one frame the Host wrote. */
  private async relay(frame: Record<string, unknown>): Promise<void> {
    const operation = frame.operation;
    const privateFrame = frame.privateFrame;
    if (operation === "recover_attempt" && typeof privateFrame === "string") {
      const preCas = new Uint8Array(Buffer.from(privateFrame, "base64url"));
      this.hostPreCasFrame = preCas;
      const answer = await this.native.sendPreCas(preCas);
      this.nativeAnswers.push(answer ?? "<refused>");
      if (answer === "held") { this.push(this.acknowledge("unavailable")); return; }
      if (answer !== "acquired") throw new Error(`native recovery gate did not acquire the Host-encoded pre-CAS frame: ${answer ?? "<pipe closed>"}`);
      this.push(this.acknowledge("recovery_accepted"));
      return;
    }
    if (operation === "recovery_post_cas" && typeof privateFrame === "string") {
      const postCas = new Uint8Array(Buffer.from(privateFrame, "base64url"));
      this.hostPostCasFrame = postCas;
      await this.native.sendPostCas(postCas);
      return;
    }
    if (operation === "recover_attempt") {
      await this.native.sendRecoverAttempt({ ...this.correlation, recoveryInstanceId: this.recoveryInstanceId });
      const player = await this.classify("playerHost");
      if (player !== "contained") {
        // Mirrors the broker: consume the AI classification so its kill-on-close
        // Job is cleaned up, then report the terminal player result.
        await this.classify("aiClient");
        this.push(this.acknowledge(player));
        return;
      }
      this.push(this.acknowledge("player_contained"));
      return;
    }
    if (operation === "recovery_role_cas_ack" && frame.role === "playerHost") {
      const ai = await this.classify("aiClient");
      this.push(this.acknowledge(ai === "contained" ? "ai_contained" : ai));
      return;
    }
    if (operation === "recovery_role_cas_ack" || operation === "recovery_finalize_ack") return;
    if (operation === "release") {
      if (!await this.native.release()) throw new Error("the native recovery child did not exit after the release frame");
      this.push(this.acknowledge("contained"));
      return;
    }
    throw new Error(`unsupported Host recovery frame: ${String(operation)}`);
  }

  private async classify(role: "playerHost" | "aiClient"): Promise<string> {
    const answer = await this.native.classify(role);
    this.nativeAnswers.push(answer ?? "<refused>");
    return answer ?? "unavailable";
  }

  /** The exact acknowledgement key set `DesktopHostBootstrapBroker` writes. */
  private acknowledge(status: string): Record<string, unknown> {
    return {
      schema: "gamebuddy-desktop-guardian-session/v1",
      protocolVersion: 1,
      operation: "recover_attempt",
      status,
      ...this.sessionBinding,
      ...this.correlation,
      recoveryInstanceId: this.recoveryInstanceId,
    };
  }

  private push(frame: Record<string, unknown>): void {
    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter.resolve(frame);
    else this.ready.push(frame);
  }

  private fail(error: unknown): void {
    this.failure = error instanceof Error ? error : new Error(String(error));
    while (this.waiters.length > 0) this.waiters.shift()?.reject(this.failure);
  }
}

/** The Host's session seam. Its `recover` is the production conversation. */
function standInDesktopGuardianSession(transport: DesktopGuardianRecoveryTransport): DesktopGuardianSession {
  return Object.freeze({
    arm: async () => { throw new Error("the recovery parity test never arms"); },
    launch: async () => { throw new Error("the recovery parity test never launches"); },
    contain: async () => { throw new Error("the recovery parity test never contains"); },
    recover: async (input: DesktopGuardianRecovery) => await driveGuardianRecoveryConversation(transport, binding, input),
    close: async () => {},
  });
}

/** One real recovery-mode native child and its private pipe. */
class NativeRecoveryChild {
  public readonly token = randomUUID();
  public readonly pipeName = `GameBuddyRecoveryParity-${randomUUID()}`;
  private readonly child: ChildProcessByStdio<Writable, Readable, Readable>;
  private readonly lines: string[] = [];
  private readonly waiters: Array<(line: string | undefined) => void> = [];
  private socket: net.Socket | undefined;
  private buffered = "";
  private channelEnded = false;
  private stderrText = "";

  public constructor() {
    this.child = spawn(guardianExecutable, [], {
      windowsHide: true,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        GAMEBUDDY_GUARDIAN_MODE: "recovery",
        GAMEBUDDY_GUARDIAN_CONTROL_PIPE: this.pipeName,
        GAMEBUDDY_GUARDIAN_CONTROL_TOKEN: this.token,
      },
    });
    this.child.stderr.on("data", (chunk: Buffer) => { this.stderrText += chunk.toString("utf8"); });
    this.child.stdout.resume();
  }

  public get stderr(): string { return this.stderrText; }
  public get exitCode(): number | null { return this.child.exitCode; }

  public async connect(): Promise<void> {
    for (let attempt = 0; attempt < 400; attempt += 1) {
      if (this.child.exitCode !== null) throw new Error(`the native Guardian exited before its recovery pipe: ${this.stderrText}`);
      const socket = net.createConnection({ path: `\\\\.\\pipe\\${this.pipeName}` });
      const connected = await new Promise<boolean>((resolveConnect) => {
        socket.once("connect", () => resolveConnect(true));
        socket.once("error", () => resolveConnect(false));
      });
      if (connected) {
        this.socket = socket;
        socket.on("data", (chunk: Buffer) => { this.receive(chunk.toString("utf8")); });
        socket.on("close", () => { this.endChannel(); });
        socket.on("error", () => { this.endChannel(); });
        return;
      }
      socket.destroy();
      await delay(25);
    }
    throw new Error("the native Guardian recovery pipe was never connectable");
  }

  /**
   * The supervisor's own gate step: the Host's body is tokenless by design, so
   * the supervisor injects the recovery token exactly as
   * `GuardianPrivateIngress.InjectRecoveryToken` does, and reads the native's
   * answer (`acquired`/`held`, or `undefined` when the native refused and closed).
   */
  public async sendPreCas(body: Uint8Array): Promise<string | undefined> {
    await this.writePipe(injectRecoveryToken(body, this.token));
    return await this.nextLine();
  }

  public async sendPostCas(body: Uint8Array): Promise<void> {
    await this.writePipe(Buffer.from(body));
  }

  public async sendRecoverAttempt(correlation: RecoveryCorrelation & Readonly<{ recoveryInstanceId: string }>): Promise<void> {
    await this.writeStdin(`{"schemaVersion":1,"operation":"recover_attempt","guardianInstanceId":"${correlation.guardianInstanceId}","guardianEpoch":${correlation.guardianEpoch},"attemptId":"${correlation.attemptId}","recoveryInstanceId":"${correlation.recoveryInstanceId}"}\n`);
  }

  public async classify(role: "playerHost" | "aiClient"): Promise<string | undefined> {
    await this.writePipe(Buffer.from(`{"operation":"classify","role":"${role}"}`, "utf8"));
    return await this.nextLine();
  }

  /** The supervisor's terminal step: the release frame, then the control writer closes. */
  public async release(): Promise<boolean> {
    await this.writePipe(Buffer.from('{"operation":"release"}', "utf8"));
    if (!this.child.stdin.writableEnded) this.child.stdin.end();
    return await this.waitForExit(10_000);
  }

  public async waitForExit(timeoutMs: number): Promise<boolean> {
    if (this.child.exitCode !== null) return true;
    return await new Promise<boolean>((resolveExit) => {
      const timer = setTimeout(() => { resolveExit(false); }, timeoutMs);
      this.child.once("exit", () => { clearTimeout(timer); resolveExit(true); });
    });
  }

  public async destroy(): Promise<void> {
    this.socket?.destroy();
    if (this.child.exitCode === null) this.child.kill();
    await this.waitForExit(5_000);
  }

  private async writePipe(bytes: Buffer): Promise<void> {
    const socket = this.socket;
    if (socket === undefined) throw new Error("the native Guardian recovery pipe is not connected");
    await new Promise<void>((resolveWrite, rejectWrite) => {
      socket.write(Buffer.concat([bytes, Buffer.from("\n", "utf8")]), (error: Error | null | undefined) => { if (error === null || error === undefined) resolveWrite(); else rejectWrite(error); });
    });
  }

  private async writeStdin(text: string): Promise<void> {
    await new Promise<void>((resolveWrite, rejectWrite) => {
      this.child.stdin.write(text, (error: Error | null | undefined) => { if (error === null || error === undefined) resolveWrite(); else rejectWrite(error); });
    });
  }

  private receive(text: string): void {
    this.buffered += text;
    for (;;) {
      const index = this.buffered.indexOf("\n");
      if (index < 0) break;
      const line = this.buffered.slice(0, index);
      this.buffered = this.buffered.slice(index + 1);
      const waiter = this.waiters.shift();
      if (waiter === undefined) this.lines.push(line);
      else waiter(line);
    }
  }

  private nextLine(): Promise<string | undefined> {
    const line = this.lines.shift();
    if (line !== undefined) return Promise.resolve(line);
    if (this.channelEnded) return Promise.resolve(undefined);
    return new Promise<string | undefined>((resolveLine) => { this.waiters.push(resolveLine); });
  }

  private endChannel(): void {
    if (this.channelEnded) return;
    this.channelEnded = true;
    while (this.waiters.length > 0) this.waiters.shift()?.(undefined);
  }
}

/**
 * `GuardianPrivateIngress.InjectToken`: one tokenless `{...}` body becomes
 * `{"token":"...",...}`. The supervisor refuses a body that already carries a
 * token, which is what keeps the Host's own encoder from inventing one.
 */
function injectRecoveryToken(body: Uint8Array, token: string): Buffer {
  const text = Buffer.from(body).toString("utf8");
  if (body.length < 2 || !text.startsWith("{") || !text.endsWith("}") || text.includes("\n") || text.includes("\r") || text.includes("\u0000") || text.includes('"token"')) {
    throw new Error("the supervisor stand-in refuses a body that is not a tokenless JSON object");
  }
  return Buffer.from(`{"token":"${token}",${text.slice(1)}`, "utf8");
}

/** The falsification's mutation: valid JSON, one key the native does not accept. */
function withExtraKey(frame: Uint8Array): Uint8Array {
  const text = Buffer.from(frame).toString("utf8");
  if (!text.startsWith("{")) throw new Error("expected the Host encoder's JSON object frame");
  return Buffer.from(`{"unexpected":"1",${text.slice(1)}`, "utf8");
}

/**
 * The int32 boundary probe's mutation: one field of the Host's own frame
 * rewidened past the domain the native parses with `TryGetInt32`. The frame is
 * the encoder's, re-serialized after one value was replaced, so the probe
 * changes nothing but that value.
 */
function withReplacedInteger(frame: Uint8Array, key: string, value: number): Uint8Array {
  const parsed = JSON.parse(Buffer.from(frame).toString("utf8")) as Record<string, unknown>;
  if (!Object.hasOwn(parsed, key)) throw new Error(`the Host encoder's frame has no ${key}`);
  parsed[key] = value;
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

async function openNativeRecovery(): Promise<NativeRecoveryChild> {
  const native = new NativeRecoveryChild();
  try {
    await native.connect();
    return native;
  } catch (error) {
    await native.destroy();
    throw error;
  }
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    try { await access(path); return; } catch { await delay(25); }
  }
  throw new Error(`fixture readiness file never appeared: ${path}`);
}

async function removeRoot(root: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try { await rm(root, { recursive: true, force: true }); return; } catch { await delay(50); }
  }
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
