import { createConnection, type Socket } from "node:net";
import { win32 } from "node:path";

import type {
  DesktopGuardianRecovery,
  DesktopGuardianRecoveryTransport,
  DesktopGuardianSession,
  GuardianAck,
  GuardianRecoveryAck,
  GuardianRecoveryClassification,
  GuardianRecoveryRole,
} from "../../containment/auth/desktop-guardian-session.internal.js";
import { createDesktopProductComposition, type DesktopHostAssemblyInput, type DesktopPrivateHostComposition, type DesktopRootLayoutCapability } from "../../composition/desktop-host-composition.js";
import { ContainmentRoleAlreadyContainedError } from "../../containment/runtime/contract/game-runtime.js";
import { loadHostDeploymentManifest } from "../../deployment-manifest.js";
import { parseStrictJson } from "../../strict-json-reader.js";
import { connectHealthyVoiceGateway } from "../../voice-bootstrap.js";
import type { VoiceSurfaceReader } from "../../tavern/reference-pipeline-state.js";
import {
  createPublishedWindowsReparseInspector,
  inspectWindowsPathIdentityChain,
  inspectWindowsPathSecurity,
  type WindowsPathObjectIdentity,
  type WindowsPathSecurity,
} from "../../windows-reparse-inspector/index.js";

const MAX_WIRE_BYTES = 32_768;

/**
 * The parent's cooperative request for this composition to close cleanly.
 *
 * The gate launcher spawns this bootstrap with an IPC channel and already
 * publishes readiness over it (`gamebuddy-desktop-composition-ready/v1`). This is
 * the symmetric inbound half: a request, not a capability. It grants the sender
 * nothing it did not already have - the parent can terminate this process at any
 * moment with TerminateProcess - it merely lets the process run its own
 * `composition.close()` instead of being killed mid-flight, so the durable chat
 * runtime teardown commits.
 *
 * Required because `child.kill("SIGTERM")` on Windows is TerminateProcess: the
 * signal handlers below never run, and the teardown never happens. Measured, not
 * assumed (probe: exit reported `signal SIGTERM` with the handler never invoked).
 */
const SHUTDOWN_REQUEST_SCHEMA = "gamebuddy-desktop-shutdown-request/v1";
const MAX_GUARDIAN_WIRE_BYTES = 16_384;
const MAX_PRIVATE_FRAME_BYTES = 65_536;
const MAX_GUARDIAN_DEADLINE_HORIZON_MS = 300_000;
const guardianSessionSchema = "gamebuddy-desktop-guardian-session/v1";
const bootstrapSchema = "gamebuddy-desktop-host-bootstrap/v1";
const statusSchema = "gamebuddy-desktop-host-bootstrap-status/v1";
const rootLayoutSchema = "gamebuddy-windows-root-layout/v1";
// One stage or waiting token: a bounded lowercase identifier. The launcher only has
// to tell this frame from the acknowledgement and read the two tokens, so nothing
// else may cross this channel - a path, a message or a count would all be new wire
// surface for no fact the operator needs.
const statusToken = /^[a-z][a-z0-9-]{0,63}$/;
const sha256 = /^[a-f0-9]{64}$/;
const generation = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
// The native recovery ingress parses the recovery actor and the binding
// revision as exact GUIDs, so a recovery actor that is not one can never be
// acknowledged as a recovery of this attempt.
const opaqueGuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// One bounded wait budget for arm/contain/recovery. A launch deadline is
// deliberately not reusable as a generic operation horizon.
const MAX_GUARDIAN_OPERATION_WAIT_BUDGET_MS = 300_000;
// The recovery wire answers four acknowledgements with one identical key set, and
// a recovery ack identifies the recovery actor instead of a containment role.
const recoveryAcknowledgementKeys = ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "guardianInstanceId", "guardianEpoch", "attemptId", "recoveryInstanceId"] as const;
// The durable role CAS reports "this record already holds this role as contained"
// with its own typed refusal instead of re-transitioning. Only that refusal is
// tolerated by the recovery conversation, and it is matched by the identity the
// platform contract exports rather than by the engine's message text: the engine
// belongs to a game composition while this wire is deliberately generic (the
// focused source-shape test refuses any occurrence of the game's name in this
// file), and a message literal only that engine can rename would silently turn
// the one refusal a resumed recovery tolerates back into a closed session.

type DesktopRootLayout = Readonly<{
  programRoot: string;
  dataRoot: string;
  operationalRoot: string;
  presentationRoot: string;
}>;

type DesktopHostBootstrapFrame = Readonly<{
  bootstrapId: string;
  generation: string;
  inventoryDigest: string;
  runtimeAdmissionSha256: string;
  rootLayout: DesktopRootLayout;
}>;

type DesktopGuardianSessionBinding = Omit<DesktopHostBootstrapFrame, "rootLayout">;

declare const desktopGuardianSessionCapabilityBrand: unique symbol;
type DesktopGuardianSessionCapability = object & { readonly [desktopGuardianSessionCapabilityBrand]: true };

const desktopRootLayoutCapabilities = new WeakSet<object>();
const desktopRootLayouts = new WeakMap<object, DesktopRootLayout>();
const desktopGuardianSessionCapabilities = new WeakSet<object>();
const desktopGuardianSessionBindings = new WeakMap<object, DesktopGuardianSessionBinding>();

