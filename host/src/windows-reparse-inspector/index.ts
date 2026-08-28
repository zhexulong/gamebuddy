import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createInspectorCapability,
  inspectorState,
  type InspectorState,
  type WindowsReparseInspectorCapability,
} from "./internal.js";

const modulePath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(modulePath), "..", "..");
const repositoryRoot = resolve(hostRoot, "..");
const helperFileName = "GameBuddy.WindowsReparseInspector.exe";
const manifestFileName = "windows-reparse-inspector.manifest.json";
const legacyProtocolVersion = 1;
const strictIdentityProtocolVersion = 2;
const rid = "win-x64";
const timeoutMs = 3_000;
const cleanupDrainTimeoutMs = 1_000;
const outputLimitBytes = 64 * 1024;
const maximumChainComponents = 513;
const strictWindowsDriveRoot = /^[A-Za-z]:\\$/;
const hex64 = /^[a-f0-9]{16}$/;
const hex128 = /^[a-f0-9]{32}$/;

export type { WindowsReparseInspectorCapability } from "./internal.js";

export type WindowsPathObjectIdentity = Readonly<{
  objectKind: "directory" | "regular_file";
  isReparsePoint: boolean;
  volumeIdentity: string;
  fileId: string;
}>;

/** Mints the build-only capability from the sole repository-relative helper pair. */
export async function createBuildWindowsReparseInspector(): Promise<WindowsReparseInspectorCapability> {
  return await createFixedInspector(resolve(repositoryRoot, "host", "native", "windows-reparse-inspector", ".dist", rid));
}

/** Mints the published-artifact capability from its sole fixed internal helper pair. */
export async function createPublishedWindowsReparseInspector(
  hostArtifactRoot: string,
): Promise<WindowsReparseInspectorCapability> {
  if (!isAbsolute(hostArtifactRoot)) throw unavailable();
  if (process.platform !== "win32") return createInspectorCapability({ executable: "", spawnHelper: unavailableSpawn });
  return await createFixedInspector(resolve(hostArtifactRoot, "native", "windows-reparse-inspector", rid));
}

