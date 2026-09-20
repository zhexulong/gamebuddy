import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
  type VoicePreference,
  VoicePreferenceRevisionConflict,
  VoicePreferenceStore,
} from "./voice-preference-store.js";

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

async function withStore(run: (path: string, store: VoicePreferenceStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-voice-preference-"));
  try {
    const path = join(root, "settings", "voice-preference.json");
    await run(path, new VoicePreferenceStore(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("voice cloud TTS preference defaults durably and projects exact public keys", async () => {
  await withStore(async (path, store) => {
    assert.deepEqual(await store.read(), {
      revision: 0,
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
    } satisfies VoicePreference);

    const accepted = await store.update(0, {
      action: "accept",
      disclosureVersion: VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
    });
    assert.equal(accepted.revision, 1);
    assert.equal(accepted.consent, "accepted");
    assert.equal(accepted.disclosureVersion, VOICE_CLOUD_TTS_DISCLOSURE_VERSION);
    assert.equal(typeof accepted.decidedAtMs, "number");
    assert.deepEqual(Object.keys(accepted).sort(), ["consent", "decidedAtMs", "disclosureVersion", "revision"]);

    const reopened = await new VoicePreferenceStore(path).read();
    assert.deepEqual(reopened, accepted);
  });
});

test("revoke preserves the accepted disclosure revision and Host owns the decision time", async () => {
  await withStore(async (_path, store) => {
    const accepted = await store.update(0, {
      action: "accept",
      disclosureVersion: VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
    });
    const revoked = await store.update(accepted.revision, { action: "revoke" });
    assert.equal(revoked.revision, 2);
    assert.equal(revoked.consent, "revoked");
    assert.equal(revoked.disclosureVersion, VOICE_CLOUD_TTS_DISCLOSURE_VERSION);
    assert.equal(typeof revoked.decidedAtMs, "number");
    assert.ok(revoked.decidedAtMs! >= accepted.decidedAtMs!);
  });
});

test("initial revoke has no disclosure revision", async () => {
  await withStore(async (_path, store) => {
    const revoked = await store.update(0, { action: "revoke" });
    assert.deepEqual(revoked, {
      revision: 1,
      disclosureVersion: null,
      consent: "revoked",
      decidedAtMs: revoked.decidedAtMs,
    });
    assert.equal(typeof revoked.decidedAtMs, "number");
  });
});

test("stale revisions and unapproved disclosure versions are rejected without mutation", async () => {
  await withStore(async (_path, store) => {
    await assert.rejects(
      store.update(0, { action: "accept", disclosureVersion: "other-version" } as never),
      /invalid_voice_preference_update/,
    );
    await assert.rejects(store.update(-1, { action: "revoke" } as never), /invalid_voice_preference_update/);

    const accepted = await store.update(0, {
      action: "accept",
      disclosureVersion: VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
    });
    await assert.rejects(
      store.update(0, { action: "revoke" }),
      VoicePreferenceRevisionConflict,
    );
    assert.equal((await store.read()).revision, accepted.revision);
  });
});

test("persisted JSON requires the exact schema and rejects malformed or duplicate keys", async () => {
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    const valid = {
      schemaVersion: 1,
      revision: 0,
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
    };

    await writeFile(path, JSON.stringify({ ...valid, extra: true }));
    await assert.rejects(store.read(), /invalid_voice_preference_store/);

    await writeFile(path, JSON.stringify({ ...valid, disclosureVersion: "not-approved" }));
    await assert.rejects(store.read(), /invalid_voice_preference_store/);

    await writeFile(
      path,
      '{"schemaVersion":1,"revision":0,"disclosureVersion":null,"consent":"undecided","decidedAtMs":null,"consent":"undecided"}',
    );
    await assert.rejects(store.read(), /invalid_voice_preference_store/);
  });
});