/** One-shot private bootstrap sequence invoked only by the fixed host entry. */
export async function runDesktopHostBootstrap(artifactRoot: string): Promise<void> {
  if (process.platform !== "win32") throw unavailable();

  // Every status frame below precedes the acknowledgement and describes the step the
  // child is entering, so the launcher's silence watch can be re-armed by real facts
  // instead of by one timer guessing at the whole startup. They are informational: a
  // status frame that cannot be written never fails the bootstrap.
  await writeStatus("bootstrap-frame");
  const frame = parseBootstrapFrame(await readBootstrapFrame());
  await writeStatus("root-layout");
  const rootLayout = await validateRootLayout(frame.rootLayout, artifactRoot);
  await writeStatus("voice-surface");
  const voice = await connectOptionalVoiceSurface();
  await writeStatus("deployment-manifest");
  const assemblyInput = await loadDesktopHostAssemblyInput(
    publishCompositionReady,
    voice?.reader,
    voice?.speechSink,
    voice?.listOutputDevices,
  );
  const rootAuthority = mintDesktopRootLayoutCapability(rootLayout);
  const guardianAuthority = mintDesktopGuardianSessionCapability(frame);
  const composition = await createDesktopProductCompositionForBootstrap(rootAuthority, guardianAuthority, assemblyInput);
  try {
    const termination = waitForTermination();
    try {
      await writeAcknowledgement(frame);
      process.stdin.destroy();
      await termination.promise;
    } finally {
      termination.dispose();
    }
  } finally {
    await composition.close();
    await voice?.close();
  }
}

async function readBootstrapFrame(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > MAX_WIRE_BYTES) throw unavailable();
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function parseBootstrapFrame(bytes: Buffer): DesktopHostBootstrapFrame {
  const value = parseOneWireDocument(bytes);
  if (!isRecord(value) || !exactKeys(value, ["schema", "protocolVersion", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "rootLayout"])) throw unavailable();
  if (
    value.schema !== bootstrapSchema ||
    value.protocolVersion !== 1 ||
    !validHex(value.bootstrapId) ||
    !validGeneration(value.generation) ||
    !validHex(value.inventoryDigest) ||
    !validHex(value.runtimeAdmissionSha256)
  ) throw unavailable();
  const rootLayout = parseRootLayout(value.rootLayout);
  return Object.freeze({
    bootstrapId: value.bootstrapId,
    generation: value.generation,
    inventoryDigest: value.inventoryDigest,
    runtimeAdmissionSha256: value.runtimeAdmissionSha256,
    rootLayout,
  });
}

function parseOneWireDocument(bytes: Buffer): unknown {
  if (bytes.length === 0 || bytes.length > MAX_WIRE_BYTES || bytes.includes(0) || bytes.includes(13)) throw unavailable();
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw unavailable();
  if (bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10)) throw unavailable();
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, -1));
  } catch {
    throw unavailable();
  }
  if (source.length === 0 || source.charCodeAt(0) === 0xfeff || source.includes("\r") || source.includes("\n") || source.includes("\u0000")) throw unavailable();
  try {
    return parseStrictJson(source);
  } catch {
    throw unavailable();
  }
}

function parseRootLayout(value: unknown): DesktopRootLayout {
  if (!isRecord(value) || !exactKeys(value, ["schema", "programRoot", "dataRoot", "operationalRoot", "presentationRoot"])) throw unavailable();
  if (value.schema !== rootLayoutSchema || !validPath(value.programRoot) || !validPath(value.dataRoot) || !validPath(value.operationalRoot) || !validPath(value.presentationRoot)) throw unavailable();
  return Object.freeze({
    programRoot: value.programRoot,
    dataRoot: value.dataRoot,
    operationalRoot: value.operationalRoot,
    presentationRoot: value.presentationRoot,
  });
}

async function validateRootLayout(layout: DesktopRootLayout, artifactRoot: string): Promise<DesktopRootLayout> {
  const localAppData = process.env.LOCALAPPDATA;
  if (!validPath(localAppData)) throw unavailable();
  const expected = Object.freeze({
    programRoot: win32.join(localAppData, "Programs", "GameBuddy"),
    dataRoot: win32.join(localAppData, "GameBuddy", "data"),
    operationalRoot: win32.join(localAppData, "GameBuddy", "operational"),
    presentationRoot: win32.join(localAppData, "GameBuddy", "presentation"),
  });
  if (
    layout.programRoot !== expected.programRoot ||
    layout.dataRoot !== expected.dataRoot ||
    layout.operationalRoot !== expected.operationalRoot ||
    layout.presentationRoot !== expected.presentationRoot
  ) throw unavailable();

  if (!strictlyContains(layout.programRoot, artifactRoot)) throw unavailable();
  const inspector = await createPublishedWindowsReparseInspector(artifactRoot);
  const roots = [layout.programRoot, layout.dataRoot, layout.operationalRoot, layout.presentationRoot] as const;
  const [chains, securities] = await Promise.all([
    Promise.all(roots.map((root) => inspectWindowsPathIdentityChain(inspector, root))),
    Promise.all(roots.map((root) => inspectWindowsPathSecurity(inspector, root))),
  ]);
  const volume = chains[0]?.at(-1)?.volumeIdentity;
  if (
    volume === undefined ||
    chains.some((chain, index) => !validDirectoryChain(chain, expectedChainLength(roots[index]!)) || chain.at(-1)?.volumeIdentity !== volume) ||
    securities.some((security, index) => !validRootSecurity(security, chains[index]!.at(-1), volume))
  ) throw unavailable();
  for (const mutableRoot of [layout.dataRoot, layout.operationalRoot, layout.presentationRoot]) {
    if (strictlyContains(artifactRoot, mutableRoot) || mutableRoot === artifactRoot) throw unavailable();
  }
  for (let index = 0; index < roots.length; index += 1) {
    for (let other = index + 1; other < roots.length; other += 1) {
      if (overlaps(roots[index]!, roots[other]!)) throw unavailable();
    }
  }
  if (overlaps(layout.programRoot, layout.dataRoot) || overlaps(layout.programRoot, layout.operationalRoot) || overlaps(layout.programRoot, layout.presentationRoot)) throw unavailable();
  return layout;
}

