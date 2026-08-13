export type CompatibilityDecision = "accepted_typed" | "preserved_opaque" | "dropped_unsupported" | "rejected_invalid";

/** Exact UTF-8 limits enforced by the inert ST-card decoder. */
export const ST_CARD_DECODER_LIMITS_V1 = Object.freeze({
  inputBytes: 1_048_576,
  jsonDepth: 64,
  jsonNodes: 4_096,
  pngChunks: 256,
  nameBytes: 128,
  textBytes: 1_024,
  examplesBytes: 4_096,
  characterBookBytes: 131_072,
  characterBookEntryBytes: 4_000,
  characterBookTitleBytes: 256,
  characterBookEntries: 128,
});

/**
 * Selected-L3 profile boundary: card data is an inert candidate, never an
 * IdentityProfile patch. Only the listed persona fields may be copied into a
 * newly provisioned profile after a durable field-level review. World Book
 * entries remain candidates: this subset does not import, bind, or execute
 * them. Version-locked `tavern-interchange/v1` accepts and exports only inert
 * WorldBook public background records and the ST-recognized player-visible Chat
 * JSONL subset (`user_name`, `character_name`, empty safe header metadata, and
 * selected `name`/`is_user`/`is_system`/`send_date`/`mes` bubbles). It excludes
 * raw ST fields, Pi/session data, ids, swipes, branches, and bindings.
 */
const SELECTED_L3_PROFILE_CONTRACT_V1 = Object.freeze({
  candidateOnly: Object.freeze(["name", "scenario", "first_mes", "first_message", "mes_example", "character_book"]),
  profileEligibleAfterExplicitReview: Object.freeze(["description", "personality"]),
  worldBook: "candidate_only_not_bound",
  chatTransfer: "tavern-interchange-v1_st-jsonl-player-visible-selected-bubbles_only",
});

export const COMPATIBILITY_MANIFEST_V1 = Object.freeze({
  schemaVersion: 1,
  id: "compatibility_manifest_v1",
  interchange: Object.freeze({
    format: "tavern-interchange/v1",
    inbound: Object.freeze(["worldbook_public_background", "chat_player_visible_jsonl"]),
    outbound: Object.freeze(["worldbook_public_background", "chat_player_visible_jsonl"]),
    denylist: Object.freeze([
      "raw_st_card",
      "always_on_premise",
      "runtime_or_world_scoped_worldbook",
      "pi_session",
      "session_id",
      "message_id",
      "greeting_source",
      "swipes",
      "selected_swipe",
      "branches",
      "bindings",
      "extensions",
      "regex",
      "html",
      "macros",
      "system_prompt",
      "hidden_reasoning",
      "tool_trace",
      "receipt",
      "bridge_token",
      "audio",
    ]),
    dispositionReport: "required",
  }),
  sillyTavernCommit: "8172dcd0ee672d3cd9a5e5f7af134f91a45cd2b8",
  formats: Object.freeze({
    "st-v2": Object.freeze({
      references: Object.freeze(["STSEM-CARD-001"]),
      fields: Object.freeze({
        name: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.nameBytes),
        description: entry(
          "accepted_typed",
          "profile_eligible_after_explicit_review",
          ST_CARD_DECODER_LIMITS_V1.textBytes,
        ),
        personality: entry(
          "accepted_typed",
          "profile_eligible_after_explicit_review",
          ST_CARD_DECODER_LIMITS_V1.textBytes,
        ),
        scenario: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.textBytes),
        first_mes: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.textBytes),
        first_message: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.textBytes),
        mes_example: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.examplesBytes),
        creator_notes: entry("dropped_unsupported", "never_runtime", ST_CARD_DECODER_LIMITS_V1.textBytes),
        system_prompt: entry("dropped_unsupported", "never_runtime", ST_CARD_DECODER_LIMITS_V1.textBytes),
        post_history_instructions: entry("dropped_unsupported", "never_runtime", ST_CARD_DECODER_LIMITS_V1.textBytes),
        character_book: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.characterBookBytes),
        extensions: entry("dropped_unsupported", "never_runtime", 0),
        regex_scripts: entry("dropped_unsupported", "never_runtime", 0),
      }),
    }),
    "st-v3": Object.freeze({ references: Object.freeze(["STSEM-CARD-001"]), sharedWith: "st-v2" }),
  }),
  profileContract: SELECTED_L3_PROFILE_CONTRACT_V1,
  chatJsonl: Object.freeze({
    status: "supported_safe_subset",
    reference: "STSEM-CHAT-001",
    schema: "SillyTavern Chat JSONL header + message records",
    inbound: Object.freeze([
      "user_name",
      "character_name",
      "chat_metadata(empty)",
      "name",
      "is_user",
      "is_system(false)",
      "send_date",
      "mes",
    ]),
    outbound: Object.freeze([
      "user_name",
      "character_name",
      "chat_metadata(empty)",
      "name",
      "is_user",
      "is_system(false)",
      "send_date",
      "mes",
    ]),
    selectedVariantPolicy: "only_selected_materialized_bubble; swipes_and_variant_ids_dropped",
    reimport: "player_visible_round_trip_only_inert_unbound",
    extensions: "omitted_with_loss_report",
    unsupported: Object.freeze([
      "ids",
      "swipes",
      "selected_swipe",
      "branches",
      "bindings",
      "extensions",
      "system_prompt",
      "hidden_reasoning",
      "tool_trace",
      "receipt",
      "bridge_token",
      "audio",
    ]),
  }),
  prohibitedExecution: Object.freeze([
    "extensions",
    "regex",
    "html",
    "macros",
    "prompt manager",
    "provider configuration",
    "tools",
    "game actions",
  ]),
});
function entry(
  decision: CompatibilityDecision,
  eligibility: "candidate_only" | "profile_eligible_after_explicit_review" | "never_runtime",
  maxBytes: number,
) {
  return Object.freeze({ decision, eligibility, maxBytes });
}
