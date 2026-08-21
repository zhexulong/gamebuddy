import { spawn } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { win32 } from "node:path";
import { superviseStardewCompanionAdmissionProbe } from "../../host/scripts/supervise-stardew-companion-live-session.mjs";

export const PRODUCTION_ADMISSION_PROFILES = Object.freeze({
  preview_run_a_v1: Object.freeze(["SIM-01", "SIM-02"]),
  preview_run_b_v1: Object.freeze(["SIM-03"]),
});
const REQUIRED_FLAGS = Object.freeze([
  "--profile",
  "--operator-config",
  "--runtime-root",
  "--fixture-transaction-manifest",
  "--output",
  "--preflight-only",
]);
const VALUE_FLAGS = new Set(REQUIRED_FLAGS.filter((flag) => flag !== "--preflight-only"));
const FORBIDDEN_FLAGS = new Set([
  "--fixture-adapter",
  "--adapter",
  "--entry",
  "--main",
  "--model",
  "--gameplay-model",
  "--tool",
  "--topology",
  "--control-pipe",
  "--pipe",
  "--pipe-name",
  "--control-token",
  "--token",
  "--scenario",
  "--scenarios",
  "--launch",
  "--command",
  "--args",
]);
const OPAQUE = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/;
const PROBE_SCHEMA = "gamebuddy-stardew-companion-admission-probe/v1";
const ADMISSION_RECORD_SCHEMA = "gamebuddy_stardew_companion_admission_record/v1";
const ALLOWED_REASON_CODES = new Set([
  "companion_live_source_attestation_unavailable",
  "companion_live_receipt_evidence_unavailable",
  "admission_supervisor_probe_unavailable",
  "admission_supervisor_probe_malformed",
  "fixture_transaction_manifest_unavailable",
  "fixture_transaction_manifest_invalid_or_unowned",
  "admission_preflight_unavailable",
]);
const SOURCE_ATTESTATION_UNAVAILABLE = "companion_live_source_attestation_unavailable";