function validDirectoryChain(chain: readonly WindowsPathObjectIdentity[], expectedLength: number): boolean {
  return chain.length === expectedLength && chain.every((identity) => identity.objectKind === "directory" && !identity.isReparsePoint);
}

function validRootSecurity(security: WindowsPathSecurity, chainLeaf: WindowsPathObjectIdentity | undefined, expectedVolume: string): boolean {
  return security.currentUserOwner && security.objectKind === "directory" && !security.isReparsePoint && security.volumeIdentity === expectedVolume && security.volumeIdentity === chainLeaf?.volumeIdentity && security.fileId === chainLeaf?.fileId;
}

function strictlyContains(root: string, candidate: string): boolean {
  const remainder = win32.relative(root, candidate);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith("..\\");
}

function expectedChainLength(path: string): number {
  return path.slice(3).split("\\").length + 1;
}

function overlaps(first: string, second: string): boolean {
  const relativeFirst = win32.relative(first, second);
  const relativeSecond = win32.relative(second, first);
  return relativeFirst === "" || relativeSecond === "" || (!relativeFirst.startsWith("..\\") && relativeFirst !== "..") || (!relativeSecond.startsWith("..\\") && relativeSecond !== "..");
}

function mintDesktopRootLayoutCapability(layout: DesktopRootLayout): DesktopRootLayoutCapability {
  const capability = Object.freeze({}) as DesktopRootLayoutCapability;
  desktopRootLayoutCapabilities.add(capability);
  desktopRootLayouts.set(capability, layout);
  return capability;
}

function consumeDesktopRootLayoutCapability(capability: DesktopRootLayoutCapability): DesktopRootLayoutCapability {
  if (!desktopRootLayoutCapabilities.delete(capability)) throw unavailable();
  if (desktopRootLayouts.get(capability) === undefined) throw unavailable();
  desktopRootLayouts.delete(capability);
  return capability;
}

function mintDesktopGuardianSessionCapability(frame: DesktopHostBootstrapFrame): DesktopGuardianSessionCapability {
  const capability = Object.freeze({}) as DesktopGuardianSessionCapability;
  desktopGuardianSessionCapabilities.add(capability);
  desktopGuardianSessionBindings.set(capability, Object.freeze({
    bootstrapId: frame.bootstrapId,
    generation: frame.generation,
    inventoryDigest: frame.inventoryDigest,
    runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
  }));
  return capability;
}

function consumeDesktopGuardianSessionCapability(capability: DesktopGuardianSessionCapability): DesktopGuardianSessionBinding {
  if (!desktopGuardianSessionCapabilities.delete(capability)) throw unavailable();
  const binding = desktopGuardianSessionBindings.get(capability);
  desktopGuardianSessionBindings.delete(capability);
  if (binding === undefined) throw unavailable();
  return binding;
}

async function createDesktopProductCompositionForBootstrap(
  rootAuthority: DesktopRootLayoutCapability,
  guardianAuthority: DesktopGuardianSessionCapability,
  assemblyInput: DesktopHostAssemblyInput,
): Promise<DesktopPrivateHostComposition> {
  const consumedRootAuthority = consumeDesktopRootLayoutCapability(rootAuthority);
  await writeStatus("guardian-session");
  const session = await createAuthenticatedDesktopGuardianSession(consumeDesktopGuardianSessionCapability(guardianAuthority));
  try {
    // The composition is a static binding so the release artifact retains the
    // whole entry closure at build time; its construction failure still closes
    // the authenticated session below.
    //
    // This is the child's longest silent stretch by construction: one call opens the
    // durable stores, provisions the semantic authority, mounts the Chat lane, builds
    // the game owner and starts the presentation admission. The launcher's silence
    // budget is therefore measured from here, which is the fact this stage exists to
    // state.
    await writeStatus("provisioning");
    return await createDesktopProductComposition(consumedRootAuthority, session, assemblyInput);
  } catch (error) {
    try {
      await session.close();
    } catch {
      // Preserve the composition construction failure after closing the authenticated session.
    }
    throw error;
  }
}

async function loadDesktopHostAssemblyInput(
  publishLaunchUrl: (launchUrl: string) => void,
  voiceSurface?: VoiceSurfaceReader,
  speechSink?: import("../../voice.js").ChatVoiceSpeechPublisher,
  listVoiceOutputDevices?: () => Promise<readonly Readonly<{ id: string; name: string }>[]>,
): Promise<DesktopHostAssemblyInput> {
  const manifestPath = process.env.GAMEBUDDY_HOST_DEPLOYMENT_MANIFEST;
  const gameSessionMode = process.env.GAMEBUDDY_HOST_GAME_SESSION_MODE;
  const surface = process.env.GAMEBUDDY_HOST_SURFACE;
  const tavernNarrativeGateNonceSha256 = process.env.GAMEBUDDY_TAVERN_NARRATIVE_GATE_NONCE_SHA256;
  if (
    manifestPath === undefined ||
    manifestPath.length === 0 ||
    (gameSessionMode !== "fresh" && gameSessionMode !== "known") ||
    (surface !== undefined && surface !== "composed-reference-game" && surface !== "chat-only" && surface !== "management") ||
    (tavernNarrativeGateNonceSha256 !== undefined && !/^[a-f0-9]{64}$/.test(tavernNarrativeGateNonceSha256))
  ) throw unavailable();
  let manifest;
  try {
    manifest = await loadHostDeploymentManifest(manifestPath);
  } catch {
    throw unavailable();
  }
  return Object.freeze({
    manifest,
    gameSessionMode,
    ...(surface === undefined ? {} : { surface }),
    ...(tavernNarrativeGateNonceSha256 === undefined ? {} : { tavernNarrativeGateNonceSha256 }),
    ...(voiceSurface === undefined ? {} : { voiceSurface }),
    ...(speechSink === undefined ? {} : { speechSink }),
    ...(listVoiceOutputDevices === undefined ? {} : { listVoiceOutputDevices }),
    publishLaunchUrl,
  });
}

