import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
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
  await supervisorClose;
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
