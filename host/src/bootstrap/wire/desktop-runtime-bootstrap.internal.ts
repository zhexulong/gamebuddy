import { createConnection, type Socket } from "node:net";
import { win32 } from "node:path";

import type { DesktopGuardianSession, GuardianAck } from "../../containment/auth/desktop-guardian-session.internal.js";
import { createDesktopPrivateHostComposition } from "../../composition/desktop-host-composition.js";
import { parseStrictJson } from "../../strict-json-reader.js";
import {
  createPublishedWindowsReparseInspector,
  inspectWindowsPathIdentityChain,
  inspectWindowsPathSecurity,
  type WindowsPathObjectIdentity,
  type WindowsPathSecurity,
} from "../../windows-reparse-inspector/index.js";

const MAX_WIRE_BYTES = 32_768;
const MAX_GUARDIAN_WIRE_BYTES = 16_384;
const MAX_PRIVATE_FRAME_BYTES = 65_536;
const guardianSessionSchema = "gamebuddy-desktop-guardian-session/v1";
const bootstrapSchema = "gamebuddy-desktop-host-bootstrap/v1";
const rootLayoutSchema = "gamebuddy-windows-root-layout/v1";
const sha256 = /^[a-f0-9]{64}$/;
const generation = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;

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

declare const desktopRootLayoutCapabilityBrand: unique symbol;
type DesktopRootLayoutCapability = object & { readonly [desktopRootLayoutCapabilityBrand]: true };
declare const desktopGuardianSessionCapabilityBrand: unique symbol;
type DesktopGuardianSessionCapability = object & { readonly [desktopGuardianSessionCapabilityBrand]: true };

const desktopRootLayoutCapabilities = new WeakSet<object>();
const desktopRootLayouts = new WeakMap<object, DesktopRootLayout>();
const desktopGuardianSessionCapabilities = new WeakSet<object>();
const desktopGuardianSessionBindings = new WeakMap<object, DesktopGuardianSessionBinding>();