/**
 * Optional Voice surface: when the operator configured a local Voice Gateway
 * (the same env the Voice Gateway executable itself reads, so host and gateway
 * share one token source), connect a healthy client and expose its surface
 * reader. Voice is an optional capability: any connection/health failure falls
 * back to no reader (browser shows no mic icon) and never blocks the Desktop
 * composition.
 */
async function connectOptionalVoiceSurface(): Promise<
  Readonly<{
    reader: VoiceSurfaceReader;
    /** Host-owned streaming speech sink for the Chat presentation; absent when no voice client. */
    speechSink?: import("../../voice.js").ChatVoiceSpeechPublisher;
    /** Read-only output endpoint enumeration for the settings surface. */
    listOutputDevices?: () => Promise<readonly Readonly<{ id: string; name: string }>[]>;
    close(): Promise<void>;
  }>
  | undefined
> {
  const port = process.env.GAMEBUDDY_VOICE_PORT;
  const token = process.env.GAMEBUDDY_VOICE_TOKEN;
  if (port === undefined || token === undefined || !/^\d+$/.test(port) || !/^[A-Za-z0-9_-]{16,256}$/.test(token))
    return undefined;
  const gatewayPort = Number(port);
  if (!Number.isInteger(gatewayPort) || gatewayPort < 1 || gatewayPort > 65_535) return undefined;
  try {
    const client = await connectHealthyVoiceGateway({
      port: gatewayPort,
      token: token.trim(),
    });
    if (client === undefined) return undefined;
    return Object.freeze({
      reader: client.createVoiceSurfaceReader(),
      speechSink: client.createChatVoiceStreamingSink(),
      listOutputDevices: () => client.listOutputDevices(),
      close: async () => {
        client.close();
      },
    });
  } catch {
    return undefined;
  }
}

/**
 * Host-owned one-shot publication of the composed surface launch URL. The
 * desktop launcher consumes it over the child IPC channel; production Desktop
 * spawns without an IPC channel, so the publication is a no-op there and the
 * composition stays the sole owner of the launch URL. Gate evidence failure
 * never changes the already-running product composition.
 */
function publishCompositionReady(launchUrl: string): void {
  if (typeof process.send !== "function" || process.connected !== true) return;
  try {
    process.send(
      Object.freeze({
        schema: "gamebuddy-desktop-composition-ready/v1",
        protocolVersion: 1,
        launchUrl,
      }),
    );
  } catch {
    // Gate evidence publication is best-effort; the composition is already running.
  }
}

