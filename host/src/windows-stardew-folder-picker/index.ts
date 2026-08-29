import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createPickerCapability, pickerState, type PickerState, type SpawnPicker, type WindowsStardewFolderPickerCapability } from "./internal.js";

const helperFileName = "GameBuddy.WindowsStardewFolderPicker.exe";
const manifestFileName = "windows-stardew-folder-picker.manifest.json";
const pairDestination = "native/windows-stardew-folder-picker/win-x64";
const inventorySchema = "gamebuddy-host-production-inventory/v4";
const originKind = "verified_windows_stardew_folder_picker";
const outputLimitBytes = 16 * 1024;
const defaultTimeoutMs = 120_000;
const modulePath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(modulePath), "..", "..");

export type { WindowsStardewFolderPickerCapability } from "./internal.js";
export type StardewFolderPickerResult = Readonly<{ status: "cancelled" } | { status: "selected"; path: string }>;
type PairFacts = Readonly<{ root: string; pairRoot: string; executable: string; manifest: string; sha256: string; inventoryPath?: string }>;

/** Mints only from the immutable published generation; no repository fallback exists. */
export async function createPublishedWindowsStardewFolderPicker(artifactRoot: string): Promise<WindowsStardewFolderPickerCapability> {
  if (!isAbsolute(artifactRoot) || process.platform !== "win32" || process.arch !== "x64") throw unavailable();
  return createFixed(resolve(artifactRoot, pairDestination), artifactRoot, resolve(artifactRoot, "production-inventory.json"));
}
/** Explicit build/test mint; never used by the production mint. */
export async function createBuildWindowsStardewFolderPicker(): Promise<WindowsStardewFolderPickerCapability> {
  if (process.platform !== "win32" || process.arch !== "x64") throw unavailable();
  const root = resolve(repositoryRoot, "native", "windows-stardew-folder-picker", ".dist", "win-x64");
  return createFixed(root, root, undefined);
}

/** Shows the native picker and returns an untrusted candidate or normal cancellation. */
export async function selectStardewFolder(capability: WindowsStardewFolderPickerCapability): Promise<StardewFolderPickerResult> {
  const state = pickerState(capability);
  if (state === undefined || (process.platform !== "win32" && !state.allowNonWindows)) throw unavailable();
  return run(state);
}

function createFixed(pairRoot: string, root: string, inventoryPath: string | undefined) {
  const facts = verifyPair({ root, pairRoot, executable: resolve(pairRoot, helperFileName), manifest: resolve(pairRoot, manifestFileName), inventoryPath });
  return createPickerCapability({ executable: facts.executable, spawnPicker: verifiedSpawn(facts) });
}
function verifiedSpawn(facts: PairFacts): SpawnPicker {
  return (command, args) => { if (command !== facts.executable || args.length !== 0) throw unavailable(); verifyPair(facts); return spawn(command, [], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }); };
}
function verifyPair(input: Omit<PairFacts, "sha256"> & { sha256?: string }): PairFacts {
  verifyChain(input.root, input.pairRoot); regular(input.executable); regular(input.manifest);
  const binary = bytes(input.executable); const manifest = bytes(input.manifest); const sha256 = createHash("sha256").update(binary).digest("hex");
  if (input.sha256 !== undefined && input.sha256 !== sha256) throw unavailable();
  if (!manifest.equals(Buffer.from(canonicalManifest(sha256)))) throw unavailable();
  if (input.inventoryPath !== undefined) {
    regular(input.inventoryPath);
    verifyInventory(bytes(input.inventoryPath), sha256, manifest);
  }
  return Object.freeze({ ...input, sha256 });
}
function canonicalManifest(sha256: string) { return `{"schemaVersion":1,"protocolVersion":1,"rid":"win-x64","helperFileName":"${helperFileName}","sha256":"${sha256}"}\n`; }
function verifyChain(root: string, target: string) {
  directory(root); const remainder = relative(root, target); if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) throw unavailable();
  let cursor = root; for (const part of remainder === "" ? [] : remainder.split(sep)) { cursor = resolve(cursor, part); directory(cursor); }
}
function directory(path: string) { const state = safeLstat(path); if (!state?.isDirectory() || state.isSymbolicLink()) throw unavailable(); physical(path); }
function regular(path: string) { const state = safeLstat(path); if (!state?.isFile() || state.isSymbolicLink()) throw unavailable(); physical(path); }
function physical(path: string) { try { if (resolve(realpathSync(path)).toLowerCase() !== resolve(path).toLowerCase()) throw unavailable(); } catch { throw unavailable(); } }
function safeLstat(path: string) { try { return lstatSync(path); } catch { return undefined; } }
function bytes(path: string) { try { return readFileSync(path); } catch { throw unavailable(); } }
function verifyInventory(raw: Buffer, helperSha256: string, manifest: Buffer) {
  let value: unknown; try { value = JSON.parse(raw.toString("utf8")); } catch { throw unavailable(); }
  if (!record(value) || value.schema !== inventorySchema || !Array.isArray(value.entries)) throw unavailable();
  const origin = (entry: unknown) => record(entry) && record(entry.origin) && entry.origin.kind === originKind && entry.origin.destination === pairDestination && entry.origin.helper === helperFileName && entry.origin.manifest === manifestFileName && entry.origin.helperSha256 === helperSha256;
  const match = (path: string, hash: string) => value.entries.filter((entry: unknown) => record(entry) && entry.path === path && entry.type === "file" && entry.sha256 === hash && origin(entry)).length === 1;
  if (!match(`${pairDestination}/${helperFileName}`, helperSha256) || !match(`${pairDestination}/${manifestFileName}`, createHash("sha256").update(manifest).digest("hex"))) throw unavailable();
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }

function run(state: PickerState): Promise<StardewFolderPickerResult> {
  return new Promise((resolveResult, reject) => {
    let child: ChildProcess;
    let settled = false;
    let terminating = false;
    let count = 0;
    let operationTimer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    const finish = (result?: StardewFolderPickerResult) => {
      if (settled) return;
      settled = true;
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      result === undefined ? reject(unavailable()) : resolveResult(result);
    };
    const terminate = () => {
      if (settled || terminating) return;
      terminating = true;
      if (operationTimer !== undefined) clearTimeout(operationTimer);
      try { child.kill(); } catch { return; }
    };
    try { child = state.spawnPicker(state.executable, []); } catch { reject(unavailable()); return; }
    operationTimer = setTimeout(terminate, state.timeoutMs ?? defaultTimeoutMs);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      if (terminating || settled) return;
      count += chunk.length;
      if (count > outputLimitBytes) terminate();
      else target.push(Buffer.from(chunk));
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.once("error", () => { if (!terminating) finish(); });
    child.once("close", (code, signal) => {
      if (terminating || code !== 0 || signal !== null || Buffer.concat(stderr).length !== 0) return finish();
      finish(parse(Buffer.concat(stdout)));
    });
  });
}
function parse(raw: Buffer): StardewFolderPickerResult | undefined {
  if (raw.length >= 3 && raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) return undefined;
  let text: string; try { text = new TextDecoder("utf-8", { fatal: true }).decode(raw); } catch { return undefined; }
  let value: unknown; try { value = JSON.parse(text); } catch { return undefined; }
  if (!text.endsWith("\n") || text.slice(0, -1).includes("\n") || !record(value) || value.schemaVersion !== 1) return undefined;
  if (value.status === "cancelled" && Object.keys(value).length === 2) return Object.freeze({ status: "cancelled" });
  if (value.status === "selected" && Object.keys(value).length === 3 && typeof value.path === "string" && validPath(value.path)) return Object.freeze({ status: "selected", path: value.path });
  return undefined;
}
function validPath(path: string) { return path.length >= 3 && path.length <= 4096 && /^[A-Za-z]:\\/.test(path) && !path.startsWith("\\\\") && !path.includes("/") && !path.includes("\0") && !path.includes("\r") && !path.includes("\n"); }
function unavailable() { return new Error("windows_stardew_folder_picker_unavailable"); }
