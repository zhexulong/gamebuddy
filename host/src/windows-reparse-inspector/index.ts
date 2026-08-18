import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { createInspectorCapability, inspectorState, type InspectorState, type WindowsReparseInspectorCapability } from "./internal.js";

const modulePath = fileURLToPath(import.meta.url);
const hostRoot = resolve(dirname(modulePath), "..", "..");
const repositoryRoot = resolve(hostRoot, "..");
const helperFileName = "GameBuddy.WindowsReparseInspector.exe";
const manifestFileName = "windows-reparse-inspector.manifest.json";
const protocolVersion = 1;
const rid = "win-x64";
const timeoutMs = 3_000;
const outputLimitBytes = 64 * 1024;

export type { WindowsReparseInspectorCapability } from "./internal.js";

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

/** Inspects an absolute path through a capability minted by one of the fixed policy constructors. */
export async function inspectWindowsReparse(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<"regular" | "reparse"> {
  if (!isAbsolute(absolutePath)) throw unavailable();
  const state = inspectorState(capability);
  if (state === undefined || (process.platform !== "win32" && state.inspectOnNonWindows !== true)) throw unavailable();
  return await inspect(state, absolutePath);
}

/** Rejects paths reported as reparse points by the fixed inspector helper. */
export async function assertNoWindowsReparse(
  capability: WindowsReparseInspectorCapability | undefined,
  absolutePath: string,
): Promise<void> {
  if (await inspectWindowsReparse(capability, absolutePath) === "reparse") throw unavailable();
}

async function createFixedInspector(pairRoot: string): Promise<WindowsReparseInspectorCapability> {
  if (process.platform !== "win32") return createInspectorCapability({ executable: "", spawnHelper: unavailableSpawn });
  if (process.arch !== "x64") throw unavailable();
  const executable = resolve(pairRoot, helperFileName);
  const manifest = resolve(pairRoot, manifestFileName);
  if (!contained(pairRoot, executable) || !contained(pairRoot, manifest)) throw unavailable();
  const [binaryState, manifestState] = await Promise.all([lstat(executable).catch(() => undefined), lstat(manifest).catch(() => undefined)]);
  if (!binaryState?.isFile() || binaryState.isSymbolicLink() || !manifestState?.isFile() || manifestState.isSymbolicLink()) throw unavailable();
  let rawManifest: Buffer;
  let binary: Buffer;
  try { [rawManifest, binary] = await Promise.all([readFile(manifest), readFile(executable)]); } catch { throw unavailable(); }
  const digest = createHash("sha256").update(binary).digest("hex");
  const canonical = `{"schemaVersion":1,"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${digest}"}\n`;
  if (!rawManifest.equals(Buffer.from(canonical, "utf8"))) throw unavailable();
  return createInspectorCapability({ executable, spawnHelper: productionSpawn });
}

async function inspect(state: InspectorState, path: string): Promise<"regular" | "reparse"> {
  const request = Buffer.from(JSON.stringify({ schemaVersion: protocolVersion, operation: "inspect", path }), "utf8");
  if (request.length > outputLimitBytes) throw unavailable();
  return await new Promise<"regular" | "reparse">((resolveInspection, rejectInspection) => {
    let child: ChildProcess;
    let settled = false;
    let outputBytes = 0;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const finish = (value?: "regular" | "reparse", error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectInspection(error); else resolveInspection(value!);
    };
    const overflow = () => { child.kill(); finish(undefined, unavailable()); };
    let result: "regular" | "reparse" | undefined;
    let timer: ReturnType<typeof setTimeout>;
    try { child = state.spawnHelper(state.executable, []); }
    catch { rejectInspection(unavailable()); return; }
    timer = setTimeout(() => { child.kill(); finish(undefined, unavailable()); }, timeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes) return overflow();
      target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", () => finish(undefined, unavailable()));
    child.once("close", (code, signal) => {
      if (code !== 0 || signal !== null || Buffer.concat(stderr).length !== 0) return finish(undefined, unavailable());
      result = parseResponse(Buffer.concat(stdout));
      finish(result === undefined ? undefined : result, result === undefined ? unavailable() : undefined);
    });
    child.stdin?.once("error", () => finish(undefined, unavailable()));
    child.stdin?.end(request);
  });
}

function parseResponse(value: Buffer): "regular" | "reparse" | undefined {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(value); } catch { return undefined; }
  if (text === '{"schemaVersion":1,"result":"regular"}\n') return "regular";
  return text === '{"schemaVersion":1,"result":"reparse"}\n' ? "reparse" : undefined;
}
function productionSpawn(command: string, args: readonly string[]): ChildProcess {
  return spawn(command, [...args], { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}
function unavailableSpawn(): ChildProcess { throw unavailable(); }
function contained(root: string, value: string): boolean {
  const remainder = relative(root, value);
  return remainder !== "" && remainder !== ".." && !remainder.startsWith(`..${sep}`);
}
function unavailable(): Error { return new Error("windows_reparse_inspection_unavailable"); }
