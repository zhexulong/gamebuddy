import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import {
  blockedAdmissionRecord,
  parseProductionAdmissionInvocation,
  publishWithPowerShell,
  resolveWindowsAdmissionPublisherBoundary,
  runProductionAdmissionPreflight,
  WINDOWS_SECURE_ADMISSION_PUBLISHER,
  writeProductionAdmissionRecord,
} from "./stardew-companion-production-admission.mjs";

const valid = () => [
  "--profile",
  "preview_run_a_v1",
  "--operator-config",
  "C:\\operator.json",
  "--runtime-root",
  "C:\\runtime",
  "--fixture-transaction-manifest",
  "C:\\fixture.json",
  "--output",
  "C:\\safe\\result.json",
  "--preflight-only",
];
const ownedManifest = JSON.stringify({
  schema: "gamebuddy-stardew-companion-fixture-transaction/v1",
  state: "owned",
  fixtureId: "fixture_one",
  ownerId: "owner_one",
  profile: "preview_run_a_v1",
  topology: "native_ai_farmhand_multiplayer",
});
const blockedRecord = () => blockedAdmissionRecord("preview_run_a_v1", "companion_live_source_attestation_unavailable");
const WINDOWS_TEMP_PEER_PROBE = String.raw`$directory=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('__DIRECTORY_UTF16LE_BASE64__')); $nonce='__READY_NONCE__'; $p=Join-Path -Path $directory -ChildPath '.admission-test-held.tmp'; $ready=Join-Path -Path $directory -ChildPath '.admission-test-ready'; $acknowledgement=Join-Path -Path $directory -ChildPath '.admission-test-acknowledgement'; Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices;
public static class AdmissionPeer { [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string p,uint a,uint s,IntPtr x,uint d,uint f,IntPtr t); [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h); public static int CanOpen(string p,uint a) { IntPtr h=CreateFile(p,a,7,IntPtr.Zero,3,0,IntPtr.Zero); if(h==(IntPtr)(-1)) return Marshal.GetLastWin32Error(); CloseHandle(h); return 0; } }
'@; if([IO.File]::ReadAllText($ready) -cne $nonce){throw 'ready_nonce_mismatch'}; $result=@{path=$p;readyNonce=$nonce;read=([AdmissionPeer]::CanOpen($p,[uint32]1));write=([AdmissionPeer]::CanOpen($p,[uint32]2));delete=([AdmissionPeer]::CanOpen($p,[uint32]65536))}; [IO.File]::WriteAllText($acknowledgement,$nonce,(New-Object Text.UTF8Encoding($false))); ConvertTo-Json -InputObject $result -Compress`;
async function probeHeldTempFromPeer(executable, environment, tempDirectory, readyNonce) {
  const directoryBase64 = Buffer.from(tempDirectory, "utf16le").toString("base64");
  const command = WINDOWS_TEMP_PEER_PROBE.replace("__DIRECTORY_UTF16LE_BASE64__", directoryBase64).replace(
    "__READY_NONCE__",
    readyNonce,
  );
  return new Promise((resolve, reject) => {
    let stdout = "",
      stderr = "";
    const child = spawn(executable, ["-NoProfile", "-NonInteractive", "-Command", command], {
      windowsHide: true,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(JSON.parse(stdout)) : reject(new Error(`peer_exit_${code}:${stderr}`)),
    );
  });
}

/** Test-only derivative: production source remains incapable of selecting this coordination path. */
function heldTempFixtureSource() {
  return (
    "param([string]$directory)\n" +
    WINDOWS_SECURE_ADMISSION_PUBLISHER.replace("Count -gt 3", "Count -gt 8")
      .replace(
        "@('fileName','record','temporaryFileName')",
        "@('fileName','record','temporaryFileName','readyFileName','acknowledgementFileName','releaseFileName','readyNonce','readyBaseline')",
      )
      .replace(
        "($null -ne $frame.temporaryFileName -and ($frame.temporaryFileName -isnot [string] -or $frame.temporaryFileName -notmatch '^[^\\/:*?\"<>|]+$'))){ exit 41 }",
        () =>
          "($null -ne $frame.temporaryFileName -and ($frame.temporaryFileName -isnot [string] -or $frame.temporaryFileName -notmatch '^[^\\/:*?\"<>|]+$')) -or ($frame.readyFileName -isnot [string] -or $frame.acknowledgementFileName -isnot [string] -or $frame.releaseFileName -isnot [string] -or $frame.readyNonce -isnot [string] -or $frame.readyBaseline -isnot [string])){ exit 41 }",
      )
      .replace(
        /\[DllImport\("kernel32\.dll",SetLastError=true\)\] static extern bool FlushFileBuffers/,
        '[DllImport("kernel32.dll",SetLastError=true)] static extern bool ReadFile(IntPtr h,byte[] data,uint count,out uint read,IntPtr overlapped);\n [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFilePointerEx(IntPtr h,long distance,out long position,uint moveMethod);\n [DllImport("kernel32.dll",SetLastError=true)] static extern bool FlushFileBuffers',
      )
      .replace(
        / public static void Publish\(string directory,string fileName,string record,string temporaryFileName\)\{/,
        ' static string Read(IntPtr h){byte[] bytes=new byte[128];uint read;if(!ReadFile(h,bytes,(uint)bytes.Length,out read,IntPtr.Zero))throw new IOException("read failed");return System.Text.Encoding.UTF8.GetString(bytes,0,(int)read);}\n static void Rewind(IntPtr h){long position;if(!SetFilePointerEx(h,0,out position,0)||position!=0)throw new IOException("rewind failed");}\n static void WaitForFixtureRelease(IntPtr directory,string readyName,string acknowledgementName,string releaseName,string nonce,string baseline){IntPtr ready=Child(directory,readyName,false,OPEN);try{if(Read(ready)!=baseline)throw new IOException("fixture ready baseline invalid");Rewind(ready);Write(ready,nonce);}finally{CloseHandle(ready);}DateTime deadline=DateTime.UtcNow.AddSeconds(15);while(DateTime.UtcNow<deadline){try{IntPtr acknowledgement=Child(directory,acknowledgementName,false,OPEN);try{if(Read(acknowledgement)!=nonce)throw new IOException("fixture acknowledgement invalid");}finally{CloseHandle(acknowledgement);}break;}catch(IOException error){if(error.Message=="fixture acknowledgement invalid")throw;System.Threading.Thread.Sleep(10);}}if(DateTime.UtcNow>=deadline)throw new IOException("fixture acknowledgement timeout");while(DateTime.UtcNow<deadline){try{IntPtr release=Child(directory,releaseName,false,OPEN);try{if(Read(release)!=nonce)throw new IOException("fixture release invalid");}finally{CloseHandle(release);}return;}catch(IOException error){if(error.Message=="fixture release invalid")throw;System.Threading.Thread.Sleep(10);}}throw new IOException("fixture release timeout");}\n public static void Publish(string directory,string fileName,string record,string temporaryFileName,string readyName,string acknowledgementName,string releaseName,string nonce,string baseline){',
      )
      .replace(
        /try\{Write\(temp,record\);/,
        "try{Write(temp,record);WaitForFixtureRelease(current,readyName,acknowledgementName,releaseName,nonce,baseline);",
      )
      .replace(
        /\[AdmissionPublisher\]::Publish\(\$directory,\$frame\.fileName,\$frame\.record,\$frame\.temporaryFileName\)/,
        "[AdmissionPublisher]::Publish($directory,$frame.fileName,$frame.record,$frame.temporaryFileName,$frame.readyFileName,$frame.acknowledgementFileName,$frame.releaseFileName,$frame.readyNonce,$frame.readyBaseline)",
      )
  );
}

async function publishHeldTempFixture(directory, fileName, record, temporaryFileName, coordination) {
  const boundary = await resolveWindowsAdmissionPublisherBoundary();
  const fixturePath = join(directory, ".admission-test-held-fixture.ps1");
  const fixtureSource = heldTempFixtureSource();
  await writeFile(fixturePath, fixtureSource, "utf8");
  await new Promise((resolve, reject) => {
    const child = spawn(
      boundary.executable,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", fixturePath, directory],
      { stdio: ["pipe", "ignore", "pipe"], windowsHide: true, env: boundary.environment },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`fixture_exit_${code}:${stderr.slice(0, 200)}`)),
    );
    child.stdin.end(
      JSON.stringify({ fileName, record: `${JSON.stringify(record)}\n`, temporaryFileName, ...coordination }),
    );
  });
}

test("production admission is Windows-only and accepts only canonical drive absolute grammar", () => {
  const parsed = parseProductionAdmissionInvocation(valid());
  assert.deepEqual(parsed.scenarioIds, ["SIM-01", "SIM-02"]);
  for (const path of [
    "/safe/output.json",
    "C:relative.json",
    "\\\\server\\share\\result.json",
    "C:/safe/result.json",
    "C:\\safe\\..\\result.json",
    "C:\\safe\\result?.json",
  ]) {
    const argv = valid();
    argv[argv.indexOf("--output") + 1] = path;
    assert.throws(() => parseProductionAdmissionInvocation(argv), /admission_path_not_absolute/);
  }
  assert.throws(
    () => parseProductionAdmissionInvocation(valid(), { platform: "linux" }),
    /admission_platform_unsupported/,
  );
  const fakeWin32 = { isAbsolute: (value) => /^[A-Za-z]:\\/.test(value) };
  assert.equal(
    parseProductionAdmissionInvocation(valid(), { platform: "win32", pathApi: fakeWin32 }).outputPath,
    "C:\\safe\\result.json",
  );
});

test("production admission parses only fixed real preflight profiles and rejects overrides", () => {
  for (const mutation of [
    ["--fixture-adapter", "x"],
    ["--model", "x"],
    ["--scenario", "SIM-04"],
    ["--control-token", "secret"],
  ])
    assert.throws(
      () => parseProductionAdmissionInvocation([...valid(), ...mutation]),
      /admission_cli_forbidden_override/,
    );
  assert.throws(
    () => parseProductionAdmissionInvocation([...valid(), "--live-evidence-artifact", "C:\\forged.jsonl"]),
    /admission_cli_unknown_flag/,
  );
  assert.throws(
    () => parseProductionAdmissionInvocation(valid().filter((value) => value !== "--preflight-only")),
    /admission_cli_required_flag_missing/,
  );
  assert.throws(
    () => parseProductionAdmissionInvocation(valid().map((value) => (value === "preview_run_a_v1" ? "other" : value))),
    /admission_profile_invalid/,
  );
});

test("Phase A is read-only and consumes the fixed supervisor reason after it succeeds", async () => {
  let reads = 0,
    probes = 0;
  const record = await runProductionAdmissionPreflight(parseProductionAdmissionInvocation(valid()), {
    read: async () => {
      reads += 1;
      return ownedManifest;
    },
    supervisorProbe: async () => {
      probes += 1;
      return {
        schema: "gamebuddy-stardew-companion-admission-probe/v1",
        state: "blocked",
        reasonCode: "companion_live_source_attestation_unavailable",
      };
    },
  });
  assert.equal(reads, 1);
  assert.equal(probes, 1);
  assert.deepEqual(record.reasonCodes, ["companion_live_source_attestation_unavailable"]);
  assert.equal(JSON.stringify(record).includes("C:\\operator.json"), false);
});

test("unavailable or malformed supervisor results and fixture faults fail closed with redacted reasons", async () => {
  const invocation = parseProductionAdmissionInvocation(valid());
  for (const supervisorProbe of [
    async () => {
      throw new Error("C:\\secret-token");
    },
    async () => ({ schema: "wrong", state: "blocked", reasonCode: "companion_live_source_attestation_unavailable" }),
  ]) {
    const record = await runProductionAdmissionPreflight(invocation, {
      read: async () => ownedManifest,
      supervisorProbe,
    });
    assert.equal(record.state, "blocked");
    assert.equal(JSON.stringify(record).includes("secret-token"), false);
    assert.notEqual(record.reasonCodes[0], "companion_live_source_attestation_unavailable");
  }
  let probes = 0;
  const record = await runProductionAdmissionPreflight(invocation, {
    read: async () => {
      throw new Error("C:\\private");
    },
    supervisorProbe: async () => {
      probes += 1;
      return {};
    },
  });
  assert.equal(record.state, "blocked");
  assert.equal(probes, 0);
  assert.equal(JSON.stringify(record).includes("private"), false);
});

test("record reason codes are a frozen allowlist and cannot persist paths or tokens", async () => {
  for (const reason of ["C:\\secret\\token", "eyJhbGciOiJIUzI1NiJ9", "arbitrary_reason"])
    assert.throws(() => blockedAdmissionRecord("preview_run_a_v1", reason), /admission_reason_code_invalid/);
  for (const reason of ["C:\\secret\\token", "eyJhbGciOiJIUzI1NiJ9"])
    await assert.rejects(
      () =>
        writeProductionAdmissionRecord(
          "C:\\safe\\result.json",
          { ...blockedRecord(), reasonCodes: [reason] },
          { publisher: async () => assert.fail("must not publish"), platform: "win32" },
        ),
      /admission_output_record_invalid/,
    );
});

test("source-run publisher resolves the runbook-validated local SystemRoot PowerShell without inheriting parent environment", async () => {
  const boundary = await resolveWindowsAdmissionPublisherBoundary();
  assert.match(boundary.executable, /^[A-Za-z]:\\.+\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.deepEqual(boundary.environment, { SystemRoot: process.env.SystemRoot, WINDIR: process.env.SystemRoot });
  let spawned;
  const child = new EventEmitter();
  child.stdin = new Writable({
    write(_chunk, _encoding, done) {
      done();
    },
  });
  child.stderr = new EventEmitter();
  child.stderr.setEncoding = () => {};
  await publishWithPowerShell("C:\\safe", "result.json", blockedRecord(), undefined, {
    spawnFn: (...args) => {
      spawned = args;
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    },
  });
  assert.equal(spawned[0], boundary.executable);
  assert.deepEqual(spawned[2].env, boundary.environment);
  assert.equal(Object.hasOwn(spawned[2].env, "PATH"), false);
  assert.equal(Object.hasOwn(spawned[2].env, "CONTROL_TOKEN"), false);
});

test("source-run publisher rejects a fake matching SystemRoot/WINDIR pair that cannot resolve locally before spawn", async () => {
  const originalSystemRoot = process.env.SystemRoot,
    originalWindir = process.env.WINDIR;
  try {
    let spawned;
    const child = new EventEmitter();
    child.stdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    child.stderr = new EventEmitter();
    child.stderr.setEncoding = () => {};
    await publishWithPowerShell("C:\\safe", "result.json", blockedRecord(), undefined, {
      spawnFn: (...args) => {
        spawned = args;
        queueMicrotask(() => child.emit("exit", 0));
        return child;
      },
    });
    assert.equal(spawned[0], (await resolveWindowsAdmissionPublisherBoundary()).executable);
    process.env.SystemRoot = "C:\\fake";
    process.env.WINDIR = "C:\\fake";
    let called = false;
    await assert.rejects(
      () =>
        publishWithPowerShell("C:\\safe", "result.json", blockedRecord(), undefined, {
          spawnFn: () => {
            called = true;
          },
        }),
      /admission_publisher_system_root_invalid/,
    );
    assert.equal(called, false);
  } finally {
    if (originalSystemRoot === undefined) delete process.env.SystemRoot;
    else process.env.SystemRoot = originalSystemRoot;
    if (originalWindir === undefined) delete process.env.WINDIR;
    else process.env.WINDIR = originalWindir;
  }
});

test("writer delegates only checked directory, leaf name, and a fresh bounded record to the secure publisher", async () => {
  let call;
  const source = blockedRecord();
  await writeProductionAdmissionRecord("C:\\safe\\result.json", source, {
    platform: "win32",
    publisher: async (...args) => {
      call = args;
    },
  });
  assert.equal(call[0], "C:\\safe");
  assert.equal(call[1], "result.json");
  assert.deepEqual(call[2], blockedRecord());
  assert.notEqual(call[2], source);
  await assert.rejects(
    () =>
      writeProductionAdmissionRecord("C:\\safe\\result.json", blockedRecord(), {
        platform: "linux",
        publisher: async () => {},
      }),
    /admission_path_not_absolute/,
  );
  await assert.rejects(
    () =>
      writeProductionAdmissionRecord("C:\\safe\\result.json", blockedRecord(), {
        publisher: async () => {
          throw new Error("EEXIST");
        },
      }),
    /admission_output_write_failed/,
  );
});

test("writer rejects noncanonical descriptors and never gives publisher a caller-controlled serializer or secret", async () => {
  const withToJson = {
    ...blockedRecord(),
    scenarioIds: [...blockedRecord().scenarioIds],
    reasonCodes: [...blockedRecord().reasonCodes],
  };
  Object.defineProperty(withToJson, "toJSON", { value: () => ({ token: "secret" }), enumerable: false });
  const accessor = { ...blockedRecord() };
  Object.defineProperty(accessor, "profile", { get: () => "preview_run_a_v1", enumerable: true });
  for (const record of [withToJson, accessor]) {
    await assert.rejects(
      () =>
        writeProductionAdmissionRecord("C:\\safe\\result.json", record, {
          platform: "win32",
          publisher: async () => assert.fail("must not publish"),
        }),
      /admission_output_record_invalid/,
    );
  }
  const mutable = {
    ...blockedRecord(),
    scenarioIds: [...blockedRecord().scenarioIds],
    reasonCodes: [...blockedRecord().reasonCodes],
  };
  let published;
  await writeProductionAdmissionRecord("C:\\safe\\result.json", mutable, {
    platform: "win32",
    publisher: async (_directory, _name, record) => {
      published = record;
      mutable.reasonCodes[0] = "C:\\secret";
      mutable.scenarioIds[0] = "not-canonical";
    },
  });
  assert.deepEqual(published, blockedRecord());
  assert.equal(JSON.stringify(published).includes("secret"), false);
});

test("secure publisher source binds descendants to handles, creates temp no-replace, publishes no-replace, and only deletes its created handle", () => {
  assert.match(WINDOWS_SECURE_ADMISSION_PUBLISHER, /NtCreateFile/);
  assert.match(WINDOWS_SECURE_ADMISSION_PUBLISHER, /RootDirectory=parent/);
  assert.match(WINDOWS_SECURE_ADMISSION_PUBLISHER, /OPEN_REPARSE_POINT|REPARSE/);
  assert.match(WINDOWS_SECURE_ADMISSION_PUBLISHER, /FILE_LINK_INFORMATION|NtSetInformationFile/);
  assert.match(WINDOWS_SECURE_ADMISSION_PUBLISHER, /SHARE_ALL=7, SHARE_READ=1/);
  assert.match(WINDOWS_SECURE_ADMISSION_PUBLISHER, /directory\?SHARE_ALL:SHARE_READ/);
  assert.doesNotMatch(WINDOWS_SECURE_ADMISSION_PUBLISHER, /File\.Delete\(/);
  assert.doesNotMatch(WINDOWS_SECURE_ADMISSION_PUBLISHER, /Remove-Item/);
  assert.doesNotMatch(
    WINDOWS_SECURE_ADMISSION_PUBLISHER,
    /testReady|testAcknowledgement|testRelease|testNonce|testBaseline|WaitForTestRelease/,
  );
});

test(
  "Windows secure publisher succeeds with its frozen SystemRoot/WINDIR child environment and rejects a collision without overwrite",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(process.cwd(), "gamebuddy-admission-"));
    const output = `${directory}\\result.json`;
    try {
      await writeProductionAdmissionRecord(output, blockedRecord());
      const original = await readFile(output);
      assert.deepEqual(JSON.parse(original.toString("utf8")), blockedRecord());
      await assert.rejects(
        () => writeProductionAdmissionRecord(output, blockedRecord()),
        /admission_output_write_failed/,
      );
      assert.deepEqual(await readFile(output), original);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows secure publisher denies a concurrent current-user peer write and delete access to its held temporary record",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(process.cwd(), "gamebuddy-admission-"));
    const tempName = ".admission-test-held.tmp",
      readyFileName = ".admission-test-ready",
      acknowledgementFileName = ".admission-test-acknowledgement",
      releaseFileName = ".admission-test-release";
    const output = `${directory}\\result.json`,
      tempPath = join(directory, tempName),
      original = blockedRecord();
    const readyBaseline = randomUUID(),
      readyNonce = randomUUID();
    const boundary = await resolveWindowsAdmissionPublisherBoundary();
    const waitForExactFile = async (fileName, expected) => {
      for (let attempt = 0; attempt < 500; attempt += 1) {
        try {
          if ((await readFile(join(directory, fileName), "utf8")) === expected) return;
        } catch {}
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`publisher did not produce expected ${fileName} nonce`);
    };
    let publishing;
    try {
      // The helper must replace this unique baseline with the nonce only after
      // WriteFile+FlushFileBuffers, so stale setup cannot satisfy the barrier.
      await writeFile(join(directory, readyFileName), readyBaseline);
      publishing = publishHeldTempFixture(directory, "result.json", original, tempName, {
        readyFileName,
        acknowledgementFileName,
        releaseFileName,
        readyNonce,
        readyBaseline,
      });
      await waitForExactFile(readyFileName, readyNonce);
      const observedPeerProbe = await probeHeldTempFromPeer(
        boundary.executable,
        boundary.environment,
        directory,
        readyNonce,
      );
      // `read: 0` is the peer's direct CreateFile proof that this is the same
      // held temporary object; share=7 is used for each peer probe.
      assert.deepEqual(observedPeerProbe, { path: tempPath, readyNonce, read: 0, write: 32, delete: 32 });
      await waitForExactFile(acknowledgementFileName, readyNonce);
      // Linking remains blocked until this explicit post-probe release.
      await writeFile(join(directory, releaseFileName), readyNonce);
      await publishing;
      assert.deepEqual(JSON.parse(await readFile(output, "utf8")), original);
    } finally {
      // Unblock any failed assertion path before removing all test-only markers.
      await writeFile(join(directory, releaseFileName), readyNonce).catch(() => {});
      await publishing?.catch(() => {});
      for (let attempt = 0; attempt < 50; attempt += 1) {
        try {
          await rm(directory, { recursive: true, force: true });
          break;
        } catch (error) {
          if (attempt === 49) throw error;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      }
    }
  },
);

test(
  "Windows secure publisher leaves a colliding deterministic temp name untouched",
  { skip: process.platform !== "win32" },
  async () => {
    const directory = await mkdtemp(join(process.cwd(), "gamebuddy-admission-"));
    const tempName = ".admission-test-collision.tmp",
      tempPath = join(directory, tempName);
    try {
      await writeFile(tempPath, "original-temp-bytes");
      await assert.rejects(
        () =>
          writeProductionAdmissionRecord(`${directory}\\result.json`, blockedRecord(), { temporaryFileName: tempName }),
        /admission_output_write_failed/,
      );
      assert.equal(await readFile(tempPath, "utf8"), "original-temp-bytes");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

test(
  "Windows secure publisher rejects a symlink ancestor where the fixture can be created",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(process.cwd(), "gamebuddy-admission-"));
    const linked = join(directory, "linked"),
      target = join(directory, "target");
    try {
      await (await import("node:fs/promises")).mkdir(target);
      try {
        await symlink(target, linked, "junction");
      } catch (error) {
        t.diagnostic(`junction fixture unavailable: ${error.code}`);
        return;
      }
      await assert.rejects(
        () => writeProductionAdmissionRecord(`${linked}\\result.json`, blockedRecord()),
        /admission_output_write_failed/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