export class ProductionAdmissionError extends Error {
  constructor(code) {
    super(code);
    this.name = "ProductionAdmissionError";
    this.code = code;
  }
}
function fail(code) {
  throw new ProductionAdmissionError(code);
}
function isWindowsDriveAbsolute(value, pathApi = win32) {
  if (typeof value !== "string" || !/^[A-Za-z]:\\/.test(value) || !pathApi.isAbsolute(value) || value.includes("/"))
    return false;
  const tail = value.slice(3);
  return (
    tail.length > 0 &&
    tail
      .split("\\")
      .every((part) => part.length > 0 && part !== "." && part !== ".." && !/[<>:"|?*\u0000-\u001f]/.test(part))
  );
}
function productionPlatform(platform) {
  return platform === "win32";
}
function allowedReasonCode(reasonCode) {
  return typeof reasonCode === "string" && ALLOWED_REASON_CODES.has(reasonCode);
}

/** Parse the only production CLI invocation accepted by P7. UNC, POSIX, and drive-relative paths are intentionally not P7 paths. */
export function parseProductionAdmissionInvocation(argv, { platform = process.platform, pathApi = win32 } = {}) {
  if (!productionPlatform(platform)) fail("admission_platform_unsupported");
  if (!Array.isArray(argv) || argv.some((item) => typeof item !== "string")) fail("admission_cli_invalid");
  const values = new Map();
  let preflightOnly = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (FORBIDDEN_FLAGS.has(flag)) fail("admission_cli_forbidden_override");
    if (!REQUIRED_FLAGS.includes(flag)) fail("admission_cli_unknown_flag");
    if (flag === "--preflight-only") {
      if (preflightOnly) fail("admission_cli_duplicate_flag");
      preflightOnly = true;
      continue;
    }
    if (values.has(flag)) fail("admission_cli_duplicate_flag");
    const value = argv[++index];
    if (value === undefined || value.startsWith("--")) fail("admission_cli_value_missing");
    values.set(flag, value);
  }
  if (!preflightOnly || REQUIRED_FLAGS.filter((flag) => VALUE_FLAGS.has(flag)).some((flag) => !values.has(flag)))
    fail("admission_cli_required_flag_missing");
  const profile = values.get("--profile");
  if (!Object.hasOwn(PRODUCTION_ADMISSION_PROFILES, profile)) fail("admission_profile_invalid");
  for (const flag of ["--operator-config", "--runtime-root", "--fixture-transaction-manifest", "--output"])
    if (!isWindowsDriveAbsolute(values.get(flag), pathApi)) fail("admission_path_not_absolute");
  return Object.freeze({
    profile,
    scenarioIds: PRODUCTION_ADMISSION_PROFILES[profile],
    operatorConfigPath: values.get("--operator-config"),
    runtimeRootPath: values.get("--runtime-root"),
    fixtureTransactionManifestPath: values.get("--fixture-transaction-manifest"),
    outputPath: values.get("--output"),
    preflightOnly: true,
  });
}

/** Read-only Phase A. Operator config and runtime root are deliberately never opened in P7. */
export async function validateProductionAdmissionPhaseA(invocation, { read = readFile } = {}) {
  if (
    !invocation ||
    invocation.preflightOnly !== true ||
    !Object.hasOwn(PRODUCTION_ADMISSION_PROFILES, invocation.profile)
  )
    fail("admission_invocation_invalid");
  let manifest;
  try {
    manifest = JSON.parse(await read(invocation.fixtureTransactionManifestPath, "utf8"));
  } catch {
    fail("fixture_transaction_manifest_unavailable");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join(",") !== "fixtureId,ownerId,profile,schema,state,topology" ||
    manifest.schema !== "gamebuddy-stardew-companion-fixture-transaction/v1" ||
    manifest.state !== "owned" ||
    manifest.profile !== invocation.profile ||
    manifest.topology !== "native_ai_farmhand_multiplayer" ||
    !OPAQUE.test(manifest.fixtureId) ||
    !OPAQUE.test(manifest.ownerId)
  )
    fail("fixture_transaction_manifest_invalid_or_unowned");
  return Object.freeze({
    profile: invocation.profile,
    scenarioIds: invocation.scenarioIds,
    phase: "A",
    readOnly: true,
  });
}
function validateSupervisorProbeResult(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).sort().join(",") !== "reasonCode,schema,state" ||
    result.schema !== PROBE_SCHEMA ||
    result.state !== "blocked" ||
    result.reasonCode !== SOURCE_ATTESTATION_UNAVAILABLE
  )
    fail("admission_supervisor_probe_malformed");
  return result;
}
export async function runProductionAdmissionPreflight(
  invocation,
  { read = readFile, supervisorProbe = superviseStardewCompanionAdmissionProbe } = {},
) {
  try {
    await validateProductionAdmissionPhaseA(invocation, { read });
    // Caller-supplied JSONL is hand-authorable. Production readiness requires
    // receipt-backed Host-owned evidence, which this preflight cannot verify.
    let probeResult;
    try {
      probeResult = await supervisorProbe();
    } catch {
      return blockedAdmissionRecord(invocation.profile, "admission_supervisor_probe_unavailable");
    }
    validateSupervisorProbeResult(probeResult);
    return blockedAdmissionRecord(invocation.profile, probeResult.reasonCode);
  } catch (error) {
    return blockedAdmissionRecord(
      invocation?.profile,
      error instanceof ProductionAdmissionError && allowedReasonCode(error.code)
        ? error.code
        : "admission_preflight_unavailable",
    );
  }
}
export function blockedAdmissionRecord(profile, reasonCode) {
  if (!allowedReasonCode(reasonCode)) fail("admission_reason_code_invalid");
  const knownProfile = Object.hasOwn(PRODUCTION_ADMISSION_PROFILES, profile);
  return Object.freeze({
    schema: ADMISSION_RECORD_SCHEMA,
    state: "blocked",
    evidenceClass: "production_admission_preflight",
    profile: knownProfile ? profile : "redacted",
    scenarioIds: knownProfile ? PRODUCTION_ADMISSION_PROFILES[profile] : [],
    phase: "A",
    reasonCodes: Object.freeze([reasonCode]),
  });
}
const ADMISSION_RECORD_KEYS = Object.freeze([
  "evidenceClass",
  "phase",
  "profile",
  "reasonCodes",
  "scenarioIds",
  "schema",
  "state",
]);
function hasOnlyDataProperties(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  let names, symbols, prototype;
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
    prototype = Object.getPrototypeOf(value);
  } catch {
    return false;
  }
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    symbols.length !== 0 ||
    names.length !== keys.length ||
    names.some((name) => !keys.includes(name))
  )
    return false;
  try {
    return names.every((name) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, name);
      return descriptor && Object.hasOwn(descriptor, "value");
    });
  } catch {
    return false;
  }
}
function boundedStringArray(value) {
  if (!Array.isArray(value)) return undefined;
  let names, symbols;
  try {
    names = Object.getOwnPropertyNames(value);
    symbols = Object.getOwnPropertySymbols(value);
  } catch {
    return undefined;
  }
  if (
    symbols.length !== 0 ||
    names.length !== value.length + 1 ||
    !names.includes("length") ||
    names.some((name) => name !== "length" && !/^(0|[1-9][0-9]*)$/.test(name))
  )
    return undefined;
  const copy = [];
  for (let index = 0; index < value.length; index += 1) {
    try {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return undefined;
      copy.push(descriptor.value);
    } catch {
      return undefined;
    }
  }
  return copy;
}
/** Validate only own data properties, then reconstruct a record that has no caller-owned references. */
function materializeBoundedAdmissionRecord(record) {
  if (!hasOnlyDataProperties(record, ADMISSION_RECORD_KEYS)) return undefined;
  let schema, state, evidenceClass, phase, profile, scenarioIds, reasonCodes;
  try {
    ({ schema, state, evidenceClass, phase, profile } = record);
    scenarioIds = boundedStringArray(record.scenarioIds);
    reasonCodes = boundedStringArray(record.reasonCodes);
  } catch {
    return undefined;
  }
  if (
    schema !== ADMISSION_RECORD_SCHEMA ||
    phase !== "A" ||
    typeof profile !== "string" ||
    !scenarioIds ||
    !reasonCodes
  )
    return undefined;
  // No caller-provided object can represent a ready production admission.
  // A future receipt-backed Host verifier must publish through its own trusted
  // authority rather than reuse this source-run preflight writer.
  if (
    state !== "blocked" ||
    evidenceClass !== "production_admission_preflight" ||
    reasonCodes.length !== 1 ||
    !allowedReasonCode(reasonCodes[0])
  )
    return undefined;
  if (profile === "redacted") {
    if (scenarioIds.length !== 0) return undefined;
  } else if (
    !Object.hasOwn(PRODUCTION_ADMISSION_PROFILES, profile) ||
    scenarioIds.length !== PRODUCTION_ADMISSION_PROFILES[profile].length ||
    scenarioIds.some((id, index) => id !== PRODUCTION_ADMISSION_PROFILES[profile][index])
  )
    return undefined;
  return Object.freeze(
    Object.assign(
      {},
      {
        schema: ADMISSION_RECORD_SCHEMA,
        state,
        evidenceClass,
        profile,
        scenarioIds: Object.freeze([...scenarioIds]),
        phase: "A",
        reasonCodes: Object.freeze([...reasonCodes]),
      },
    ),
  );
}

