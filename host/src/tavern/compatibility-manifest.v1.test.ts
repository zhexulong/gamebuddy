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
  assert.equal(ST_CARD_DECODER_LIMITS_V1.characterBookEntryBytes, 4_000);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.characterBookTitleBytes, 256);
  assert.equal(ST_CARD_DECODER_LIMITS_V1.characterBookEntries, 128);
});

test("selected L3 contract limits profile use and interchange to the version-locked inert subset", () => {
  assert.deepEqual(COMPATIBILITY_MANIFEST_V1.profileContract.profileEligibleAfterExplicitReview, [
    "description",
    "personality",
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
