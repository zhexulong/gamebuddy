import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  characterizeStardewTargetVersion,
  EXPECTED_ASSEMBLY_VERSION,
  EXPECTED_SMAPI_VERSION,
  parseCliArgs,
  redactValue,
  SCHEMA,
  TARGET_ASSEMBLY_NAME,
} from "./stardew-humanlike-target-version-characterization.mjs";

const ARTIFACT_PATH = path.resolve(
  "integrations/stardew/tests/GameBuddy.Stardew.Integration.Tests/target-version-evidence/emote-facing-characterization.json",
);

test("parseCliArgs parses arguments and env variables correctly", () => {
  const custom = parseCliArgs([
    "--game-path",
    "C:/custom/game",
    "--out",
    "evidence.json",
    "--pretty",
  ]);
  assert.equal(custom.gamePath, "C:/custom/game");
  assert.equal(custom.out, "evidence.json");
  assert.equal(custom.pretty, true);
  assert.equal(custom.help, false);

  const help = parseCliArgs(["--help"]);
  assert.equal(help.help, true);

  const prevEnv = process.env.GAMEBUDDY_STARDEW_GAME_PATH;
  try {
    process.env.GAMEBUDDY_STARDEW_GAME_PATH = "C:/env/game";
    const fromEnv = parseCliArgs([]);
    assert.equal(fromEnv.gamePath, "C:/env/game");
  } finally {
    if (prevEnv !== undefined) {
      process.env.GAMEBUDDY_STARDEW_GAME_PATH = prevEnv;
    } else {
      delete process.env.GAMEBUDDY_STARDEW_GAME_PATH;
    }
  }
});

test("characterizeStardewTargetVersion throws game_path_required when no path is provided", async () => {
  await assert.rejects(
    characterizeStardewTargetVersion({ gamePath: undefined }),
    (error) => {
      assert.equal(error.code, "game_path_required");
      assert.match(error.message, /game_path_required/);
      return true;
    },
  );
});