async function createAuthenticatedDesktopGuardianSession(binding: DesktopGuardianSessionBinding): Promise<DesktopGuardianSession> {
  const socket = await connectGuardianPipe(`\\\\.\\pipe\\GameBuddy.HostGuardian.${binding.bootstrapId}`);
  const session = new GuardianSessionClient(socket, binding);
  try {
    await session.hello();
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

type GuardianRole = "player_host" | "ai_client";
type GuardianCommandOperation = "arm_attempt" | "launch_role" | "contain_role";
type GuardianRecoveryOperation = "recover_attempt" | "recovery_post_cas" | "recovery_role_cas_ack" | "recovery_finalize_ack" | "release";
type GuardianInput = Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs?: number; operationWaitBudgetMs?: number; role?: GuardianRole; privateFrame?: Uint8Array }>;
type PendingResponse = { resolve(value: Record<string, unknown>): void; reject(reason: Error): void; timer?: ReturnType<typeof setTimeout> };

class GuardianSessionClient implements DesktopGuardianSession {
  #closed = false;
  #buffer = Buffer.alloc(0);
  #waiter: PendingResponse | undefined;
  #serial: Promise<void> = Promise.resolve();

  constructor(private readonly socket: Socket, private readonly binding: DesktopGuardianSessionBinding) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.once("end", () => this.fail());
    socket.once("close", () => this.fail());
    socket.once("error", () => this.fail());
  }

  async arm(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; privateFrame: Uint8Array }>): Promise<GuardianAck> { return await this.command("arm_attempt", input); }
  async launch(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: GuardianRole; privateFrame: Uint8Array }>): Promise<GuardianAck> { return await this.command("launch_role", input); }
  async contain(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; operationWaitBudgetMs: number; role: GuardianRole }>): Promise<GuardianAck> { return await this.command("contain_role", input); }
  /**
   * Recovery is a conversation rather than one command: the broker answers two
   * written frames with a single acknowledgement and answers a role
   * classification only after the durable step it belongs to has run, so it
   * needs the multi-acknowledgement read path below instead of the single
   * request/acknowledgement helper the three commands use.
   */
  async recover(input: DesktopGuardianRecovery): Promise<GuardianRecoveryAck> {
    return await this.serialize(async () => {
      try {
        if (this.#closed) throw unavailable();
        return await driveGuardianRecoveryConversation({
          write: (frame) => { this.writeFrame(frame); },
          receive: () => this.awaitAcknowledgement(input.operationWaitBudgetMs),
        }, this.binding, input);
      } catch (error) { this.fail(); throw error; }
    });
  }
  async close(): Promise<void> { this.fail(); }

  async hello(): Promise<void> {
    const acknowledgement = await this.request({ schema: guardianSessionSchema, protocolVersion: 1, operation: "hello", ...this.binding });
    if (!validHelloAcknowledgement(acknowledgement, this.binding)) throw unavailable();
  }

  private async command(operation: GuardianCommandOperation, input: GuardianInput): Promise<GuardianAck> {
    return await this.serialize(async () => {
      try {
        if (this.#closed || !validGuardianInput(operation, input)) throw unavailable();
        const acknowledgement = await this.request(guardianCommandFrame(operation, this.binding, input), operation === "launch_role" ? input.deadlineUnixMs! - Date.now() : input.operationWaitBudgetMs!);
        if (!validCommandAcknowledgement(acknowledgement, operation, input, this.binding)) throw unavailable();
        return acknowledgement;
      } catch (error) { this.fail(); throw error; }
    });
  }

  /** Operations run one at a time; a refusal must never interleave with a live conversation. */
  private serialize<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#serial.then(task, task);
    this.#serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private request(message: Record<string, unknown>, waitBudgetMs?: number): Promise<Record<string, unknown>> {
    if (this.#closed || this.#waiter !== undefined || (waitBudgetMs !== undefined && !validWaitBudget(waitBudgetMs))) return Promise.reject(unavailable());
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (bytes.length > MAX_GUARDIAN_WIRE_BYTES) return Promise.reject(unavailable());
    return this.awaitWaiter(bytes, waitBudgetMs);
  }

  /**
   * Installs the next acknowledgement waiter without writing anything. The
   * waiter must exist before the frames it answers are written: `receive` fails
   * the session closed on an acknowledgement that arrives with no waiter, and the
   * recovery conversation answers two written frames with one acknowledgement.
   */
  private awaitAcknowledgement(waitBudgetMs: number): Promise<Record<string, unknown>> {
    if (this.#closed || this.#waiter !== undefined || !validWaitBudget(waitBudgetMs)) return Promise.reject(unavailable());
    return this.awaitWaiter(undefined, waitBudgetMs);
  }

  /** Writes one already-ordered frame the broker does not answer on its own. */
  private writeFrame(frame: Readonly<Record<string, unknown>>): void {
    if (this.#closed) return;
    const bytes = Buffer.from(`${JSON.stringify(frame)}\n`, "utf8");
    if (bytes.length > MAX_GUARDIAN_WIRE_BYTES) return this.fail();
    this.socket.write(bytes, (error) => { if (error != null) this.fail(); });
  }

  /** Installs the waiter first and writes the pending frame second, so a reply can never arrive unowned. */
  private awaitWaiter(bytes: Buffer | undefined, waitBudgetMs: number | undefined): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const waiter: PendingResponse = { resolve, reject };
      if (waitBudgetMs !== undefined) waiter.timer = setTimeout(() => this.fail(), waitBudgetMs);
      this.#waiter = waiter;
      if (bytes === undefined) return;
      this.socket.write(bytes, (error) => { if (error != null) this.fail(); });
    });
  }

  private receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    if (this.#buffer.length > MAX_GUARDIAN_WIRE_BYTES) return this.fail();
    const newline = this.#buffer.indexOf(10);
    if (newline < 0) return;
    const line = this.#buffer.subarray(0, newline + 1);
    if (newline !== this.#buffer.length - 1 || line.includes(0) || line.includes(13) || line[0] === 0xef || this.#waiter === undefined) return this.fail();
    this.#buffer = Buffer.alloc(0);
    try {
      const value = parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(line.subarray(0, -1)));
      if (!isRecord(value)) return this.fail();
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer !== undefined) clearTimeout(waiter.timer);
      waiter.resolve(value);
    } catch { this.fail(); }
  }

  private fail(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.destroy();
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter?.timer !== undefined) clearTimeout(waiter.timer);
    waiter?.reject(unavailable());
  }
}

function connectGuardianPipe(path: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const rejectConnection = (): void => { socket.destroy(); reject(unavailable()); };
    socket.once("connect", () => { socket.off("error", rejectConnection); resolve(socket); });
    socket.once("error", rejectConnection);
  });
}

