import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { createConnection, type Socket } from "node:net";
import type { DesktopGuardianSession, GuardianAck } from "./desktop-guardian-session.internal.js";
import { dirname, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { parseStrictJson } from "./strict-json-reader.js";
import {
  createPublishedWindowsReparseInspector,
  inspectWindowsPathIdentityChain,
  inspectWindowsPathSecurity,
  type WindowsPathObjectIdentity,
  type WindowsPathSecurity,
} from "./windows-reparse-inspector/index.js";

const MAX_WIRE_BYTES = 32_768;
const GUARDIAN_SCHEMA = "gamebuddy-desktop-guardian-session/v1";
const GUARDIAN_MAX_FRAME_BYTES = 16_384;
const GUARDIAN_MAX_PRIVATE_BYTES = 65_536;
const GUARDIAN_MAX_DEADLINE_HORIZON_MS = 5 * 60_000;
const GUARDIAN_CORRELATION = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GUARDIAN_BASE64URL = /^[A-Za-z0-9_-]*$/;
const bootstrapSchema = "gamebuddy-desktop-host-bootstrap/v1";
const rootLayoutSchema = "gamebuddy-windows-root-layout/v1";
const runtimeAdmissionFileName = "host-runtime-admission.json";
const sha256 = /^[a-f0-9]{64}$/;
const generation = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const fixedRuntimePath = "runtime/node.exe";
const fixedBootstrapPath = "desktop-runtime-bootstrap.internal.js";
const fixedRuntimeVersion = "v24.20.0";
const fixedRuntimePlatform = "win32";
const fixedRuntimeArch = "x64";
const windowsReservedDeviceName = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const GUARDIAN_HELLO_TIMEOUT_MS = 30_000;

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

type RuntimeAdmission = Readonly<{
  generation: string;
  inventoryDigest: string;
}>;

declare const desktopRootLayoutCapabilityBrand: unique symbol;
type DesktopRootLayoutCapability = object & { readonly [desktopRootLayoutCapabilityBrand]: true };

const desktopRootLayoutCapabilities = new WeakSet<object>();
const desktopRootLayoutCapabilityStates = new WeakMap<object, undefined>();

/** Fixed artifact-relative Desktop bootstrap entry descriptor. */
export const DESKTOP_RUNTIME_BOOTSTRAP_ENTRY = Object.freeze({
  schema: "gamebuddy-desktop-runtime-bootstrap-entry/v1",
  entry: "desktop-runtime-bootstrap.internal.js",
});

async function bootstrap(): Promise<void> {
  if (process.platform !== "win32") throw unavailable();

  const frame = parseBootstrapFrame(await readBootstrapFrame());
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  const admission = await readAndValidateRuntimeAdmission(moduleDirectory, frame);
  const rootLayout = await validateRootLayout(frame.rootLayout, moduleDirectory);
  mintDesktopRootLayoutCapability(rootLayout);

  const supervisorClose = waitForSupervisorClose();
  await writeAcknowledgement(frame, admission);
  const guardianSession = await connectGuardianSession(frame);
  await supervisorClose;
  await guardianSession.close();
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

async function readAndValidateRuntimeAdmission(moduleDirectory: string, frame: DesktopHostBootstrapFrame): Promise<RuntimeAdmission> {
  const sidecarPath = win32.join(moduleDirectory, runtimeAdmissionFileName);
  const state = await lstat(sidecarPath);
  if (!state.isFile() || state.isSymbolicLink() || state.size === 0 || state.size > MAX_WIRE_BYTES) throw unavailable();
  const raw = await readFile(sidecarPath);
  if (raw.length !== state.size || createHash("sha256").update(raw).digest("hex") !== frame.runtimeAdmissionSha256) throw unavailable();
  const sidecar = parseOneWireDocument(raw);
  if (!isRecord(sidecar) || !exactKeys(sidecar, ["schema", "inventoryDigest", "generation", "runtimePath", "runtimeSha256", "bootstrapPath", "bootstrapSha256", "runtimeVersion", "runtimePlatform", "runtimeArch", "runtimeClosure"])) throw unavailable();
  if (!raw.equals(Buffer.from(`${JSON.stringify(sidecar)}\n`, "utf8"))) throw unavailable();
  if (
    sidecar.schema !== "host-runtime-admission/v1" ||
    sidecar.generation !== frame.generation ||
    sidecar.inventoryDigest !== frame.inventoryDigest ||
    sidecar.runtimePath !== fixedRuntimePath ||
    !validHex(sidecar.runtimeSha256) ||
    sidecar.bootstrapPath !== fixedBootstrapPath ||
    !validHex(sidecar.bootstrapSha256) ||
    sidecar.runtimeVersion !== fixedRuntimeVersion ||
    sidecar.runtimePlatform !== fixedRuntimePlatform ||
    sidecar.runtimeArch !== fixedRuntimeArch ||
    !validRuntimeClosure(sidecar.runtimeClosure)
  ) throw unavailable();

  const [runtime, bootstrap, runtimeTree] = await Promise.all([
    readVerifiedArtifactFile(moduleDirectory, fixedRuntimePath),
    readVerifiedArtifactFile(moduleDirectory, fixedBootstrapPath),
    enumerateRuntimeTree(moduleDirectory),
  ]);
  if (
    digest(runtime) !== sidecar.runtimeSha256 ||
    digest(bootstrap) !== sidecar.bootstrapSha256 ||
    !sameRuntimeTree(runtimeTree, sidecar.runtimeSha256, sidecar.runtimeClosure.files)
  ) throw unavailable();
  return Object.freeze({ generation: sidecar.generation, inventoryDigest: sidecar.inventoryDigest });
}

function validRuntimeClosure(value: unknown): value is Readonly<{ readonly schema: "host-bundled-runtime-closure/v1"; readonly files: readonly Readonly<{ readonly path: string; readonly sha256: string }>[] }> {
  if (!isRecord(value) || !exactKeys(value, ["schema", "files"]) || value.schema !== "host-bundled-runtime-closure/v1" || !Array.isArray(value.files)) return false;
  let previousPath: string | undefined;
  return value.files.every((file) => {
    if (!isRecord(file) || !exactKeys(file, ["path", "sha256"]) || typeof file.path !== "string" || !validRuntimeClosurePath(file.path) || !validHex(file.sha256) || file.path === fixedRuntimePath || (previousPath !== undefined && previousPath.localeCompare(file.path) >= 0)) return false;
    previousPath = file.path;
    return true;
  });
}

function validRuntimeClosurePath(path: string): boolean {
  if (!/^runtime\/[A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/.test(path)) return false;
  const components = path.split("/");
  return components[0] === "runtime" && components.length > 1 && components.slice(1).every((component) => (
    component.length > 0 &&
    component !== "." &&
    component !== ".." &&
    !/[\\/:*?<>"|\u0000-\u001f]/.test(component) &&
    !component.endsWith(".") &&
    !component.endsWith(" ") &&
    !windowsReservedDeviceName.test(component)
  ));
}

type RuntimeTreeEntry = Readonly<{ path: string; sha256: string }>;

async function enumerateRuntimeTree(moduleDirectory: string): Promise<readonly RuntimeTreeEntry[]> {
  const runtimeRoot = artifactPath(moduleDirectory, "runtime");
  await safeArtifactAncestors(moduleDirectory, runtimeRoot);
  const rootState = await lstat(runtimeRoot);
  if (rootState.isSymbolicLink() || !rootState.isDirectory()) throw unavailable();

  const entries: RuntimeTreeEntry[] = [];
  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => left.name.localeCompare(right.name));
    for (const child of children) {
      const relativePath = relativeDirectory.length === 0 ? child.name : `${relativeDirectory}/${child.name}`;
      const path = artifactPath(moduleDirectory, `runtime/${relativePath}`);
      await safeArtifactAncestors(moduleDirectory, path);
      const state = await lstat(path);
      if (state.isSymbolicLink()) throw unavailable();
      if (state.isDirectory()) {
        await visit(path, relativePath);
      } else if (state.isFile()) {
        entries.push(Object.freeze({ path: `runtime/${relativePath}`, sha256: digest(await readFile(path)) }));
      } else {
        throw unavailable();
      }
    }
  };
  await visit(runtimeRoot, "");
  entries.sort((left, right) => left.path.localeCompare(right.path));
  return entries;
}

function sameRuntimeTree(actual: readonly RuntimeTreeEntry[], runtimeSha256: string, closure: readonly Readonly<{ readonly path: string; readonly sha256: string }>[]): boolean {
  if (actual.length !== closure.length + 1) return false;
  const expected = new Map<string, string>([
    [fixedRuntimePath, runtimeSha256],
    ...closure.map((entry): readonly [string, string] => [entry.path, entry.sha256]),
  ]);
  return expected.size === actual.length && actual.every((entry) => expected.get(entry.path) === entry.sha256);
}

async function readVerifiedArtifactFile(moduleDirectory: string, relativePath: string): Promise<Buffer> {
  const path = artifactPath(moduleDirectory, relativePath);
  await safeArtifactAncestors(moduleDirectory, path);
  const state = await lstat(path);
  if (state.isSymbolicLink() || !state.isFile()) throw unavailable();
  const bytes = await readFile(path);
  if (bytes.length !== state.size) throw unavailable();
  return bytes;
}

function artifactPath(moduleDirectory: string, relativePath: string): string {
  const path = win32.resolve(moduleDirectory, relativePath.replaceAll("/", "\\"));
  if (win32.relative(moduleDirectory, path).startsWith("..")) throw unavailable();
  return path;
}

async function safeArtifactAncestors(moduleDirectory: string, path: string): Promise<void> {
  const root = await lstat(moduleDirectory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw unavailable();
  const relativePath = win32.relative(moduleDirectory, path);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith("..\\")) throw unavailable();
  let cursor = moduleDirectory;
  for (const component of relativePath.split("\\")) {
    cursor = win32.join(cursor, component);
    const state = await lstat(cursor);
    if (state.isSymbolicLink() || (cursor !== path && !state.isDirectory())) throw unavailable();
  }
}

function digest(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function mintDesktopRootLayoutCapability(_layout: DesktopRootLayout): DesktopRootLayoutCapability {
  const capability = Object.freeze({}) as DesktopRootLayoutCapability;
  desktopRootLayoutCapabilities.add(capability);
  desktopRootLayoutCapabilityStates.set(capability, undefined);
  return capability;
}

async function writeAcknowledgement(frame: DesktopHostBootstrapFrame, admission: RuntimeAdmission): Promise<void> {
  const acknowledgement = Buffer.from(`${JSON.stringify({
    schema: bootstrapSchema,
    protocolVersion: 1,
    status: "accepted",
    bootstrapId: frame.bootstrapId,
    generation: admission.generation,
    inventoryDigest: admission.inventoryDigest,
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

async function createGuardianSession(socket: Socket, binding: Readonly<{ bootstrapId: string; generation: string; inventoryDigest: string; runtimeAdmissionSha256: string }>): Promise<DesktopGuardianSession> {
  type State = "ready" | "armed" | "active" | "closed";
  type Role = "player_host" | "ai_client";
  let state: State = "ready", closing = false, correlation: { guardianInstanceId: string; guardianEpoch: number; attemptId: string } | undefined;
  const launched = new Set<Role>(), contained = new Set<Role>(); let chain = Promise.resolve(); let closePromise: Promise<void> | undefined;
  let transportClosed = false; let resolveClosed!: () => void;
  const transportClose = new Promise<void>((resolve) => { resolveClosed = resolve; });
  const activeReads = new WeakSet<Socket>();
  const markClosed = () => { if (transportClosed) return; transportClosed = true; resolveClosed(); state = "closed"; closing = true; };
  const terminal = () => { state = "closed"; closing = true; if (!socket.destroyed) socket.destroy(); };
  socket.on("error", terminal); socket.on("close", markClosed); socket.on("data", () => { if (!activeReads.has(socket)) terminal(); });
  if (socket.destroyed) markClosed();
  const transact = (operation: "arm_attempt" | "launch_role" | "contain_role", input: Readonly<{ guardianInstanceId: string; guardianEpoch: number; attemptId: string; deadlineUnixMs: number; role?: Role; privateFrame?: Uint8Array }>): Promise<GuardianAck> => {
    if (closing) return Promise.reject(unavailable());
    const run = chain.then(async () => { try {
      if (state === "closed" || !guardianDeadline(input.deadlineUnixMs) || !guardianCorrelation(input) || (correlation && !sameGuardianCorrelation(correlation, input))) throw unavailable();
      if (operation === "arm_attempt" && (state !== "ready" || input.privateFrame === undefined)) throw unavailable();
      if (operation === "launch_role" && (state !== "armed" || !input.role || launched.has(input.role) || input.privateFrame === undefined)) throw unavailable();
      if (operation === "contain_role" && (state !== "active" || !input.role || !launched.has(input.role) || contained.has(input.role))) throw unavailable();
      if (input.privateFrame && (input.privateFrame.length > GUARDIAN_MAX_PRIVATE_BYTES || !GUARDIAN_BASE64URL.test(Buffer.from(input.privateFrame).toString("base64url")))) throw unavailable();
      const body: Record<string, unknown> = { schema: GUARDIAN_SCHEMA, protocolVersion: 1, operation, ...binding, deadlineUnixMs: input.deadlineUnixMs, guardianInstanceId: input.guardianInstanceId, guardianEpoch: input.guardianEpoch, attemptId: input.attemptId };
      if (input.role) body.role = input.role; if (input.privateFrame) body.privateFrame = Buffer.from(input.privateFrame).toString("base64url");
      const ack = await guardianRequest(socket, body, input.deadlineUnixMs);
      const expected = operation === "arm_attempt" ? "armed" : operation === "launch_role" ? "role_active" : "role_contained";
      if (ack.operation !== operation || ack.status !== expected || !sameGuardianBinding(ack, binding) || !sameGuardianCorrelation(ack, input) || (input.role && ack.role !== input.role)) throw unavailable();
      if (operation === "arm_attempt") { state = "armed"; correlation = { guardianInstanceId: input.guardianInstanceId, guardianEpoch: input.guardianEpoch, attemptId: input.attemptId }; }
      else if (operation === "launch_role") { state = "active"; launched.add(input.role!); } else contained.add(input.role!);
      return ack;
    } catch (error) { terminal(); throw error instanceof Error ? error : unavailable(); } });
    chain = run.then(() => undefined, () => undefined); return run;
  };
  return Object.freeze({ arm: (input) => transact("arm_attempt", input), launch: (input) => transact("launch_role", input), contain: (input) => transact("contain_role", input), close() { if (closePromise) return closePromise; closing = true; closePromise = (async () => { await chain; terminal(); await transportClose; })(); return closePromise; } });
}
async function guardianRequest(socket: Socket, body: Record<string, unknown>, deadline: number): Promise<GuardianAck> { await guardianWrite(socket, body, deadline); const value = parseGuardian(await readGuardianLine(socket, deadline)); if (!isRecord(value) || !validGuardianAck(value)) throw unavailable(); return value as GuardianAck; }
function guardianWrite(socket: Socket, body: Record<string, unknown>, deadline: number): Promise<void> { const bytes = Buffer.from(`${JSON.stringify(body)}\n`); if (bytes.length > GUARDIAN_MAX_FRAME_BYTES || deadline <= Date.now()) return Promise.reject(unavailable()); return new Promise((resolve, reject) => { let done = false; const timer = setTimeout(() => finish(unavailable()), Math.max(1, deadline - Date.now())); const finish = (error?: Error) => { if (done) return; done = true; clearTimeout(timer); socket.off("error", fail); socket.off("close", fail); error ? reject(error) : resolve(); }; const fail = () => finish(unavailable()); socket.once("error", fail); socket.once("close", fail); socket.write(bytes, (error) => finish(error ? unavailable() : undefined)); }); }
function parseGuardian(bytes: Buffer): unknown { try { if (!bytes.length || bytes.at(-1) !== 10 || bytes.subarray(0, -1).includes(10) || bytes.includes(0) || bytes.includes(13)) throw unavailable(); return parseStrictJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, -1))); } catch { throw unavailable(); } }
function validGuardianAck(v: Record<string, unknown>): boolean { const hasRole = v.operation === "launch_role" || v.operation === "contain_role"; const keys = ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256", "guardianInstanceId", "guardianEpoch", "attemptId", ...(hasRole ? ["role"] : [])]; return exactGuardian(v, keys) && v.schema === GUARDIAN_SCHEMA && v.protocolVersion === 1 && typeof v.operation === "string" && typeof v.status === "string" && v.status !== "unavailable" && typeof v.bootstrapId === "string" && typeof v.generation === "string" && typeof v.inventoryDigest === "string" && typeof v.runtimeAdmissionSha256 === "string" && GUARDIAN_CORRELATION.test(String(v.guardianInstanceId)) && Number.isSafeInteger(v.guardianEpoch) && GUARDIAN_CORRELATION.test(String(v.attemptId)) && (!hasRole || v.role === "player_host" || v.role === "ai_client"); }
function guardianDeadline(v: number): boolean { const now = Date.now(); return Number.isSafeInteger(v) && v > now && v <= now + GUARDIAN_MAX_DEADLINE_HORIZON_MS; }
function guardianCorrelation(v: { guardianInstanceId: string; guardianEpoch: number; attemptId: string }): boolean { return GUARDIAN_CORRELATION.test(v.guardianInstanceId) && GUARDIAN_CORRELATION.test(v.attemptId) && Number.isSafeInteger(v.guardianEpoch) && v.guardianEpoch > 0; }
function sameGuardianCorrelation(a: { guardianInstanceId: string; guardianEpoch: number; attemptId: string }, b: { guardianInstanceId: string; guardianEpoch: number; attemptId: string }): boolean { return a.guardianInstanceId === b.guardianInstanceId && a.guardianEpoch === b.guardianEpoch && a.attemptId === b.attemptId; }
function sameGuardianBinding(v: Record<string, unknown>, b: Readonly<{ bootstrapId: string; generation: string; inventoryDigest: string; runtimeAdmissionSha256: string }>): boolean { return v.bootstrapId === b.bootstrapId && v.generation === b.generation && v.inventoryDigest === b.inventoryDigest && v.runtimeAdmissionSha256 === b.runtimeAdmissionSha256; }
function exactGuardian(v: Record<string, unknown>, keys: readonly string[]): boolean { return Object.keys(v).length === keys.length && keys.every((k) => Object.hasOwn(v, k)); }

async function connectGuardianSession(frame: DesktopHostBootstrapFrame): Promise<DesktopGuardianSession> {
  const socket = createConnection(`\\\\.\\pipe\\GameBuddy.HostGuardian.${frame.bootstrapId}`);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    const hello = Buffer.from(`${JSON.stringify({
      schema: "gamebuddy-desktop-guardian-session/v1",
      protocolVersion: 1,
      operation: "hello",
      bootstrapId: frame.bootstrapId,
      generation: frame.generation,
      inventoryDigest: frame.inventoryDigest,
      runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
    })}\n`, "utf8");
    if (hello.length > 16_384) throw unavailable();
    const deadline = Date.now() + GUARDIAN_HELLO_TIMEOUT_MS;
    await writeGuardianFrame(socket, hello, deadline);
    const acknowledgement = await readGuardianLine(socket, deadline);
    const value = parseOneWireDocument(acknowledgement);
    if (!isRecord(value) || !exactKeys(value, ["schema", "protocolVersion", "operation", "status", "bootstrapId", "generation", "inventoryDigest", "runtimeAdmissionSha256"]) ||
      value.schema !== "gamebuddy-desktop-guardian-session/v1" || value.protocolVersion !== 1 || value.operation !== "hello" || value.status !== "accepted" ||
      value.bootstrapId !== frame.bootstrapId || value.generation !== frame.generation || value.inventoryDigest !== frame.inventoryDigest || value.runtimeAdmissionSha256 !== frame.runtimeAdmissionSha256) throw unavailable();
    return await createGuardianSession(socket, {
      bootstrapId: frame.bootstrapId,
      generation: frame.generation,
      inventoryDigest: frame.inventoryDigest,
      runtimeAdmissionSha256: frame.runtimeAdmissionSha256,
    });
  } catch {
    socket.destroy();
    throw unavailable();
  }
}

async function writeGuardianFrame(socket: Socket, frame: Buffer, deadline: number): Promise<void> {
  if (deadline <= Date.now()) throw unavailable();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(unavailable()); } }, Math.max(1, deadline - Date.now()));
    socket.write(frame, (error) => { if (settled) return; settled = true; clearTimeout(timer); error === undefined ? resolve() : reject(unavailable()); });
  });
}

async function readGuardianLine(socket: Socket, deadline: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let length = 0;
  return await new Promise<Buffer>((resolve, reject) => {
    const fail = (error: Error) => { cleanup(); reject(error); };
    const data = (chunk: Buffer) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      length += bytes.length;
      if (length > 16_384 || bytes.includes(0) || bytes.includes(13)) return fail(unavailable());
      chunks.push(bytes);
      const combined = Buffer.concat(chunks);
      if (combined.indexOf(10) >= 0 && combined.indexOf(10) === combined.length - 1) { cleanup(); resolve(combined); }
      else if (combined.includes(10)) fail(unavailable());
    };
    const close = () => fail(unavailable());
    const timer = setTimeout(() => fail(unavailable()), Math.max(1, deadline - Date.now()));
    const cleanup = () => { clearTimeout(timer); socket.off("data", data); socket.off("error", fail); socket.off("close", close); };
    if (deadline <= Date.now()) return fail(unavailable());
    socket.on("data", data); socket.once("error", fail); socket.once("close", close);
  });
}

function waitForSupervisorClose(): Promise<void> {
  return new Promise((resolveClose) => {
    const close = () => {
      process.off("SIGTERM", close);
      process.off("SIGINT", close);
      resolveClose();
    };
    process.once("SIGTERM", close);
    process.once("SIGINT", close);
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

if (import.meta.main) {
  void bootstrap().catch(() => {
    process.exitCode = 1;
  });
}