test("characterizeStardewTargetVersion throws target_assembly_missing when Stardew Valley.dll is absent", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-test-empty-"));
  try {
    await assert.rejects(
      characterizeStardewTargetVersion({ gamePath: tempDir }),
      (error) => {
        assert.equal(error.code, "target_assembly_missing");
        assert.match(error.message, /Missing Stardew Valley.dll/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("characterizeStardewTargetVersion throws target_installation_mismatch when version differs", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-test-mismatch-"));
  try {
    const dummyDll = path.join(tempDir, TARGET_ASSEMBLY_NAME);
    await writeFile(dummyDll, "dummy-assembly-content");

    const mockRunner = async () => ({
      fileVersion: "1.5.6.22010",
      productVersion: "1.5.6",
    });

    await assert.rejects(
      characterizeStardewTargetVersion({ gamePath: tempDir, runner: mockRunner }),
      (error) => {
        assert.equal(error.code, "target_installation_mismatch");
        assert.match(error.message, /Expected Stardew 1.6.15 build 24356/);
        assert.match(error.message, /1.5.6.22010/);
        return true;
      },
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("redactValue replaces absolute game path, home dir, and temp dir", () => {
  const gamePath = "D:\\Steam\\steamapps\\common\\Stardew Valley";
  const input = {
    message: "Loaded from D:\\Steam\\steamapps\\common\\Stardew Valley\\Stardew Valley.dll",
    nested: {
      altSlash: "Path D:/Steam/steamapps/common/Stardew Valley/Content",
      home: `${os.homedir()}\\secret.txt`,
      tmp: `${os.tmpdir()}/temp.json`,
    },
    array: ["D:\\Steam\\steamapps\\common\\Stardew Valley", 42],
  };

  const output = redactValue(input, gamePath);
  assert.equal(output.message, "Loaded from <redacted-game-path>\\Stardew Valley.dll");
  assert.equal(output.nested.altSlash, "Path <redacted-game-path>/Content");
  assert.equal(output.nested.home, "<redacted-home>\\secret.txt");
  assert.equal(output.nested.tmp, "<redacted-temp>/temp.json");
  assert.equal(output.array[0], "<redacted-game-path>");
  assert.equal(output.array[1], 42);
});

test("characterizeStardewTargetVersion produces valid schema and contracts with mock runner", async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), "gamebuddy-test-mock-"));
  try {
    const dummyDll = path.join(tempDir, TARGET_ASSEMBLY_NAME);
    await writeFile(dummyDll, "mock-stardew-valley-binary");

    const mockRunner = async () => ({
      fileVersion: EXPECTED_ASSEMBLY_VERSION,
      productVersion: "1.6.15, , 24356, ",
      doEmoteMethods: [
        {
          name: "doEmote",
          declaringType: "StardewValley.Farmer",
          returnType: "System.Void",
          parameters: [{ name: "whichEmote", type: "System.Int32" }],
        },
      ],
      faceDirectionMethods: [
        {
          name: "faceDirection",
          declaringType: "StardewValley.Character",
          returnType: "System.Void",
          parameters: [{ name: "direction", type: "System.Int32" }],
        },
      ],
      facingProperty: {
        name: "FacingDirection",
        declaringType: "StardewValley.Character",
        type: "System.Int32",
        canRead: true,
        canWrite: true,
      },
      facingField: {
        name: "facingDirection",
        declaringType: "StardewValley.Character",
        type: "StardewValley.Network.NetDirection",
      },
      isEmotingField: {
        name: "isEmoting",
        declaringType: "StardewValley.Character",
        type: "System.Boolean",
        isPublic: true,
      },
      isEmotingProperty: {
        name: "IsEmoting",
        declaringType: "StardewValley.Character",
        type: "System.Boolean",
        canRead: true,
        canWrite: true,
      },
      isMovingMethod: {
        name: "isMoving",
        declaringType: "StardewValley.Character",
        returnType: "System.Boolean",
        parameters: [],
      },
      characterEmoteConstants: {
        happyEmote: 32,
        sadEmote: 28,
        questionMarkEmote: 8,
        exclamationEmote: 16,
        heartEmote: 20,
        sleepEmote: 24,
      },
      farmerEmotes: [
        {
          emoteString: "happy",
          emoteIconIndex: 32,
          displayNameKey: "Strings\\UI:Emote_Happy",
          hidden: false,
          facingDirection: 2,
        },
        {
          emoteString: "sad",
          emoteIconIndex: 28,
          displayNameKey: "Strings\\UI:Emote_Sad",
          hidden: false,
          facingDirection: 2,
        },
      ],
      directions: { up: 0, right: 1, down: 2, left: 3 },
      smapi: {
        fileVersion: "4.5.2.0",
        productVersion: "4.5.2+821167e5c511bf3a2d98f604e5e838561c469219",
      },
    });

    const result = await characterizeStardewTargetVersion({
      gamePath: tempDir,
      runner: mockRunner,
    });

    assert.equal(result.schema, SCHEMA);
    assert.equal(result.target.fileVersion, EXPECTED_ASSEMBLY_VERSION);
    assert.equal(result.target.assemblyName, TARGET_ASSEMBLY_NAME);
    assert.equal(result.target.gamePath, "<redacted-game-path>");
    assert.equal(result.liveObservation.state, "unavailable");
    assert.equal(result.contracts.emote.candidateAction, "express_emote");
    assert.equal(result.contracts.facing.candidateAction, "face_direction");
    assert.equal(result.contracts.facing.directions.cardinalValues.up, 0);
    assert.equal(result.contracts.facing.directions.cardinalValues.right, 1);
    assert.equal(result.contracts.facing.directions.cardinalValues.down, 2);
    assert.equal(result.contracts.facing.directions.cardinalValues.left, 3);
    assert.equal(result.contracts.emote.constants.candidateMapping.happy, 32);
    assert.equal(result.contracts.emote.constants.candidateMapping.sad, 28);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

test("verified target-version characterization artifact exists, is schema-valid, and redacted", async () => {
  const content = await readFile(ARTIFACT_PATH, "utf8");
  const data = JSON.parse(content);

  // Schema validation
  assert.equal(data.schema, SCHEMA);
  assert.ok(data.target, "target must be present");
  assert.ok(data.contracts, "contracts must be present");
  assert.ok(data.contracts.emote, "contracts.emote must be present");
  assert.ok(data.contracts.facing, "contracts.facing must be present");
  assert.ok(data.liveObservation, "liveObservation must be present");

  // Redaction checks: no unredacted paths in string representation
  assert.doesNotMatch(content, /[A-Za-z]:\\[^"'\r\n]*(?:Steam|steamapps|Users)/i);
  assert.equal(data.target.gamePath, "<redacted-game-path>");

  // Target version assertions
  assert.equal(data.target.assemblyName, "Stardew Valley.dll");
  assert.equal(data.target.fileVersion, EXPECTED_ASSEMBLY_VERSION);
  assert.equal(data.target.assemblyVersion, EXPECTED_ASSEMBLY_VERSION);
  assert.ok(data.target.lengthBytes > 0);
  assert.match(data.target.sha256, /^[0-9a-f]{64}$/);

  // SMAPI target assertions
  assert.equal(data.target.smapi?.assemblyName, "StardewModdingAPI.dll");
  assert.equal(data.target.smapi?.fileVersion, "4.5.2.0");
  assert.match(data.target.smapi?.productVersion, /^4\.5\.2/);

  // Emote contract assertions
  const emote = data.contracts.emote;
  assert.equal(emote.candidateAction, "express_emote");
  assert.equal(emote.declaringType, "StardewValley.Farmer");
  assert.equal(emote.baseType, "StardewValley.Character");
  assert.ok(Array.isArray(emote.methods));

  // Must have Farmer.doEmote(int whichEmote)
  const directDoEmote = emote.methods.find(
    (m) =>
      m.name === "doEmote" &&
      m.declaringType === "StardewValley.Farmer" &&
      m.parameters?.length === 1 &&
      m.parameters[0].name === "whichEmote" &&
      m.parameters[0].type === "System.Int32",
  );
  assert.ok(directDoEmote, "Farmer.doEmote(int whichEmote) must exist");

  // Emote busyCheck assertions
  assert.equal(emote.busyCheck.field.name, "isEmoting");
  assert.equal(emote.busyCheck.field.type, "System.Boolean");
  assert.equal(emote.busyCheck.property.name, "IsEmoting");
  assert.equal(emote.busyCheck.property.type, "System.Boolean");
  assert.match(emote.busyCheck.semantics, /emote_busy/);

  // Emote constants assertions
  const charConsts = emote.constants.characterConstants;
  assert.equal(charConsts.happyEmote, 32);
  assert.equal(charConsts.sadEmote, 28);
  assert.equal(charConsts.heartEmote, 20);
  assert.equal(charConsts.exclamationEmote, 16);
  assert.equal(charConsts.sleepEmote, 24);
  assert.equal(charConsts.questionMarkEmote, 8);
  assert.equal(charConsts.angryEmote, 12);
  assert.equal(charConsts.xEmote, 36);
  assert.equal(charConsts.pauseEmote, 40);
  assert.equal(charConsts.blushEmote, 60);

  // Emote mapping assertions
  const mapping = emote.constants.candidateMapping;
  assert.equal(mapping.happy, 32);
  assert.equal(mapping.sad, 28);
  assert.equal(mapping.heart, 20);
  assert.equal(mapping.exclamation, 16);
  assert.equal(mapping.sleep, 24);
  assert.equal(mapping.question, 8);

  // Facing contract assertions
  const facing = data.contracts.facing;
  assert.equal(facing.candidateAction, "face_direction");
  assert.equal(facing.declaringType, "StardewValley.Character");

  // Character.faceDirection(int direction)
  const faceDirMethod = facing.methods.find(
    (m) =>
      m.name === "faceDirection" &&
      m.declaringType === "StardewValley.Character" &&
      m.parameters?.length === 1 &&
      m.parameters[0].name === "direction" &&
      m.parameters[0].type === "System.Int32",
  );
  assert.ok(faceDirMethod, "Character.faceDirection(int direction) must exist");

  // Facing property and field
  assert.equal(facing.property.name, "FacingDirection");
  assert.equal(facing.property.declaringType, "StardewValley.Character");
  assert.equal(facing.field.name, "facingDirection");

  // Cardinal directions: Up=0, Right=1, Down=2, Left=3
  assert.deepEqual(facing.directions.cardinalValues, {
    up: 0,
    right: 1,
    down: 2,
    left: 3,
  });
  assert.deepEqual(facing.directions.game1Constants, {
    up: 0,
    right: 1,
    down: 2,
    left: 3,
  });

  // Moving check
  assert.equal(facing.movingCheck.method.name, "isMoving");
  assert.equal(facing.movingCheck.method.declaringType, "StardewValley.Character");
  assert.equal(facing.movingCheck.method.returnType, "System.Boolean");
  assert.match(facing.movingCheck.semantics, /actor_moving/);

  // Live observation
  assert.equal(data.liveObservation.state, "unavailable");
  assert.equal(data.liveObservation.reason, "no_real_game_thread_harness_exists");
});
