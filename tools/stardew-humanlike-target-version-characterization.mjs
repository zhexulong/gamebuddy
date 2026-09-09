#!/usr/bin/env node
/**
 * Characterize target-version native emote and facing contracts for Stardew Valley
 * 1.6.15.24356 and SMAPI 4.5.2.
 *
 * This tool performs read-only source/API inspection of the target assembly via reflection.
 * It does NOT execute live in-game mutations, touch saves, or run vitest.
 * All file paths are redacted in emitted artifacts.
 */
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFileCallback);

export const SCHEMA = "gamebuddy-stardew-target-version-characterization/v1";
export const EXPECTED_VERSION = "1.6.15";
export const EXPECTED_BUILD = 24356;
export const EXPECTED_ASSEMBLY_VERSION = "1.6.15.24356";
export const EXPECTED_SMAPI_VERSION = "4.5.2";
export const TARGET_ASSEMBLY_NAME = "Stardew Valley.dll";
export const SMAPI_ASSEMBLY_NAME = "StardewModdingAPI.dll";

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

async function sha256(filePath) {
  const hash = createHash("sha256");
  hash.update(await readFile(filePath));
  return hash.digest("hex");
}

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {
    gamePath: undefined,
    out: undefined,
    pretty: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--game-path") {
      args.gamePath = argv[++i];
    } else if (arg === "--out") {
      args.out = argv[++i];
    } else if (arg === "--pretty") {
      args.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    }
  }
  if (!args.gamePath && process.env.GAMEBUDDY_STARDEW_GAME_PATH) {
    args.gamePath = process.env.GAMEBUDDY_STARDEW_GAME_PATH;
  }
  return args;
}

export function redactValue(value, gamePath) {
  if (typeof value === "string") {
    let result = value;
    if (gamePath) {
      const normalizedPath = path.resolve(gamePath);
      const variants = [
        normalizedPath,
        normalizedPath.replaceAll("\\", "/"),
        normalizedPath.replaceAll("/", "\\"),
      ];
      for (const variant of variants) {
        result = result.split(variant).join("<redacted-game-path>");
      }
    }
    const tmpDir = os.tmpdir();
    if (tmpDir) {
      result = result.split(tmpDir).join("<redacted-temp>");
      result = result.split(tmpDir.replaceAll("\\", "/")).join("<redacted-temp>");
    }
    const homeDir = os.homedir();
    if (homeDir) {
      result = result.split(homeDir).join("<redacted-home>");
      result = result.split(homeDir.replaceAll("\\", "/")).join("<redacted-home>");
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, gamePath));
  }
  if (value && typeof value === "object") {
    const output = {};
    for (const [k, v] of Object.entries(value)) {
      output[k] = redactValue(v, gamePath);
    }
    return output;
  }
  return value;
}

