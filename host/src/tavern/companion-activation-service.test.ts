import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { GameBrowserContractV1 } from "../game-browser-contract/index.js";

import {
  classifiedConnectionStatuses,
  createCompanionActivationService,
  gameSessionOccupiesTheInstallation,
  NON_OCCUPYING_CONNECTION_STATUSES,
} from "./companion-activation-service.js";
import {
  COMPANION_SWITCH_REQUEST_KEYS,
  COMPANION_SWITCH_REQUEST_SCHEMA,
  companionSwitchRequestPath,
} from "./companion-switch-request.js";

/**
 * Recording the player's choice of which companion this installation plays.
 *
 * The Host may only RECORD the choice: the companion in play is the deployment identity's
 * `companionId`, the semantic authority binds its database to that one principal, and the
 * launcher owns that identity. So every test here is about one of two things - the exact file
 * the launcher will read, or a refusal that names why the choice was not recorded.
 */

const runtimeRoot = async (): Promise<string> =>
  await realpath(await mkdtemp(join(await realpath(tmpdir()), "gamebuddy-companion-activation-")));

function gameState(overrides: Readonly<Record<string, unknown>> = {}): any {
  return {
    apiVersion: 1,
    build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
    csrfToken: "csrf",
    browserSession: { expiresAtMs: 1 },
    game: {
      prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
      instance: { status: "none", gameTitle: null, generation: 0 },
      compatibility: { status: "unchecked", message: null },
      attachment: { status: "none", generation: 0 },
      connectionStatus: "none",
      actionAuthority: "unavailable",
      role: null,
      companionName: null,
      selectedWorld: null,
      selectedSave: null,
      capabilitySummary: { available: false, count: 0 },
      latestOutcome: "none",
      ...overrides,
    },
  };
}

const ROSTER = Object.freeze([
  Object.freeze({
    handle: "HANDLE-ARCHIVED",
    companionId: "companion-archived",
    continuityId: "continuity-archived",
    name: "Nova",
  }),
]);

function service(options: Readonly<{ runtimeRoot: string }>) {
  return createCompanionActivationService({
    runtimeRoot: options.runtimeRoot,
    currentCompanionId: "companion-in-play",
    resolveCompanion: async (handle) => ROSTER.find((entry) => entry.handle === handle) ?? null,
    gameAuthorityPresent: false,
  });
}

test("a recorded choice is the exact file the launcher reads, and nothing else is written", async () => {
  const root = await runtimeRoot();
  const result = await service({ runtimeRoot: root }).activate("HANDLE-ARCHIVED");

  assert.deepEqual(result, { handle: "HANDLE-ARCHIVED", status: "recorded" });

  const path = companionSwitchRequestPath(root);
  const written = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
  // The key set IS the contract the launcher requires exactly (`CompanionSwitch.ReadRequest`).
  // One extra key there is a refusal of every request, so this asserts equality, not inclusion.
  assert.deepEqual(Object.keys(written).sort(), [...COMPANION_SWITCH_REQUEST_KEYS].sort());
  assert.equal(written.schemaVersion, COMPANION_SWITCH_REQUEST_SCHEMA);
  assert.equal(written.status, "requested");
  assert.equal(written.expectedActiveCompanionId, "companion-in-play");
  assert.equal(written.targetCompanionId, "companion-archived");
  // The target's OWN continuity, from her library record: the launcher never invents one,
  // because a continuity identifier it invented would not match the record her artifacts
  // were written under.
  assert.equal(written.targetContinuityId, "continuity-archived");
  assert.match(String(written.requestId), /^[0-9a-f-]{36}$/u);

  // One file, at the durable root: no second record, no directory of its own.
  assert.equal((await stat(path)).isFile(), true);
});

test("a handle this mount never projected records nothing at all", async () => {
  const root = await runtimeRoot();
  const result = await service({ runtimeRoot: root }).activate("HANDLE-NOT-ON-THE-ROSTER");

  // Null rather than a refusal: the caller cannot word a request about a companion the roster
  // never showed, and pretending it recorded one would tell the player a switch happened.
  assert.equal(result, null);
  await assert.rejects(stat(companionSwitchRequestPath(root)), /ENOENT/u);
});

test("the companion already in play is refused by name, and no request is written", async () => {
  const root = await runtimeRoot();
  const inPlay = createCompanionActivationService({
    runtimeRoot: root,
    currentCompanionId: "companion-in-play",
    gameAuthorityPresent: false,
    resolveCompanion: async () =>
      Object.freeze({ companionId: "companion-in-play", continuityId: "continuity-in-play", name: "Kohaku" }),
  });

  await assert.rejects(inPlay.activate("HANDLE-IN-PLAY"), /companion_switch_already_in_play/u);
  await assert.rejects(stat(companionSwitchRequestPath(root)), /ENOENT/u);
});

