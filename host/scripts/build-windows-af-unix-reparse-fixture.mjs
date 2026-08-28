import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
export const hostRoot = resolve(dirname(scriptPath), "..");
export const repositoryRoot = resolve(hostRoot, "..");
export const projectRoot = resolve(hostRoot, "native", "windows-af-unix-reparse-fixture");
export const projectFile = resolve(projectRoot, "GameBuddy.WindowsAfUnixReparseFixture.csproj");
export const outputRoot = resolve(projectRoot, ".dist", "win-x64");
export const helperFileName = "GameBuddy.WindowsAfUnixReparseFixture.exe";
const trustedDotnetPath = "C:\\Program Files\\dotnet\\dotnet.exe";
const timeoutMs = 120_000;
const outputLimitBytes = 64 * 1024;
const expectedSdkVersionPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

async function runBounded(command, args, cwd, env) {
  return await new Promise((resolveRun, rejectRun) => {
    let child;
    let outputBytes = 0;
    let timedOut = false;
    let timer;
    const output = [];
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) rejectRun(error); else resolveRun(result);
    };
    try {
      child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { finish(error); return; }
    const collect = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > outputLimitBytes) { child.kill(); return; }
      output.push(chunk);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", (error) => finish(error));
    child.once("close", (code, signal) => {
      if (timedOut) return finish(new Error("af_unix_fixture_build_timeout"));
      if (outputBytes > outputLimitBytes) return finish(new Error("af_unix_fixture_build_output_overflow"));
      if (code !== 0 || signal !== null) return finish(new Error("af_unix_fixture_build_failed"));
      finish(undefined, Buffer.concat(output).toString("utf8"));
    });
    timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    timer.unref();
  });
}

async function readLockedSdkVersion() {
  const value = JSON.parse(await readFile(resolve(repositoryRoot, "global.json"), "utf8"));
  if (typeof value?.sdk?.version !== "string" || !expectedSdkVersionPattern.test(value.sdk.version)) throw new Error("af_unix_fixture_sdk_lock_invalid");
  return value.sdk.version;
}

async function resolveDotnet() {
  const state = await lstat(trustedDotnetPath).catch(() => undefined);
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error("af_unix_fixture_dotnet_unavailable");
  return trustedDotnetPath;
}

function buildEnvironment() {
  const temp = resolve(repositoryRoot, ".tmp", "windows-af-unix-reparse-fixture");
  return {
    SystemRoot: "C:\\Windows", WINDIR: "C:\\Windows", ComSpec: "C:\\Windows\\System32\\cmd.exe",
    OS: "Windows_NT", PROCESSOR_ARCHITECTURE: "AMD64", ProgramFiles: "C:\\Program Files", ProgramW6432: "C:\\Program Files",
    PROGRAMDATA: "C:\\ProgramData", TEMP: temp, TMP: temp, USERPROFILE: resolve(temp, "user-profile"),
    APPDATA: resolve(temp, "appdata"), LOCALAPPDATA: resolve(temp, "localappdata"), DOTNET_CLI_HOME: resolve(temp, "dotnet-home"),
    NUGET_PACKAGES: resolve(temp, "nuget-packages"), DOTNET_CLI_TELEMETRY_OPTOUT: "1", DOTNET_SKIP_FIRST_TIME_EXPERIENCE: "1", DOTNET_NOLOGO: "1",
  };
}

export async function buildWindowsAfUnixReparseFixture() {
  if (process.platform !== "win32") throw new Error("af_unix_fixture_windows_required");
  const dotnet = await resolveDotnet();
  if ((await runBounded(dotnet, ["--version"], repositoryRoot, buildEnvironment())).trim() !== await readLockedSdkVersion()) throw new Error("af_unix_fixture_sdk_drift");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await runBounded(dotnet, ["publish", projectFile, "--configuration", "Release", "--runtime", "win-x64", "--self-contained", "true", "--output", outputRoot, "-p:PublishSingleFile=true", "-p:PublishTrimmed=false", "-p:DebugType=None", "-p:DebugSymbols=false", "-p:Deterministic=true", "-p:ContinuousIntegrationBuild=true", "-p:UseAppHost=true", "--nologo"], repositoryRoot, buildEnvironment());
  const helperPath = resolve(outputRoot, helperFileName);
  const state = await lstat(helperPath).catch(() => undefined);
  if (!state?.isFile() || state.isSymbolicLink()) throw new Error("af_unix_fixture_missing");
  return Object.freeze({ helperPath, sha256: createHash("sha256").update(await readFile(helperPath)).digest("hex") });
}

if (process.argv[1] === scriptPath) {
  try { process.stdout.write(`${JSON.stringify(await buildWindowsAfUnixReparseFixture())}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : "af_unix_fixture_build_failed"}\n`); process.exitCode = 2; }
}