// This constant is passed as code, never as record data. The helper receives only a checked directory and bounded stdin frame.
export const WINDOWS_SECURE_ADMISSION_PUBLISHER = String.raw`
$ErrorActionPreference='Stop'
$frame=[Console]::In.ReadToEnd() | ConvertFrom-Json
if(($frame.PSObject.Properties.Name.Count -lt 2 -or $frame.PSObject.Properties.Name.Count -gt 3) -or @($frame.PSObject.Properties.Name | Where-Object { $_ -notin @('fileName','record','temporaryFileName') }).Count -ne 0 -or $frame.fileName -notmatch '^[^\/:*?"<>|]+$' -or $frame.record -isnot [string] -or [Text.Encoding]::UTF8.GetByteCount($frame.record) -gt 4096 -or ($null -ne $frame.temporaryFileName -and ($frame.temporaryFileName -isnot [string] -or $frame.temporaryFileName -notmatch '^[^\/:*?"<>|]+$'))){ exit 41 }
Add-Type -TypeDefinition @'
using System; using System.IO; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class AdmissionPublisher {
 [StructLayout(LayoutKind.Sequential)] struct IO { public IntPtr Status; public IntPtr Information; }
 [StructLayout(LayoutKind.Sequential)] struct OA { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
 [StructLayout(LayoutKind.Sequential)] struct US { public ushort Length, MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct BH { public uint Attributes; public System.Runtime.InteropServices.ComTypes.FILETIME C,A,W; public uint V,SH,SL,L,IH,IL; }
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out IntPtr h,uint access,ref OA oa,out IO io,ref long allocation,uint attributes,uint share,uint disposition,uint options,IntPtr ea,uint eaLength);
 [DllImport("ntdll.dll")] static extern int NtSetInformationFile(IntPtr h,out IO io,IntPtr info,uint length,int infoClass);
 [DllImport("kernel32.dll",SetLastError=true,CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string path,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(IntPtr h,out BH info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool WriteFile(IntPtr h,byte[] data,uint count,out uint written,IntPtr overlapped);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers(IntPtr h);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool CloseHandle(IntPtr h);
 const uint READ=0x80000000, WRITE=0x40000000, DELETE=0x10000, SYNC=0x100000, SHARE_ALL=7, SHARE_READ=1, OPEN_EXISTING=3, OPEN=1, CREATE=2, DIRECTORY=1, NONDIR=0x40, OPEN_REPARSE_POINT=0x200000, SYNCHRONOUS=0x20, BACKUP=0x02000000, DIRECTORY_ATTRIBUTE=0x10, REPARSE_ATTRIBUTE=0x400;
 static void Status(int status){if(status!=0)throw new IOException("native_status_"+status.ToString("X8"));}
 static void CheckDirectory(IntPtr h){BH i;if(h==IntPtr.Zero||h==(IntPtr)(-1)||!GetFileInformationByHandle(h,out i)||(i.Attributes&REPARSE_ATTRIBUTE)!=0||(i.Attributes&DIRECTORY_ATTRIBUTE)==0)throw new IOException("unsafe directory");}
 static IntPtr Root(string path){IntPtr h=CreateFile(path,READ|SYNC,SHARE_ALL,IntPtr.Zero,OPEN_EXISTING,BACKUP,IntPtr.Zero);try{CheckDirectory(h);return h;}catch{CloseHandle(h);throw;}}
 // The temporary record owns WRITE and DELETE but shares only READ. Windows share checks therefore deny peers' write, delete, and rename requests until this handle closes.
 static IntPtr Child(IntPtr parent,string name,bool directory,uint disposition){byte[] bytes=System.Text.Encoding.Unicode.GetBytes(name);IntPtr text=Marshal.AllocHGlobal(bytes.Length);IntPtr usp=IntPtr.Zero;try{Marshal.Copy(bytes,0,text,bytes.Length);US us=new US{Length=(ushort)bytes.Length,MaximumLength=(ushort)bytes.Length,Buffer=text};usp=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(US)));Marshal.StructureToPtr(us,usp,false);OA oa=new OA{Length=Marshal.SizeOf(typeof(OA)),RootDirectory=parent,ObjectName=usp};IO io;long z=0;IntPtr h;Status(NtCreateFile(out h,(directory?READ:READ|WRITE|DELETE)|SYNC,ref oa,out io,ref z,0,directory?SHARE_ALL:SHARE_READ,disposition,(directory?DIRECTORY:NONDIR)|OPEN_REPARSE_POINT|SYNCHRONOUS,IntPtr.Zero,0));return h;}finally{if(usp!=IntPtr.Zero)Marshal.FreeHGlobal(usp);Marshal.FreeHGlobal(text);}}
 static void DeleteOnClose(IntPtr h){IntPtr p=Marshal.AllocHGlobal(1);try{Marshal.WriteByte(p,1);IO io;Status(NtSetInformationFile(h,out io,p,1,13));}finally{Marshal.FreeHGlobal(p);}}
 static void Write(IntPtr h,string record){byte[] bytes=System.Text.Encoding.UTF8.GetBytes(record);uint written;if(!WriteFile(h,bytes,(uint)bytes.Length,out written,IntPtr.Zero)||written!=(uint)bytes.Length||!FlushFileBuffers(h))throw new IOException("write failed");}
 public static void Publish(string directory,string fileName,string record,string temporaryFileName){if(directory.Length<4||directory[1]!=':'||directory[2]!=(char)92)throw new IOException("invalid directory");IntPtr current=Root(directory.Substring(0,3));try{foreach(string part in directory.Substring(3).Split('\\')){IntPtr next=Child(current,part,true,OPEN);try{CheckDirectory(next);}catch{CloseHandle(next);throw;}CloseHandle(current);current=next;}IntPtr temp=Child(current,String.IsNullOrEmpty(temporaryFileName)?".admission-"+Guid.NewGuid().ToString("N")+".tmp":temporaryFileName,false,CREATE);bool ownTemp=true;try{Write(temp,record);int n=fileName.Length*2,rootOffset=IntPtr.Size==8?8:4,lengthOffset=rootOffset+IntPtr.Size,nameOffset=lengthOffset+4;IntPtr link=Marshal.AllocHGlobal(nameOffset+n);try{for(int i=0;i<nameOffset+n;i++)Marshal.WriteByte(link,i,0);Marshal.WriteIntPtr(link,rootOffset,current);Marshal.WriteInt32(link,lengthOffset,n);for(int i=0;i<fileName.Length;i++)Marshal.WriteInt16(link,nameOffset+2*i,fileName[i]);IO io;Status(NtSetInformationFile(temp,out io,link,(uint)(nameOffset+n),11));DeleteOnClose(temp);ownTemp=false;}finally{Marshal.FreeHGlobal(link);}}catch{if(ownTemp)try{DeleteOnClose(temp);}catch{}throw;}finally{CloseHandle(temp);}}finally{CloseHandle(current);}}
}
'@
[AdmissionPublisher]::Publish($directory,$frame.fileName,$frame.record,$frame.temporaryFileName)
`;

