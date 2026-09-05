import { win32 } from "node:path";

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

declare const desktopRootLayoutCapabilityBrand: unique symbol;
type DesktopRootLayoutCapability = object & { readonly [desktopRootLayoutCapabilityBrand]: true };

const desktopRootLayoutCapabilities = new WeakSet<object>();
const desktopRootLayoutCapabilityStates = new WeakMap<object, undefined>();

/** One-shot private bootstrap sequence invoked only by the fixed host entry. */
export async function runDesktopHostBootstrap(moduleDirectory: string): Promise<void> {
  if (process.platform !== "win32") throw unavailable();

  const frame = parseBootstrapFrame(await readBootstrapFrame());
  const rootLayout = await validateRootLayout(frame.rootLayout, moduleDirectory);
  mintDesktopRootLayoutCapability(rootLayout);

  const termination = waitForTermination();
  await writeAcknowledgement(frame);
  process.stdin.destroy();
  await termination;
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

function mintDesktopRootLayoutCapability(_layout: DesktopRootLayout): DesktopRootLayoutCapability {
  const capability = Object.freeze({}) as DesktopRootLayoutCapability;
  desktopRootLayoutCapabilities.add(capability);
  desktopRootLayoutCapabilityStates.set(capability, undefined);
  return capability;
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