function validHelloAcknowledgement(value: Record<string, unknown>, binding: DesktopGuardianSessionBinding): boolean {
  return exactKeys(value, ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256"]) && value.schema === guardianSessionSchema && value.protocolVersion === 1 && value.operation === "hello" && value.status === "accepted" && matchesBinding(value, binding);
}

function validGuardianInput(operation: GuardianCommandOperation, input: GuardianInput): boolean {
  if (!validOpaque(input.guardianInstanceId) || !Number.isSafeInteger(input.guardianEpoch) || input.guardianEpoch < 1 || !validOpaque(input.attemptId)) return false;
  if (operation === "launch_role") {
    if (Object.hasOwn(input, "operationWaitBudgetMs")) return false;
    const deadlineUnixMs = input.deadlineUnixMs;
    if (typeof deadlineUnixMs !== "number" || !Number.isSafeInteger(deadlineUnixMs) || deadlineUnixMs <= Date.now() || deadlineUnixMs - Date.now() > MAX_GUARDIAN_DEADLINE_HORIZON_MS) return false;
  } else {
    if (Object.hasOwn(input, "deadlineUnixMs")) return false;
    const operationWaitBudgetMs = input.operationWaitBudgetMs;
    if (typeof operationWaitBudgetMs !== "number" || !Number.isSafeInteger(operationWaitBudgetMs) || operationWaitBudgetMs < 1 || operationWaitBudgetMs > MAX_GUARDIAN_OPERATION_WAIT_BUDGET_MS) return false;
  }
  return operation === "contain_role" ? validRole(input.role) && input.privateFrame === undefined : (operation === "arm_attempt" || validRole(input.role)) && input.privateFrame instanceof Uint8Array && input.privateFrame.byteLength <= MAX_PRIVATE_FRAME_BYTES;
}

function validCommandAcknowledgement(value: Record<string, unknown>, operation: GuardianCommandOperation, input: GuardianInput, binding: DesktopGuardianSessionBinding): value is GuardianAck {
  const role = operation === "arm_attempt" ? undefined : input.role;
  const expected = role === undefined ? ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "guardianInstanceId", "guardianEpoch", "attemptId"] : ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "guardianInstanceId", "guardianEpoch", "attemptId", "role"];
  const status = operation === "arm_attempt" ? "armed" : operation === "launch_role" ? "role_active" : "role_contained";
  return exactKeys(value, expected) && value.schema === guardianSessionSchema && value.protocolVersion === 1 && value.operation === operation && value.status === status && matchesBinding(value, binding) && value.guardianInstanceId === input.guardianInstanceId && value.guardianEpoch === input.guardianEpoch && value.attemptId === input.attemptId && value.role === role;
}

function matchesBinding(value: Record<string, unknown>, binding: DesktopGuardianSessionBinding): boolean { return value.bootstrapId === binding.bootstrapId && value.generation === binding.generation && value.inventoryDigest === binding.inventoryDigest && value.runtimeAdmissionSha256 === binding.runtimeAdmissionSha256; }
function validOpaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }
function validRole(value: unknown): value is GuardianRole { return value === "player_host" || value === "ai_client"; }
function validWaitBudget(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= 2_147_483_647; }

/**
 * Builds one guardian command frame in the exact ordinal key order
 * `DesktopHostBootstrapBroker.ExactObject` validates it by. The Desktop compares
 * the key sequence, not only the key set, so the bounded wait (or the launch
 * deadline) precedes the Guardian correlation and the role precedes the private
 * frame; a differently ordered frame is refused outright and closes the session.
 */
function guardianCommandFrame(operation: GuardianCommandOperation, binding: DesktopGuardianSessionBinding, input: GuardianInput): Record<string, unknown> {
  return Object.freeze({
    schema: guardianSessionSchema,
    protocolVersion: 1,
    operation,
    bootstrapId: binding.bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
    ...(operation === "launch_role" ? { deadlineUnixMs: input.deadlineUnixMs! } : { operationWaitBudgetMs: input.operationWaitBudgetMs! }),
    guardianInstanceId: input.guardianInstanceId,
    guardianEpoch: input.guardianEpoch,
    attemptId: input.attemptId,
    ...(operation === "arm_attempt" ? {} : { role: input.role as GuardianRole }),
    ...(input.privateFrame === undefined ? {} : { privateFrame: Buffer.from(input.privateFrame).toString("base64url") }),
  });
}

/** Builds one recovery frame in the same exact ordinal key order. */
function guardianRecoveryFrame(operation: GuardianRecoveryOperation, binding: DesktopGuardianSessionBinding, input: DesktopGuardianRecovery, extra: Readonly<{ privateFrame?: Uint8Array; role?: GuardianRecoveryRole }> = {}): Record<string, unknown> {
  return Object.freeze({
    schema: guardianSessionSchema,
    protocolVersion: 1,
    operation,
    bootstrapId: binding.bootstrapId,
    generation: binding.generation,
    inventoryDigest: binding.inventoryDigest,
    runtimeAdmissionSha256: binding.runtimeAdmissionSha256,
    operationWaitBudgetMs: input.operationWaitBudgetMs,
    guardianInstanceId: input.guardianInstanceId,
    guardianEpoch: input.guardianEpoch,
    attemptId: input.attemptId,
    recoveryInstanceId: input.recoveryInstanceId,
    ...(extra.privateFrame === undefined ? {} : { privateFrame: Buffer.from(extra.privateFrame).toString("base64url") }),
    ...(extra.role === undefined ? {} : { role: extra.role }),
  });
}

function validRecoveryInput(input: DesktopGuardianRecovery): boolean {
  if (!validOpaque(input.guardianInstanceId) || !Number.isSafeInteger(input.guardianEpoch) || input.guardianEpoch < 1 || !validOpaque(input.attemptId)) return false;
  if (typeof input.recoveryInstanceId !== "string" || !opaqueGuid.test(input.recoveryInstanceId)) return false;
  if (!validWaitBudget(input.operationWaitBudgetMs) || input.operationWaitBudgetMs > MAX_GUARDIAN_OPERATION_WAIT_BUDGET_MS) return false;
  if (!(input.preCasFrame instanceof Uint8Array) || input.preCasFrame.byteLength === 0 || input.preCasFrame.byteLength > MAX_PRIVATE_FRAME_BYTES) return false;
  return typeof input.beginRecovery === "function" && typeof input.roleContained === "function";
}

/**
 * The recovery wire answers four acknowledgements with one identical key set, so
 * the accepted statuses are a function of the position the conversation reached
 * rather than of the frame: the broker reports `unavailable` both for a gate it
 * refused to open and for a role it could not classify as contained.
 */