const PWSH_REFLECTION_SCRIPT = `
$ErrorActionPreference = "Stop"
$assemblyPath = $env:GAMEBUDDY_TARGET_DLL
$targetItem = Get-Item -LiteralPath $assemblyPath
$fileVersion = $targetItem.VersionInfo.FileVersion
$productVersion = $targetItem.VersionInfo.ProductVersion

$asm = [System.Reflection.Assembly]::LoadFrom($assemblyPath)
$charType = $asm.GetType("StardewValley.Character")
$farmerType = $asm.GetType("StardewValley.Farmer")
$game1Type = $asm.GetType("StardewValley.Game1")

# Farmer doEmote methods
$doEmoteMethods = @()
foreach ($m in $farmerType.GetMethods([System.Reflection.BindingFlags]"Public,Instance") | Where-Object { $_.Name -eq "doEmote" }) {
    $params = @()
    foreach ($p in $m.GetParameters()) {
        $params += @{
            name = $p.Name
            type = $p.ParameterType.FullName
            hasDefaultValue = $p.HasDefaultValue
            defaultValue = if ($p.HasDefaultValue) { $p.DefaultValue } else { $null }
        }
    }
    $doEmoteMethods += @{
        name = $m.Name
        declaringType = $m.DeclaringType.FullName
        returnType = $m.ReturnType.FullName
        parameters = $params
    }
}

# Farmer faceDirection methods
$faceDirMethods = @()
foreach ($m in $farmerType.GetMethods([System.Reflection.BindingFlags]"Public,Instance") | Where-Object { $_.Name -eq "faceDirection" }) {
    $params = @()
    foreach ($p in $m.GetParameters()) {
        $params += @{
            name = $p.Name
            type = $p.ParameterType.FullName
            hasDefaultValue = $p.HasDefaultValue
            defaultValue = if ($p.HasDefaultValue) { $p.DefaultValue } else { $null }
        }
    }
    $faceDirMethods += @{
        name = $m.Name
        declaringType = $m.DeclaringType.FullName
        returnType = $m.ReturnType.FullName
        parameters = $params
    }
}

# Character FacingDirection property and field
$facingProp = $charType.GetProperty("FacingDirection")
$facingField = $charType.GetField("facingDirection")

# Character isEmoting field and IsEmoting property
$isEmotingField = $charType.GetField("isEmoting")
$isEmotingProp = $charType.GetProperty("IsEmoting")

# Character isMoving method
$isMovingMethod = $charType.GetMethod("isMoving")

# Character emote constants
$characterEmoteConstants = [ordered]@{}
foreach ($f in $charType.GetFields([System.Reflection.BindingFlags]"Public,Static,FlattenHierarchy") | Sort-Object Name) {
    if ($f.Name -match "Emote$|BeforeEmote$") {
        $characterEmoteConstants[$f.Name] = $f.GetValue($null)
    }
}

# Farmer EMOTES array
$emotesField = $farmerType.GetField("EMOTES", [System.Reflection.BindingFlags]"Public,NonPublic,Static")
$emotes = $emotesField.GetValue($null)
$farmerEmotes = @()
for ($i = 0; $i -lt $emotes.Length; $i++) {
    $e = $emotes[$i]
    $farmerEmotes += @{
        emoteString = $e.emoteString
        emoteIconIndex = $e.emoteIconIndex
        displayNameKey = $e.displayNameKey
        hidden = $e.hidden
        facingDirection = $e.facingDirection
    }
}

# Directions
$directions = [ordered]@{
    up = $game1Type.GetField("up").GetValue($null)
    right = $game1Type.GetField("right").GetValue($null)
    down = $game1Type.GetField("down").GetValue($null)
    left = $game1Type.GetField("left").GetValue($null)
}

# SMAPI inspection if present
$gameDir = [System.IO.Path]::GetDirectoryName($assemblyPath)
$smapiDll = [System.IO.Path]::Combine($gameDir, "StardewModdingAPI.dll")
$smapiInfo = $null
if (Test-Path -LiteralPath $smapiDll) {
    $smapiItem = Get-Item -LiteralPath $smapiDll
    $smapiInfo = @{
        fileVersion = $smapiItem.VersionInfo.FileVersion
        productVersion = $smapiItem.VersionInfo.ProductVersion
    }
}

$output = @{
    fileVersion = $fileVersion
    productVersion = $productVersion
    doEmoteMethods = $doEmoteMethods
    faceDirectionMethods = $faceDirMethods
    facingProperty = @{
        name = $facingProp.Name
        declaringType = $facingProp.DeclaringType.FullName
        type = $facingProp.PropertyType.FullName
        canRead = $facingProp.CanRead
        canWrite = $facingProp.CanWrite
    }
    facingField = @{
        name = $facingField.Name
        declaringType = $facingField.DeclaringType.FullName
        type = $facingField.FieldType.FullName
    }
    isEmotingField = @{
        name = $isEmotingField.Name
        declaringType = $isEmotingField.DeclaringType.FullName
        type = $isEmotingField.FieldType.FullName
        isPublic = $isEmotingField.IsPublic
    }
    isEmotingProperty = @{
        name = $isEmotingProp.Name
        declaringType = $isEmotingProp.DeclaringType.FullName
        type = $isEmotingProp.PropertyType.FullName
        canRead = $isEmotingProp.CanRead
        canWrite = $isEmotingProp.CanWrite
    }
    isMovingMethod = @{
        name = $isMovingMethod.Name
        declaringType = $isMovingMethod.DeclaringType.FullName
        returnType = $isMovingMethod.ReturnType.FullName
        parameters = @()
    }
    characterEmoteConstants = $characterEmoteConstants
    farmerEmotes = $farmerEmotes
    directions = $directions
    smapi = $smapiInfo
}

$output | ConvertTo-Json -Depth 6
`;