test("a running game refuses the switch by name, so the player is told to stop it first", async () => {
  const root = await runtimeRoot();
  const running = service({ runtimeRoot: root });

  await assert.rejects(
    running.activate("HANDLE-ARCHIVED", {
      readGameState: async () =>
        gameState({ instance: { status: "running", gameTitle: "Stardew Valley", generation: 1 } }),
    }),
    /companion_switch_requires_no_session/u,
  );
  // Nothing was recorded: a refusal that left a request behind would switch her at the next
  // launch, which is the opposite of what the player was told.
  await assert.rejects(stat(companionSwitchRequestPath(root)), /ENOENT/u);
});

test("an attached game with an idle turn is still a running game", async () => {
  const root = await runtimeRoot();
  for (const connectionStatus of [...classifiedConnectionStatuses()]) {
    const occupying = gameSessionOccupiesTheInstallation(
      gameState({ connectionStatus, attachment: { status: "attached", generation: 1 } }),
    );
    assert.equal(occupying, true, `an attached session with connection ${connectionStatus} must refuse the switch`);
  }
});

test("a mount that serves a Game authority but supplies no reader refuses rather than parking a live session", async () => {
  const root = await runtimeRoot();
  // The mount has a Game authority (so a session COULD be running) but the caller hands this
  // call no reader. Nothing can prove the game is stopped, so the switch must refuse: parking
  // the authority root out from under a live session is the failure this branch exists for.
  const unprovable = createCompanionActivationService({
    runtimeRoot: root,
    currentCompanionId: "companion-in-play",
    resolveCompanion: async (handle) => ROSTER.find((entry) => entry.handle === handle) ?? null,
    gameAuthorityPresent: true,
  });

  await assert.rejects(unprovable.activate("HANDLE-ARCHIVED"), /companion_switch_requires_no_session/u);
  await assert.rejects(stat(companionSwitchRequestPath(root)), /ENOENT/u);
});

test("a chat-only mount with no Game authority needs no game read at all", async () => {
  const root = await runtimeRoot();
  const chatOnly = createCompanionActivationService({
    runtimeRoot: root,
    currentCompanionId: "companion-in-play",
    resolveCompanion: async (handle) => ROSTER.find((entry) => entry.handle === handle) ?? null,
    gameAuthorityPresent: false,
  });

  // A chat-only composition constructs no Game authority, so no session can be running there
  // and the absence of a reader is the honest answer rather than an unprovable one.
  assert.deepEqual(await chatOnly.activate("HANDLE-ARCHIVED"), { handle: "HANDLE-ARCHIVED", status: "recorded" });
  assert.equal((await stat(companionSwitchRequestPath(root))).isFile(), true);
});

test("every connection status the contract declares has a position, so a new one cannot silently allow a switch", async () => {
  // Derived from the contract's own union: a member added to `ConnectionStatus` without a
  // decision here appears in neither list and fails this assertion by name.
  const declared = connectionStatusUnionMembers();
  const classified = new Set(classifiedConnectionStatuses());

  const unclassified = declared.filter((status) => !classified.has(status));
  assert.deepEqual(unclassified, [], `unclassified connection statuses: ${unclassified.join(",")}`);

  const invented = [...classified].filter((status) => !declared.includes(status));
  assert.deepEqual(invented, [], `classified statuses the contract does not declare: ${invented.join(",")}`);

  // And the two halves are disjoint: a status that is both occupying and free is a
  // classification that would answer differently depending on which list a reader asked.
  const occupying = classifiedConnectionStatuses().filter((status) =>
    gameSessionOccupiesTheInstallation(gameState({ connectionStatus: status })),
  );
  const overlapping = occupying.filter((status) => NON_OCCUPYING_CONNECTION_STATUSES.includes(status));
  assert.deepEqual(overlapping, [], `statuses classified both ways: ${overlapping.join(",")}`);
});

/**
 * The `ConnectionStatus` union as the contract declares it.
 *
 * Derived from the published schema rather than from the source text: the schema IS the
 * contract every reader validates against, so a member added there is a member here, and this
 * gate keeps working after the file is compiled, moved, or reformatted.
 */
function connectionStatusUnionMembers(): readonly string[] {
  const schema = GameBrowserContractV1.schemas.GameBrowserStateV1Schema as any;
  const connectionStatus = schema.properties?.game?.properties?.connectionStatus;
  const members = (connectionStatus?.anyOf ?? []) as readonly { const?: unknown }[];
  assert.ok(members.length > 0, "the contract no longer declares a connection-status union this gate can read");
  return members.map((member) => {
    assert.equal(
      typeof member.const,
      "string",
      "a connection-status member is not a literal, so it cannot be classified",
    );
    return member.const as string;
  });
}