/** Preserves the shipped v1 reparse classification operation exactly. */
export async function inspectWindowsReparse(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<"regular" | "reparse"> {
  if (!isAbsolute(absolutePath)) throw unavailable();
  const state = usableState(capability);
  const response = await invokeHelper(state, {
    schemaVersion: legacyProtocolVersion,
    operation: "inspect",
    path: absolutePath,
  });
  if (response.equals(Buffer.from('{"schemaVersion":1,"result":"regular"}\n', "utf8"))) return "regular";
  if (response.equals(Buffer.from('{"schemaVersion":1,"result":"reparse"}\n', "utf8"))) return "reparse";
  throw unavailable();
}

/** Rejects paths reported as reparse points by the fixed inspector helper. */
export async function assertNoWindowsReparse(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<void> {
  if (await inspectWindowsReparse(capability, absolutePath) === "reparse") throw unavailable();
}

/** Returns the strict handle-derived identity of one exact local-drive path object. */
export async function inspectWindowsPathIdentity(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<WindowsPathObjectIdentity> {
  assertStrictWindowsDrivePath(absolutePath);
  const state = usableState(capability);
  const response = await invokeHelper(state, {
    schemaVersion: strictIdentityProtocolVersion,
    operation: "inspect_identity_v2",
    path: absolutePath,
  });
  return parseIdentityResponse(response, "inspect_identity_v2");
}

/** Returns root-to-leaf identities so a later authority can require every object non-reparse. */
export async function inspectWindowsPathIdentityChain(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<readonly WindowsPathObjectIdentity[]> {
  assertStrictWindowsDrivePath(absolutePath);
  const expectedCount = expectedChainComponentCount(absolutePath);
  if (expectedCount > maximumChainComponents) throw unavailable();
  const state = usableState(capability);
  const response = await invokeHelper(state, {
    schemaVersion: strictIdentityProtocolVersion,
    operation: "inspect_path_chain_v2",
    path: absolutePath,
  });
  const value = parseStrictJson(response);
  if (!isRecord(value) || !exactKeys(value, ["schemaVersion", "operation", "status", "components"])) throw unavailable();
  if (value.schemaVersion !== strictIdentityProtocolVersion || value.operation !== "inspect_path_chain_v2" || value.status !== "ok" || !Array.isArray(value.components)) throw unavailable();
  if (value.components.length !== expectedCount || value.components.length === 0 || value.components.length > maximumChainComponents) throw unavailable();
  const components = value.components.map(parseIdentityObject);
  const leafVolumeIdentity = components.at(-1)?.volumeIdentity;
  if (leafVolumeIdentity === undefined || components.some((component) => component.volumeIdentity !== leafVolumeIdentity)) throw unavailable();
  for (let index = 0; index < components.length - 1; index++) {
    if (components[index]?.objectKind !== "directory") throw unavailable();
  }
  return Object.freeze(components);
}

async function createFixedInspector(pairRoot: string): Promise<WindowsReparseInspectorCapability> {
  if (process.platform !== "win32") return createInspectorCapability({ executable: "", spawnHelper: unavailableSpawn });
  if (process.arch !== "x64") throw unavailable();
  const executable = resolve(pairRoot, helperFileName);
  const manifest = resolve(pairRoot, manifestFileName);
  if (!contained(pairRoot, executable) || !contained(pairRoot, manifest)) throw unavailable();
  const [binaryState, manifestState] = await Promise.all([
    lstat(executable).catch(() => undefined),
    lstat(manifest).catch(() => undefined),
  ]);
  if (!binaryState?.isFile() || binaryState.isSymbolicLink() || !manifestState?.isFile() || manifestState.isSymbolicLink()) throw unavailable();
  let rawManifest: Buffer;
  let binary: Buffer;
  try {
    [rawManifest, binary] = await Promise.all([readFile(manifest), readFile(executable)]);
  } catch {
    throw unavailable();
  }
  const digest = createHash("sha256").update(binary).digest("hex");
  const canonical = `{"schemaVersion":1,"protocolVersion":${legacyProtocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${digest}"}\n`;
  if (!rawManifest.equals(Buffer.from(canonical, "utf8"))) throw unavailable();
  return createInspectorCapability({ executable, spawnHelper: productionSpawn });
}

function usableState(capability: WindowsReparseInspectorCapability | undefined): InspectorState {
  const state = inspectorState(capability);
  if (state === undefined || (process.platform !== "win32" && state.inspectOnNonWindows !== true)) throw unavailable();
  return state;
}

async function invokeHelper(state: InspectorState, requestValue: object): Promise<Buffer> {
  const request = Buffer.from(JSON.stringify(requestValue), "utf8");
  if (request.length > outputLimitBytes) throw unavailable();
  return await new Promise<Buffer>((resolveInspection, rejectInspection) => {
    let child: ChildProcess;
    try {
      child = state.spawnHelper(state.executable, []);
    } catch {
      rejectInspection(unavailable());
      return;
    }

    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    let settled = false;
    let acceptingOutput = true;
    let outputBytes = 0;
    let terminalFailure: Error | undefined;
    let killAttempted = false;
    let killFailed = false;
    let killReturned = false;
    let closeDuringKill: Readonly<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    const clearOperationTimer = () => {
      if (operationTimer === undefined) return;
      clearTimeout(operationTimer);
      operationTimer = undefined;
    };
    const clearCleanupTimer = () => {
      if (cleanupTimer === undefined) return;
      clearTimeout(cleanupTimer);
      cleanupTimer = undefined;
    };
    const stopAcceptingOutput = () => {
      if (!acceptingOutput) return;
      acceptingOutput = false;
      childStdout?.off("data", onStdoutData);
      childStdout?.off("error", onStdoutError);
      childStderr?.off("data", onStderrData);
      childStderr?.off("error", onStderrError);
    };
    const removeListeners = () => {
      stopAcceptingOutput();
      child.off("error", onChildError);
      child.off("close", onClose);
      childStdin?.off("error", onStdinError);
    };
    const finish = (value: Buffer | undefined, error: Error | undefined) => {
      if (settled) return;
      settled = true;
      clearOperationTimer();
      clearCleanupTimer();
      removeListeners();
      if (error !== undefined) rejectInspection(error);
      else resolveInspection(value!);
    };
    const finishClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (terminalFailure !== undefined) {
        finish(undefined, killFailed ? cleanupFailed() : terminalFailure);
        return;
      }
      if (code !== 0 || signal !== null || Buffer.concat(stderr).length !== 0) {
        finish(undefined, unavailable());
        return;
      }
      finish(Buffer.concat(stdout), undefined);
    };
    const beginTerminalFailure = (error: Error) => {
      if (settled || terminalFailure !== undefined) return;
      terminalFailure = error;
      clearOperationTimer();
      stopAcceptingOutput();
      cleanupTimer = setTimeout(() => finish(undefined, cleanupFailed()), cleanupDrainTimeoutMs);

      if (killAttempted) return;
      killAttempted = true;
      try {
        killFailed = !child.kill();
      } catch {
        killFailed = true;
      } finally {
        killReturned = true;
      }
      if (closeDuringKill !== undefined) {
        const close = closeDuringKill;
        closeDuringKill = undefined;
        finishClose(close.code, close.signal);
      }
    };
    function collect(target: Buffer[], chunk: Buffer): void {
      if (!acceptingOutput) return;
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes) {
        beginTerminalFailure(unavailable());
        return;
      }
      target.push(Buffer.from(chunk));
    }
    function onStdoutData(chunk: Buffer): void {
      collect(stdout, chunk);
    }
    function onStderrData(chunk: Buffer): void {
      collect(stderr, chunk);
    }
    function onStdoutError(): void {
      beginTerminalFailure(unavailable());
    }
    function onStderrError(): void {
      beginTerminalFailure(unavailable());
    }
    function onChildError(): void {
      beginTerminalFailure(unavailable());
    }
    function onStdinError(): void {
      beginTerminalFailure(unavailable());
    }
    function onClose(code: number | null, signal: NodeJS.Signals | null): void {
      if (settled) return;
      if (killAttempted && !killReturned) {
        closeDuringKill = { code, signal };
        return;
      }
      finishClose(code, signal);
    }

    childStdout?.on("data", onStdoutData);
    childStdout?.once("error", onStdoutError);
    childStderr?.on("data", onStderrData);
    childStderr?.once("error", onStderrError);
    child.once("error", onChildError);
    child.once("close", onClose);
    childStdin?.once("error", onStdinError);
    operationTimer = setTimeout(() => beginTerminalFailure(unavailable()), timeoutMs);
    try {
      childStdin?.end(request);
    } catch {
      beginTerminalFailure(unavailable());
    }
  });
}

function parseIdentityResponse(value: Buffer, operation: "inspect_identity_v2"): WindowsPathObjectIdentity {
  const parsed = parseStrictJson(value);
  if (!isRecord(parsed) || parsed.schemaVersion !== strictIdentityProtocolVersion || parsed.operation !== operation || parsed.status !== "ok") throw unavailable();
  if (!exactKeys(parsed, ["schemaVersion", "operation", "status", "objectKind", "isReparsePoint", "volumeIdentity", "fileId"])) throw unavailable();
  return parseIdentityObject({
    objectKind: parsed.objectKind,
    isReparsePoint: parsed.isReparsePoint,
    volumeIdentity: parsed.volumeIdentity,
    fileId: parsed.fileId,
  });
}

function parseIdentityObject(value: unknown): WindowsPathObjectIdentity {
  if (!isRecord(value) || !exactKeys(value, ["objectKind", "isReparsePoint", "volumeIdentity", "fileId"])) throw unavailable();
  if ((value.objectKind !== "directory" && value.objectKind !== "regular_file") || typeof value.isReparsePoint !== "boolean") throw unavailable();
  if (typeof value.volumeIdentity !== "string" || !hex64.test(value.volumeIdentity) || typeof value.fileId !== "string" || !hex128.test(value.fileId)) throw unavailable();
  return Object.freeze({
    objectKind: value.objectKind,
    isReparsePoint: value.isReparsePoint,
    volumeIdentity: value.volumeIdentity,
    fileId: value.fileId,
  });
}

function parseStrictJson(value: Buffer): unknown {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(value);
  } catch {
    throw unavailable();
  }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || text.includes("\r") || text.charCodeAt(0) === 0xfeff) throw unavailable();
  const json = text.slice(0, -1);
  try {
    const parsed = JSON.parse(json) as unknown;
    if (JSON.stringify(parsed) !== json) throw unavailable();
    return parsed;
  } catch {
    throw unavailable();
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertStrictWindowsDrivePath(value: string): void {
  if (process.platform !== "win32") throw unavailable();
  if (value.length === 0 || value.length > 32 * 1024 || !/^[A-Za-z]:\\/.test(value) || value.startsWith("\\\\")) throw unavailable();
  if (strictWindowsDriveRoot.test(value)) return;
  const components = value.slice(3).split("\\");
  if (components.length === 0 || components.length > maximumChainComponents - 1) throw unavailable();
  for (const component of components) {
    if (component.length === 0 || component === "." || component === ".." || /[\\/:*?<>"\u0000]/.test(component)) throw unavailable();
  }
}

function expectedChainComponentCount(path: string): number {
  if (strictWindowsDriveRoot.test(path)) return 1;
  return path.slice(3).split("\\").length + 1;
}

function productionSpawn(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

function unavailableSpawn(): ChildProcess {
  throw unavailable();
}

function contained(root: string, value: string): boolean {
  const remainder = relative(root, value);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}

function unavailable(): Error {
  return new Error("windows_reparse_inspection_unavailable");
}

function cleanupFailed(): Error {
  return new Error("windows_reparse_inspection_cleanup_failed");
}