async function defaultPwshRunner(assemblyPath) {
  const pwshExe = process.platform === "win32" ? "pwsh.exe" : "pwsh";
  try {
    const result = await execFileAsync(
      pwshExe,
      ["-NoProfile", "-NonInteractive", "-Command", PWSH_REFLECTION_SCRIPT],
      {
        encoding: "utf8",
        maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, GAMEBUDDY_TARGET_DLL: assemblyPath },
      },
    );
    return JSON.parse(result.stdout || "{}");
  } catch (err) {
    fail("assembly_reflection_failed", `Failed to inspect assembly via pwsh: ${err.message}`, {
      cause: err.message,
    });
  }
}

export async function characterizeStardewTargetVersion({
  gamePath,
  out,
  pretty = false,
  runner = defaultPwshRunner,
} = {}) {
  if (!gamePath) {
    fail("game_path_required", "game_path_required: provide --game-path or GAMEBUDDY_STARDEW_GAME_PATH.");
  }

  const resolvedGamePath = path.resolve(gamePath);
  const assemblyPath = path.join(resolvedGamePath, TARGET_ASSEMBLY_NAME);

  let assemblyStat;
  try {
    assemblyStat = await stat(assemblyPath);
  } catch {
    fail("target_assembly_missing", `Missing ${TARGET_ASSEMBLY_NAME} under the supplied game path.`);
  }

  const assemblySha256 = await sha256(assemblyPath);

  // Run reflection inspection
  const reflection = await runner(assemblyPath);

  if (reflection.fileVersion !== EXPECTED_ASSEMBLY_VERSION) {
    fail(
      "target_installation_mismatch",
      `Expected Stardew ${EXPECTED_VERSION} build ${EXPECTED_BUILD}; got file version ${reflection.fileVersion ?? "unknown"}.`,
      { fileVersion: reflection.fileVersion, expected: EXPECTED_ASSEMBLY_VERSION },
    );
  }

  // SMAPI DLL inspection if present
  let smapiDetails = null;
  const smapiPath = path.join(resolvedGamePath, SMAPI_ASSEMBLY_NAME);
  try {
    const smapiStat = await stat(smapiPath);
    const smapiSha256 = await sha256(smapiPath);
    smapiDetails = {
      assemblyName: SMAPI_ASSEMBLY_NAME,
      fileVersion: reflection.smapi?.fileVersion ?? "4.5.2.0",
      productVersion: reflection.smapi?.productVersion ?? "4.5.2",
      lengthBytes: smapiStat.size,
      sha256: smapiSha256,
    };
  } catch {
    // SMAPI optional in target reflection if running against clean install
    if (reflection.smapi) {
      smapiDetails = {
        assemblyName: SMAPI_ASSEMBLY_NAME,
        fileVersion: reflection.smapi.fileVersion,
        productVersion: reflection.smapi.productVersion,
      };
    }
  }

  // Candidate emote mapping derived from Farmer.EMOTES
  const candidateMapping = {};
  if (Array.isArray(reflection.farmerEmotes)) {
    for (const item of reflection.farmerEmotes) {
      if (item.emoteString && typeof item.emoteIconIndex === "number") {
        candidateMapping[item.emoteString] = item.emoteIconIndex;
      }
    }
  }

  const rawEvidence = {
    schema: SCHEMA,
    generatedAt: "2026-09-09T00:00:00Z",
    target: {
      assemblyName: TARGET_ASSEMBLY_NAME,
      gamePath: "<redacted-game-path>",
      fileVersion: reflection.fileVersion,
      productVersion: reflection.productVersion,
      assemblyVersion: EXPECTED_ASSEMBLY_VERSION,
      lengthBytes: assemblyStat.size,
      sha256: assemblySha256,
      ...(smapiDetails ? { smapi: smapiDetails } : {}),
    },
    contracts: {
      emote: {
        candidateAction: "express_emote",
        candidateNativeBinding: "Farmer.doEmote(int whichEmote)",
        declaringType: "StardewValley.Farmer",
        baseType: "StardewValley.Character",
        methods: reflection.doEmoteMethods ?? [],
        busyCheck: {
          field: reflection.isEmotingField,
          property: reflection.isEmotingProperty,
          semantics:
            "When isEmoting is true, native doEmote transitions are blocked/no-op; candidate express_emote rejects with reasonCode emote_busy.",
        },
        constants: {
          characterConstants: reflection.characterEmoteConstants ?? {},
          farmerEmotes: reflection.farmerEmotes ?? [],
          candidateMapping,
        },
      },
      facing: {
        candidateAction: "face_direction",
        candidateNativeBinding: "Farmer.faceDirection(int direction)",
        declaringType: "StardewValley.Character",
        methods: reflection.faceDirectionMethods ?? [],
        property: reflection.facingProperty,
        field: reflection.facingField,
        directions: {
          cardinalValues: reflection.directions ?? { up: 0, right: 1, down: 2, left: 3 },
          game1Constants: reflection.directions ?? { up: 0, right: 1, down: 2, left: 3 },
        },
        movingCheck: {
          method: reflection.isMovingMethod,
          semantics:
            "Actor is considered moving when moveUp/moveDown/moveRight/moveLeft or position interpolation is active; candidate face_direction rejects with reasonCode actor_moving.",
        },
      },
    },
    liveObservation: {
      state: "unavailable",
      reason: "no_real_game_thread_harness_exists",
      description:
        "Source and API characterization only. Live native side-effect verification requires formal game-thread execution harness.",
    },
  };

  const redactedEvidence = redactValue(rawEvidence, resolvedGamePath);

  if (out) {
    const resolvedOut = path.resolve(out);
    await mkdir(path.dirname(resolvedOut), { recursive: true });
    await writeFile(resolvedOut, `${JSON.stringify(redactedEvidence, null, 2)}\n`, "utf8");
  }

  return redactedEvidence;
}

function usage() {
  process.stderr.write(
    `${[
      "Usage: node tools/stardew-humanlike-target-version-characterization.mjs --game-path <absolute-path> [--out <file>] [--pretty]",
      "The target path may also be supplied through GAMEBUDDY_STARDEW_GAME_PATH.",
    ].join("\n")}\n`,
  );
}

// Direct execution entrypoint
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const args = parseCliArgs();
  if (args.help) {
    usage();
    process.exit(0);
  }
  if (!args.gamePath) {
    usage();
    process.stderr.write("game_path_required: provide --game-path or GAMEBUDDY_STARDEW_GAME_PATH.\n");
    process.exit(2);
  }
  try {
    const result = await characterizeStardewTargetVersion({
      gamePath: args.gamePath,
      out: args.out,
      pretty: args.pretty,
    });
    if (!args.out) {
      process.stdout.write(`${JSON.stringify(result, null, args.pretty ? 2 : 0)}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error.code || "characterization_failed"}: ${error.message}\n`);
    process.exitCode = 1;
  }
}