function recoveryAcknowledgementStatus(value: Record<string, unknown>, input: DesktopGuardianRecovery, binding: DesktopGuardianSessionBinding, expectedStatuses: readonly string[]): string | undefined {
  if (
    !exactKeys(value, recoveryAcknowledgementKeys) ||
    value.schema !== guardianSessionSchema ||
    value.protocolVersion !== 1 ||
    value.operation !== "recover_attempt" ||
    typeof value.status !== "string" ||
    !expectedStatuses.includes(value.status) ||
    !matchesBinding(value, binding) ||
    value.guardianInstanceId !== input.guardianInstanceId ||
    value.guardianEpoch !== input.guardianEpoch ||
    value.attemptId !== input.attemptId ||
    value.recoveryInstanceId !== input.recoveryInstanceId
  ) return undefined;
  return value.status;
}

function isRecoveryClassification(value: string): value is GuardianRecoveryClassification {
  return value === "unavailable" || value === "quarantined";
}

function roleClassified(role: GuardianRecoveryRole, classification: string | undefined): GuardianRecoveryAck {
  if (classification === undefined || !isRecoveryClassification(classification)) throw unavailable();
  return Object.freeze({ outcome: "role_classified", role, classification });
}

/**
 * Runs one durable role CAS, tolerating the one rejection a resumed recovery
 * legitimately meets.
 *
 * A recovery that crashed between a role's durable CAS and that role's CAS
 * acknowledgement comes back with the native side classifying the role
 * contained again while the durable record already says so too. The durable
 * engine reports exactly that case with its shared typed refusal instead of
 * re-transitioning, and the record agreeing with the native classification is
 * not a failure, so the conversation continues at the same acknowledgement
 * position.
 *
 * Nothing is retried to make that work and no frame is written twice: the
 * resume repeats no native step. Every other rejection is a live CAS failure
 * that must still close the session, because a role the durable record did not
 * accept is not a containment.
 */
async function recordRecoveredRole(input: DesktopGuardianRecovery, role: GuardianRecoveryRole): Promise<void> {
  try {
    await input.roleContained(role);
  } catch (error) {
    if (!(error instanceof ContainmentRoleAlreadyContainedError)) throw error;
  }
}

/**
 * Drives the complete bounded recovery conversation the Desktop broker serves.
 *
 * The broker answers two written frames with one acknowledgement (the post-CAS
 * binding and the native recover attempt both precede the first role
 * classification) and it only writes a role classification once the durable step
 * it belongs to has run, so the waiter for each acknowledgement is installed
 * before the frames it answers are written. A conversation that does not reach
 * its exact terminal acknowledgement fails closed: an uncertain native recovery
 * is never reported as containment. The one durable rejection it does accept is
 * a role the record already holds as contained, which is what a resumed recovery
 * meets and not an uncertainty.
 *
 * Exported for the focused protocol test; the frame order above only exists here.
 */
export async function driveGuardianRecoveryConversation(transport: DesktopGuardianRecoveryTransport, binding: DesktopGuardianSessionBinding, input: DesktopGuardianRecovery): Promise<GuardianRecoveryAck> {
  if (!validRecoveryInput(input)) throw unavailable();
  // Gate. The broker injects the native recovery token into this one frame, and
  // it opens the gate only while it holds the exact recorded lease binding.
  const gate = transport.receive();
  transport.write(guardianRecoveryFrame("recover_attempt", binding, input, { privateFrame: input.preCasFrame }));
  const gateStatus = recoveryAcknowledgementStatus(await gate, input, binding, ["recovery_accepted", "unavailable"]);
  // `unavailable` at this position is the gate refusing to open: nothing
  // downstream ran, no durable CAS may run, and the previous lease stays
  // authority.
  if (gateStatus === undefined) throw unavailable();
  if (gateStatus === "unavailable") return Object.freeze({ outcome: "gate_held" as const });
  // The durable recovering CAS may only run while the gate is held, and the
  // post-CAS binding it produces is validated against that exact gate, so it
  // cannot be an input.
  const postCasFrame = await input.beginRecovery();
  if (!(postCasFrame instanceof Uint8Array) || postCasFrame.byteLength === 0 || postCasFrame.byteLength > MAX_PRIVATE_FRAME_BYTES) throw unavailable();
  // One acknowledgement answers these two frames: the post-CAS binding and the
  // native recover attempt the broker rebuilds from the correlation alone.
  const player = transport.receive();
  transport.write(guardianRecoveryFrame("recovery_post_cas", binding, input, { privateFrame: postCasFrame }));
  transport.write(guardianRecoveryFrame("recover_attempt", binding, input));
  const playerStatus = recoveryAcknowledgementStatus(await player, input, binding, ["player_contained", "unavailable", "quarantined"]);
  if (playerStatus === undefined) throw unavailable();
  if (playerStatus !== "player_contained") return roleClassified("playerHost", playerStatus);
  await recordRecoveredRole(input, "playerHost");
  const ai = transport.receive();
  transport.write(guardianRecoveryFrame("recovery_role_cas_ack", binding, input, { role: "playerHost" }));
  const aiStatus = recoveryAcknowledgementStatus(await ai, input, binding, ["ai_contained", "unavailable", "quarantined"]);
  if (aiStatus === undefined) throw unavailable();
  if (aiStatus !== "ai_contained") return roleClassified("aiClient", aiStatus);
  await recordRecoveredRole(input, "aiClient");
  const settled = transport.receive();
  transport.write(guardianRecoveryFrame("recovery_role_cas_ack", binding, input, { role: "aiClient" }));
  transport.write(guardianRecoveryFrame("recovery_finalize_ack", binding, input));
  // The release closes the native control pipe and the recovery gate, so it is
  // the last frame this conversation ever writes.
  transport.write(guardianRecoveryFrame("release", binding, input));
  const settledStatus = recoveryAcknowledgementStatus(await settled, input, binding, ["contained"]);
  if (settledStatus !== "contained") throw unavailable();
  return Object.freeze({ outcome: "contained" as const });
}

