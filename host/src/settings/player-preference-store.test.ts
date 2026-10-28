import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { bindWindowsStaleLockReclaimer } from "../path-lock.js";
import { createBuildWindowsStaleLockReclaimer } from "../windows-stale-lock-reclaimer/index.js";
import { canonicalTestRoot } from "../test-support/canonical-test-root.test-support.js";
import {
  PlayerPreferenceRevisionConflict,
  type PlayerPreference,
  PlayerPreferenceStore,
  playerPreferencePath,
  readStoredCompanionLocale,
  resolveCompanionLocale,
  resolveGamePromptAddition,
  resolvePacedDelivery,
  VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
} from "./player-preference-store.js";
import { MAX_GAME_PROMPT_ADDITION_CHARS } from "../tavern/browser-contract/index.js";

// The record's durable path lock releases through the Windows stale-lock
// reclaimer; bind the same capability the production runtime binds.
bindWindowsStaleLockReclaimer(await createBuildWindowsStaleLockReclaimer());

async function canonicalTemporaryRoot(): Promise<string> {
  const root = process.platform === "win32" ? process.env.LOCALAPPDATA : tmpdir();
  if (typeof root !== "string" || root.length === 0) throw new Error("test_local_app_data_unavailable");
  return realpath(root);
}

async function withStore(run: (path: string, store: PlayerPreferenceStore) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "gamebuddy-player-preference-"));
  try {
    const path = join(root, "settings", "player-preference.json");
    await run(path, new PlayerPreferenceStore(path));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("player preference defaults to unconfigured and projects one record with exact public keys", async () => {
  await withStore(async (_path, store) => {
    assert.deepEqual(await store.read(), {
      revision: 0,
      locale: null,
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
      outputDevice: null,
      persona: null,
      paced: false,
      gamePromptAddition: "",
    } satisfies PlayerPreference);

    const updated = await store.update(0, { action: "setLocale", locale: "zh-CN" });
    assert.equal(updated.revision, 1);
    assert.equal(updated.locale, "zh-CN");
    assert.deepEqual(Object.keys(updated).sort(), [
      "consent",
      "decidedAtMs",
      "disclosureVersion",
      "gamePromptAddition",
      "locale",
      "outputDevice",
      "paced",
      "persona",
      "revision",
    ]);
    assert.deepEqual(await store.read(), updated);
  });
});

test("a write from either field group advances the SAME revision and preserves the other group", async () => {
  await withStore(async (path, store) => {
    // Language first: the record's one revision moves, and the voice field group
    // it did not touch is carried forward unchanged.
    const afterLanguage = await store.update(0, { action: "setLocale", locale: "en-US" });
    assert.equal(afterLanguage.revision, 1);
    assert.equal(afterLanguage.consent, "undecided");
    assert.equal(afterLanguage.outputDevice, null);

    // Voice next, from the revision the language write produced: the same
    // counter keeps moving instead of a second, independent one.
    const afterConsent = await store.update(afterLanguage.revision, {
      action: "accept",
      disclosureVersion: VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
    });
    assert.equal(afterConsent.revision, 2);
    assert.equal(afterConsent.consent, "accepted");
    assert.equal(afterConsent.locale, "en-US");

    // And the language group is still reachable from the revision the voice
    // write produced.
    const afterDevice = await store.update(afterConsent.revision, {
      action: "setOutputDevice",
      outputDevice: "waveout:3",
    });
    assert.equal(afterDevice.revision, 3);
    assert.equal(afterDevice.locale, "en-US");
    assert.equal(afterDevice.consent, "accepted");
    assert.equal(afterDevice.outputDevice, "waveout:3");
    // Choosing an output endpoint is not a consent decision.
    assert.equal(afterDevice.decidedAtMs, afterConsent.decidedAtMs);

    const reopened = await new PlayerPreferenceStore(path).read();
    assert.deepEqual(reopened, afterDevice);
  });
});

test("a stale expectedRevision is rejected across both surfaces without mutation", async () => {
  await withStore(async (_path, store) => {
    const language = await store.update(0, { action: "setLocale", locale: "en-US" });
    // The voice surface still holds the revision it read before the language
    // write: the record refuses it rather than silently overwriting the choice.
    await assert.rejects(store.update(0, { action: "revoke" }), PlayerPreferenceRevisionConflict);
    assert.equal((await store.read()).revision, language.revision);

    const voice = await store.update(language.revision, { action: "revoke" });
    // Symmetrically, the language surface's now-stale revision is refused after
    // the voice write.
    await assert.rejects(
      store.update(language.revision, { action: "setLocale", locale: "zh-CN" }),
      PlayerPreferenceRevisionConflict,
    );
    assert.equal((await store.read()).revision, voice.revision);
    assert.equal(voice.locale, "en-US");
    assert.equal(voice.consent, "revoked");
  });
});

test("revoke preserves the accepted disclosure revision and Host owns the decision time", async () => {
  await withStore(async (path, store) => {
    const accepted = await store.update(0, {
      action: "accept",
      disclosureVersion: VOICE_CLOUD_TTS_DISCLOSURE_VERSION,
    });
    const revoked = await store.update(accepted.revision, { action: "revoke" });
    assert.equal(revoked.consent, "revoked");
    assert.equal(revoked.disclosureVersion, VOICE_CLOUD_TTS_DISCLOSURE_VERSION);
    assert.equal(typeof revoked.decidedAtMs, "number");
    assert.ok(revoked.decidedAtMs! >= accepted.decidedAtMs!);

    // An initial revoke has no disclosure revision to preserve.
    const fresh = new PlayerPreferenceStore(join(path, "..", "fresh.json"));
    const initial = await fresh.update(0, { action: "revoke" });
    assert.equal(initial.disclosureVersion, null);
    assert.equal(initial.consent, "revoked");
    assert.equal(typeof initial.decidedAtMs, "number");
  });
});

test("output device selection round-trips and rejects malformed endpoints", async () => {
  await withStore(async (path, store) => {
    assert.equal((await store.read()).outputDevice, null);

    const pinned = await store.update(0, { action: "setOutputDevice", outputDevice: "waveout:3" });
    assert.equal(pinned.outputDevice, "waveout:3");
    assert.equal(pinned.consent, "undecided");

    const reopened = await new PlayerPreferenceStore(path).read();
    assert.equal(reopened.outputDevice, "waveout:3");

    // Clearing back to the Windows default is an explicit selection too.
    const cleared = await store.update(reopened.revision, { action: "setOutputDevice", outputDevice: null });
    assert.equal(cleared.outputDevice, null);

    // Only the frozen `waveout:N` endpoint shape is ever stored; anything else
    // fails closed so a device name/path can never reach the gateway.
    for (const outputDevice of ["Speakers", "C:\\devices\\speakers", "waveout:"]) {
      await assert.rejects(
        store.update(cleared.revision, { action: "setOutputDevice", outputDevice } as never),
        /invalid_player_preference_update/u,
      );
    }
  });
});

test("unapproved disclosure versions, unknown fields and malformed locales are rejected", async () => {
  await withStore(async (_path, store) => {
    await assert.rejects(
      store.update(0, { action: "accept", disclosureVersion: "other-version" } as never),
      /invalid_player_preference_update/u,
    );
    await assert.rejects(store.update(-1, { action: "revoke" } as never), /invalid_player_preference_update/u);
    // The shape is what is bounded here, not the language: `ja-JP` is the player's own
    // choice and saves (see the locale test below), while a string that is not a tag at
    // all is refused.
    await assert.rejects(
      store.update(0, { action: "setLocale", locale: "not a locale" } as never),
      /invalid_player_preference_update/u,
    );
    await assert.rejects(
      store.update(0, { action: "setLocale", locale: null } as never),
      /invalid_player_preference_update/u,
    );
    await assert.rejects(store.update(0, { action: "setLocale" } as never), /invalid_player_preference_update/u);
    await assert.rejects(store.update(0, {} as never), /invalid_player_preference_update/u);
    await assert.rejects(
      store.update(0, { action: "setOutputDeviceX", outputDevice: null } as never),
      /invalid_player_preference_update/u,
    );
  });
});

test("persona selection round-trips and rejects ids outside the bounded shape", async () => {
  await withStore(async (path, store) => {
    assert.equal((await store.read()).persona, null);

    const chosen = await store.update(0, { action: "setPersona", persona: "soft_maid" });
    assert.equal(chosen.persona, "soft_maid");
    // Picking a persona is not a consent decision: the voice field group moves
    // independently of consent/device and the record's one revision advances.
    assert.equal(chosen.consent, "undecided");
    assert.equal(chosen.outputDevice, null);
    assert.equal(chosen.revision, 1);

    const reopened = await new PlayerPreferenceStore(path).read();
    assert.equal(reopened.persona, "soft_maid");

    // Clearing back to no persona is an explicit selection too (the gateway
    // variable must be left UNSET, never an empty string).
    const cleared = await store.update(reopened.revision, { action: "setPersona", persona: null });
    assert.equal(cleared.persona, null);
    assert.equal(cleared.revision, 2);

    // Only the frozen lowercase-snake id shape is ever stored; a display name,
    // an uppercase id, or free text fails closed so nothing but a real persona
    // id can reach the gateway.
    for (const persona of ["SoftMaid", "", "soft maid", "soft-maid", "soft_maid!", "a".repeat(33)]) {
      await assert.rejects(
        store.update(cleared.revision, { action: "setPersona", persona } as never),
        /invalid_player_preference_update/u,
        `expected ${JSON.stringify(persona)} to be refused`,
      );
    }
  });
});

test("persona writes use the SAME revision CAS and cannot clobber the other groups", async () => {
  await withStore(async (path, store) => {
    const language = await store.update(0, { action: "setLocale", locale: "en-US" });
    const device = await store.update(language.revision, { action: "setOutputDevice", outputDevice: "waveout:3" });

    // A stale revision from before the other groups wrote is refused.
    await assert.rejects(
      store.update(0, { action: "setPersona", persona: "gentle_maid" }),
      PlayerPreferenceRevisionConflict,
    );
    assert.equal((await store.read()).revision, device.revision);
    assert.equal((await store.read()).persona, null);

    const persona = await store.update(device.revision, { action: "setPersona", persona: "gentle_maid" });
    assert.equal(persona.revision, 3);
    assert.equal(persona.locale, "en-US");
    assert.equal(persona.outputDevice, "waveout:3");
    assert.equal(persona.persona, "gentle_maid");

    const reopened = await new PlayerPreferenceStore(path).read();
    assert.deepEqual(reopened, persona);
  });
});

test("unapproved personas, unknown keys and extra fields are refused", async () => {
  await withStore(async (_path, store) => {
    await assert.rejects(store.update(0, { action: "setPersona" } as never), /invalid_player_preference_update/u);
    await assert.rejects(
      store.update(0, { action: "setPersona", persona: 7 } as never),
      /invalid_player_preference_update/u,
    );
    await assert.rejects(
      store.update(0, { action: "setPersona", persona: null, extra: true } as never),
      /invalid_player_preference_update/u,
    );
    await assert.rejects(
      store.update(0, { action: "setPersonaX", persona: null } as never),
      /invalid_player_preference_update/u,
    );
  });
});

test("the persisted record requires the exact schema and rejects malformed files without overwriting them", async () => {
  await withStore(async (path, store) => {
    await mkdir(join(path, ".."), { recursive: true });
    const valid = {
      schemaVersion: 1,
      revision: 0,
      locale: null,
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
      outputDevice: null,
      persona: null,
      paced: false,
    };

    // An unknown key, a malformed locale, a missing persona and an unapproved
    // disclosure all fail: a record without the exact key set (e.g. written
    // before `persona` existed) is refused rather than half-read.
    await writeFile(path, JSON.stringify({ ...valid, extra: true }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    await writeFile(path, JSON.stringify({ ...valid, locale: "not a locale" }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    await writeFile(path, JSON.stringify({ ...valid, persona: undefined }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    await writeFile(path, JSON.stringify({ ...valid, disclosureVersion: "not-approved" }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    // A consent state and its evidence may never disagree.
    await writeFile(path, JSON.stringify({ ...valid, consent: "accepted" }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    await writeFile(path, JSON.stringify({ ...valid, consent: "revoked", decidedAtMs: null }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    await writeFile(path, JSON.stringify({ ...valid, decision: 1 }));
    await assert.rejects(store.read(), /invalid_player_preference_store/u);

    // A corrupt file is never overwritten with defaults, and an update refuses
    // rather than repairing it.
    await writeFile(path, '{"schemaVersion":1,"revision":0,"locale":"zh-CN" , garbage');
    await assert.rejects(store.read(), /invalid_player_preference_store/u);
    assert.match(await readFile(path, "utf8"), /garbage/u);
    await assert.rejects(store.update(0, { action: "setLocale", locale: "en-US" }), /invalid_player_preference_store/u);
  });
});

test("the runtime-facing reader resolves the player's choice from the one root path", async () => {
  // The runtime never carries a preference of its own: it asks this reader, and
  // only a configured record overrides the default.
  const root = await canonicalTestRoot("player-preference-root-");
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  assert.equal(playerPreferencePath(root).endsWith(join("settings", "player-preference.json")), true);
  // Never configured: no stored value, and the effective locale is the default.
  assert.equal(await readStoredCompanionLocale(root), undefined);
  assert.equal(await resolveCompanionLocale(root), "zh-CN");

  const store = new PlayerPreferenceStore(playerPreferencePath(root));
  await store.update(0, { action: "setLocale", locale: "en-US" });
  assert.equal(await readStoredCompanionLocale(root), "en-US");
  assert.equal(await resolveCompanionLocale(root), "en-US");
  // A voice-only write on the same record does not disturb the language.
  const current = await store.read();
  await store.update(current.revision, { action: "setOutputDevice", outputDevice: "waveout:1" });
  assert.equal(await resolveCompanionLocale(root), "en-US");

  // A corrupt record is not a "no preference": the runtime must refuse rather
  // than speak a language the player did not choose. The tag itself is malformed here
  // (a valid tag outside the two the panel suggests is legal, so it must not be what
  // this refuses).
  await writeFile(playerPreferencePath(root), '{"schemaVersion":1,"revision":0,"locale":"not a locale"}');
  await assert.rejects(readStoredCompanionLocale(root), /invalid_player_preference_store/u);
  await rm(root, { recursive: true, force: true });
});

test("the companion language is the player's own bounded tag, not a closed pair", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "player-preference-locale-"));
  await mkdir(root, { recursive: true });
  const store = new PlayerPreferenceStore(playerPreferencePath(root));

  // A language the panel does not suggest is still the player's choice: it saves,
  // reads back, and resolves exactly.
  await store.update(0, { action: "setLocale", locale: "ja-JP" });
  assert.equal(await readStoredCompanionLocale(root), "ja-JP");
  const changed = await store.update(1, { action: "setLocale", locale: "pt-BR" });
  assert.equal(changed.locale, "pt-BR");
  assert.equal(await resolveCompanionLocale(root), "pt-BR");

  // Bounded, not closed: the guards reject shapes that are not language tags at all.
  for (const invalid of ["", "x", "!!!", "ja_JP", "ja-JP-x-private-extra-tag", "a".repeat(70)]) {
    await assert.rejects(
      store.update(2, { action: "setLocale", locale: invalid }),
      /invalid_player_preference_update/u,
      `expected ${JSON.stringify(invalid)} to be refused`,
    );
  }

  // A malformed record on disk is still refused, and still leaves the write path closed.
  await writeFile(
    playerPreferencePath(root),
    JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      locale: "!!",
      disclosureVersion: null,
      consent: "undecided",
      decidedAtMs: null,
      outputDevice: null,
      persona: null,
      paced: false,
    }),
  );
  await assert.rejects(readStoredCompanionLocale(root), /invalid_player_preference_store/u);
  await rm(root, { recursive: true, force: true });
});

test("the paced-delivery choice round-trips under the SAME revision and defaults to off", async () => {
  await withStore(async (path, store) => {
    // Never chosen: the delivery path reads "not paced", without a second store.
    assert.equal((await store.read()).paced, false);

    const paced = await store.update(0, { action: "setPaced", paced: true });
    assert.equal(paced.paced, true);
    assert.equal(paced.revision, 1);
    // Choosing pacing is not a consent decision and touches no other group.
    assert.equal(paced.consent, "undecided");
    assert.equal(paced.locale, null);

    const reopened = await new PlayerPreferenceStore(path).read();
    assert.equal(reopened.paced, true);

    // Turning it off is the same revision-checked write.
    const cleared = await store.update(reopened.revision, { action: "setPaced", paced: false });
    assert.equal(cleared.paced, false);
    assert.equal(cleared.revision, 2);
  });
});

test("a paced write cannot clobber the other groups and refuses a non-boolean", async () => {
  await withStore(async (_path, store) => {
    const language = await store.update(0, { action: "setLocale", locale: "en-US" });
    // A stale revision from before the language write is refused, so pacing is
    // one more mutation of the one record rather than a second counter.
    await assert.rejects(store.update(0, { action: "setPaced", paced: true }), PlayerPreferenceRevisionConflict);

    const paced = await store.update(language.revision, { action: "setPaced", paced: true });
    assert.equal(paced.locale, "en-US");

    for (const update of [
      { action: "setPaced" },
      { action: "setPaced", paced: "true" },
      { action: "setPaced", paced: 1 },
      { action: "setPaced", paced: true, extra: true },
    ]) {
      await assert.rejects(
        store.update(paced.revision, update as never),
        /invalid_player_preference_update/u,
        `expected ${JSON.stringify(update)} to be refused`,
      );
    }
  });
});

test("the delivery path reads the player's paced choice from the one root path", async () => {
  const root = await mkdtemp(join(await canonicalTemporaryRoot(), "player-preference-paced-"));
  await mkdir(root, { recursive: true });
  try {
    // The runtime-side reader answers the chosen value, not a preference of its own.
    assert.equal(await resolvePacedDelivery(root), false);
    const store = new PlayerPreferenceStore(playerPreferencePath(root));
    await store.update(0, { action: "setPaced", paced: true });
    assert.equal(await resolvePacedDelivery(root), true);

    // A corrupt record is not "unpaced": the delivery path must refuse rather
    // than present replies in a shape the player did not choose.
    await writeFile(playerPreferencePath(root), '{"schemaVersion":1,"revision":0,"paced":"yes"}');
    await assert.rejects(resolvePacedDelivery(root), /invalid_player_preference_store/u);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

/**
 * The Game prompt addition is player-authored free text that the system prompt carries on
 * every turn of every session that follows, so it is the one field in this record whose abuse
 * is measured in tokens rather than in UI: an unbounded string in the Host floor's own context
 * is a settings control with more room than the floor itself.
 *
 * The bound is asserted against the imported authority rather than a literal here, because the
 * field, the wire and this record must refuse the same string at the same length - and 2000 is
 * the contract's number, not this test's.
 */
test("the Game prompt addition round-trips as the player's own text under the shared revision", async () => {
  await withStore(async (path, store) => {
    // Never written is the empty addition, which is a different fact from "no record":
    // the field shows what they wrote, and they have written nothing.
    assert.equal((await store.read()).gamePromptAddition, "");

    const written = await store.update(0, {
      action: "setGamePromptAddition",
      addition: "收完土豆再去矿洞。下雨天不用浇水。",
    });
    assert.equal(written.gamePromptAddition, "收完土豆再去矿洞。下雨天不用浇水。");
    assert.equal(written.revision, 1);
    // Writing the addition touches no other field group.
    assert.equal(written.locale, null);
    assert.equal(written.consent, "undecided");
    assert.equal(written.paced, false);

    // Durable: a fresh store over the same path answers the same text.
    assert.equal(
      (await new PlayerPreferenceStore(path).read()).gamePromptAddition,
      "收完土豆再去矿洞。下雨天不用浇水。",
    );
    // And it is the one root-path reader the runtime calls.
    const root = join(path, "..", "..");
    assert.equal(await resolveGamePromptAddition(root), "收完土豆再去矿洞。下雨天不用浇水。");

    // Clearing is the same revision-checked write, not a delete of the record:
    // an empty addition from a player who cleared the field is a value they chose.
    const cleared = await store.update(written.revision, { action: "setGamePromptAddition", addition: "" });
    assert.equal(cleared.gamePromptAddition, "");
    assert.equal(cleared.revision, 2);
    assert.equal(await resolveGamePromptAddition(root), "");
  });
});

test("the Game prompt addition is bounded by the contract's ceiling and refuses one character more", async () => {
  await withStore(async (_path, store) => {
    const atBound = "x".repeat(MAX_GAME_PROMPT_ADDITION_CHARS);
    const saved = await store.update(0, { action: "setGamePromptAddition", addition: atBound });
    assert.equal(saved.gamePromptAddition.length, MAX_GAME_PROMPT_ADDITION_CHARS);

    // One past the bound is refused, not truncated: a store that silently shortened the
    // player's text would save a document the author never wrote and the field can never
    // show them, and they would have no way to know which part was dropped.
    await assert.rejects(
      store.update(saved.revision, {
        action: "setGamePromptAddition",
        addition: "x".repeat(MAX_GAME_PROMPT_ADDITION_CHARS + 1),
      }),
      /invalid_player_preference_update/u,
    );
    assert.equal((await store.read()).gamePromptAddition.length, MAX_GAME_PROMPT_ADDITION_CHARS);

    // An over-bound record on disk is a protocol fault, not a value to keep serving.
    await writeFile(
      playerPreferencePath(join(_path, "..", "..")),
      JSON.stringify({
        schemaVersion: 1,
        revision: 3,
        locale: null,
        disclosureVersion: null,
        consent: "undecided",
        decidedAtMs: null,
        outputDevice: null,
        persona: null,
        paced: false,
        gamePromptAddition: "x".repeat(MAX_GAME_PROMPT_ADDITION_CHARS + 1),
      }),
    );
    await assert.rejects(resolveGamePromptAddition(join(_path, "..", "..")), /invalid_player_preference_store/u);

    // The bound is the CONTRACT's, so one constant change moves the store with it: the
    // field, the counter, the wire and this record cannot disagree about the same string.
    for (const update of [
      { action: "setGamePromptAddition" },
      { action: "setGamePromptAddition", addition: null },
      { action: "setGamePromptAddition", addition: 12 },
      { action: "setGamePromptAddition", addition: "ok", extra: true },
    ]) {
      await assert.rejects(
        store.update(saved.revision, update as never),
        /invalid_player_preference_update/u,
        `expected ${JSON.stringify(update)} to be refused`,
      );
    }
  });
});

test("an addition write cannot clobber the other groups and a stale revision is refused", async () => {
  await withStore(async (_path, store) => {
    const language = await store.update(0, { action: "setLocale", locale: "en-US" });
    await assert.rejects(
      store.update(0, { action: "setGamePromptAddition", addition: "hello" }),
      PlayerPreferenceRevisionConflict,
    );
    const addition = await store.update(language.revision, { action: "setGamePromptAddition", addition: "hello" });
    assert.equal(addition.locale, "en-US");
    assert.equal(addition.gamePromptAddition, "hello");
  });
});