function environmentValue(environment, name) {
  const values = Object.entries(environment)
    .filter(([key]) => key.toLowerCase() === name.toLowerCase())
    .map(([, value]) => value);
  return values.length === 1 && typeof values[0] === "string" ? values[0] : undefined;
}

/**
 * Source-run P7 operator tooling boundary. The already-running Node process,
 * checked source tree, and runbook-validated local Windows installation are its
 * TCB; this is not a standalone product-artifact OS bootstrap proof. Do not
 * add PATH lookup or inherit ambient child variables. `SystemRoot` supplies a
 * fixed candidate only, which must realpath to itself (rejecting substituted
 * / reparse resolution) before the helper is launched. The child independently
 * rejects an image that differs from Environment.SystemDirectory.
 */
export async function resolveWindowsAdmissionPublisherBoundary() {
  const systemRoot = environmentValue(process.env, "SystemRoot");
  if (!isWindowsDriveAbsolute(systemRoot)) fail("admission_publisher_system_root_invalid");
  const candidate = `${systemRoot}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`;
  let executable;
  try {
    executable = await realpath(candidate);
  } catch {
    fail("admission_publisher_system_root_invalid");
  }
  if (!isWindowsDriveAbsolute(executable) || executable.toLowerCase() !== candidate.toLowerCase())
    fail("admission_publisher_system_root_invalid");
  return Object.freeze({ executable, environment: Object.freeze({ SystemRoot: systemRoot, WINDIR: systemRoot }) });
}