/** One-shot private bootstrap sequence invoked only by the fixed host entry. */
export async function runDesktopHostBootstrap(moduleDirectory: string): Promise<void> {
  if (process.platform !== "win32") throw unavailable();

  const frame = parseBootstrapFrame(await readBootstrapFrame());
  const rootLayout = await validateRootLayout(frame.rootLayout, moduleDirectory);
  const rootAuthority = mintDesktopRootLayoutCapability(rootLayout);
  const guardianAuthority = mintDesktopGuardianSessionCapability(frame);
  const composition = await createDesktopPrivateHostCompositionForBootstrap(rootAuthority, guardianAuthority);
  try {
    const termination = waitForTermination();
    await writeAcknowledgement(frame);
    process.stdin.destroy();
    await termination;
  } finally {
    await composition.close();
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

async function validateRootLayout(layout: DesktopRootLayout, moduleDirectory: string): Promise<DesktopRootLayout> {
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

  if (!strictlyContains(layout.programRoot, moduleDirectory)) throw unavailable();
  const inspector = await createPublishedWindowsReparseInspector(moduleDirectory);
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
    if (strictlyContains(moduleDirectory, mutableRoot) || mutableRoot === moduleDirectory) throw unavailable();
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

function consumeDesktopRootLayoutCapability(capability: DesktopRootLayoutCapability): DesktopRootLayout {
  if (!desktopRootLayoutCapabilities.delete(capability)) throw unavailable();
  const layout = desktopRootLayouts.get(capability);
  desktopRootLayouts.delete(capability);
  if (layout === undefined) throw unavailable();
  return layout;
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

async function createDesktopPrivateHostCompositionForBootstrap(rootAuthority: DesktopRootLayoutCapability, guardianAuthority: DesktopGuardianSessionCapability): Promise<ReturnType<typeof createDesktopPrivateHostComposition>> {
  consumeDesktopRootLayoutCapability(rootAuthority);
  const session = await createAuthenticatedDesktopGuardianSession(consumeDesktopGuardianSessionCapability(guardianAuthority));
  return createDesktopPrivateHostComposition(session);
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
type GuardianOperation = "arm_attempt" | "launch_role" | "contain_role";
type GuardianInput = Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role?: GuardianRole; privateFrame?: Uint8Array }>;
type PendingResponse = Readonly<{ resolve(value: Record<string, unknown>): void; reject(reason: Error): void }>;

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

  async arm(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; privateFrame: Uint8Array }>): Promise<GuardianAck> { return await this.command("arm_attempt", input); }
  async launch(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: GuardianRole; privateFrame: Uint8Array }>): Promise<GuardianAck> { return await this.command("launch_role", input); }
  async contain(input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role: GuardianRole }>): Promise<GuardianAck> { return await this.command("contain_role", input); }
  async close(): Promise<void> { this.fail(); }

  async hello(): Promise<void> {
    const acknowledgement = await this.request({ schema: guardianSessionSchema, protocolVersion: 1, operation: "hello", ...this.binding });
    if (!validHelloAcknowledgement(acknowledgement, this.binding)) throw unavailable();
  }

  private async command(operation: GuardianOperation, input: GuardianInput): Promise<GuardianAck> {
    const run = async (): Promise<GuardianAck> => {
      try {
        if (this.#closed || !validGuardianInput(operation, input)) throw unavailable();
        const request: Record<string, unknown> = { schema: guardianSessionSchema, protocolVersion: 1, operation, ...this.binding, ...input };
        if (input.privateFrame !== undefined) request.privateFrame = Buffer.from(input.privateFrame).toString("base64url");
        const acknowledgement = await this.request(request);
        if (!validCommandAcknowledgement(acknowledgement, operation, input, this.binding)) throw unavailable();
        return acknowledgement;
      } catch (error) { this.fail(); throw error; }
    };
    const result = this.#serial.then(run, run);
    this.#serial = result.then(() => undefined, () => undefined);
    return await result;
  }

  private request(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.#closed || this.#waiter !== undefined) return Promise.reject(unavailable());
    const bytes = Buffer.from(`${JSON.stringify(message)}\n`, "utf8");
    if (bytes.length > MAX_GUARDIAN_WIRE_BYTES) return Promise.reject(unavailable());
    return new Promise((resolve, reject) => {
      this.#waiter = { resolve, reject };
      this.socket.write(bytes, (error) => { if (error !== undefined) this.fail(); });
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
      waiter.resolve(value);
    } catch { this.fail(); }
  }

  private fail(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.socket.destroy();
    const waiter = this.#waiter;
    this.#waiter = undefined;
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

function validGuardianInput(operation: GuardianOperation, input: GuardianInput): boolean {
  if (!validOpaque(input.guardianInstanceId) || !Number.isSafeInteger(input.guardianEpoch) || input.guardianEpoch < 1 || !validOpaque(input.attemptId) || !Number.isSafeInteger(input.deadlineUnixMs) || input.deadlineUnixMs <= Date.now()) return false;
  return operation === "contain_role" ? validRole(input.role) && input.privateFrame === undefined : (operation === "arm_attempt" || validRole(input.role)) && input.privateFrame instanceof Uint8Array && input.privateFrame.byteLength <= MAX_PRIVATE_FRAME_BYTES;
}

function validCommandAcknowledgement(value: Record<string, unknown>, operation: GuardianOperation, input: GuardianInput, binding: DesktopGuardianSessionBinding): value is GuardianAck {
  const role = operation === "arm_attempt" ? undefined : input.role;
  const expected = role === undefined ? ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "guardianInstanceId", "guardianEpoch", "attemptId"] : ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "guardianInstanceId", "guardianEpoch", "attemptId", "role"];
  const status = operation === "arm_attempt" ? "armed" : operation === "launch_role" ? "role_active" : "role_contained";
  return exactKeys(value, expected) && value.schema === guardianSessionSchema && value.protocolVersion === 1 && value.operation === operation && value.status === status && matchesBinding(value, binding) && value.guardianInstanceId === input.guardianInstanceId && value.guardianEpoch === input.guardianEpoch && value.attemptId === input.attemptId && value.role === role;
}

function matchesBinding(value: Record<string, unknown>, binding: DesktopGuardianSessionBinding): boolean { return value.bootstrapId === binding.bootstrapId && value.generation === binding.generation && value.inventoryDigest === binding.inventoryDigest && value.runtimeAdmissionSha256 === binding.runtimeAdmissionSha256; }
function validOpaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && value.length <= 1024; }
function validRole(value: unknown): value is GuardianRole { return value === "player_host" || value === "ai_client"; }

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

function waitForTermination(): Promise<void> {
  return new Promise((resolveTermination) => {
    const livenessHandle = setInterval(() => {}, 2_147_483_647);
    const terminate = () => {
      clearInterval(livenessHandle);
      process.off("SIGTERM", terminate);
      process.off("SIGINT", terminate);
      resolveTermination();
    };
    process.once("SIGTERM", terminate);
    process.once("SIGINT", terminate);
  });
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
