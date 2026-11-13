/**
 * Stardew Guardian named-object presence probe (composition-owned).
 *
 * It answers one question about the two OS objects a Guardian binding names:
 * does the named player Job Object still exist, and does the named lease mutex
 * still exist? The answer is `absent` only for the one Win32 result that means
 * "no such object", and it is deliberately blind to everything else.
 *
 * Why this lives under `composition/`: the game layer owns the presence
 * CONTRACT and the release decision, but ADR-0007 keeps `games/**` free of
 * Windows and native modules. Composition is the layer that admits a platform
 * capability and injects it into the selected game adapter.
 *
 * The transport is one bounded one-shot PowerShell process with a fixed script
 * (`-EncodedCommand`, so no caller value is ever parsed as command text) and the
 * two object names handed over as environment variables. Both halves are read
 * in that one process so a pair can never be observed across two different
 * moments of the Guardian's teardown.
 */
import { type ChildProcess, spawn } from "node:child_process";

import type {
  StardewGuardianNamedObjectAnswer,
  StardewGuardianNamedObjectNames,
  StardewGuardianNamedObjectProbe,
} from "../../games/stardew/lifecycle/stardew-guardian-object-presence.js";
import { resolveWindowsPowerShell } from "../../windows-powershell-executable.js";

/**
 * The name grammar the native Guardian itself enforces when it creates the
 * objects (`GuardianLease.ValidateName` and the owner-record generator). A name
 * outside it could not have been created by a Guardian, so it is not evidence
 * about any object and is never probed.
 */
const GUARDIAN_OBJECT_NAME = /^Local\\[A-Za-z0-9_-]{1,128}$/u;

/** `OpenJobObjectW` with only `JOB_OBJECT_QUERY`: enough to prove existence, nothing that can act. */
const JOB_OBJECT_QUERY = 0x0004;
/** `OpenMutexW` with only `SYNCHRONIZE`. */
const SYNCHRONIZE = 0x00100000;

/**
 * Borrow the Add-Type compiler plus one interpreter start; the guardian-live
 * fixture measured this well inside a few seconds. It is a hang detector for a
 * probe that is run at most once per held attempt at Host boot, never a latency
 * budget.
 */
const PROBE_TIMEOUT_MS = 30_000;

/** The one Win32 answer that is proof of absence (ERROR_FILE_NOT_FOUND). */
const ERROR_FILE_NOT_FOUND = 2;

/**
 * Maps one open attempt's Win32 result to the presence vocabulary.
 *
 * Only `ERROR_FILE_NOT_FOUND` is absence. `ERROR_ACCESS_DENIED` (5) means the
 * object exists with a DACL this user cannot open - a foreign owner, or the
 * Guardian's own protected descriptor seen by a principal it does not name -
 * and `ERROR_INVALID_HANDLE` (6) means the name resolves to a different object
 * kind. Both are objects that may still own a player world, so both are
 * `unclassified`.
 */
export function classifyGuardianObjectWin32Error(win32Error: number): StardewGuardianNamedObjectAnswer {
  if (win32Error === 0) return "opened";
  if (win32Error === ERROR_FILE_NOT_FOUND) return "not_found";
  return "unclassified";
}

/**
 * The production probe. It never throws: a missing PowerShell, a spawn failure,
 * a timeout, a non-zero exit, unreadable output or a malformed name are all
 * `unclassified`, because every one of them is a probe that did not measure -
 * not a measurement of absence.
 */
export const probeWindowsStardewGuardianObjects: StardewGuardianNamedObjectProbe = runProbe;

async function runProbe(
  names: StardewGuardianNamedObjectNames,
): Promise<Readonly<{ playerJob: StardewGuardianNamedObjectAnswer; lease: StardewGuardianNamedObjectAnswer }>> {
  const unclassified = Object.freeze({
    playerJob: "unclassified" as StardewGuardianNamedObjectAnswer,
    lease: "unclassified" as StardewGuardianNamedObjectAnswer,
  });
  if (process.platform !== "win32") return unclassified;
  if (!GUARDIAN_OBJECT_NAME.test(names.playerJobName) || !GUARDIAN_OBJECT_NAME.test(names.leaseName))
    return unclassified;
  const powershell = resolveWindowsPowerShell();
  if (powershell === undefined) return unclassified;
  const output = await runEncodedScript(powershell, names);
  if (output === undefined) return unclassified;
  return Object.freeze({
    playerJob: answerFromOutput(output, "player_job"),
    lease: answerFromOutput(output, "lease"),
  });
}

/** The fixed script. No caller value is interpolated into it; names arrive as environment variables. */
const GUARDIAN_OBJECT_PROBE_SCRIPT = `$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class GameBuddyGuardianObjectProbe
{
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenJobObjectW(uint desiredAccess, bool inheritHandle, string name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr OpenMutexW(uint desiredAccess, bool inheritHandle, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);
    public static int Job(string name)
    {
        var handle = OpenJobObjectW(${JOB_OBJECT_QUERY}, false, name);
        if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error();
        CloseHandle(handle);
        return 0;
    }
    public static int Mutex(string name)
    {
        var handle = OpenMutexW(${SYNCHRONIZE}, false, name);
        if (handle == IntPtr.Zero) return Marshal.GetLastWin32Error();
        CloseHandle(handle);
        return 0;
    }
}
'@
[Console]::Out.WriteLine('player_job=' + [GameBuddyGuardianObjectProbe]::Job($env:GAMEBUDDY_GUARDIAN_PROBE_PLAYER_JOB))
[Console]::Out.WriteLine('lease=' + [GameBuddyGuardianObjectProbe]::Mutex($env:GAMEBUDDY_GUARDIAN_PROBE_LEASE))
`;

const PLAYER_JOB_ENVIRONMENT = "GAMEBUDDY_GUARDIAN_PROBE_PLAYER_JOB";
const LEASE_ENVIRONMENT = "GAMEBUDDY_GUARDIAN_PROBE_LEASE";

async function runEncodedScript(
  powershell: string,
  names: StardewGuardianNamedObjectNames,
): Promise<string | undefined> {
  const encoded = Buffer.from(GUARDIAN_OBJECT_PROBE_SCRIPT, "utf16le").toString("base64");
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stdout: Buffer[] = [];
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      resolve(value);
    };
    let child: ChildProcess;
    try {
      child = spawn(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
        {
          env: {
            ...process.env,
            [PLAYER_JOB_ENVIRONMENT]: names.playerJobName,
            [LEASE_ENVIRONMENT]: names.leaseName,
          },
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
    } catch {
      finish(undefined);
      return;
    }
    // Cleanup kills exactly this child, the one process this probe started.
    const abandon = () => {
      if (settled) return;
      try {
        child.kill();
      } catch {
        // The terminal fallback below still settles the probe.
      }
      finish(undefined);
    };
    timer = setTimeout(abandon, PROBE_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout.push(Buffer.from(chunk));
    });
    child.stdout?.once("error", abandon);
    child.once("error", abandon);
    child.once("close", (code: number | null) => {
      if (code !== 0) {
        finish(undefined);
        return;
      }
      finish(Buffer.concat(stdout).toString("utf8"));
    });
  });
}

/** Reads one `name=<win32>` line; a missing or malformed line is unclassified for that object only. */
function answerFromOutput(output: string, field: string): StardewGuardianNamedObjectAnswer {
  const matches = [...output.matchAll(/^([a-z_]+)=([0-9]{1,10})\r?$/gmu)].filter((match) => match[1] === field);
  if (matches.length !== 1) return "unclassified";
  return classifyGuardianObjectWin32Error(Number(matches[0]![2]));
}