/**
 * Publishes one informational status frame on the SAME channel and the SAME framing as
 * the acknowledgement: one JSON object plus one newline, written before it.
 *
 * The acknowledgement keeps its exact meaning - ready for service - and stays the only
 * success signal. This frame exists because one binary signal plus a timer cannot
 * distinguish a child that is slow from one that is waiting for its player from one
 * that is wedged, and all three were being guessed at, wrongly, from the same silence.
 *
 * `waitingForPlayerInput` names the human decision the child is about to wait for,
 * which is the one fact that suspends the launcher's silence watch: a child waiting for
 * its player must never be killed for being quiet.
 */
async function writeStatus(stage: string, waitingForPlayerInput?: string): Promise<void> {
  if (!statusToken.test(stage) || (waitingForPlayerInput !== undefined && !statusToken.test(waitingForPlayerInput))) throw unavailable();
  const bytes = Buffer.from(`${JSON.stringify({
    schema: statusSchema,
    protocolVersion: 1,
    stage,
    ...(waitingForPlayerInput === undefined ? {} : { waitingForPlayerInput }),
  })}\n`, "utf8");
  if (bytes.length > MAX_WIRE_BYTES) throw unavailable();
  await new Promise<void>((resolveWrite) => {
    // Informational only. The write is awaited so the frame cannot be reordered behind
    // the work it announces, and a broken status channel is swallowed here: what must
    // fail closed is the acknowledgement's own write, not this one. The listener is
    // removed on both paths, so nothing is left attached to the stream.
    const onError = (): void => { process.stdout.off("error", onError); resolveWrite(); };
    process.stdout.once("error", onError);
    process.stdout.write(bytes, () => { process.stdout.off("error", onError); resolveWrite(); });
  });
}

async function writeAcknowledgement(frame: DesktopHostBootstrapFrame): Promise<void> {
  const acknowledgement = Buffer.from(`${JSON.stringify({
    schema: bootstrapSchema,
    protocolVersion: 1,
    status: "accepted",
    bootstrapId: frame.bootstrapId,
    generation: frame.generation,
    inventoryDigest: frame.inventoryDigest,
    runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
    rootLayoutSchema,
  })}\n`, "utf8");
  if (acknowledgement.length > MAX_WIRE_BYTES) throw unavailable();
  await new Promise<void>((resolveWrite, rejectWrite) => {
    process.stdout.once("error", rejectWrite);
    process.stdout.end(acknowledgement, () => {
      process.stdout.off("error", rejectWrite);
      resolveWrite();
    });
  });
}

function waitForTermination(): Readonly<{
  promise: Promise<void>;
  dispose: () => void;
}> {
  let dispose: () => void = () => {};
  const promise = new Promise<void>((resolveTermination) => {
    const livenessHandle = setInterval(() => {}, 2_147_483_647);
    let settled = false;
    const cleanup = () => {
      clearInterval(livenessHandle);
      process.off("SIGTERM", onTerminate);
      process.off("SIGINT", onTerminate);
      // Windows console control events (Ctrl+Break, and GenerateConsoleCtrlEvent
      // from a supervising native process) arrive as SIGBREAK, not SIGTERM. They
      // are the only signal path that actually reaches a handler here.
      process.off("SIGBREAK", onTerminate);
      process.off("message", onMessage);
    };
    const onTerminate = () => {
      // Idempotent: several sources can request termination, and `dispose` runs
      // unconditionally in the caller's finally.
      if (settled) return;
      settled = true;
      cleanup();
      resolveTermination();
    };
    // The IPC channel is the private parent-child pipe created at spawn; only the
    // parent holds the other end. The shape is validated strictly so a malformed or
    // unrelated message can never drop the composition.
    const onMessage = (value: unknown) => {
      if (isShutdownRequest(value)) onTerminate();
    };
    // Cleanup only - it does not itself terminate, so a caller that abandons the
    // wait (a failed acknowledgement, say) does not race the close path.
    dispose = cleanup;
    process.once("SIGTERM", onTerminate);
    process.once("SIGINT", onTerminate);
    process.once("SIGBREAK", onTerminate);
    process.on("message", onMessage);
  });
  return {
    promise,
    dispose,
  };
}

function isShutdownRequest(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false;
  const keys = Reflect.ownKeys(value);
  return (
    keys.length === 2 &&
    keys.every((key) => key === "schema" || key === "protocolVersion") &&
    (value as { schema?: unknown }).schema === SHUTDOWN_REQUEST_SCHEMA &&
    (value as { protocolVersion?: unknown }).protocolVersion === 1
  );
}

function validHex(value: unknown): value is string {
  return typeof value === "string" && sha256.test(value);
}

function validGeneration(value: unknown): value is string {
  return typeof value === "string" && generation.test(value);
}

function validPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 4 || value.length > 32 * 1024 || value.includes("/") || !/^[A-Za-z]:\\/.test(value) || win32.normalize(value) !== value) return false;
  const components = value.slice(3).split("\\");
  return components.length > 0 && components.every((component) => component.length > 0 && component !== "." && component !== ".." && !/[\\/:*?<>"|\u0000-\u001f]/.test(component) && !component.endsWith(".") && !component.endsWith(" "));
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function unavailable(): Error {
  return new Error("desktop_runtime_bootstrap_unavailable");
}
