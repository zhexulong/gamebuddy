import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const hostRoot = resolve(dirname(scriptPath), "..");
export const repositoryRoot = resolve(hostRoot, "..");
export const projectRoot = resolve(hostRoot, "native", "windows-reparse-inspector");
export const projectFile = resolve(projectRoot, "GameBuddy.WindowsReparseInspector.csproj");
export const outputRoot = resolve(projectRoot, ".dist", "win-x64");
export const helperFileName = "GameBuddy.WindowsReparseInspector.exe";
export const manifestFileName = "windows-reparse-inspector.manifest.json";
export const protocolVersion = 1;
export const manifestSchemaVersion = 1;
export const rid = "win-x64";
const trustedDotnetPath = "C:\\Program Files\\dotnet\\dotnet.exe";
const timeoutMs = 5 * 60_000;
const outputLimitBytes = 64 * 1024;
const expectedSdkVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function contained(root, value) {
  const remainder = relative(root, value);
  return remainder === "" || (!isAbsolute(remainder) && remainder !== ".." && !remainder.startsWith(`..${sep}`));
}

/** Resolves only the repository policy's fixed Windows SDK host. */
export async function resolveRepositoryDotnet() {
  const state = await lstat(trustedDotnetPath).catch(() => undefined);
  if (!state?.isFile() || state.isSymbolicLink() || !contained("C:\\", trustedDotnetPath)) throw new Error("windows_reparse_dotnet_missing");
  return trustedDotnetPath;
}

async function readLockedSdkVersion() {
  let parsed;
  try { parsed = JSON.parse(await readFile(resolve(repositoryRoot, "global.json"), "utf8")); }
  catch { throw new Error("windows_reparse_dotnet_sdk_lock_invalid"); }
  const version = parsed?.sdk?.version;
  if (typeof version !== "string" || !expectedSdkVersionPattern.test(version)) throw new Error("windows_reparse_dotnet_sdk_lock_invalid");
  return version;
}

export function canonicalManifest(sha256) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error("windows_reparse_helper_hash_invalid");
  return `{"schemaVersion":${manifestSchemaVersion},"protocolVersion":${protocolVersion},"rid":"${rid}","helperFileName":"${helperFileName}","sha256":"${sha256}"}\n`;
}

function minimalDotnetEnvironment() {
  const temporaryRoot = resolve(repositoryRoot, ".tmp", "windows-reparse-inspector");
  return {
    SystemRoot: "C:\\Windows",
    WINDIR: "C:\\Windows",
    ComSpec: "C:\\Windows\\System32\\cmd.exe",
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64",
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    PROGRAMDATA: "C:\\ProgramData",
    TEMP: temporaryRoot,
    TMP: temporaryRoot,
    USERPROFILE: resolve(temporaryRoot, "user-profile"),
    APPDATA: resolve(temporaryRoot, "appdata"),
    LOCALAPPDATA: resolve(temporaryRoot, "localappdata"),
    DOTNET_CLI_HOME: resolve(temporaryRoot, "dotnet-home"),
    NUGET_PACKAGES: resolve(temporaryRoot, "nuget-packages"),
    DOTNET_CLI_TELEMETRY_OPTOUT: "1",
    DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1",
    DOTNET_NOLOGO: "1",
  };
}

async function runBoundedDotnet(command, args) {
  return await new Promise((resolveRun, rejectRun) => {
    let child; let outputBytes = 0; let timedOut = false; const output = [];
    const finish = (error, result) => error ? rejectRun(error) : resolveRun(result);
    try {
      child = spawn(command, args, { cwd: repositoryRoot, env: minimalDotnetEnvironment(), shell: false, windowsHide: true, detached: false, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { finish(new Error("windows_reparse_dotnet_spawn_failed", { cause: error })); return; }
    const collect = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes <= outputLimitBytes) output.push(chunk);
      else child.kill();
    };
    child.stdout.on("data", collect); child.stderr.on("data", collect);
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); finish(new Error("windows_reparse_dotnet_spawn_failed", { cause: error })); });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) return finish(new Error("windows_reparse_dotnet_timeout"));
      if (outputBytes > outputLimitBytes) return finish(new Error("windows_reparse_dotnet_output_overflow"));
      if (code !== 0 || signal) return finish(new Error("windows_reparse_dotnet_failed"));
      finish(undefined, Buffer.concat(output).toString("utf8"));
    });
  });
}

async function assertLockedSdk(dotnet) {
  const expected = await readLockedSdkVersion();
  const actual = (await runBoundedDotnet(dotnet, ["--version"])).trim();
  if (actual !== expected) throw new Error("windows_reparse_dotnet_sdk_drift");
}

export async function buildWindowsReparseInspector() {
  if (process.platform !== "win32") throw new Error("windows_reparse_build_requires_windows");
  const dotnet = await resolveRepositoryDotnet();
  await assertLockedSdk(dotnet);
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  const args = ["publish", projectFile, "--configuration", "Release", "--runtime", rid, "--self-contained", "true", "--output", outputRoot, "-p:PublishSingleFile=true", "-p:PublishTrimmed=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-p:Deterministic=true", "-p:ContinuousIntegrationBuild=true", "-p:UseAppHost=true", "--nologo"];
  await runBoundedDotnet(dotnet, args);
  const helperPath = resolve(outputRoot, helperFileName);
  const helperState = await lstat(helperPath).catch(() => undefined);
  if (!helperState?.isFile() || helperState.isSymbolicLink()) throw new Error("windows_reparse_helper_missing");
  const sha256 = createHash("sha256").update(await readFile(helperPath)).digest("hex");
  const manifestPath = resolve(outputRoot, manifestFileName);
  await writeFile(manifestPath, canonicalManifest(sha256), { encoding: "utf8", flag: "w" });
  await access(manifestPath);
  return Object.freeze({ helperPath, manifestPath, sha256 });
}

if (process.argv[1] === scriptPath) {
  try {
    const result = await buildWindowsReparseInspector();
    process.stdout.write(`${canonicalManifest(result.sha256)}`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "windows_reparse_build_failed"}\n`);
    process.exitCode = 1;
  }
}