export async function publishWithPowerShell(directory, fileName, record, temporaryFileName, { spawnFn = spawn } = {}) {
  const boundary = await resolveWindowsAdmissionPublisherBoundary();
  await new Promise((resolve, reject) => {
    const command = `$actualSystemDirectory=[Environment]::SystemDirectory; $expected=(Join-Path $actualSystemDirectory 'WindowsPowerShell\\v1.0\\powershell.exe'); $image=[Diagnostics.Process]::GetCurrentProcess().MainModule.FileName; if($image -ine $expected){exit 42}; & { param([string]$directory) ${WINDOWS_SECURE_ADMISSION_PUBLISHER} }`;
    const child = spawnFn(
      boundary.executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command, directory],
      { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, env: boundary.environment },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`publisher_exit_${code}:${stderr.slice(0, 200)}`)),
    );
    const frame = { fileName, record: `${JSON.stringify(record)}\n` };
    if (temporaryFileName !== undefined) frame.temporaryFileName = temporaryFileName;
    child.stdin.end(JSON.stringify(frame));
  });
}
/** Publishes through a Windows directory-handle-bound helper. No path-based Node write/link/unlink is permitted. */
export async function writeProductionAdmissionRecord(
  outputPath,
  record,
  { platform = process.platform, pathApi = win32, publisher = publishWithPowerShell, temporaryFileName } = {},
) {
  if (!productionPlatform(platform) || !isWindowsDriveAbsolute(outputPath, pathApi))
    fail("admission_path_not_absolute");
  const canonicalRecord = materializeBoundedAdmissionRecord(record);
  if (!canonicalRecord) fail("admission_output_record_invalid");
  const directory = pathApi.dirname(outputPath);
  const fileName = pathApi.basename(outputPath);
  try {
    await publisher(directory, fileName, canonicalRecord, temporaryFileName);
  } catch {
    fail("admission_output_write_failed");
  }
}
