export type CompatibilityDecision = "accepted_typed" | "preserved_opaque" | "dropped_unsupported" | "rejected_invalid";

/** Exact UTF-8 limits enforced by the inert ST-card decoder. */
export const ST_CARD_DECODER_LIMITS_V1 = Object.freeze({
  inputBytesJson: 2_097_152,
  inputBytesPng: 33_554_432,
  inflateMaxOutputBytes: 67_108_864,
  jsonDepth: 64,
  jsonNodes: 524_288,
  pngChunks: 1_024,
  nameBytes: 256,
  textBytes: 2_097_152,
  examplesBytes: 2_097_152,
  characterBookBytes: 16_777_216,
  characterBookEntryBytes: 16_384,
  characterBookTitleBytes: 256,
  characterBookEntries: Number.POSITIVE_INFINITY,
  /**
   * The card's own `system_prompt`, carried as the companion's performance
   * directive. Tighter than `textBytes` on purpose: this text lands in the
   * stable Tier-1 prefix sent on every turn, and it is third-party input. A
   * longer directive is refused (not truncated) and the refusal is counted.
   */
  cardVoiceBytes: 8_192,
  /**
   * The card's inert `extensions` object, measured on its JSON text exactly as the
   * decoder applies it (`JSON.stringify(value).length`). Open by design, so the
   * bound only stops a blowup; the export re-applies this same rule so a card it
   * writes is one the decoder keeps whole.
   */
  cardExtensionsJsonChars: 8_192,
  /**
   * The card's own closing direction (`post_history_instructions`), carried as the
   * companion's own durable record. Tighter than `textBytes` on purpose: this text
   * is third-party prose the companion surface appends after the transcript on
   * every turn, outside the cached prefix. A longer one is refused at import by
   * name (`post_history_instructions_too_long`), never truncated.
   */
  postHistoryInstructionsBytes: 4_096,
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
  // `system_prompt` is profile-eligible as the companion's `characterVoice` (the
  // card's own performance directive, rendered after the Host floor), not as a
  // persona dimension; it is listed here so the profile boundary stays truthful.
  profileEligibleAfterExplicitReview: Object.freeze(["description", "personality", "system_prompt"]),
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
        creator_notes: entry("preserved_opaque", "never_runtime", ST_CARD_DECODER_LIMITS_V1.textBytes),
        // A standard v2/v3 field. It carries the card's own performance
        // directive into the profile (`characterVoice`), rendered AFTER the Host
        // floor and never able to loosen it.
        system_prompt: entry(
          "accepted_typed",
          "profile_eligible_after_explicit_review",
          ST_CARD_DECODER_LIMITS_V1.cardVoiceBytes,
        ),
        // A standard v2/v3 field: the card's own closing direction, which the ST
        // spec injects AFTER the history rather than as a statement of voice. It is
        // accepted and bounded here, then kept as the companion's own durable record
        // (`post-history-instructions.json`) beside her scenario and her openings -
        // never a profile field and never part of the cached prefix. The Chat
        // materialization reads it (`catalog-service.ts`) and publishes it beside the
        // catalogue's hashed body, which is where the fork appends it after the
        // transcript.
        post_history_instructions: entry(
          "accepted_typed",
          "companion_artifact",
          ST_CARD_DECODER_LIMITS_V1.postHistoryInstructionsBytes,
        ),
        character_book: entry("accepted_typed", "candidate_only", ST_CARD_DECODER_LIMITS_V1.characterBookBytes),
        // Open by design. Carried verbatim as bounded inert data (never executed)
        // and preserved into the companion's own `card-extensions.json`, so the
        // facts a card author wrote for a game integration
        // (`extensions.gamebuddy.stardew`) survive the import and the export. It is
        // still never a profile field and never prompt input - the artifact is her
        // record, not her identity.
        extensions: entry("accepted_typed", "companion_artifact", ST_CARD_DECODER_LIMITS_V1.cardExtensionsJsonChars),
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
  eligibility:
    | "candidate_only"
    | "profile_eligible_after_explicit_review"
    | "never_runtime"
    /** Preserved as the companion's own durable artifact; never a profile field. */
    | "companion_artifact",
  maxBytes: number,
) {
  return Object.freeze({ decision, eligibility, maxBytes });
}
