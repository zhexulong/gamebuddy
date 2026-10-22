import assert from "node:assert/strict";
import test from "node:test";
import { COMPATIBILITY_MANIFEST_V1, ST_CARD_DECODER_LIMITS_V1 } from "./compatibility-manifest.v1.js";

test("ST-card compatibility manifest publishes the decoder's exact byte bounds", () => {
  const fields = COMPATIBILITY_MANIFEST_V1.formats["st-v2"].fields;
  assert.equal(fields.name.maxBytes, ST_CARD_DECODER_LIMITS_V1.nameBytes);
  assert.equal(fields.description.maxBytes, ST_CARD_DECODER_LIMITS_V1.textBytes);
  assert.equal(fields.personality.maxBytes, ST_CARD_DECODER_LIMITS_V1.textBytes);
  assert.equal(fields.scenario.maxBytes, ST_CARD_DECODER_LIMITS_V1.textBytes);
  assert.equal(fields.first_mes.maxBytes, ST_CARD_DECODER_LIMITS_V1.textBytes);
  assert.equal(fields.first_message.maxBytes, ST_CARD_DECODER_LIMITS_V1.textBytes);
  assert.equal(fields.mes_example.maxBytes, ST_CARD_DECODER_LIMITS_V1.examplesBytes);
  assert.equal(fields.character_book.maxBytes, ST_CARD_DECODER_LIMITS_V1.characterBookBytes);
  // A standard field and an open-by-design field are carried in the reviewed
  // candidate; only executable / prompt-control fields are dropped.
  assert.equal(fields.system_prompt.decision, "accepted_typed");
  assert.equal(fields.system_prompt.eligibility, "profile_eligible_after_explicit_review");
  assert.equal(fields.system_prompt.maxBytes, ST_CARD_DECODER_LIMITS_V1.cardVoiceBytes);
  assert.equal(fields.extensions.decision, "accepted_typed");
  // Its home moved: the object is preserved as the companion's own
  // `card-extensions.json` record, not left in the staged candidate forever. It is
  // still never a profile field and never executed, and its bound is the decoder's
  // own JSON-text ceiling for the field.
  assert.equal(fields.extensions.eligibility, "companion_artifact");
  assert.equal(fields.extensions.maxBytes, ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars, 8_192);
  assert.equal(fields.creator_notes.decision, "preserved_opaque");
  // The card's own closing direction is no longer `never_runtime`: it is accepted,
  // bounded at 4 KB, and kept as her own record beside her scenario and openings.
  // It is still never a profile field and never part of the cached prefix.
  assert.equal(fields.post_history_instructions.decision, "accepted_typed");
  assert.equal(fields.post_history_instructions.eligibility, "companion_artifact");
  assert.equal(fields.post_history_instructions.maxBytes, ST_CARD_DECODER_LIMITS_V1.postHistoryInstructionsBytes);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.postHistoryInstructionsBytes, 4_096);
  assert.equal(fields.regex_scripts.decision, "dropped_unsupported");
  assert.equal(ST_CARD_DECODER_LIMITS_V1.inputBytesJson, 2_097_152);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.inputBytesPng, 33_554_432);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.inflateMaxOutputBytes, 67_108_864);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.jsonDepth, 64);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.jsonNodes, 524_288);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.pngChunks, 1_024);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.nameBytes, 256);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.textBytes, 2_097_152);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.examplesBytes, 2_097_152);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes, 16_384);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.characterBookTitleBytes, 256);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.characterBookEntries, Number.POSITIVE_INFINITY);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.cardVoiceBytes, 8_192);
});

test("selected L3 contract limits profile use and interchange to the version-locked inert subset", () => {
  assert.deepEqual(COMPATIBILITY_MANIFEST_V1.profileContract.profileEligibleAfterExplicitReview, [
    "description",
    "personality",
    "system_prompt",
  ]);
  assert.equal(COMPATIBILITY_MANIFEST_V1.profileContract.worldBook, "candidate_only_not_bound");
  assert.equal(
    COMPATIBILITY_MANIFEST_V1.profileContract.chatTransfer,
    "tavern-interchange-v1_st-jsonl-player-visible-selected-bubbles_only",
  );
  assert.equal(COMPATIBILITY_MANIFEST_V1.interchange.format, "tavern-interchange/v1");
  assert.deepEqual(COMPATIBILITY_MANIFEST_V1.interchange.inbound, [
    "worldbook_public_background",
    "chat_player_visible_jsonl",
  ]);
  assert.ok(COMPATIBILITY_MANIFEST_V1.interchange.denylist.includes("pi_session"));
  assert.ok(COMPATIBILITY_MANIFEST_V1.interchange.denylist.includes("raw_st_card"));
  assert.ok(COMPATIBILITY_MANIFEST_V1.interchange.denylist.includes("session_id"));
  // The card export is not this interchange: `extensions` rides the card between
  // the player and the Host, and still never enters a chat/worldbook interchange
  // payload or a profile.
  assert.ok(COMPATIBILITY_MANIFEST_V1.interchange.denylist.includes("extensions"));
  assert.equal(COMPATIBILITY_MANIFEST_V1.chatJsonl.extensions, "omitted_with_loss_report");
  assert.deepEqual(COMPATIBILITY_MANIFEST_V1.chatJsonl.inbound, [
    "user_name",
    "character_name",
    "chat_metadata(empty)",
    "name",
    "is_user",
    "is_system(false)",
    "send_date",
    "mes",
  ]);
  assert.equal(COMPATIBILITY_MANIFEST_V1.chatJsonl.status, "supported_safe_subset");
  assert.equal(COMPATIBILITY_MANIFEST_V1.chatJsonl.reimport, "player_visible_round_trip_only_inert_unbound");
  assert.equal(
    COMPATIBILITY_MANIFEST_V1.chatJsonl.selectedVariantPolicy,
    "only_selected_materialized_bubble; swipes_and_variant_ids_dropped",
  );
});
