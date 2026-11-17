import assert from "node:assert/strict";
import { readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  openProductionContinuityStore,
  PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
} from "../continuity-semantic-store/continuity-semantic-production-store.js";
import {
  PRODUCTION_STORE_DATABASE,
  rewriteProductionStoreAsVersion45,
} from "../test-support/production-store-v45-fixture.test-support.js";
import { canonicalTestRootSync } from "../test-support/canonical-test-root.test-support.js";
import {
  openKnownProductionContinuity,
  provisionFreshProductionContinuity,
} from "./continuity-semantic-provisioning.internal.js";

const principal = { continuityId: "continuity_01", companionId: "companion_01", playerId: "player_01" };
const input = (runtimeCwd: string) => ({
  runtimeCwd,
  principal,
  bootstrapOperationId: "bootstrap_01",
  authorityGeneration: 1,
});
const AUTHORITY = ".gamebuddy-semantic-continuity-v1";
const MARKER = "production-authority-marker.json";
const UPGRADE_RECORD = "production-authority-upgrade.json";
const holderBindingDigest = "b".repeat(64);

function readMarker(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, AUTHORITY, MARKER), "utf8")) as Record<string, unknown>;
}

function writeMarkerVersion(root: string, version: number): void {
  writeFileSync(join(root, AUTHORITY, MARKER), JSON.stringify({ ...readMarker(root), schemaVersion: version }));
}

/** One root as the fresh path mints it, holding a registered, verified and selected initial Chat. */
function rootWithSelectedChat(): { root: string; chatThreadId: string } {
  const root = canonicalTestRootSync("s3-schema-upgrade-");
  provisionFreshProductionContinuity(input(root)).close();
  const control = openProductionContinuityStore({ runtimeRoot: join(root, AUTHORITY) });
  try {
    const bootstrap = {
      principal,
      bootstrapOperationId: "bootstrap_01",
      authorityGeneration: 1,
      authorityRootIdentity: readMarker(root).authorityRootIdentity as string,
    };
    const store = control.bindBootstrapContext({ bootstrap, metadata: control.validateBootstrap(bootstrap) });
    const claim = store.claim({
      holderBindingDigest,
      operationId: "claim-1",
      expected: { partitionRevision: 1, fenceEpoch: 1, selectionRevision: 0 },
    });
    const registered = store.register({ holderBindingDigest, operationId: "register-1", expected: claim.vector });
    const verified = store.verify(
      { holderBindingDigest, operationId: "verify-1", expected: registered.vector },
      Object.freeze({
        chatThreadId: registered.chatThreadId!,
        chatSurfaceSessionId: registered.chatSurfaceSessionId!,
        continuityId: principal.continuityId,
        companionId: principal.companionId,
        digest: "c".repeat(64),
      }),
    );
    store.select({ holderBindingDigest, operationId: "select-1", expected: verified.vector });
    return { root, chatThreadId: registered.chatThreadId! };
  } finally {
    control.close();
  }
}

/**
 * The upgrade, end to end through the mount a launch actually performs.
 *
 * A root minted by the previous build is opened by `openKnownProductionContinuity`, which is the only door
 * a known authority has: the store is migrated before any reader opens it, the fact is published beside the
 * deployment identity record, the marker moves to the version the root now holds, and every other marker
 * field stays byte-identical because none of them changed. The second open is the ordinary one - nothing is
 * left behind by the first.
 */
test("a version 45 root opens through the known-authority mount, and the upgrade is published by name", () => {
  const { root, chatThreadId } = rootWithSelectedChat();
  try {
    const markerBefore = readMarker(root);
    rewriteProductionStoreAsVersion45(join(root, AUTHORITY));
    writeMarkerVersion(root, 45);

    const reopened = openKnownProductionContinuity(input(root));
    try {
      assert.equal(reopened.schemaVersion, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
      assert.equal(reopened.store.readChatCatalog().threads[0]!.chatThreadId, chatThreadId);
      assert.equal(reopened.store.readChatCatalog().threads[0]!.contentState, "verified");
    } finally {
      reopened.close();
    }

    const markerAfter = readMarker(root);
    assert.deepEqual(
      { ...markerAfter, schemaVersion: markerBefore.schemaVersion },
      markerBefore,
      "the upgrade rewrote a marker field other than the version",
    );
    assert.equal(markerAfter.schemaVersion, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);

    const record = JSON.parse(readFileSync(join(root, UPGRADE_RECORD), "utf8")) as Record<string, unknown>;
    console.log(`authority upgrade: ${JSON.stringify(record)}`);
    assert.deepEqual(record, {
      authority: "SEMANTIC",
      fromVersion: 45,
      toVersion: PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION,
      drops: [
        "production_continuity_thread.lifecycle",
        "production_chat_lifecycle_metadata",
        "production_continuity_command.command_kind=transition_chat_lifecycle",
      ],
    });
    assert.equal(
      readdirSync(join(root, AUTHORITY)).includes(`${MARKER}.upgrade`),
      false,
      "the upgrade left its marker rewrite beside the marker",
    );

    const second = openKnownProductionContinuity(input(root));
    try {
      assert.equal(second.schemaVersion, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
    } finally {
      second.close();
    }
    assert.equal(
      JSON.parse(readFileSync(join(root, UPGRADE_RECORD), "utf8")).fromVersion,
      45,
      "the ordinary open after an upgrade published a second, different record",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A launch that dies between the store migration and the marker rewrite leaves exactly that: a store at this
 * build's version behind a marker that still names the old one. The next launch finishes it, and says so -
 * the record is derived from the migration table, so it names the same drops the interrupted one would have.
 */
test("a launch that finds the store already migrated finishes the marker and still publishes the upgrade", () => {
  const { root } = rootWithSelectedChat();
  try {
    writeMarkerVersion(root, 45);
    const reopened = openKnownProductionContinuity(input(root));
    try {
      assert.equal(reopened.schemaVersion, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
    } finally {
      reopened.close();
    }
    assert.equal(readMarker(root).schemaVersion, PRODUCTION_CONTINUITY_STORE_SCHEMA_VERSION);
    const record = JSON.parse(readFileSync(join(root, UPGRADE_RECORD), "utf8")) as Record<string, unknown>;
    assert.equal(record.fromVersion, 45);
    assert.equal((record.drops as string[]).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * The refusal that must not be a brick: a marker naming a version this build has no migration from is
 * refused BY NAME - the version is the only thing an operator can act on - and the refusal writes nothing,
 * so the root is exactly as it was for the build that can open it.
 *
 * The population of acceptable versions comes from `PRODUCTION_CONTINUITY_STORE_SCHEMA_MIGRATIONS`: 45 is
 * accepted because a step starts there, 44 is refused because none does. Removing the 45 -> 46 step from
 * that table would move 45 into this same refusal.
 */
test("a marker at a version with no migration is refused by name and left byte-identical", () => {
  const { root } = rootWithSelectedChat();
  try {
    writeMarkerVersion(root, 44);
    const markerPath = join(root, AUTHORITY, MARKER);
    const databasePath = join(root, AUTHORITY, PRODUCTION_STORE_DATABASE);
    const markerBefore = readFileSync(markerPath);
    const databaseBefore = readFileSync(databasePath);
    assert.throws(
      () => openKnownProductionContinuity(input(root)),
      (error: unknown) => error instanceof Error && error.message === "production_authority_schema_unopenable:44",
      "a version with no migration must be refused by name, not as an anonymous artifact",
    );
    assert.deepEqual(readFileSync(markerPath), markerBefore);
    assert.deepEqual(readFileSync(databasePath), databaseBefore);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
