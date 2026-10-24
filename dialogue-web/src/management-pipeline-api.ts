/**
 * Browser-only strict DTO validators and fetch client for the
 * `tavern_browser_api/v1` tavern-management wire contract
 * (`gamebuddy.tavern-management.chat-list-title`): metadata-only Chat list and
 * exact title rename.
 *
 * This module is deliberately dependency-free and closed:
 *
 * - it imports no Host package and no typebox: the only runtime imports are the problem
 *   identity `./reference-pipeline-api` declares. The player-facing wording of a refusal lives
 *   in the catalogue (`./composed-problem-view`), not here: a wire contract must not depend on a
 *   UI module, so `problemTextWithCode` is that module's export and the panels import it there;
 * - every DTO validator is strict and local: extra fields are rejected,
 *   handles are canonical opaque unpadded base64url strings, and every union
 *   accepts only its exact frozen variants;
 * - the fetch client uses only same-origin relative routes with
 *   `credentials: "same-origin"`; `chat.rename` sends `Content-Type` and
 *   `x-csrf-token`; reads never send a CSRF header;
 * - validated non-2xx responses surface the RFC-9457-style `TavernProblemV1`
 *   as `TavernProblemError`; any opaque protocol failure throws
 *   `TavernProtocolError` and never echoes raw body text.
 *
 * There is no SSE, polling, timer, storage, generated handle, local list or
 * mock anywhere in this module.
 */

import type { Messages } from "./i18n";
import { TavernProblemError, TavernProtocolError } from "./reference-pipeline-api";

const TAVERN_BROWSER_API_VERSION = 1 as const;
const TAVERN_BROWSER_CONTRACT = "tavern_browser_api/v1" as const;
const MANAGEMENT_PROFILE_ID = "gamebuddy.tavern-management.chat-list-title" as const;

// --- Frozen v1 DTO shapes (structural mirrors of host/src/tavern/browser-contract). ---

/**
 * Additive v1 fact: the swipe/regenerate set a message belongs to.
 * Mirrors `BrowserSwipeInfoV1Schema`.
 */
type BrowserSwipeInfoV1 = Readonly<{
  currentIndex: number;
  totalSwipes: number;
  label: string;
  hasPrevious: boolean;
  hasNext: boolean;
}>;

// `swipeInfo` and `openingVariant` are `Type.Optional` in the Host contract
// (host/src/tavern/browser-contract). They are declared-optional additive v1
// facts, so a read that carries either is legal; the mirror must allow them
// rather than reject the whole message (and, with it, the management surface).
type BrowserMessageV1 = Readonly<{
  handle: string;
  role: "player" | "companion";
  text: string;
  locale: "en" | "zh-CN" | "und";
  order: number;
  revision: number;
  swipeInfo?: BrowserSwipeInfoV1;
  openingVariant?: BrowserOpeningVariantV1;
}>;

type BrowserTurnV1 = Readonly<{
  handle: string;
  state: "queued" | "running" | "response_visible" | "stopping" | "completed" | "cancelled" | "failed";
  projectionRevision: number;
  canCancel: boolean;
  problemCode?: "interrupted" | "no_visible_presentation" | "runtime_unavailable" | "storage_unavailable";
  /** The generation that wrote the visible reply stopped at the model's length ceiling. */
  truncated?: true;
}>;

type TavernBrowserOperationV1 = Readonly<{
  operationId:
    | "chat.submit"
    | "chat.cancel"
    | "draft.save"
    | "draft.discard"
    | "chat.rename"
    | "chat.opening"
    | "chat.create"
    | "chat.select"
    | "memory.mutate"
    | "world-info.bind"
    | "world-info.detail"
    | "world-info.create"
    | "world-info.update"
    | "world-info.delete"
    | "settings.voice.read"
    | "settings.voice.consent"
    | "settings.voice.devices"
    | "settings.language.read"
    | "settings.language.update"
    | "settings.delivery.read"
    | "settings.delivery.update"
    | "settings.connection.read"
    | "settings.connection.create"
    | "settings.connection.test"
    | "settings.connection.activate"
    | "settings.connection.model"
    | "settings.connection.remove"
    | "settings.profiles.read"
    | "settings.profiles.update"
    | "companion.list"
    | "companion.worldbook.read"
    | "companion.worldbook.update"
    | "companion.profile.read"
    | "companion.card.export"
    | "companion.avatar.update"
    | "companion.delete"
    | "companion.create"
    | "character.import.stage"
    | "character.import.read"
    | "character.import.review"
    | "character.import.confirm"
    | "character.import.history"
    | "persona.read"
    | "persona.update"
    | "scenario.read"
    | "scenario.update"
    | "greeting.read"
    | "greeting.update"
    | "chat.archive"
    | "chat.restore"
    | "chat.trash"
    | "character.voice.read"
    | "character.voice.update";
  labelKey:
    | "tavern.nav.chat"
    | "tavern.nav.memory"
    | "tavern.nav.characters"
    | "tavern.operation.submit"
    | "tavern.operation.cancel"
    | "tavern.operation.draft.save"
    | "tavern.operation.draft.discard"
    | "tavern.operation.rename"
    | "tavern.operation.chat.opening"
    | "tavern.operation.chat.create"
    | "tavern.operation.chat.select"
    | "tavern.operation.memory.mutate"
    | "tavern.operation.world-info.bind"
    | "tavern.operation.world-info.detail"
    | "tavern.operation.world-info.create"
    | "tavern.operation.world-info.update"
    | "tavern.operation.world-info.delete"
    | "tavern.operation.settings.voice.read"
    | "tavern.operation.settings.voice.consent"
    | "tavern.operation.settings.voice.devices"
    | "tavern.operation.settings.language.read"
    | "tavern.operation.settings.language.update"
    | "tavern.operation.settings.delivery.read"
    | "tavern.operation.settings.delivery.update"
    | "tavern.operation.settings.connection.read"
    | "tavern.operation.settings.connection.create"
    | "tavern.operation.settings.connection.test"
    | "tavern.operation.settings.connection.activate"
    | "tavern.operation.settings.connection.model"
    | "tavern.operation.settings.connection.remove"
    | "tavern.operation.settings.profiles.read"
    | "tavern.operation.settings.profiles.update"
    | "tavern.operation.companion.list"
    | "tavern.operation.companion.worldbook.read"
    | "tavern.operation.companion.worldbook.update"
    | "tavern.operation.companion.profile.read"
    | "tavern.operation.companion.card.export"
    | "tavern.operation.companion.avatar.update"
    | "tavern.operation.companion.delete"
    | "tavern.operation.companion.create"
    | "tavern.operation.character.import.stage"
    | "tavern.operation.character.import.read"
    | "tavern.operation.character.import.review"
    | "tavern.operation.character.import.confirm"
    | "tavern.operation.character.import.history"
    | "tavern.operation.persona.read"
    | "tavern.operation.persona.update"
    | "tavern.operation.scenario.read"
    | "tavern.operation.scenario.update"
    | "tavern.operation.greeting.read"
    | "tavern.operation.greeting.update"
    | "tavern.operation.chat.archive"
    | "tavern.operation.chat.restore"
    | "tavern.operation.chat.trash"
    | "tavern.operation.character.voice.read"
    | "tavern.operation.character.voice.update";
  availability: "available" | "busy" | "unavailable";
  routeId: string;
}>;

type WorldInfoItemV1 = Readonly<{
  handle: string;
  title: string;
  summary: string | null;
  selected: boolean;
  pending: boolean;
}>;

/** Safe opaque projection for binding World Info to the exact mounted Chat. */
export type WorldInfoStateV1 = Readonly<{
  state: "none" | "selected" | "pending" | "unavailable";
  revision: string;
  items: readonly WorldInfoItemV1[];
}>;

export type SetWorldInfoBindingCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  sourceHandle: string | null;
}>;

/** One authored entry of a managed World Info item. */
export type WorldInfoEntryV1 = Readonly<{
  scope: "companion" | "setting";
  publicTitle: string;
  summary: string;
  keys?: readonly string[];
  secondaryKeys?: readonly string[];
  selectiveLogic?: 0 | 1 | 2 | 3;
  constant?: boolean;
}>;
/** One managed library item's own content at one exact revision, as `world-info.detail` returns it. */
export type WorldInfoContentV1 = Readonly<{
  revision: number;
  publicTitle: string;
  summary: string;
  entries: readonly WorldInfoEntryV1[];
}>;
/** The authored content a create or update carries, without the library's own revision. */
export type WorldInfoAuthoredContentV1 = Readonly<{
  publicTitle: string;
  summary: string;
  entries: readonly WorldInfoEntryV1[];
}>;
export type WorldInfoItemCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  itemHandle: string;
}>;
export type WorldInfoCreateCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  item: WorldInfoAuthoredContentV1;
}>;
export type WorldInfoUpdateCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  itemHandle: string;
  item: WorldInfoAuthoredContentV1 & Readonly<{ expectedRevision: number }>;
}>;
/**
 * `world-info.import`: one external lorebook file, carried whole. The file's interior is the Host
 * importer's business, so this mirror admits any JSON object and decides nothing about its entries.
 */
export type WorldInfoImportCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: string;
  lorebook: Readonly<Record<string, unknown>>;
}>;
/**
 * `chat.export`: one Chat's transcript as a SillyTavern chat file. `jsonl` is the file itself, so
 * the download saves the Host's own bytes and never re-serializes the transcript here.
 */
export type ChatExportDispositionV1 = Readonly<{
  field: string;
  classification: "accepted_typed" | "dropped_unsupported" | "rejected_invalid";
  reason: string;
}>;
export type ChatExportV1 = Readonly<{
  apiVersion: 1;
  format: "tavern-interchange/v1";
  chatHandle: string;
  messageCount: number;
  dispositions: readonly ChatExportDispositionV1[];
  canonicalHash: string;
  jsonl: string;
}>;
/** `chat.export`'s own query: the exact Chat the browser's list handed out. */
export type ChatExportQueryV1 = Readonly<{ chatHandle: string }>;

/** Metadata-only companion library entry: opaque handle plus display name. */
export type CompanionListEntryV1 = Readonly<{
  handle: string;
  name: string;
  isCurrent: boolean;
}>;
export type CompanionListV1 = Readonly<{
  apiVersion: 1;
  companions: readonly CompanionListEntryV1[];
}>;
/** Safe player-visible companion detail: name only. */
export type CompanionDetailV1 = Readonly<{
  apiVersion: 1;
  name: string;
}>;
/**
 * One entry of the companion's OWN world book - the reviewed card's
 * `character_book`, which the import persisted under the companion's runtime
 * root. The entry's body IS projected, and it is editable: the panel already lets
 * the player read and edit this companion's voice directive, persona, scenario and
 * greetings, so a row showing which words reach an entry but not what it says is a
 * row they can deliberately reach and still cannot read. The Host renders the body
 * through the run's macro table before it is sent, so no `{{user}}`/`{{char}}`
 * placeholder reaches this surface; `updateCompanionWorldBook` sends the whole list
 * back with the book's durable revision as the CAS.
 */
export type CompanionWorldBookEntryV1 = Readonly<{
  title: string;
  /**
   * The card's own trigger words. Per-turn selection matches them against what
   * the player actually said, so an entry whose keys are invisible is an entry
   * the player cannot deliberately reach.
   */
  keys: readonly string[];
  /** Always-on background, carried whatever is said, so it has no trigger words. */
  constant: boolean;
  /** The entry's text, as the Host rendered it: macros resolved, bounded. */
  content: string;
}>;
/**
 * The companion's own world book. A different thing from the World Info items a
 * conversation can attach (`WorldInfoStateV1`): that is the managed library of
 * artifacts a Chat may bind, this is the book the companion was provisioned with.
 * `present: false` means the companion has no book at all - the surface then
 * renders no block, so absence never reads as a book whose entries were lost.
 * `revision` is the durable book's own revision and is null in exactly that one
 * case; it is what an edit CASes on.
 */
export type CompanionWorldBookV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  entries: readonly CompanionWorldBookEntryV1[];
}>;
/**
 * One player edit of the companion's OWN world book: the complete entry list, CASed
 * on the revision the read carried. The entries are the projection's own shape, so
 * this command can never carry a bound the read does not already carry.
 */
export type UpdateCompanionWorldBookCommandV1 = Readonly<{
  apiVersion: 1;
  expectedRevision: number;
  entries: readonly CompanionWorldBookEntryV1[];
}>;
/**
 * The companion's own authored persona, as her identity profile holds it.
 * `present` is false when she was provisioned without one at all; a dimension is
 * null when that dimension is absent, which is a different fact from an empty
 * sentence.
 */
export type CompanionProfilePersonaV1 = Readonly<{
  present: boolean;
  core: string | null;
  interactionStyle: string | null;
  expressionStyle: string | null;
}>;
/**
 * The companion's own scenario. `present: false` is "she was made without one";
 * both fields are null then, so an absent scenario never reads as empty text.
 */
export type CompanionProfileScenarioV1 = Readonly<{
  present: boolean;
  name: string | null;
  description: string | null;
}>;
/** One opening with its own text, already rendered by the Host (no `{{macro}}`). */
export type CompanionProfileGreetingVariantV1 = Readonly<{
  label: string | null;
  text: string;
}>;
/** The companion's own greeting set; `present: false` is "she was made without one". */
export type CompanionProfileGreetingsV1 = Readonly<{
  present: boolean;
  label: string | null;
  variants: readonly CompanionProfileGreetingVariantV1[];
}>;
/**
 * The read-only character inspector: one companion's own authored facts, by the
 * same opaque handle the roster projected. It is not the mounted editor's
 * projection (`persona.read` is the PLAYER's persona, and the scenario/greeting
 * reads resolve only the mounted companion) and it carries no command at all, so
 * the inspector can never become a second place to edit a field another panel owns.
 */
export type CompanionProfileV1 = Readonly<{
  apiVersion: 1;
  name: string;
  /**
   * The revision of her own `companion.json` record: the value `companion.delete` CASes on.
   * Null when the record is absent - the one case the roster splices the mounted companion in
   * from the identity profile alone.
   */
  revision: number | null;
  persona: CompanionProfilePersonaV1;
  scenario: CompanionProfileScenarioV1;
  greetings: CompanionProfileGreetingsV1;
  worldBook: CompanionWorldBookV1;
}>;
/**
 * The read-back of one stored picture: which companion it belongs to, and the digest of
 * the bytes now on disk.
 *
 * The digest is the same value the Host's runtime asset face publishes as the `ETag` of
 * `/assets/companions/<handle>/avatar.png`, so it is what a surface compares when it
 * wants to know whether her picture really changed - and it is the key that makes the
 * new picture appear at once: the image element is remounted under it, the browser
 * revalidates the URL it already has, and the changed digest is served as new bytes.
 */
export type CompanionAvatarV1 = Readonly<{ apiVersion: 1; handle: string; digest: string }>;
/**
 * What a completed `companion.delete` answers: the handle that no longer resolves, so the
 * surface can say which row went and drop exactly it.
 */
export type CompanionDeletionV1 = Readonly<{ apiVersion: 1; handle: string }>;
/**
 * One companion's own records exported as a standard Tavern V3 card, in the form
 * the caller asked for.
 *
 * The JSON arm carries `card`, the card's own JSON TEXT - the exact bytes the
 * player saves - so the Host is the one author of the card's serialization and
 * the browser never rebuilds it. The PNG arm carries `cardFileBase64`, the whole
 * card file (her picture with the card inside it) base64-encoded - the same
 * spelling `character.import.stage` uses for a PNG card on the way in. `fileName`
 * is what the save dialog offers; `spec` is the format's own version. `format`
 * names which arm this is, so the browser never infers the file's kind.
 */
export type CompanionCardExportV1 =
  | Readonly<{ apiVersion: 1; format: "json"; spec: "chara_card_v3"; fileName: string; card: string }>
  | Readonly<{ apiVersion: 1; format: "png"; spec: "chara_card_v3"; fileName: string; cardFileBase64: string }>;
/**
 * The mounted companion's own performance directive, as the durable identity
 * profile holds it (the imported card's `system_prompt`). `source` is
 * provenance: `card` while the text is exactly what the card supplied,
 * `player` once the player has edited it. `null` means the field is absent -
 * the card wrote none, or the player cleared it.
 */
export type CompanionCharacterVoiceV1 = Readonly<{
  text: string;
  source: "card" | "player";
}>;
/** The companion voice read-back: the profile revision to CAS against plus the effective directive. */
export type CompanionVoiceV1 = Readonly<{
  apiVersion: 1;
  profileRevision: number;
  characterVoice: CompanionCharacterVoiceV1 | null;
}>;
/**
 * One edit or one clear of the mounted companion's directive. An edit always
 * re-authors the text as the player's; a clear removes the field entirely.
 */
export type UpdateCompanionVoiceCommandV1 =
  | Readonly<{ apiVersion: 1; expectedProfileRevision: number; text: string }>
  | Readonly<{ apiVersion: 1; expectedProfileRevision: number; clear: true }>;
/**
 * The largest card file the stage route accepts, mirroring the Host's own limit
 * (`ST_CARD_DECODER_LIMITS_V1.inputBytesPng`, the card decoder's PNG input
 * ceiling). A PNG card IS its picture - the image and the `tEXt` chunk holding
 * the card are one file - so the number that bounds an importable card bounds
 * its picture too. The picker refuses a larger file before reading a byte of it,
 * and the PNG arm's payload is bounded by this same number, base64-inflated.
 */
export const MAX_CARD_FILE_BYTES = 32 * 1024 * 1024;
const MAX_CARD_FILE_BASE64_CHARS = Math.ceil(MAX_CARD_FILE_BYTES / 3) * 4;
/**
 * The largest picture the avatar route accepts. It is the card file's own ceiling rather
 * than a second number: the Host's avatar module derives its bound from the same card
 * decoder limit (`ST_CARD_DECODER_LIMITS_V1.inputBytesPng`), because an avatar IS the
 * card's picture. The picker refuses a larger picture before the request is made, so the
 * refusal is a sentence rather than a 45 MB round trip - and it is checked on the PNG the
 * upload would carry (the picked file is converted in the browser, `pngBytesOfPickedPicture`),
 * which is the byte string this ceiling describes.
 */
export const MAX_AVATAR_FILE_BYTES = MAX_CARD_FILE_BYTES;

/**
 * `character.import.stage`'s body, mirrored from the Host's own union.
 *
 * A `.json` card is its own text. A PNG card is the WHOLE picked file, base64:
 * the picture and the card are the same object, so sending them as two fields
 * would assert a pairing the Host cannot check. One payload, one parser, one
 * authority - the Host's decoder reads the card's fields and its picture out of
 * the bytes the Host itself received.
 */
export type StageStCardImportCommandV1 =
  | Readonly<{ apiVersion: 1; cardSource: "json"; card: string }>
  | Readonly<{ apiVersion: 1; cardSource: "png"; cardFileBase64: string }>;

export type StCardImportFieldSummaryV1 = Readonly<{
  field: string;
  eligibility: "candidate_only" | "profile_eligible_after_explicit_review" | "never_runtime";
  chars: number;
}>;
export type StCardImportDispositionV1 = Readonly<{
  field: string;
  classification: "accepted_typed" | "preserved_opaque" | "dropped_unsupported" | "rejected_invalid";
  reason: string;
}>;
/**
 * One counted loss inside an accepted field. A card's own `system_prompt`
 * beyond the voice bound reports `field: "system_prompt"`,
 * `reason: "character_voice_too_long"` - the decoder's own ledger, so a review
 * reports the loss rather than inferring one.
 */
export type StCardImportLossV1 = Readonly<{
  field: string;
  reason: string;
  count: number;
}>;
export type StCardImportStageResultV1 = Readonly<{
  apiVersion: 1;
  importId: string;
  name: string;
  candidateRevision: number;
  fields: readonly StCardImportFieldSummaryV1[];
  dispositions: readonly StCardImportDispositionV1[];
  losses?: readonly StCardImportLossV1[];
}>;
export type StCardImportReadResultV1 = Readonly<{
  apiVersion: 1;
  importId: string;
  name: string;
  candidateRevision: number;
  reviewed: boolean;
  reviewedFields: readonly string[];
  fields: readonly StCardImportFieldSummaryV1[];
  dispositions: readonly StCardImportDispositionV1[];
  losses?: readonly StCardImportLossV1[];
}>;
export type StCardImportReviewResultV1 = Readonly<{
  apiVersion: 1;
  importId: string;
  reviewedFields: readonly string[];
  approvedAtMs: number;
}>;
export type StCardImportConfirmResultV1 = Readonly<{ apiVersion: 1; name: string }>;
/** How many raw card fields the decoder kept or dropped, per disposition class. */
export type StCardImportDispositionCountsV1 = Readonly<{
  accepted_typed: number;
  preserved_opaque: number;
  dropped_unsupported: number;
  rejected_invalid: number;
}>;
/** Durable evidence row for one confirmed import; never a capability. */
export type StCardImportHistoryEntryV1 = Readonly<{
  importId: string;
  occurredAtMs: number;
  cardName: string;
  counts: StCardImportDispositionCountsV1;
}>;
export type StCardImportHistoryV1 = Readonly<{
  apiVersion: 1;
  entries: readonly StCardImportHistoryEntryV1[];
}>;
/** Player persona projection: revision and safe display fields. */
export type PersonaV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  name: string | null;
  description: string | null;
}>;
/** Player scenario projection. */
export type ScenarioV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  name: string | null;
  description: string | null;
  preview: string | null;
}>;
/** Player greeting set projection. */
export type GreetingV1 = Readonly<{
  apiVersion: 1;
  present: boolean;
  revision: number | null;
  label: string | null;
  variants: readonly Readonly<{ label: string | null; text: string }>[];
}>;
/** Chat lifecycle retention result. */
export type ChatRetentionResultV1 = Readonly<{
  apiVersion: 1;
  handle: string;
  status: "active" | "archived" | "trashed";
  managementRevision: number;
}>;

export type TavernVoicePreferenceV1 = Readonly<{
  revision: number;
  disclosureVersion: "mimo-cloud-tts-v1" | null;
  consent: "undecided" | "accepted" | "revoked";
  decidedAtMs: number | null;
  /** `null` = Windows default output; `waveout:N` pins one enumerated endpoint. */
  outputDevice: string | null;
  /** `null` = no persona; otherwise the bounded lowercase-snake persona id. */
  persona: string | null;
}>;

export type TavernVoiceDevicesV1 = Readonly<{
  devices: readonly Readonly<{ id: string; name: string }>[];
  defaultSelectable: true;
}>;

export type TavernVoicePreferenceConsentCommandV1 =
  | Readonly<{ expectedRevision: number; action: "accept"; disclosureVersion: "mimo-cloud-tts-v1" }>
  | Readonly<{ expectedRevision: number; action: "revoke" }>
  | Readonly<{
      expectedRevision: number;
      action: "setOutputDevice";
      outputDevice: string | null;
    }>
  | Readonly<{
      expectedRevision: number;
      action: "setPersona";
      persona: string | null;
    }>;

/** Mirrors the Host's TavernLanguagePreferenceV1. */
export type TavernLanguagePreferenceV1 = Readonly<{
  revision: number;
  /** `null` = the player has never chosen; the runtime then uses its default. */
  locale: string | null;
}>;

/** Mirrors the Host's TavernLanguagePreferenceCommandV1. */
export type TavernLanguagePreferenceCommandV1 = Readonly<{
  expectedRevision: number;
  locale: string;
}>;

/**
 * Mirrors the Host's TavernDeliveryPreferenceV1: whether the player chose short
 * paced replies instead of one whole message.
 *
 * The record reads what the player chose and nothing else. Which surfaces honour
 * it, and what an un-chosen record falls to for each of them, is the delivery
 * path's decision, so this client never invents a default of its own.
 */
export type TavernDeliveryPreferenceV1 = Readonly<{
  revision: number;
  paced: boolean;
}>;

/** Mirrors the Host's TavernDeliveryPreferenceCommandV1. */
export type TavernDeliveryPreferenceCommandV1 = Readonly<{
  expectedRevision: number;
  paced: boolean;
}>;

export type TavernStateSnapshotV1 = Readonly<{
  apiVersion: 1;
  build: Readonly<{
    browserContract: "tavern_browser_api/v1";
    profileId: "gamebuddy.tavern-management.chat-list-title";
  }>;
  csrfToken: string;
  browserSession: Readonly<{ expiresAtMs: number }>;
  operations: readonly TavernBrowserOperationV1[];
  navigation: readonly unknown[];
  selection: Readonly<{ chatHandle: string; generation: number; stateRevision: string }> | null;
  chat: Readonly<{
    companion: Readonly<{ name: string; handle: string }>;
    title: string | null;
    transcript: readonly BrowserMessageV1[];
    draft: Readonly<{ revision: number; present: boolean }>;
    turn: BrowserTurnV1 | null;
    worldInfo: WorldInfoStateV1 | null;
  }> | null;
  memory: Readonly<{ readAvailable: boolean; mutationAvailable: boolean; projectionRevision: string | null }>;
  eventStream: null;
}>;

export type BrowserDraftV1 = Readonly<{ apiVersion: 1; revision: number; text: string | null }>;
type SaveDraftCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  expectedRevision: number;
  text: string;
}>;
type DiscardDraftCommandV1 = Readonly<{ apiVersion: 1; selectionGeneration: number; expectedRevision: number }>;
type ChatListQueryV1 = Readonly<{ apiVersion: 1; state?: "active" }>;

/** Metadata-only Chat list entry: no durable identifier ever appears. */
type ChatListEntryV1 = Readonly<{
  handle: string;
  title: string | null;
  status: "active";
  managementRevision: number;
  isSelected: boolean;
  /** The Host's durable last-activity time for the thread. */
  updatedAtMs: number;
  /** Plain-text preview of the last message; `null` for a Chat with no message. */
  preview: string | null;
}>;

type ChatListV1 = Readonly<{
  apiVersion: 1;
  chats: readonly ChatListEntryV1[];
}>;

type RenameChatTitleCommandV1 = Readonly<{
  apiVersion: 1;
  chatHandle: string;
  expectedManagementRevision: number;
  title: string;
}>;

export type ChatTitleV1 = Readonly<{
  apiVersion: 1;
  title: string | null;
  managementRevision: number;
}>;

/** The committed opening variant: the variant id and its position in the greeting set it came from. */
type BrowserOpeningVariantV1 = Readonly<{
  variantId: string;
  index: number;
  count: number;
  label: string | null;
  locked: boolean;
}>;

/** New-chat opening choice: the browser names no durable greeting or Chat id, only the step. */
type ChatOpeningCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  direction?: "prev" | "next";
  targetIndex?: number;
}>;

export type ChatOpeningResultV1 = Readonly<{
  apiVersion: 1;
  openingVariant: BrowserOpeningVariantV1;
}>;

/** New Chat: the browser names nothing durable, only the selection generation it read. */
type CreateChatCommandV1 = Readonly<{ apiVersion: 1; selectionGeneration: number }>;

/**
 * The created Chat's metadata-only entry plus the durable message-zero text when the Host opened
 * it on a greeting (`null` for a genuinely blank opening), so the surface can render message 0
 * before it claims success (design/26 §4.4).
 */
export type ChatCreateResultV1 = Readonly<{
  apiVersion: 1;
  chat: ChatListEntryV1;
  opening: string | null;
}>;

/** Chat selection (ADR 0009 / ADR-0010): the browser names the exact Chat it read and the generation it read. */
type SelectChatCommandV1 = Readonly<{
  apiVersion: 1;
  selectionGeneration: number;
  chatHandle: string;
}>;

/**
 * The honest selection outcome. Switching is turn-level and the request is never refused for a
 * generating turn (ADR-0010): the Host aborts the mounted turn through the same cancel path an
 * explicit Stop uses - including a turn whose attempt had not started, which is prepared to that
 * path first - lets that abort settle, releases the runtime and mounts the target, then answers
 * `switched`. `turn_in_flight` survives only as the fail-closed answer for the mounted turn that
 * path cannot reach; the runtime then stays where it is. The recorded selection is durable either
 * way.
 */
export type ChatSelectResultV1 = Readonly<{
  apiVersion: 1;
  status: "switched" | "turn_in_flight";
}>;

export type MemoryItemV1 = Readonly<{
  handle: string;
  title: string;
  content: string;
  category: "semantic" | "interaction";
  status: "active" | "permanent" | "archived";
  /** Whose memory this is: the player's own writing, or the companion's. */
  origin: "player" | "companion";
  pinned: boolean;
}>;

/**
 * One narrative chapter of the companion's long-term memory: the stretch of time it covers, the body, and
 * whether the player has touched it. Same kind of thing as a Memory row, same rule: the player may correct
 * it or remove it.
 */
export type MemoryChapterV1 = Readonly<{
  handle: string;
  title: string;
  span: string;
  content: string;
  status: "sealed" | "edited" | "deleted";
  editedByPlayer: boolean;
}>;

export type MemoryReadV1 = Readonly<{
  apiVersion: 1;
  projectionRevision: string;
  memories: readonly MemoryItemV1[];
  /** The continuity's chapters, oldest first. */
  chapters: readonly MemoryChapterV1[];
}>;

export type MemoryMutationCommandV1 =
  | Readonly<{ apiVersion: 1; operation: "create"; expectedProjectionRevision: string; content: string }>
  | Readonly<{
      apiVersion: 1;
      operation: "update";
      expectedProjectionRevision: string;
      handle: string;
      content: string;
    }>
  | Readonly<{ apiVersion: 1; operation: "archive"; expectedProjectionRevision: string; handle: string }>
  | Readonly<{
      apiVersion: 1;
      operation: "update_chapter";
      expectedProjectionRevision: string;
      handle: string;
      content: string;
    }>
  | Readonly<{ apiVersion: 1; operation: "delete_chapter"; expectedProjectionRevision: string; handle: string }>;

export type TavernProblemV1 = Readonly<{
  type: string;
  title: string;
  status: number;
  code: string;
  requestId: string;
  retryable: boolean;
}>;

/**
 * Connection and model management (design/28 §1, §5.1).
 *
 * `connectionId` is an opaque write handle; each row also carries the labels a
 * player reads. `baseUrl` is present only for the connection whose endpoint the
 * player typed (the OpenAI-compatible escape hatch) — it is the one endpoint
 * fact a player may read back. No credential, credential source or raw provider
 * error exists anywhere in these shapes.
 */
export type TavernConnectionSetupFieldV1 = "apiKey" | "apiKeyRequired" | "apiShape" | "baseUrl" | "modelId";
/**
 * The exact `api` shapes the assistant runtime's provider adapters speak — the
 * browser mirror of the Host's own list. The escape hatch is the one entry
 * whose player record chooses one, and the chosen value is written verbatim
 * into the runtime's provider entry.
 */
export const CONNECTION_API_SHAPES = [
  "anthropic-messages",
  "azure-openai-responses",
  "openai-completions",
  "openai-responses",
  "openai-codex-responses",
  "google-generative-ai",
  "google-vertex",
  "bedrock-converse-stream",
  "mistral-conversations",
  "pi-messages",
] as const;
export type TavernConnectionApiShapeV1 = (typeof CONNECTION_API_SHAPES)[number];
/** Derived from the one list, so the type cannot drift from the validator's. */
export type TavernConnectionThinkingLevelV1 = (typeof CONNECTION_THINKING_LEVELS)[number];
export type TavernConnectionReadinessV1 = "unconfigured" | "configured" | "ready" | "failed";
export type TavernConnectionFailureV1 =
  | "invalid_endpoint"
  | "not_configured"
  | "unauthorized"
  | "not_found"
  | "unreachable"
  | "timeout"
  | "invalid_response";

export type TavernConnectionModelV1 = Readonly<{
  modelId: string;
  modelLabel: string;
  allowedThinkingLevels: readonly TavernConnectionThinkingLevelV1[];
  defaultThinkingLevel: TavernConnectionThinkingLevelV1;
}>;

export type TavernConnectionProviderV1 = Readonly<{
  providerId: string;
  label: string;
  setupFields: readonly TavernConnectionSetupFieldV1[];
  allowedPlayerModels: readonly TavernConnectionModelV1[];
  escapeHatch: boolean;
  environmentManaged: boolean;
}>;

export type TavernConnectionV1 = Readonly<{
  connectionId: string;
  label: string;
  providerId: string;
  providerLabel: string;
  configured: boolean;
  readiness: TavernConnectionReadinessV1;
  active: boolean;
  modelId: string;
  modelLabel: string;
  thinkingLevel: TavernConnectionThinkingLevelV1;
  /** What this record's model accepts; the panel offers exactly these. */
  allowedThinkingLevels: readonly TavernConnectionThinkingLevelV1[];
  /**
   * The endpoint's own model listing as of this record's last probe, or null when that probe read
   * none. It is what the endpoint served at that moment, never a claim about which of them answers.
   */
  modelIds: readonly string[] | null;
  baseUrl: string | null;
  failure: TavernConnectionFailureV1 | null;
  lastCheckedAtMs: number | null;
}>;

export type TavernConnectionActiveV1 = Readonly<{
  connectionId: string;
  label: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  thinkingLevel: TavernConnectionThinkingLevelV1;
  readiness: TavernConnectionReadinessV1;
  baseUrl: string | null;
  failure: TavernConnectionFailureV1 | null;
  lastCheckedAtMs: number | null;
}>;

export type TavernConnectionStateV1 = Readonly<{
  apiVersion: 1;
  revision: number;
  active: TavernConnectionActiveV1 | null;
  connections: readonly TavernConnectionV1[];
  providers: readonly TavernConnectionProviderV1[];
}>;

export type TavernConnectionCreateCommandV1 = Readonly<{
  apiVersion: 1;
  providerId: string;
  apiKey?: string;
  baseUrl?: string;
  apiShape?: TavernConnectionApiShapeV1;
  modelId?: string;
  /** The player's answer for a self-hosted endpoint: does it need a credential at all? */
  apiKeyRequired?: boolean;
}>;

export type TavernConnectionProbeV1 = Readonly<{
  apiVersion: 1;
  connectionId: string;
  outcome: "ready" | "failed";
  failure: TavernConnectionFailureV1 | null;
  state: TavernConnectionStateV1;
}>;

/**
 * The player-managed model profiles (design/28 §2.3).
 *
 * `modelId` and `thinkingLevel` are exactly what the player typed: a general
 * bounded string, never a closed union and never a catalog membership test.
 * `recommendedModels` is guidance the panel may offer — it is never the set of
 * values a profile may hold.
 */
export type TavernRecommendedModelV1 = Readonly<{
  providerId: string;
  providerLabel: string;
  modelId: string;
  modelLabel: string;
  allowedThinkingLevels: readonly TavernConnectionThinkingLevelV1[];
  defaultThinkingLevel: TavernConnectionThinkingLevelV1;
}>;

/**
 * One surface's active model profile (design/28 §2.3): the thinking level that surface reasons
 * at. It names no model and no provider - the player's own active connection is the one thing
 * that names a provider, a model and an endpoint together, and this product ships no endpoint
 * of its own.
 */
export type TavernModelProfileV1 = Readonly<{
  revision: number;
  thinkingLevel: string;
}>;

export type TavernModelProfilesV1 = Readonly<{
  apiVersion: 1;
  chat: TavernModelProfileV1;
  game: TavernModelProfileV1;
  recommendedModels: readonly TavernRecommendedModelV1[];
}>;

export type TavernModelProfileUpdateCommandV1 = Readonly<{
  apiVersion: 1;
  surface: "chat" | "game";
  expectedRevision: number;
  thinkingLevel: string;
}>;

// --- Errors. ---

/**
 * The problem identity this module throws is the one `./reference-pipeline-api`
 * already declares, re-exported so a management failure and a chat failure are the
 * same `instanceof` at the one place a failure becomes a player-visible problem
 * (`composed-problem-view.ts`). A second declaration here would make that check
 * false for every management refusal and drop its `code` before the player reads it.
 */
export { TavernProblemError, TavernProtocolError };

export function problemCodeFor(error: unknown): string | null {
  return error instanceof TavernProblemError ? error.code : null;
}

// --- Local strict validation primitives (mirroring the frozen contract). ---

const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const HANDLE_PATTERN = /^[A-Za-z0-9_-]{22,128}$/;
const ROUTE_ID_PATTERN = /^[a-z][a-z0-9._-]*$/;
const MAX_TEXT_UTF8_BYTES = 16_384;
const MAX_MEMORY_TEXT_UTF8_BYTES = 4096;
const MAX_ARRAY_ITEMS = 100;

const MESSAGE_ROLES = ["player", "companion"] as const;
const MESSAGE_LOCALES = ["en", "zh-CN", "und"] as const;
const TURN_STATES = ["queued", "running", "response_visible", "stopping", "completed", "cancelled", "failed"] as const;
const TURN_PROBLEM_CODES = [
  "interrupted",
  "no_visible_presentation",
  "runtime_unavailable",
  "storage_unavailable",
] as const;
const OPERATION_IDS = [
  "chat.submit",
  "chat.cancel",
  "draft.save",
  "draft.discard",
  "chat.rename",
  "chat.opening",
  "chat.create",
  "chat.select",
  "memory.mutate",
  "world-info.bind",
  "world-info.detail",
  "world-info.create",
  "world-info.update",
  "world-info.delete",
  "settings.voice.read",
  "settings.voice.consent",
  "settings.voice.devices",
  "settings.language.read",
  "settings.language.update",
  "settings.delivery.read",
  "settings.delivery.update",
  "settings.connection.read",
  "settings.connection.create",
  "settings.connection.test",
  "settings.connection.activate",
  "settings.connection.model",
  "settings.connection.remove",
  "settings.profiles.read",
  "settings.profiles.update",
  // design/28 §2 Character / Persona / Scenario / Greeting + Chat retention.
  "companion.list",
  // design/28 §2 the companion's OWN world book: what the reviewed card carried,
  // which is a different thing from the World Info items a Chat can attach. Read
  // and rewritten through the same route pair, CASed on the book's own revision.
  "companion.worldbook.read",
  "companion.worldbook.update",
  // design/28 §2 the read-only character inspector: one roster companion's own authored
  // facts, which no other route projects for a companion who is not the mounted one.
  "companion.profile.read",
  // design/28 §2 the character-card export: a roster companion's own records as a
  // standard Tavern V3 card she can save and re-import.
  "companion.card.export",
  "companion.avatar.update",
  "companion.delete",
  "companion.create",
  // design/28 §2 companion directive: the mounted companion's own performance
  // directive (the reviewed card's `system_prompt`), read/edit/clear.
  "character.voice.read",
  "character.voice.update",
  // design/28 §2 import/export row: reviewed ST-card import pipeline.
  "character.import.stage",
  "character.import.read",
  "character.import.review",
  "character.import.confirm",
  "character.import.history",
  "persona.read",
  "persona.update",
  "scenario.read",
  "scenario.update",
  "greeting.read",
  "greeting.update",
  "chat.archive",
  "chat.restore",
  "chat.trash",
] as const;
const MANAGEMENT_LABEL_KEYS = [
  "tavern.nav.chat",
  "tavern.nav.memory",
  "tavern.operation.submit",
  "tavern.operation.cancel",
  "tavern.operation.draft.save",
  "tavern.operation.draft.discard",
  "tavern.operation.rename",
  "tavern.operation.chat.opening",
  "tavern.operation.chat.create",
  "tavern.operation.chat.select",
  "tavern.operation.memory.mutate",
  "tavern.operation.world-info.bind",
  "tavern.operation.world-info.detail",
  "tavern.operation.world-info.create",
  "tavern.operation.world-info.update",
  "tavern.operation.world-info.delete",
  "tavern.operation.settings.voice.read",
  "tavern.operation.settings.voice.consent",
  "tavern.operation.settings.voice.devices",
  "tavern.operation.settings.language.read",
  "tavern.operation.settings.language.update",
  "tavern.operation.settings.delivery.read",
  "tavern.operation.settings.delivery.update",
  "tavern.operation.settings.connection.read",
  "tavern.operation.settings.connection.create",
  "tavern.operation.settings.connection.test",
  "tavern.operation.settings.connection.activate",
  "tavern.operation.settings.connection.model",
  "tavern.operation.settings.connection.remove",
  "tavern.operation.settings.profiles.read",
  "tavern.operation.settings.profiles.update",
  "tavern.nav.characters",
  "tavern.operation.companion.list",
  "tavern.operation.companion.worldbook.read",
  "tavern.operation.companion.worldbook.update",
  "tavern.operation.companion.profile.read",
  "tavern.operation.companion.card.export",
  "tavern.operation.companion.avatar.update",
  "tavern.operation.companion.delete",
  "tavern.operation.companion.create",
  "tavern.operation.character.import.stage",
  "tavern.operation.character.import.read",
  "tavern.operation.character.import.review",
  "tavern.operation.character.import.confirm",
  "tavern.operation.character.import.history",
  "tavern.operation.persona.read",
  "tavern.operation.persona.update",
  "tavern.operation.scenario.read",
  "tavern.operation.scenario.update",
  "tavern.operation.greeting.read",
  "tavern.operation.greeting.update",
  "tavern.operation.chat.archive",
  "tavern.operation.chat.restore",
  "tavern.operation.chat.trash",
  "tavern.operation.character.voice.read",
  "tavern.operation.character.voice.update",
] as const;
const OPERATION_AVAILABILITY = ["available", "busy", "unavailable"] as const;
const NAVIGATION_ITEM_IDS = ["chat", "memory", "characters"] as const;
const NAVIGATION_AVAILABILITY = ["available", "unavailable"] as const;
const WORLD_INFO_STATES = ["none", "selected", "pending", "unavailable"] as const;
const VOICE_DISCLOSURE_VERSIONS = ["mimo-cloud-tts-v1"] as const;
const VOICE_CONSENTS = ["undecided", "accepted", "revoked"] as const;
// The MIMO voice persona id shape, mirroring the Host store's VOICE_PERSONA_PATTERN.
const VOICE_PERSONA_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;
const VOICE_PERSONA_MAX_LENGTH = 32;
const PROBLEM_CODES = [
  "unauthorized",
  "csrf_failed",
  "invalid_request",
  "unsupported_api_version",
  "profile_operation_unavailable",
  "selection_conflict",
  "draft_conflict",
  "idempotency_conflict",
  "idempotency_in_progress",
  "idempotency_expired",
  "turn_busy",
  "stream_resync_required",
  "selection_busy",
  "turn_not_active",
  "turn_already_terminal",
  "runtime_unavailable",
  "presentation_unavailable",
  "storage_unavailable",
  "state_reconciliation_required",
  "settings_revision_conflict",
  // design/28 §5.3: activation may not switch a running turn, and the
  // connection routes carry their own closed problem codes.
  "dialogue_busy",
  "connection_not_found",
  "connection_not_ready",
  "connection_conflict",
  "connection_limit_reached",
  "companion_not_found",
  "companion_conflict",
  // The mounted companion's directive is CASed on the exact profile revision
  // the browser read; a stale edit is its own bounded refusal.
  "character_voice_conflict",
  "character_voice_turn_active",
  // design/28 §2 import/export row: the staged-card pipeline has its own closed
  // problem codes (rejected card, unknown import, unreviewed confirm).
  "st_card_import_rejected",
  "character_import_not_found",
  "character_import_review_invalid",
  "character_import_confirm_invalid",
  "persona_conflict",
  "scenario_conflict",
  "greeting_conflict",
  "authored_content_invalid",
  // The new-chat opening choice's bounded refusals (sealed opening / not a greeting / unknown variant).
  "chat_opening_locked",
  "chat_opening_not_greeting",
  "chat_opening_variant_not_found",
  "chat_message_not_found",
  "chat_message_revision_conflict",
  "chat_rewind_opening_retained",
  "chat_rewind_turn_active",
  "chat_edit_turn_active",
  "chat_delete_opening_retained",
  "chat_delete_turn_active",
  "chat_delete_binding_unavailable",
  // Chat management names any Chat of the partition by its own handle (not only the mounted one);
  // a handle that names none is bounded and player-actionable, not a selection conflict.
  "chat_not_found",
  // The managed World Info library's own refusals (`world-info.create`/`update`/`delete`/`detail`):
  // the item is gone, its title is taken, the edit raced a newer revision, or the mounted Chat
  // still reads it. Each reaches the player as its own code rather than as a generic failure.
  "world_info_not_found",
  "world_info_already_exists",
  "world_info_revision_conflict",
  "world_info_in_use",
  // A companion record that is absent, incomplete or unreadable: a data-integrity fact, not a
  // retryable runtime outage.
  "companion_record_unreadable",
  // Her own world book is one durable file replaced whole, so an edit CASes on the
  // revision the browser read. Each refusal is its own code rather than a generic
  // failure: the book moved on, she has no book to edit, or the durable thread store
  // could not follow the change (the last is not retryable into validity).
  "companion_world_book_conflict",
  "companion_world_book_absent",
  "companion_world_book_binding_partial",
  // `companion.card.export` refuses by name when a companion's own records will not fit a
  // Tavern card our import accepts: a bounded, non-retryable fact about her data.
  "companion_card_too_large",
  // And the PNG form's own refusal: a PNG card must contain an image, and a companion
  // with no picture has none the Host will put there. The JSON card carries her records
  // without a picture, so this is a bounded fact about her records, not a runtime outage.
  "companion_card_image_absent",
  // `companion.avatar.update` refuses a picture it will not keep by name: the file is over
  // the ceiling the avatar module reads by, or its bytes are not a complete PNG. Both are
  // bounded, non-retryable facts about the file the player picked.
  "companion_avatar_too_large",
  "companion_avatar_malformed",
  // `companion.delete` refuses to remove the companion who is in play: her Chats are the
  // mounted conversation, so removing her would take the conversation the player is
  // having. It is the one refusal the control itself is absent for.
  "companion_delete_in_play",
  // Transport: the over-ceiling request body the management dispatcher refuses before any route
  // runs (`tavern-management-dialogue-web.ts:538`), sent outside its own schema check. It must be
  // named here or the typed 413 arrives as an opaque `TavernProtocolError` with no code to show;
  // `dialogue-web/tests/problem-code-gate.test.mjs` (`problem-code.7`) holds this set equal to the
  // contract's union.
  "payload_too_large",
] as const;

const MESSAGE_KEYS = ["handle", "role", "text", "locale", "order", "revision"] as const;
const TURN_KEYS = ["handle", "state", "projectionRevision", "canCancel"] as const;
/** The two additive optional turn facts, in any combination; see `reference-pipeline-api.ts`. */
const TURN_OPTIONAL_KEYS = ["problemCode", "truncated"] as const;
const OPERATION_KEYS = ["operationId", "labelKey", "availability", "routeId"] as const;
const NAVIGATION_ITEM_KEYS = ["itemId", "labelKey", "availability"] as const;
const WORLD_INFO_KEYS = ["state", "revision", "items"] as const;
const WORLD_INFO_ITEM_KEYS = ["handle", "title", "summary", "selected", "pending"] as const;
const SET_WORLD_INFO_BINDING_COMMAND_KEYS = [
  "apiVersion",
  "selectionGeneration",
  "expectedRevision",
  "sourceHandle",
] as const;
const SNAPSHOT_KEYS = [
  "apiVersion",
  "build",
  "csrfToken",
  "browserSession",
  "operations",
  "navigation",
  "selection",
  "chat",
  "memory",
  "eventStream",
] as const;
// `voice` is `Type.Optional` in the Host contract (host/src/tavern/browser-contract).
// This mirror is strict - hasExactKeys compares lengths - so "optional" has to be
// written as "exactly one of these two shapes", not left out of the list. Leaving
// it out made the client reject any snapshot that carried the field, and the time
// between the Host adding a key and this mirror learning it is exactly when the
// whole management surface goes dark (the `pending` World Info key did that: no
// panel was reachable at all).
const SNAPSHOT_KEYS_WITH_VOICE = [
  "apiVersion",
  "build",
  "csrfToken",
  "browserSession",
  "operations",
  "navigation",
  "selection",
  "chat",
  "memory",
  "voice",
  "eventStream",
] as const;
const SNAPSHOT_BUILD_KEYS = ["browserContract", "profileId"] as const;
const SNAPSHOT_BROWSER_SESSION_KEYS = ["expiresAtMs"] as const;
const SNAPSHOT_SELECTION_KEYS = ["chatHandle", "generation", "stateRevision"] as const;
const SNAPSHOT_CHAT_KEYS = ["companion", "title", "transcript", "draft", "turn", "worldInfo"] as const;
const CHAT_COMPANION_KEYS = ["name", "handle"] as const;
const CHAT_DRAFT_KEYS = ["revision", "present"] as const;
const MEMORY_KEYS = ["readAvailable", "mutationAvailable", "projectionRevision"] as const;
const MEMORY_ITEM_KEYS = ["handle", "title", "content", "category", "status", "origin", "pinned"] as const;
const MEMORY_READ_KEYS = ["apiVersion", "projectionRevision", "memories", "chapters"] as const;
const MEMORY_MUTATION_CREATE_KEYS = ["apiVersion", "operation", "expectedProjectionRevision", "content"] as const;
const MEMORY_MUTATION_UPDATE_KEYS = [
  "apiVersion",
  "operation",
  "expectedProjectionRevision",
  "handle",
  "content",
] as const;
const MEMORY_MUTATION_ARCHIVE_KEYS = ["apiVersion", "operation", "expectedProjectionRevision", "handle"] as const;
const MEMORY_CATEGORIES = ["semantic", "interaction"] as const;
const MEMORY_STATUSES = ["active", "permanent", "archived"] as const;
const MEMORY_ORIGINS = ["player", "companion"] as const;
const MAX_MEMORY_ITEMS = 200;
const MEMORY_CHAPTER_STATUSES = ["sealed", "edited", "deleted"] as const;
const MEMORY_CHAPTER_KEYS = ["handle", "title", "span", "content", "status", "editedByPlayer"] as const;
const DRAFT_KEYS = ["apiVersion", "revision", "text"] as const;
const SAVE_DRAFT_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision", "text"] as const;
const DISCARD_DRAFT_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision"] as const;
const _CHAT_LIST_QUERY_KEYS = ["apiVersion", "state"] as const;
const CHAT_LIST_ENTRY_KEYS = [
  "handle",
  "title",
  "status",
  "managementRevision",
  "isSelected",
  "updatedAtMs",
  "preview",
] as const;
const CHAT_LIST_KEYS = ["apiVersion", "chats"] as const;
const RENAME_COMMAND_KEYS = ["apiVersion", "chatHandle", "expectedManagementRevision", "title"] as const;
const CHAT_TITLE_KEYS = ["apiVersion", "title", "managementRevision"] as const;
const SWIPE_INFO_KEYS = ["currentIndex", "totalSwipes", "label", "hasPrevious", "hasNext"] as const;
const OPENING_VARIANT_KEYS = ["variantId", "index", "count", "label", "locked"] as const;
const CHAT_OPENING_RESULT_KEYS = ["apiVersion", "openingVariant"] as const;
const CREATE_CHAT_COMMAND_KEYS = ["apiVersion", "selectionGeneration"] as const;
const CHAT_CREATE_RESULT_KEYS = ["apiVersion", "chat", "opening"] as const;
const SELECT_CHAT_COMMAND_KEYS = ["apiVersion", "selectionGeneration", "chatHandle"] as const;
const CHAT_SELECT_RESULT_KEYS = ["apiVersion", "status"] as const;
const OPENING_COMMAND_REQUIRED_KEYS = ["apiVersion", "selectionGeneration"] as const;
const OPENING_COMMAND_ALLOWED_KEYS = ["apiVersion", "selectionGeneration", "direction", "targetIndex"] as const;
const OPENING_VARIANT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/;
const OPENING_DIRECTIONS = ["prev", "next"] as const;
const PROBLEM_KEYS = ["type", "title", "status", "code", "requestId", "retryable"] as const;
const LANGUAGE_PREFERENCE_KEYS = ["revision", "locale"] as const;
const LANGUAGE_PREFERENCE_COMMAND_KEYS = ["expectedRevision", "locale"] as const;
const DELIVERY_PREFERENCE_KEYS = ["revision", "paced"] as const;
const DELIVERY_PREFERENCE_COMMAND_KEYS = ["expectedRevision", "paced"] as const;
const VOICE_PREFERENCE_KEYS = [
  "revision",
  "disclosureVersion",
  "consent",
  "decidedAtMs",
  "outputDevice",
  "persona",
] as const;
const VOICE_PREFERENCE_ACCEPT_KEYS = ["expectedRevision", "action", "disclosureVersion"] as const;
const VOICE_PREFERENCE_REVOKE_KEYS = ["expectedRevision", "action"] as const;
const VOICE_PREFERENCE_DEVICE_KEYS = ["expectedRevision", "action", "outputDevice"] as const;
const VOICE_PREFERENCE_PERSONA_KEYS = ["expectedRevision", "action", "persona"] as const;
const VOICE_DEVICES_KEYS = ["devices", "defaultSelectable"] as const;
const VOICE_DEVICE_KEYS = ["id", "name"] as const;
const CONNECTION_STATE_KEYS = ["apiVersion", "revision", "active", "connections", "providers"] as const;
const CONNECTION_ROW_KEYS = [
  "connectionId",
  "label",
  "providerId",
  "providerLabel",
  "configured",
  "readiness",
  "active",
  "modelId",
  "modelLabel",
  "thinkingLevel",
  "allowedThinkingLevels",
  "modelIds",
  "baseUrl",
  "failure",
  "lastCheckedAtMs",
] as const;
const CONNECTION_ACTIVE_KEYS = [
  "connectionId",
  "label",
  "providerLabel",
  "modelId",
  "modelLabel",
  "thinkingLevel",
  "readiness",
  "baseUrl",
  "failure",
  "lastCheckedAtMs",
] as const;
const CONNECTION_PROVIDER_KEYS = [
  "providerId",
  "label",
  "setupFields",
  "allowedPlayerModels",
  "escapeHatch",
  "environmentManaged",
] as const;
const CONNECTION_MODEL_KEYS = ["modelId", "modelLabel", "allowedThinkingLevels", "defaultThinkingLevel"] as const;
// The Host's own ceiling on one endpoint's published listing (`TAVERN_MODEL_LISTING_LIMIT` in
// host/src/tavern/browser-contract/index.ts); kept as a literal because this module is deliberately
// dependency-free, and pinned to the Host's value by the mirror test.
const CONNECTION_MODEL_LISTING_LIMIT = 32;
const CONNECTION_PROBE_KEYS = ["apiVersion", "connectionId", "outcome", "failure", "state"] as const;
const CONNECTION_SETUP_FIELDS = ["apiKey", "apiKeyRequired", "apiShape", "baseUrl", "modelId"] as const;
// The thinking levels the embedded runtime accepts, mirroring pi's own
// VALID_THINKING_LEVELS (pi-coding-agent/dist/cli/args.js). Kept as a literal here
// because this module is deliberately dependency-free.
const CONNECTION_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const CONNECTION_READINESS = ["unconfigured", "configured", "ready", "failed"] as const;
const CONNECTION_FAILURES = [
  "invalid_endpoint",
  "not_configured",
  "unauthorized",
  "not_found",
  "unreachable",
  "timeout",
  "invalid_response",
] as const;
// Mirrors of the Host's open model-profile bounds (design/28 §2.3.1): the panel
// refuses only a malformed value. The model-id bound is still here because a
// provider's published model listing is bounded by the same ceiling the Host uses,
// so https://… a listing id the product would refuse cannot reach the panel.
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const MODEL_PROFILE_THINKING_LEVEL_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MODEL_PROFILES_KEYS = ["apiVersion", "chat", "game", "recommendedModels"] as const;
const MODEL_PROFILE_KEYS = ["revision", "thinkingLevel"] as const;
const RECOMMENDED_MODEL_KEYS = [
  "providerId",
  "providerLabel",
  "modelId",
  "modelLabel",
  "allowedThinkingLevels",
  "defaultThinkingLevel",
] as const;
const MODEL_PROFILE_UPDATE_KEYS = ["apiVersion", "surface", "expectedRevision", "thinkingLevel"] as const;
const MODEL_PROFILE_SURFACES = ["chat", "game"] as const;
const STAGE_ST_CARD_IMPORT_JSON_KEYS = ["apiVersion", "cardSource", "card"] as const;
const STAGE_ST_CARD_IMPORT_PNG_KEYS = ["apiVersion", "cardSource", "cardFileBase64"] as const;

/**
 * The stage command as the browser intends to send it. Both arms are refused
 * before the request leaves: a payload the Host would reject is not sent, and an
 * over-large one is never read into memory in the first place.
 */
function isStageStCardImportCommand(value: unknown): value is StageStCardImportCommandV1 {
  if (!isRecord(value) || value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  if (value.cardSource === "json")
    return hasExactKeys(value, STAGE_ST_CARD_IMPORT_JSON_KEYS) && isLengthBoundedString(value.card, 1, 2_097_152);
  if (value.cardSource === "png")
    return (
      hasExactKeys(value, STAGE_ST_CARD_IMPORT_PNG_KEYS) &&
      isLengthBoundedString(value.cardFileBase64, 1, MAX_CARD_FILE_BASE64_CHARS)
    );
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const ownKeys = Object.keys(record);
  if (ownKeys.length !== keys.length) return false;
  for (const key of keys) {
    if (!ownKeys.includes(key)) return false;
  }
  return true;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value >= 1;
}

function isLengthBoundedString(value: unknown, minLength: number, maxLength: number): value is string {
  return typeof value === "string" && value.length >= minLength && value.length <= maxLength;
}

function isOneOf(value: unknown, allowed: readonly string[]): value is string {
  return typeof value === "string" && allowed.includes(value);
}

/** Canonical unpadded base64url: no padding, no length%4===1, zeroed trailing bits. */
function isCanonicalUnpaddedBase64Url(value: string): boolean {
  const length = value.length;
  if (length === 0 || length % 4 === 1) return false;
  for (let index = 0; index < length; index += 1) {
    if (BASE64URL_ALPHABET.indexOf(value.charAt(index)) < 0) return false;
  }
  const finalIndex = BASE64URL_ALPHABET.indexOf(value.charAt(length - 1));
  if (length % 4 === 0) return true;
  return length % 4 === 2 ? finalIndex % 16 === 0 : finalIndex % 4 === 0;
}

/** Canonical opaque handle: 22-128 chars, base64url alphabet, canonical unpadded encoding. */
function isOpaqueHandle(value: unknown): value is string {
  return typeof value === "string" && HANDLE_PATTERN.test(value) && isCanonicalUnpaddedBase64Url(value);
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.length) return true;
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** NFC, no unpaired surrogates, bounded UTF-8 bytes (frozen BoundedText). */
function isBoundedText(value: unknown, maxBytes: number): value is string {
  return isNfcUtf8Text(value, 1, maxBytes);
}

function isNfcUtf8Text(value: unknown, minLength = 1, maxBytes = MAX_TEXT_UTF8_BYTES): value is string {
  if (typeof value !== "string" || value.length < minLength) return false;
  if (hasUnpairedUtf16Surrogate(value)) return false;
  if (value !== value.normalize("NFC")) return false;
  return new TextEncoder().encode(value).byteLength <= maxBytes;
}

// --- DTO validators (strict closed shapes; every invalid value throws TavernProtocolError). ---

function isBrowserMessage(value: unknown): value is BrowserMessageV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!MESSAGE_KEYS.every((key) => keys.includes(key))) return false;
  // The two additive optional facts a message may carry; any subset is legal.
  const optionalKeys = ["swipeInfo", "openingVariant"] as const;
  const expectedKeys = MESSAGE_KEYS.length + optionalKeys.filter((key) => key in value).length;
  if (keys.length !== expectedKeys) return false;
  if ("swipeInfo" in value && !isBrowserSwipeInfo(value.swipeInfo)) return false;
  if ("openingVariant" in value && !isBrowserOpeningVariant(value.openingVariant)) return false;
  return (
    isOpaqueHandle(value.handle) &&
    isOneOf(value.role, MESSAGE_ROLES) &&
    isNfcUtf8Text(value.text) &&
    isOneOf(value.locale, MESSAGE_LOCALES) &&
    isNonNegativeSafeInteger(value.order) &&
    isNonNegativeSafeInteger(value.revision)
  );
}

function isBrowserTurn(value: unknown): value is BrowserTurnV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!TURN_KEYS.every((key) => keys.includes(key))) return false;
  if (keys.length !== TURN_KEYS.length + TURN_OPTIONAL_KEYS.filter((key) => key in value).length) return false;
  if (!isOpaqueHandle(value.handle) || !isOneOf(value.state, TURN_STATES)) return false;
  if (!isNonNegativeSafeInteger(value.projectionRevision) || typeof value.canCancel !== "boolean") return false;
  if ("problemCode" in value && !isOneOf(value.problemCode, TURN_PROBLEM_CODES)) return false;
  if ("truncated" in value && value.truncated !== true) return false;
  return true;
}

function isTavernBrowserOperation(value: unknown): value is TavernBrowserOperationV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, OPERATION_KEYS) &&
    isOneOf(value.operationId, OPERATION_IDS) &&
    isOneOf(value.labelKey, MANAGEMENT_LABEL_KEYS) &&
    isOneOf(value.availability, OPERATION_AVAILABILITY) &&
    isLengthBoundedString(value.routeId, 1, 128) &&
    ROUTE_ID_PATTERN.test(value.routeId)
  );
}

function isNavigationItem(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, NAVIGATION_ITEM_KEYS) &&
    isOneOf(value.itemId, NAVIGATION_ITEM_IDS) &&
    isOneOf(value.labelKey, MANAGEMENT_LABEL_KEYS) &&
    isOneOf(value.availability, NAVIGATION_AVAILABILITY)
  );
}

function isWorldInfoItem(value: unknown): value is WorldInfoItemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_ITEM_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isLengthBoundedString(value.title, 1, 256) &&
    (value.summary === null || isLengthBoundedString(value.summary, 0, 512)) &&
    typeof value.selected === "boolean" &&
    typeof value.pending === "boolean"
  );
}

function isWorldInfo(value: unknown): value is WorldInfoStateV1 {
  if (!isRecord(value) || !hasExactKeys(value, WORLD_INFO_KEYS)) return false;
  return (
    isOneOf(value.state, WORLD_INFO_STATES) &&
    isOpaqueHandle(value.revision) &&
    Array.isArray(value.items) &&
    value.items.length <= MAX_ARRAY_ITEMS &&
    value.items.every(isWorldInfoItem)
  );
}

function isSetWorldInfoBindingCommand(value: unknown): value is SetWorldInfoBindingCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SET_WORLD_INFO_BINDING_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isOpaqueHandle(value.expectedRevision) &&
    (value.sourceHandle === null || isOpaqueHandle(value.sourceHandle))
  );
}

const WORLD_INFO_ENTRY_KEYS = ["scope", "publicTitle", "summary"] as const;
const WORLD_INFO_CONTENT_KEYS = ["revision", "publicTitle", "summary", "entries"] as const;
const WORLD_INFO_AUTHORED_KEYS = ["publicTitle", "summary", "entries"] as const;
const WORLD_INFO_UPDATE_ITEM_KEYS = ["publicTitle", "summary", "entries", "expectedRevision"] as const;
const WORLD_INFO_ITEM_COMMAND_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision", "itemHandle"] as const;
const WORLD_INFO_CREATE_COMMAND_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision", "item"] as const;
const WORLD_INFO_IMPORT_COMMAND_KEYS = ["apiVersion", "selectionGeneration", "expectedRevision", "lorebook"] as const;
/**
 * The largest lorebook file the import route accepts, mirroring the Host's own body ceiling
 * (`MAX_WORLD_INFO_IMPORT_BODY_BYTES`). The picker refuses a larger file before reading a byte of it,
 * so the refusal is a sentence rather than a multi-megabyte round trip.
 */
export const MAX_LOREBOOK_FILE_BYTES = 2 * 1024 * 1024;
const WORLD_INFO_UPDATE_COMMAND_KEYS = [
  "apiVersion",
  "selectionGeneration",
  "expectedRevision",
  "itemHandle",
  "item",
] as const;

/** A trigger-word list: non-empty and bounded, exactly as the library stores one. */
function isWorldInfoKeyList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length >= 1 &&
    value.length <= 128 &&
    value.every((key) => isLengthBoundedString(key, 1, 128))
  );
}

function isWorldInfoSelectiveLogic(value: unknown): boolean {
  return value === 0 || value === 1 || value === 2 || value === 3;
}

function isWorldInfoEntry(value: unknown): value is WorldInfoEntryV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!WORLD_INFO_ENTRY_KEYS.every((key) => keys.includes(key))) return false;
  // The four additive optional entry facts; any subset is legal.
  const optionalKeys = ["keys", "secondaryKeys", "selectiveLogic", "constant"] as const;
  if (keys.length !== WORLD_INFO_ENTRY_KEYS.length + optionalKeys.filter((key) => key in value).length) return false;
  if ("keys" in value && !isWorldInfoKeyList(value.keys)) return false;
  if ("secondaryKeys" in value && !isWorldInfoKeyList(value.secondaryKeys)) return false;
  if ("selectiveLogic" in value && !isWorldInfoSelectiveLogic(value.selectiveLogic)) return false;
  if ("constant" in value && typeof value.constant !== "boolean") return false;
  return (
    (value.scope === "companion" || value.scope === "setting") &&
    isLengthBoundedString(value.publicTitle, 1, 128) &&
    isLengthBoundedString(value.summary, 1, 4_000)
  );
}

function isWorldInfoEntryList(value: unknown): value is readonly WorldInfoEntryV1[] {
  return Array.isArray(value) && value.every(isWorldInfoEntry);
}

/** The authored content a create carries: the library mints the item's first revision. */
function isWorldInfoAuthoredContent(value: unknown): value is WorldInfoAuthoredContentV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_AUTHORED_KEYS) &&
    isLengthBoundedString(value.publicTitle, 1, 128) &&
    isLengthBoundedString(value.summary, 1, 4_000) &&
    isWorldInfoEntryList(value.entries)
  );
}

/**
 * One item's own projection. `revision` is the library's own optimistic revision - an integer -
 * and `entries` is uncapped for the same reason the contract leaves it uncapped: the library's own
 * envelope is the bound, and a stricter mirror would refuse a legal artifact.
 */
function isWorldInfoContent(value: unknown): value is WorldInfoContentV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_CONTENT_KEYS) &&
    isPositiveSafeInteger(value.revision) &&
    isLengthBoundedString(value.publicTitle, 1, 128) &&
    isLengthBoundedString(value.summary, 1, 4_000) &&
    isWorldInfoEntryList(value.entries)
  );
}

function isWorldInfoProjectionCommand(value: Record<string, unknown>): boolean {
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isOpaqueHandle(value.expectedRevision)
  );
}

function isWorldInfoItemCommand(value: unknown): value is WorldInfoItemCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_ITEM_COMMAND_KEYS) &&
    isWorldInfoProjectionCommand(value) &&
    isOpaqueHandle(value.itemHandle)
  );
}

function isWorldInfoCreateCommand(value: unknown): value is WorldInfoCreateCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_CREATE_COMMAND_KEYS) &&
    isWorldInfoProjectionCommand(value) &&
    isWorldInfoAuthoredContent(value.item)
  );
}

function isWorldInfoUpdateCommand(value: unknown): value is WorldInfoUpdateCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_UPDATE_COMMAND_KEYS) &&
    isWorldInfoProjectionCommand(value) &&
    isOpaqueHandle(value.itemHandle) &&
    isRecord(value.item) &&
    hasExactKeys(value.item, WORLD_INFO_UPDATE_ITEM_KEYS) &&
    isPositiveSafeInteger(value.item.expectedRevision) &&
    isWorldInfoAuthoredContent({
      publicTitle: value.item.publicTitle,
      summary: value.item.summary,
      entries: value.item.entries,
    })
  );
}

/**
 * One external lorebook file, carried whole. The file's interior is the Host importer's business,
 * so this mirror admits any JSON object and decides nothing about its entries - exactly the shape
 * `tavern-lorebook-importer.ts` reads through the library's own `import()`.
 */
function isWorldInfoImportCommand(value: unknown): value is WorldInfoImportCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, WORLD_INFO_IMPORT_COMMAND_KEYS) &&
    isWorldInfoProjectionCommand(value) &&
    isRecord(value.lorebook)
  );
}

const COMPANION_LIST_KEYS = ["apiVersion", "companions"] as const;
const COMPANION_LIST_ENTRY_KEYS = ["handle", "name", "isCurrent"] as const;
const COMPANION_DETAIL_KEYS = ["apiVersion", "name"] as const;
const PERSONA_KEYS = ["apiVersion", "present", "revision", "name", "description"] as const;
const SCENARIO_KEYS = ["apiVersion", "present", "revision", "name", "description", "preview"] as const;
const GREETING_KEYS = ["apiVersion", "present", "revision", "label", "variants"] as const;
const GREETING_VARIANT_KEYS = ["label", "text"] as const;
const RETENTION_RESULT_KEYS = ["apiVersion", "handle", "status", "managementRevision"] as const;
const RETENTION_OPERATIONS = ["archive", "restore", "trash"] as const;
const CHAT_EXPORT_KEYS = [
  "apiVersion",
  "format",
  "chatHandle",
  "messageCount",
  "dispositions",
  "canonicalHash",
  "jsonl",
] as const;
const CHAT_EXPORT_DISPOSITION_KEYS = ["field", "classification", "reason"] as const;
const CHAT_EXPORT_DISPOSITION_CLASSES = ["accepted_typed", "dropped_unsupported", "rejected_invalid"] as const;
// Mirrors the contract's own `CHAT_EXPORT_JSONL_MAX_LENGTH`: 256 bubbles of at most 4 000 bytes plus their JSON.
const CHAT_EXPORT_JSONL_MAX_LENGTH = 1_048_576;
const CHAT_EXPORT_HASH_PATTERN = /^[0-9a-f]{64}$/;

function isCompanionList(value: unknown): value is CompanionListV1 {
  if (!isRecord(value) || !hasExactKeys(value, COMPANION_LIST_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    Array.isArray(value.companions) &&
    value.companions.every(
      (entry) =>
        isRecord(entry) &&
        hasExactKeys(entry, COMPANION_LIST_ENTRY_KEYS) &&
        isOpaqueHandle(entry.handle) &&
        isLengthBoundedString(entry.name, 1, 128) &&
        typeof entry.isCurrent === "boolean",
    )
  );
}

function isCompanionDetail(value: unknown): value is CompanionDetailV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_DETAIL_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isLengthBoundedString(value.name, 1, 128)
  );
}

const COMPANION_VOICE_KEYS = ["apiVersion", "profileRevision", "characterVoice"] as const;
const COMPANION_CHARACTER_VOICE_KEYS = ["text", "source"] as const;
/**
 * The value the one profile-revision read returns: the exact revision the edit
 * must CAS on, plus the effective directive (null when the field is absent).
 * A cleared directive reads as `null`, the same absence the prompt renders.
 */
function isCompanionVoice(value: unknown): value is CompanionVoiceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_VOICE_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isNonNegativeSafeInteger(value.profileRevision) &&
    (value.characterVoice === null || isCompanionCharacterVoice(value.characterVoice))
  );
}

function isCompanionCharacterVoice(value: unknown): value is CompanionCharacterVoiceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_CHARACTER_VOICE_KEYS) &&
    isLengthBoundedString(value.text, 1, 8_192) &&
    (value.source === "card" || value.source === "player")
  );
}

const COMPANION_WORLD_BOOK_KEYS = ["apiVersion", "present", "revision", "entries"] as const;
const COMPANION_WORLD_BOOK_ENTRY_KEYS = ["title", "keys", "constant", "content"] as const;
/**
 * The companion's own world book, read once per mount. The browser may not widen
 * what the Host bounded: an entry's title is `worldbook.ts`'s own title bound, its
 * trigger words are the persisted entry's own per-entry list bound, and the list
 * is the persisted `MAX_ENTRIES` ceiling.
 */
function isCompanionWorldBook(value: unknown): value is CompanionWorldBookV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_WORLD_BOOK_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.revision === null || isPositiveSafeInteger(value.revision)) &&
    Array.isArray(value.entries) &&
    value.entries.length <= 128 &&
    value.entries.every(isCompanionWorldBookEntry)
  );
}

function isCompanionWorldBookEntry(value: unknown): value is CompanionWorldBookEntryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_WORLD_BOOK_ENTRY_KEYS) &&
    isLengthBoundedString(value.title, 1, 256) &&
    typeof value.constant === "boolean" &&
    // The Host bounds the rendered body; the mirror may not widen it.
    isLengthBoundedString(value.content, 0, 4_096) &&
    Array.isArray(value.keys) &&
    value.keys.length <= 16 &&
    value.keys.every((key) => isLengthBoundedString(key, 1, 64))
  );
}

const UPDATE_COMPANION_WORLD_BOOK_COMMAND_KEYS = ["apiVersion", "expectedRevision", "entries"] as const;
/**
 * One player edit of the companion's own world book. The revision is the one the
 * read carried, so the mirror checks it is a positive integer rather than settling
 * for "a number": the durable book's own revision is never zero.
 */
function isUpdateCompanionWorldBookCommand(value: unknown): value is UpdateCompanionWorldBookCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, UPDATE_COMPANION_WORLD_BOOK_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.expectedRevision) &&
    Array.isArray(value.entries) &&
    value.entries.length <= 128 &&
    value.entries.every(isCompanionWorldBookEntry)
  );
}

const COMPANION_PROFILE_KEYS = [
  "apiVersion",
  "name",
  "revision",
  "persona",
  "scenario",
  "greetings",
  "worldBook",
] as const;
const COMPANION_PROFILE_PERSONA_KEYS = ["present", "core", "interactionStyle", "expressionStyle"] as const;
const COMPANION_PROFILE_SCENARIO_KEYS = ["present", "name", "description"] as const;
const COMPANION_PROFILE_GREETINGS_KEYS = ["present", "label", "variants"] as const;
const COMPANION_PROFILE_GREETING_VARIANT_KEYS = ["label", "text"] as const;
/**
 * The read-only character inspector, as the Host bounded it. Every authored text
 * field is the Host's own bound (the same 8_192 / 128 the scenario, greeting and
 * voice projections carry), and the world book reuses the mirror's own validator,
 * so this read can never widen what the neighbouring read accepts.
 */
function isCompanionProfile(value: unknown): value is CompanionProfileV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_PROFILE_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isLengthBoundedString(value.name, 1, 128) &&
    (value.revision === null || (Number.isSafeInteger(value.revision) && (value.revision as number) >= 0)) &&
    isCompanionProfilePersona(value.persona) &&
    isCompanionProfileScenario(value.scenario) &&
    isCompanionProfileGreetings(value.greetings) &&
    isCompanionWorldBook(value.worldBook)
  );
}

const COMPANION_CARD_EXPORT_JSON_KEYS = ["apiVersion", "format", "spec", "fileName", "card"] as const;
const COMPANION_CARD_EXPORT_PNG_KEYS = ["apiVersion", "format", "spec", "fileName", "cardFileBase64"] as const;
/**
 * One companion's exported card. The JSON arm's `card` is the card's own JSON text,
 * bounded by the decoder's own JSON input ceiling; the PNG arm's `cardFileBase64` is
 * the whole card file, bounded by the decoder's own PNG input ceiling, base64-
 * inflated. Same bounds the Host's own schema checks, so the mirror never refuses a
 * card the import route would accept.
 */
function isCompanionCardExport(value: unknown): value is CompanionCardExportV1 {
  if (
    !isRecord(value) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    value.spec !== "chara_card_v3" ||
    !isLengthBoundedString(value.fileName, 1, 200)
  )
    return false;
  if (value.format === "json")
    return hasExactKeys(value, COMPANION_CARD_EXPORT_JSON_KEYS) && isLengthBoundedString(value.card, 2, 2_097_152);
  if (value.format === "png")
    return (
      hasExactKeys(value, COMPANION_CARD_EXPORT_PNG_KEYS) &&
      isLengthBoundedString(value.cardFileBase64, 2, MAX_CARD_FILE_BASE64_CHARS)
    );
  return false;
}

function isCompanionProfilePersona(value: unknown): value is CompanionProfilePersonaV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_PROFILE_PERSONA_KEYS) &&
    typeof value.present === "boolean" &&
    (value.core === null || isLengthBoundedString(value.core, 1, 8_192)) &&
    (value.interactionStyle === null || isLengthBoundedString(value.interactionStyle, 1, 8_192)) &&
    (value.expressionStyle === null || isLengthBoundedString(value.expressionStyle, 1, 8_192))
  );
}

function isCompanionProfileScenario(value: unknown): value is CompanionProfileScenarioV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_PROFILE_SCENARIO_KEYS) &&
    typeof value.present === "boolean" &&
    (value.name === null || isLengthBoundedString(value.name, 1, 128)) &&
    (value.description === null || isLengthBoundedString(value.description, 1, 8_192))
  );
}

function isCompanionProfileGreetings(value: unknown): value is CompanionProfileGreetingsV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_PROFILE_GREETINGS_KEYS) &&
    typeof value.present === "boolean" &&
    (value.label === null || isLengthBoundedString(value.label, 1, 128)) &&
    Array.isArray(value.variants) &&
    value.variants.length <= 16 &&
    value.variants.every(isCompanionProfileGreetingVariant)
  );
}

function isCompanionProfileGreetingVariant(value: unknown): value is CompanionProfileGreetingVariantV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_PROFILE_GREETING_VARIANT_KEYS) &&
    (value.label === null || isLengthBoundedString(value.label, 1, 128)) &&
    isLengthBoundedString(value.text, 1, 8_192)
  );
}

const IMPORT_FIELD_KEYS = ["field", "eligibility", "chars"] as const;
const IMPORT_DISPOSITION_KEYS = ["field", "classification", "reason"] as const;
const IMPORT_LOSS_KEYS = ["field", "reason", "count"] as const;
const IMPORT_STAGE_KEYS = ["apiVersion", "importId", "name", "candidateRevision", "fields", "dispositions"] as const;
const IMPORT_STAGE_KEYS_WITH_LOSSES = [...IMPORT_STAGE_KEYS, "losses"] as const;
const IMPORT_READ_KEYS = [
  "apiVersion",
  "importId",
  "name",
  "candidateRevision",
  "reviewed",
  "reviewedFields",
  "fields",
  "dispositions",
] as const;
const IMPORT_READ_KEYS_WITH_LOSSES = [...IMPORT_READ_KEYS, "losses"] as const;
const IMPORT_REVIEW_KEYS = ["apiVersion", "importId", "reviewedFields", "approvedAtMs"] as const;
const IMPORT_CONFIRM_KEYS = ["apiVersion", "name"] as const;
const IMPORT_HISTORY_COUNTS_KEYS = [
  "accepted_typed",
  "preserved_opaque",
  "dropped_unsupported",
  "rejected_invalid",
] as const;
const IMPORT_HISTORY_ENTRY_KEYS = ["importId", "occurredAtMs", "cardName", "counts"] as const;
const IMPORT_HISTORY_KEYS = ["apiVersion", "entries"] as const;
const IMPORT_ELIGIBILITY = new Set(["candidate_only", "profile_eligible_after_explicit_review", "never_runtime"]);
const IMPORT_CLASSIFICATION = new Set([
  "accepted_typed",
  "preserved_opaque",
  "dropped_unsupported",
  "rejected_invalid",
]);

function isImportField(value: unknown): value is StCardImportFieldSummaryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_FIELD_KEYS) &&
    isLengthBoundedString(value.field, 1, 64) &&
    typeof value.eligibility === "string" &&
    IMPORT_ELIGIBILITY.has(value.eligibility) &&
    isNonNegativeSafeInteger(value.chars)
  );
}

function isImportDisposition(value: unknown): value is StCardImportDispositionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_DISPOSITION_KEYS) &&
    isLengthBoundedString(value.field, 1, 128) &&
    typeof value.classification === "string" &&
    IMPORT_CLASSIFICATION.has(value.classification) &&
    isLengthBoundedString(value.reason, 1, 128)
  );
}

function isImportFields(value: unknown): value is readonly StCardImportFieldSummaryV1[] {
  return Array.isArray(value) && value.length <= 32 && value.every(isImportField);
}

function isImportDispositions(value: unknown): value is readonly StCardImportDispositionV1[] {
  return Array.isArray(value) && value.length <= 128 && value.every(isImportDisposition);
}

function isImportLoss(value: unknown): value is StCardImportLossV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_LOSS_KEYS) &&
    isLengthBoundedString(value.field, 1, 128) &&
    isLengthBoundedString(value.reason, 1, 128) &&
    isNonNegativeSafeInteger(value.count)
  );
}

/**
 * The decoder's loss ledger, declared-optional additive v1: a stage read that
 * predates it (or a card with no losses) simply omits the member.
 */
function isImportLosses(value: unknown): value is readonly StCardImportLossV1[] {
  return Array.isArray(value) && value.length <= 64 && value.every(isImportLoss);
}

function hasOptionalLosses(value: Record<string, unknown>, keys: readonly string[]): boolean {
  if (!Object.hasOwn(value, "losses")) return true;
  return hasExactKeys(value, keys) && isImportLosses(value.losses);
}

function isReviewedFields(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length <= 32 && value.every((field) => isLengthBoundedString(field, 1, 64));
}

function isStCardImportStageResult(value: unknown): value is StCardImportStageResultV1 {
  if (!isRecord(value)) return false;
  const withLosses = Object.hasOwn(value, "losses");
  const keys = withLosses ? IMPORT_STAGE_KEYS_WITH_LOSSES : IMPORT_STAGE_KEYS;
  return (
    hasExactKeys(value, keys) &&
    hasOptionalLosses(value, keys) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.importId) &&
    isLengthBoundedString(value.name, 1, 128) &&
    isNonNegativeSafeInteger(value.candidateRevision) &&
    isImportFields(value.fields) &&
    isImportDispositions(value.dispositions)
  );
}

function isStCardImportReadResult(value: unknown): value is StCardImportReadResultV1 {
  if (!isRecord(value)) return false;
  const withLosses = Object.hasOwn(value, "losses");
  const keys = withLosses ? IMPORT_READ_KEYS_WITH_LOSSES : IMPORT_READ_KEYS;
  return (
    hasExactKeys(value, keys) &&
    hasOptionalLosses(value, keys) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.importId) &&
    isLengthBoundedString(value.name, 1, 128) &&
    isNonNegativeSafeInteger(value.candidateRevision) &&
    typeof value.reviewed === "boolean" &&
    isReviewedFields(value.reviewedFields) &&
    isImportFields(value.fields) &&
    isImportDispositions(value.dispositions)
  );
}

function isStCardImportReviewResult(value: unknown): value is StCardImportReviewResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_REVIEW_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.importId) &&
    isReviewedFields(value.reviewedFields) &&
    isNonNegativeSafeInteger(value.approvedAtMs)
  );
}

function isStCardImportConfirmResult(value: unknown): value is StCardImportConfirmResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_CONFIRM_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isLengthBoundedString(value.name, 1, 128)
  );
}

function isStCardImportHistory(value: unknown): value is StCardImportHistoryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, IMPORT_HISTORY_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    Array.isArray(value.entries) &&
    value.entries.length <= 100 &&
    value.entries.every(isStCardImportHistoryEntry)
  );
}

function isStCardImportHistoryEntry(value: unknown): value is StCardImportHistoryEntryV1 {
  if (!isRecord(value)) return false;
  const counts = value.counts;
  return (
    hasExactKeys(value, IMPORT_HISTORY_ENTRY_KEYS) &&
    isOpaqueHandle(value.importId) &&
    isNonNegativeSafeInteger(value.occurredAtMs) &&
    isLengthBoundedString(value.cardName, 1, 128) &&
    isRecord(counts) &&
    hasExactKeys(counts, IMPORT_HISTORY_COUNTS_KEYS) &&
    IMPORT_HISTORY_COUNTS_KEYS.every((key) => isNonNegativeSafeInteger(counts[key]))
  );
}

function isPersona(value: unknown): value is PersonaV1 {
  if (!isRecord(value) || !hasExactKeys(value, PERSONA_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.present ? isNonNegativeSafeInteger(value.revision) : value.revision === null) &&
    (value.name === null || isLengthBoundedString(value.name, 1, 128)) &&
    (value.description === null || isLengthBoundedString(value.description, 1, 4096))
  );
}

function isScenario(value: unknown): value is ScenarioV1 {
  if (!isRecord(value) || !hasExactKeys(value, SCENARIO_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.present ? isNonNegativeSafeInteger(value.revision) : value.revision === null) &&
    (value.name === null || isLengthBoundedString(value.name, 1, 128)) &&
    (value.description === null || isLengthBoundedString(value.description, 1, 8192)) &&
    (value.preview === null || isLengthBoundedString(value.preview, 1, 512))
  );
}

function isGreeting(value: unknown): value is GreetingV1 {
  if (!isRecord(value) || !hasExactKeys(value, GREETING_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    typeof value.present === "boolean" &&
    (value.present ? isNonNegativeSafeInteger(value.revision) : value.revision === null) &&
    (value.label === null || isLengthBoundedString(value.label, 1, 128)) &&
    Array.isArray(value.variants) &&
    value.variants.every(
      (variant) =>
        isRecord(variant) &&
        hasExactKeys(variant, GREETING_VARIANT_KEYS) &&
        (variant.label === null || isLengthBoundedString(variant.label, 1, 128)) &&
        isLengthBoundedString(variant.text, 1, 8192),
    )
  );
}

function isChatRetentionResult(value: unknown): value is ChatRetentionResultV1 {
  if (!isRecord(value) || !hasExactKeys(value, RETENTION_RESULT_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.handle) &&
    isOneOf(value.status, ["active", "archived", "trashed"]) &&
    isNonNegativeSafeInteger(value.managementRevision)
  );
}

/**
 * One Chat's transcript as a SillyTavern chat file. `jsonl` is the file itself, the header line plus
 * one bubble per message, so the browser saves the Host's own bytes rather than re-serializing the
 * transcript; `dispositions` says what the file does not carry.
 */
function isChatExport(value: unknown): value is ChatExportV1 {
  if (!isRecord(value) || !hasExactKeys(value, CHAT_EXPORT_KEYS)) return false;
  return (
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    value.format === "tavern-interchange/v1" &&
    isOpaqueHandle(value.chatHandle) &&
    isNonNegativeSafeInteger(value.messageCount) &&
    Array.isArray(value.dispositions) &&
    value.dispositions.length <= 8 &&
    value.dispositions.every(
      (disposition) =>
        isRecord(disposition) &&
        hasExactKeys(disposition, CHAT_EXPORT_DISPOSITION_KEYS) &&
        isLengthBoundedString(disposition.field, 1, 128) &&
        isOneOf(disposition.classification, CHAT_EXPORT_DISPOSITION_CLASSES) &&
        isLengthBoundedString(disposition.reason, 1, 128),
    ) &&
    typeof value.canonicalHash === "string" &&
    CHAT_EXPORT_HASH_PATTERN.test(value.canonicalHash) &&
    isLengthBoundedString(value.jsonl, 1, CHAT_EXPORT_JSONL_MAX_LENGTH)
  );
}

function isSelection(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasExactKeys(value, SNAPSHOT_SELECTION_KEYS) &&
    isOpaqueHandle(value.chatHandle) &&
    isPositiveSafeInteger(value.generation) &&
    isOpaqueHandle(value.stateRevision)
  );
}

function isChat(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, SNAPSHOT_CHAT_KEYS)) return false;
  if (
    !isRecord(value.companion) ||
    !hasExactKeys(value.companion, CHAT_COMPANION_KEYS) ||
    !isLengthBoundedString(value.companion.name, 1, 256) ||
    !isOpaqueHandle(value.companion.handle)
  )
    return false;
  if (value.title !== null && !isLengthBoundedString(value.title, 0, 256)) return false;
  if (!Array.isArray(value.transcript) || !value.transcript.every(isBrowserMessage)) return false;
  if (
    !isRecord(value.draft) ||
    !hasExactKeys(value.draft, CHAT_DRAFT_KEYS) ||
    !isNonNegativeSafeInteger(value.draft.revision) ||
    typeof value.draft.present !== "boolean"
  )
    return false;
  if (value.turn !== null && !isBrowserTurn(value.turn)) return false;
  if (value.worldInfo !== null && !isWorldInfo(value.worldInfo)) return false;
  return true;
}

function isMemoryState(value: unknown): boolean {
  if (!isRecord(value) || !hasExactKeys(value, MEMORY_KEYS)) return false;
  if (typeof value.readAvailable !== "boolean" || typeof value.mutationAvailable !== "boolean") return false;
  if (value.projectionRevision !== null && !isOpaqueHandle(value.projectionRevision)) return false;
  return (
    (value.readAvailable && value.projectionRevision !== null) ||
    (!value.readAvailable && value.projectionRevision === null && !value.mutationAvailable)
  );
}

function isSnapshot(value: unknown): value is TavernStateSnapshotV1 {
  if (!isRecord(value)) return false;
  if (!hasExactKeys(value, SNAPSHOT_KEYS) && !hasExactKeys(value, SNAPSHOT_KEYS_WITH_VOICE)) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  if (
    !isRecord(value.build) ||
    !hasExactKeys(value.build, SNAPSHOT_BUILD_KEYS) ||
    value.build.browserContract !== TAVERN_BROWSER_CONTRACT ||
    value.build.profileId !== MANAGEMENT_PROFILE_ID
  )
    return false;
  if (!isOpaqueHandle(value.csrfToken)) return false;
  if (
    !isRecord(value.browserSession) ||
    !hasExactKeys(value.browserSession, SNAPSHOT_BROWSER_SESSION_KEYS) ||
    !isNonNegativeSafeInteger(value.browserSession.expiresAtMs)
  )
    return false;
  if (
    !Array.isArray(value.operations) ||
    value.operations.length > MAX_ARRAY_ITEMS ||
    !value.operations.every(isTavernBrowserOperation)
  )
    return false;
  if (
    !Array.isArray(value.navigation) ||
    value.navigation.length > MAX_ARRAY_ITEMS ||
    !value.navigation.every(isNavigationItem)
  )
    return false;
  if (value.selection !== null && !isSelection(value.selection)) return false;
  if (value.chat !== null && !isChat(value.chat)) return false;
  if (!isMemoryState(value.memory)) return false;
  // The management profile mounts no events route: any event stream object is
  // a different (looser) contract and must reconcile, never be read loosely.
  if (value.eventStream !== null) return false;
  return true;
}

function isDraft(value: unknown): value is BrowserDraftV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DRAFT_KEYS) &&
    value.apiVersion === 1 &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.text === null || isNfcUtf8Text(value.text))
  );
}
function isSaveDraftCommand(value: unknown): value is SaveDraftCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SAVE_DRAFT_KEYS) &&
    value.apiVersion === 1 &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isNonNegativeSafeInteger(value.expectedRevision) &&
    isNfcUtf8Text(value.text)
  );
}
function isDiscardDraftCommand(value: unknown): value is DiscardDraftCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DISCARD_DRAFT_KEYS) &&
    value.apiVersion === 1 &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isNonNegativeSafeInteger(value.expectedRevision)
  );
}
function validateDraft(value: unknown): BrowserDraftV1 {
  if (!isDraft(value)) throw new TavernProtocolError();
  return value;
}

function isChatListQuery(value: unknown): value is ChatListQueryV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== 1 && keys.length !== 2) return false;
  if (!keys.includes("apiVersion") || (keys.length === 2 && !keys.includes("state"))) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION) return false;
  return keys.length === 1 || value.state === "active";
}

function isChatListEntry(value: unknown): value is ChatListEntryV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_LIST_ENTRY_KEYS) &&
    isOpaqueHandle(value.handle) &&
    (value.title === null || isLengthBoundedString(value.title, 0, 256)) &&
    value.status === "active" &&
    isNonNegativeSafeInteger(value.managementRevision) &&
    typeof value.isSelected === "boolean" &&
    isNonNegativeSafeInteger(value.updatedAtMs) &&
    (value.preview === null || isLengthBoundedString(value.preview, 0, 160))
  );
}

function isChatList(value: unknown): value is ChatListV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_LIST_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    Array.isArray(value.chats) &&
    value.chats.length <= MAX_ARRAY_ITEMS &&
    value.chats.every(isChatListEntry)
  );
}

function isRenameChatTitleCommand(value: unknown): value is RenameChatTitleCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, RENAME_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.chatHandle) &&
    isNonNegativeSafeInteger(value.expectedManagementRevision) &&
    isNfcUtf8Text(value.title, 1) &&
    value.title.length <= 120
  );
}

function isChatTitle(value: unknown): value is ChatTitleV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_TITLE_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    (value.title === null || isLengthBoundedString(value.title, 0, 256)) &&
    isNonNegativeSafeInteger(value.managementRevision)
  );
}

function isBrowserSwipeInfo(value: unknown): value is BrowserSwipeInfoV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SWIPE_INFO_KEYS) &&
    isNonNegativeSafeInteger(value.currentIndex) &&
    isPositiveSafeInteger(value.totalSwipes) &&
    isLengthBoundedString(value.label, 1, 32) &&
    typeof value.hasPrevious === "boolean" &&
    typeof value.hasNext === "boolean"
  );
}

function isBrowserOpeningVariant(value: unknown): value is BrowserOpeningVariantV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, OPENING_VARIANT_KEYS) &&
    typeof value.variantId === "string" &&
    OPENING_VARIANT_ID_PATTERN.test(value.variantId) &&
    isNonNegativeSafeInteger(value.index) &&
    isPositiveSafeInteger(value.count) &&
    value.index < value.count &&
    (value.label === null ||
      (typeof value.label === "string" && value.label.length >= 1 && value.label.length <= 128)) &&
    typeof value.locked === "boolean"
  );
}

function isChatOpeningResult(value: unknown): value is ChatOpeningResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_OPENING_RESULT_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isBrowserOpeningVariant(value.openingVariant)
  );
}

function validateChatOpeningResult(value: unknown): ChatOpeningResultV1 {
  if (!isChatOpeningResult(value)) throw new TavernProtocolError();
  return value;
}

function isChatOpeningCommand(value: unknown): value is ChatOpeningCommandV1 {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (!OPENING_COMMAND_REQUIRED_KEYS.every((key) => keys.includes(key))) return false;
  if (!keys.every((key) => (OPENING_COMMAND_ALLOWED_KEYS as readonly string[]).includes(key))) return false;
  if (value.apiVersion !== TAVERN_BROWSER_API_VERSION || !isPositiveSafeInteger(value.selectionGeneration))
    return false;
  const hasDirection = "direction" in value;
  const hasTargetIndex = "targetIndex" in value;
  // Exactly one step form: the Host refuses a request that names both or neither.
  if (hasDirection === hasTargetIndex) return false;
  if (hasDirection && !isOneOf(value.direction, OPENING_DIRECTIONS)) return false;
  if (hasTargetIndex && !isNonNegativeSafeInteger(value.targetIndex)) return false;
  return true;
}

function isProblem(value: unknown): value is TavernProblemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, PROBLEM_KEYS) &&
    isLengthBoundedString(value.type, 1, 256) &&
    isLengthBoundedString(value.title, 1, 256) &&
    typeof value.status === "number" &&
    Number.isSafeInteger(value.status) &&
    value.status >= 400 &&
    value.status <= 599 &&
    isOneOf(value.code, PROBLEM_CODES) &&
    isOpaqueHandle(value.requestId) &&
    typeof value.retryable === "boolean"
  );
}

function isMemoryItem(value: unknown): value is MemoryItemV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MEMORY_ITEM_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isLengthBoundedString(value.title, 1, 256) &&
    isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES) &&
    isOneOf(value.category, MEMORY_CATEGORIES) &&
    isOneOf(value.status, MEMORY_STATUSES) &&
    isOneOf(value.origin, MEMORY_ORIGINS) &&
    typeof value.pinned === "boolean"
  );
}

function isMemoryChapter(value: unknown): value is MemoryChapterV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MEMORY_CHAPTER_KEYS) &&
    isOpaqueHandle(value.handle) &&
    isBoundedText(value.title, 256) &&
    isBoundedText(value.span, 128) &&
    isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES) &&
    isOneOf(value.status, MEMORY_CHAPTER_STATUSES) &&
    typeof value.editedByPlayer === "boolean"
  );
}

function isMemoryRead(value: unknown): value is MemoryReadV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MEMORY_READ_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.projectionRevision) &&
    Array.isArray(value.memories) &&
    value.memories.length <= MAX_MEMORY_ITEMS &&
    value.memories.every(isMemoryItem) &&
    Array.isArray(value.chapters) &&
    value.chapters.length <= MAX_MEMORY_ITEMS &&
    value.chapters.every(isMemoryChapter)
  );
}

function isVoicePreference(value: unknown): value is TavernVoicePreferenceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, VOICE_PREFERENCE_KEYS) &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.disclosureVersion === null || isOneOf(value.disclosureVersion, VOICE_DISCLOSURE_VERSIONS)) &&
    isOneOf(value.consent, VOICE_CONSENTS) &&
    (value.decidedAtMs === null || isNonNegativeSafeInteger(value.decidedAtMs)) &&
    (value.outputDevice === null ||
      (typeof value.outputDevice === "string" && /^waveout:[0-9]{1,4}$/.test(value.outputDevice))) &&
    isVoicePersona(value.persona) &&
    (value.consent === "undecided"
      ? value.disclosureVersion === null && value.decidedAtMs === null
      : value.decidedAtMs !== null && (value.consent !== "accepted" || value.disclosureVersion === "mimo-cloud-tts-v1"))
  );
}

function isVoicePersona(value: unknown): value is string | null {
  return (
    value === null ||
    (typeof value === "string" && value.length <= VOICE_PERSONA_MAX_LENGTH && VOICE_PERSONA_PATTERN.test(value))
  );
}

function isVoiceDevice(value: unknown): value is Readonly<{ id: string; name: string }> {
  return (
    isRecord(value) &&
    hasExactKeys(value, VOICE_DEVICE_KEYS) &&
    typeof value.id === "string" &&
    /^waveout:[0-9]{1,4}$/.test(value.id) &&
    typeof value.name === "string" &&
    value.name.length >= 1 &&
    value.name.length <= 128
  );
}

function isVoiceDevices(value: unknown): value is TavernVoiceDevicesV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, VOICE_DEVICES_KEYS) &&
    Array.isArray(value.devices) &&
    value.devices.length <= 32 &&
    value.devices.every(isVoiceDevice) &&
    value.defaultSelectable === true
  );
}

export function validateVoiceDevices(value: unknown): TavernVoiceDevicesV1 {
  if (!isVoiceDevices(value)) throw new TavernProtocolError();
  return value;
}

function isVoicePreferenceConsentCommand(value: unknown): value is TavernVoicePreferenceConsentCommandV1 {
  if (!isRecord(value) || !isNonNegativeSafeInteger(value.expectedRevision)) return false;
  if (value.action === "accept")
    return hasExactKeys(value, VOICE_PREFERENCE_ACCEPT_KEYS) && value.disclosureVersion === "mimo-cloud-tts-v1";
  if (value.action === "setOutputDevice")
    return (
      hasExactKeys(value, VOICE_PREFERENCE_DEVICE_KEYS) &&
      (value.outputDevice === null ||
        (typeof value.outputDevice === "string" && /^waveout:[0-9]{1,4}$/.test(value.outputDevice)))
    );
  if (value.action === "setPersona")
    return hasExactKeys(value, VOICE_PREFERENCE_PERSONA_KEYS) && isVoicePersona(value.persona);
  return value.action === "revoke" && hasExactKeys(value, VOICE_PREFERENCE_REVOKE_KEYS);
}

export function validateLanguagePreference(value: unknown): TavernLanguagePreferenceV1 {
  if (!isLanguagePreference(value)) throw new TavernProtocolError();
  return value;
}

function isLanguagePreference(value: unknown): value is TavernLanguagePreferenceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, LANGUAGE_PREFERENCE_KEYS) &&
    isNonNegativeSafeInteger(value.revision) &&
    (value.locale === null || isLanguageLocale(value.locale))
  );
}

function isLanguagePreferenceCommand(value: unknown): value is TavernLanguagePreferenceCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, LANGUAGE_PREFERENCE_COMMAND_KEYS) &&
    isNonNegativeSafeInteger(value.expectedRevision) &&
    isLanguageLocale(value.locale)
  );
}

export function validateDeliveryPreference(value: unknown): TavernDeliveryPreferenceV1 {
  if (!isDeliveryPreference(value)) throw new TavernProtocolError();
  return value;
}

function isDeliveryPreference(value: unknown): value is TavernDeliveryPreferenceV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DELIVERY_PREFERENCE_KEYS) &&
    isNonNegativeSafeInteger(value.revision) &&
    typeof value.paced === "boolean"
  );
}

function isDeliveryPreferenceCommand(value: unknown): value is TavernDeliveryPreferenceCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, DELIVERY_PREFERENCE_COMMAND_KEYS) &&
    isNonNegativeSafeInteger(value.expectedRevision) &&
    typeof value.paced === "boolean"
  );
}

// The companion language is the player's own BCP-47 tag: the shape is bounded and the
// set is open. Mirrors the Host's COMPANION_LOCALE_PATTERN (settings/player-preference-store.ts),
// spelled as a literal because this module is deliberately dependency-free; a test in
// dialogue-web asserts the two spellings agree.
const COMPANION_LOCALE_PATTERN = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{2,16}){0,3}$/;

function isLanguageLocale(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && COMPANION_LOCALE_PATTERN.test(value);
}

export function validateVoicePreference(value: unknown): TavernVoicePreferenceV1 {
  if (!isVoicePreference(value)) throw new TavernProtocolError();
  return value;
}

export function validateVoicePreferenceConsentCommand(value: unknown): TavernVoicePreferenceConsentCommandV1 {
  if (!isVoicePreferenceConsentCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateDeliveryPreferenceCommand(value: unknown): TavernDeliveryPreferenceCommandV1 {
  if (!isDeliveryPreferenceCommand(value)) throw new TavernProtocolError();
  return value;
}

function isConnectionFailure(value: unknown): value is TavernConnectionFailureV1 | null {
  return value === null || isOneOf(value, CONNECTION_FAILURES);
}

function isConnectionModel(value: unknown): value is TavernConnectionModelV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_MODEL_KEYS) &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    Array.isArray(value.allowedThinkingLevels) &&
    value.allowedThinkingLevels.length > 0 &&
    value.allowedThinkingLevels.length <= 7 &&
    value.allowedThinkingLevels.every((level) => isOneOf(level, CONNECTION_THINKING_LEVELS)) &&
    isOneOf(value.defaultThinkingLevel, CONNECTION_THINKING_LEVELS) &&
    value.allowedThinkingLevels.includes(value.defaultThinkingLevel as string)
  );
}

function isConnectionProvider(value: unknown): value is TavernConnectionProviderV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_PROVIDER_KEYS) &&
    isLengthBoundedString(value.providerId, 1, 64) &&
    isLengthBoundedString(value.label, 1, 128) &&
    Array.isArray(value.setupFields) &&
    value.setupFields.length <= CONNECTION_SETUP_FIELDS.length &&
    value.setupFields.every((field) => isOneOf(field, CONNECTION_SETUP_FIELDS)) &&
    new Set(value.setupFields).size === value.setupFields.length &&
    Array.isArray(value.allowedPlayerModels) &&
    value.allowedPlayerModels.length <= 32 &&
    value.allowedPlayerModels.every(isConnectionModel) &&
    typeof value.escapeHatch === "boolean" &&
    typeof value.environmentManaged === "boolean"
  );
}

function isConnectionRow(value: unknown): value is TavernConnectionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_ROW_KEYS) &&
    isOpaqueHandle(value.connectionId) &&
    isLengthBoundedString(value.label, 1, 256) &&
    isLengthBoundedString(value.providerId, 1, 64) &&
    isLengthBoundedString(value.providerLabel, 1, 128) &&
    typeof value.configured === "boolean" &&
    isOneOf(value.readiness, CONNECTION_READINESS) &&
    typeof value.active === "boolean" &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    isOneOf(value.thinkingLevel, CONNECTION_THINKING_LEVELS) &&
    Array.isArray(value.allowedThinkingLevels) &&
    value.allowedThinkingLevels.length > 0 &&
    value.allowedThinkingLevels.length <= 7 &&
    value.allowedThinkingLevels.every((level) => isOneOf(level, CONNECTION_THINKING_LEVELS)) &&
    value.allowedThinkingLevels.includes(value.thinkingLevel as string) &&
    (value.modelIds === null ||
      (Array.isArray(value.modelIds) &&
        value.modelIds.length <= CONNECTION_MODEL_LISTING_LIMIT &&
        value.modelIds.every((id) => typeof id === "string" && id.length <= 128 && MODEL_ID_PATTERN.test(id)))) &&
    // The player's own endpoint — the one endpoint fact they read back.
    (value.baseUrl === null || isLengthBoundedString(value.baseUrl, 1, 512)) &&
    isConnectionFailure(value.failure) &&
    (value.lastCheckedAtMs === null || isNonNegativeSafeInteger(value.lastCheckedAtMs)) &&
    (value.readiness !== "ready" || value.failure === null) &&
    (value.readiness !== "failed" || value.failure !== null)
  );
}

function isConnectionActive(value: unknown): value is TavernConnectionActiveV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CONNECTION_ACTIVE_KEYS) &&
    isOpaqueHandle(value.connectionId) &&
    isLengthBoundedString(value.label, 1, 256) &&
    isLengthBoundedString(value.providerLabel, 1, 128) &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    isOneOf(value.thinkingLevel, CONNECTION_THINKING_LEVELS) &&
    isOneOf(value.readiness, CONNECTION_READINESS) &&
    (value.baseUrl === null || isLengthBoundedString(value.baseUrl, 1, 512)) &&
    isConnectionFailure(value.failure) &&
    (value.lastCheckedAtMs === null || isNonNegativeSafeInteger(value.lastCheckedAtMs)) &&
    (value.readiness !== "ready" || value.failure === null) &&
    (value.readiness !== "failed" || value.failure !== null)
  );
}

function isConnectionState(value: unknown): value is TavernConnectionStateV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONNECTION_STATE_KEYS) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isNonNegativeSafeInteger(value.revision) ||
    (value.active !== null && !isConnectionActive(value.active)) ||
    !Array.isArray(value.connections) ||
    value.connections.length > 16 ||
    !value.connections.every(isConnectionRow) ||
    !Array.isArray(value.providers) ||
    value.providers.length > 16 ||
    !value.providers.every(isConnectionProvider)
  )
    return false;
  // The projection must be internally consistent: exactly one row may carry the
  // active flag, and it must be the row the active selection names.
  const activeRows = value.connections.filter((row) => row.active);
  if (value.active === null) return activeRows.length === 0;
  return (
    activeRows.length === 1 && activeRows[0]!.connectionId === (value.active as TavernConnectionActiveV1).connectionId
  );
}

export function validateConnectionState(value: unknown): TavernConnectionStateV1 {
  if (!isConnectionState(value)) throw new TavernProtocolError();
  return value;
}

export function validateConnectionProbe(value: unknown): TavernConnectionProbeV1 {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, CONNECTION_PROBE_KEYS) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isOpaqueHandle(value.connectionId) ||
    (value.outcome !== "ready" && value.outcome !== "failed") ||
    !isConnectionFailure(value.failure) ||
    (value.outcome === "ready" ? value.failure !== null : value.failure === null) ||
    !isConnectionState(value.state)
  )
    throw new TavernProtocolError();
  return value as TavernConnectionProbeV1;
}

function isModelProfile(value: unknown): value is TavernModelProfileV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MODEL_PROFILE_KEYS) &&
    isNonNegativeSafeInteger(value.revision) &&
    typeof value.thinkingLevel === "string" &&
    MODEL_PROFILE_THINKING_LEVEL_PATTERN.test(value.thinkingLevel)
  );
}

function isRecommendedModel(value: unknown): value is TavernRecommendedModelV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, RECOMMENDED_MODEL_KEYS) &&
    isLengthBoundedString(value.providerId, 1, 64) &&
    isLengthBoundedString(value.providerLabel, 1, 128) &&
    isLengthBoundedString(value.modelId, 1, 128) &&
    isLengthBoundedString(value.modelLabel, 1, 128) &&
    Array.isArray(value.allowedThinkingLevels) &&
    value.allowedThinkingLevels.length > 0 &&
    value.allowedThinkingLevels.length <= 7 &&
    value.allowedThinkingLevels.every((level) => isOneOf(level, CONNECTION_THINKING_LEVELS)) &&
    isOneOf(value.defaultThinkingLevel, CONNECTION_THINKING_LEVELS)
  );
}

function isModelProfiles(value: unknown): value is TavernModelProfilesV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MODEL_PROFILES_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isModelProfile(value.chat) &&
    isModelProfile(value.game) &&
    Array.isArray(value.recommendedModels) &&
    value.recommendedModels.length <= 64 &&
    value.recommendedModels.every(isRecommendedModel)
  );
}

function isModelProfileUpdateCommand(value: unknown): value is TavernModelProfileUpdateCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, MODEL_PROFILE_UPDATE_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOneOf(value.surface, MODEL_PROFILE_SURFACES) &&
    isNonNegativeSafeInteger(value.expectedRevision) &&
    typeof value.thinkingLevel === "string" &&
    MODEL_PROFILE_THINKING_LEVEL_PATTERN.test(value.thinkingLevel)
  );
}

export function validateModelProfiles(value: unknown): TavernModelProfilesV1 {
  if (!isModelProfiles(value)) throw new TavernProtocolError();
  return value;
}

export function validateModelProfileUpdateCommand(value: unknown): TavernModelProfileUpdateCommandV1 {
  if (!isModelProfileUpdateCommand(value)) throw new TavernProtocolError();
  return value;
}

function isMemoryMutationCommand(value: unknown): value is MemoryMutationCommandV1 {
  if (
    !isRecord(value) ||
    value.apiVersion !== TAVERN_BROWSER_API_VERSION ||
    !isOpaqueHandle(value.expectedProjectionRevision)
  )
    return false;
  if (value.operation === "create")
    return hasExactKeys(value, MEMORY_MUTATION_CREATE_KEYS) && isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES);
  if (value.operation === "update")
    return (
      hasExactKeys(value, MEMORY_MUTATION_UPDATE_KEYS) &&
      isOpaqueHandle(value.handle) &&
      isBoundedText(value.content, MAX_MEMORY_TEXT_UTF8_BYTES)
    );
  return (
    value.operation === "archive" && hasExactKeys(value, MEMORY_MUTATION_ARCHIVE_KEYS) && isOpaqueHandle(value.handle)
  );
}

// --- Public strict closed validators. ---

export function validateSnapshot(value: unknown): TavernStateSnapshotV1 {
  if (!isSnapshot(value)) throw new TavernProtocolError();
  return value;
}
export function validateMemoryRead(value: unknown): MemoryReadV1 {
  if (!isMemoryRead(value)) throw new TavernProtocolError();
  return value;
}
export function validateMemoryMutationCommand(value: unknown): MemoryMutationCommandV1 {
  if (!isMemoryMutationCommand(value)) throw new TavernProtocolError();
  return value;
}
export function validateWorldInfoState(value: unknown): WorldInfoStateV1 {
  if (!isWorldInfo(value)) throw new TavernProtocolError();
  return value;
}
export function validateSetWorldInfoBindingCommand(value: unknown): SetWorldInfoBindingCommandV1 {
  if (!isSetWorldInfoBindingCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateWorldInfoContent(value: unknown): WorldInfoContentV1 {
  if (!isWorldInfoContent(value)) throw new TavernProtocolError();
  return value;
}

export function validateWorldInfoItemCommand(value: unknown): WorldInfoItemCommandV1 {
  if (!isWorldInfoItemCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateWorldInfoCreateCommand(value: unknown): WorldInfoCreateCommandV1 {
  if (!isWorldInfoCreateCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateWorldInfoUpdateCommand(value: unknown): WorldInfoUpdateCommandV1 {
  if (!isWorldInfoUpdateCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateWorldInfoImportCommand(value: unknown): WorldInfoImportCommandV1 {
  if (!isWorldInfoImportCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionList(value: unknown): CompanionListV1 {
  if (!isCompanionList(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionDetail(value: unknown): CompanionDetailV1 {
  if (!isCompanionDetail(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionVoice(value: unknown): CompanionVoiceV1 {
  if (!isCompanionVoice(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionWorldBook(value: unknown): CompanionWorldBookV1 {
  if (!isCompanionWorldBook(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionWorldBookUpdateCommand(value: unknown): UpdateCompanionWorldBookCommandV1 {
  if (!isUpdateCompanionWorldBookCommand(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionProfile(value: unknown): CompanionProfileV1 {
  if (!isCompanionProfile(value)) throw new TavernProtocolError();
  return value;
}

export function validateCompanionCardExport(value: unknown): CompanionCardExportV1 {
  if (!isCompanionCardExport(value)) throw new TavernProtocolError();
  return value;
}

const COMPANION_AVATAR_KEYS = ["apiVersion", "handle", "digest"] as const;
/** The avatar read-back: the handle it stored for, and the sha256 the Host computed. */
function isCompanionAvatar(value: unknown): value is CompanionAvatarV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_AVATAR_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.handle) &&
    typeof value.digest === "string" &&
    /^[0-9a-f]{64}$/u.test(value.digest)
  );
}

export function validateCompanionAvatar(value: unknown): CompanionAvatarV1 {
  if (!isCompanionAvatar(value)) throw new TavernProtocolError();
  return value;
}

const COMPANION_DELETION_KEYS = ["apiVersion", "handle"] as const;
/** What a completed removal answers: the handle that no longer resolves. */
function isCompanionDeletion(value: unknown): value is CompanionDeletionV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, COMPANION_DELETION_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isOpaqueHandle(value.handle)
  );
}

export function validateCompanionDeletion(value: unknown): CompanionDeletionV1 {
  if (!isCompanionDeletion(value)) throw new TavernProtocolError();
  return value;
}

export function validatePersona(value: unknown): PersonaV1 {
  if (!isPersona(value)) throw new TavernProtocolError();
  return value;
}

export function validateScenario(value: unknown): ScenarioV1 {
  if (!isScenario(value)) throw new TavernProtocolError();
  return value;
}

export function validateGreeting(value: unknown): GreetingV1 {
  if (!isGreeting(value)) throw new TavernProtocolError();
  return value;
}

export function validateChatRetentionResult(value: unknown): ChatRetentionResultV1 {
  if (!isChatRetentionResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateChatExport(value: unknown): ChatExportV1 {
  if (!isChatExport(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportStageResult(value: unknown): StCardImportStageResultV1 {
  if (!isStCardImportStageResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportReadResult(value: unknown): StCardImportReadResultV1 {
  if (!isStCardImportReadResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportReviewResult(value: unknown): StCardImportReviewResultV1 {
  if (!isStCardImportReviewResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportConfirmResult(value: unknown): StCardImportConfirmResultV1 {
  if (!isStCardImportConfirmResult(value)) throw new TavernProtocolError();
  return value;
}

export function validateStCardImportHistory(value: unknown): StCardImportHistoryV1 {
  if (!isStCardImportHistory(value)) throw new TavernProtocolError();
  return value;
}

function validateChatList(value: unknown): ChatListV1 {
  if (!isChatList(value)) throw new TavernProtocolError();
  return value;
}

function isCreateChatCommand(value: unknown): value is CreateChatCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CREATE_CHAT_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration)
  );
}

function isChatCreateResult(value: unknown): value is ChatCreateResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_CREATE_RESULT_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isChatListEntry(value.chat) &&
    (value.opening === null || isLengthBoundedString(value.opening, 1, 8192))
  );
}

function validateChatCreateResult(value: unknown): ChatCreateResultV1 {
  if (!isChatCreateResult(value)) throw new TavernProtocolError();
  return value;
}

function isSelectChatCommand(value: unknown): value is SelectChatCommandV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, SELECT_CHAT_COMMAND_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    isPositiveSafeInteger(value.selectionGeneration) &&
    isOpaqueHandle(value.chatHandle)
  );
}

function isChatSelectResult(value: unknown): value is ChatSelectResultV1 {
  return (
    isRecord(value) &&
    hasExactKeys(value, CHAT_SELECT_RESULT_KEYS) &&
    value.apiVersion === TAVERN_BROWSER_API_VERSION &&
    (value.status === "switched" || value.status === "turn_in_flight")
  );
}

function validateChatSelectResult(value: unknown): ChatSelectResultV1 {
  if (!isChatSelectResult(value)) throw new TavernProtocolError();
  return value;
}

function validateChatTitle(value: unknown): ChatTitleV1 {
  if (!isChatTitle(value)) throw new TavernProtocolError();
  return value;
}

// --- Fetch client for the management routes. ---

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

async function exchange<T>(
  transport: typeof fetch,
  method: string,
  path: string,
  expectedStatus: number,
  decode: (value: unknown) => T,
  headers: Record<string, string> = {},
  body?: unknown,
): Promise<T> {
  const init: RequestInit = { method, credentials: "same-origin" };
  const headerNames = Object.keys(headers);
  if (headerNames.length > 0) init.headers = headers;
  if (body !== undefined) init.body = JSON.stringify(body);
  const response = await transport(path, init);
  const bodyValue: unknown = await readJson(response);
  if (!response.ok) {
    if (isProblem(bodyValue)) throw new TavernProblemError(bodyValue);
    throw new TavernProtocolError();
  }
  if (response.status !== expectedStatus) throw new TavernProtocolError();
  return decode(bodyValue);
}

export type ManagementPipelineApi = Readonly<{
  /** POST /api/tavern/v1/bootstrap (one-time bootstrap token). */
  bootstrap(token: string): Promise<TavernStateSnapshotV1>;
  /** GET /api/tavern/v1/state (browser session cookie). */
  readState(): Promise<TavernStateSnapshotV1>;
  /** GET /api/tavern/v1/chats (metadata-only list; no CSRF header). */
  listChats(query?: ChatListQueryV1): Promise<ChatListV1>;
  /**
   * POST /api/tavern/v1/chats: creates a second conversation in the mounted companion/continuity.
   * The Host mints the thread identity and resolves the companion's own greeting as the opening.
   */
  createChat(command: CreateChatCommandV1, csrfToken: string): Promise<ChatCreateResultV1>;
  /** PUT /api/tavern/v1/chat/select: chooses which existing Chat the next runtime start mounts. */
  selectChat(command: SelectChatCommandV1, csrfToken: string): Promise<ChatSelectResultV1>;
  /** GET /api/tavern/v1/draft for the exact mounted Chat. */
  readDraft(): Promise<BrowserDraftV1>;
  /** PUT /api/tavern/v1/draft with durable revision CAS. */
  saveDraft(command: SaveDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1>;
  /** DELETE /api/tavern/v1/draft with durable revision CAS. */
  discardDraft(command: DiscardDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1>;
  /**
   * GET /api/tavern/v1/chat/export: one Chat of this companion/continuity, named by the handle the
   * list handed out, as the interchange's own SillyTavern chat file (browser session; no CSRF header).
   */
  exportChat(command: ChatExportQueryV1): Promise<ChatExportV1>;
  /** PUT /api/tavern/v1/chat/title with Content-Type and x-csrf-token. */
  renameChatTitle(command: RenameChatTitleCommandV1, csrfToken: string): Promise<ChatTitleV1>;
  /**
   * PUT /api/tavern/v1/chat/opening: chooses the greeting variant the mounted, not-yet-locked
   * Chat opens with. A sealed opening answers with the bounded `chat_opening_locked`.
   */
  selectOpeningVariant(command: ChatOpeningCommandV1, csrfToken: string): Promise<ChatOpeningResultV1>;
  /** GET /api/tavern/v1/memory (browser session; no CSRF header). */
  readMemory(): Promise<MemoryReadV1>;
  /** PUT /api/tavern/v1/memory with ordinary projection-revision CAS. */
  mutateMemory(command: MemoryMutationCommandV1, csrfToken: string): Promise<MemoryReadV1>;
  /** GET safe World Info state for the exact mounted Chat. */
  readWorldInfo(): Promise<WorldInfoStateV1>;
  /** PUT exact bind/unbind command with browser-session CSRF protection. */
  setWorldInfoBinding(command: SetWorldInfoBindingCommandV1, csrfToken: string): Promise<WorldInfoStateV1>;
  /**
   * GET /api/tavern/v1/world-info/item: one library item's own content at its exact
   * revision, addressed by an opaque handle from the state projection the caller read
   * (browser session; no CSRF header).
   */
  readWorldInfoItem(command: WorldInfoItemCommandV1): Promise<WorldInfoContentV1>;
  /** POST /api/tavern/v1/world-info/item: creates an item and answers with the re-projected state. */
  createWorldInfo(command: WorldInfoCreateCommandV1, csrfToken: string): Promise<WorldInfoStateV1>;
  /**
   * PUT /api/tavern/v1/world-info/item: rewrites one item's content, CASing on the
   * library revision the caller read (`item.expectedRevision`).
   */
  updateWorldInfo(command: WorldInfoUpdateCommandV1, csrfToken: string): Promise<WorldInfoStateV1>;
  /** DELETE /api/tavern/v1/world-info/item: removes an item from the library. */
  deleteWorldInfo(command: WorldInfoItemCommandV1, csrfToken: string): Promise<WorldInfoStateV1>;
  /**
   * POST /api/tavern/v1/world-info/import: one external SillyTavern/Chub lorebook file, carried
   * whole, answered with the re-projected library. The file's interior is the Host importer's
   * business - this client uploads the player's file as-is and never translates its entries.
   */
  importWorldInfo(command: WorldInfoImportCommandV1, csrfToken: string): Promise<WorldInfoStateV1>;
  /** GET /api/tavern/v1/settings/language (browser session; no CSRF header). */
  readLanguagePreference(): Promise<TavernLanguagePreferenceV1>;
  /**
   * PUT /api/tavern/v1/settings/language with browser-session CSRF protection.
   * The Host owns this preference and every runtime reads it, so the companion
   * speaks the language the player chose here.
   */
  updateLanguagePreference(
    command: TavernLanguagePreferenceCommandV1,
    csrfToken: string,
  ): Promise<TavernLanguagePreferenceV1>;
  /**
   * GET /api/tavern/v1/settings/delivery (browser session; no CSRF header).
   * `paced` is the player's own choice; the Host owns what an un-chosen record
   * means per surface, so this client never substitutes a default.
   */
  readDeliveryPreference(): Promise<TavernDeliveryPreferenceV1>;
  /**
   * PUT /api/tavern/v1/settings/delivery with browser-session CSRF protection. The
   * reply is the Host's validated read-back, which is the only value the surface
   * then shows.
   */
  updateDeliveryPreference(
    command: TavernDeliveryPreferenceCommandV1,
    csrfToken: string,
  ): Promise<TavernDeliveryPreferenceV1>;
  /** GET /api/tavern/v1/settings/voice-preference (browser session; no CSRF header). */
  readVoicePreference(): Promise<TavernVoicePreferenceV1>;
  /** GET /api/tavern/v1/settings/voice-devices (browser-session read). */
  readVoiceDevices(): Promise<TavernVoiceDevicesV1>;
  /** PUT /api/tavern/v1/settings/voice-preference with browser-session CSRF protection. */
  updateVoicePreference(
    command: TavernVoicePreferenceConsentCommandV1,
    csrfToken: string,
  ): Promise<TavernVoicePreferenceV1>;
  /** GET /api/tavern/v1/settings/connection (browser session; no CSRF header). */
  readConnection(): Promise<TavernConnectionStateV1>;
  /** POST /api/tavern/v1/settings/connections: creates a draft record whose credential is write-only. */
  createConnection(command: TavernConnectionCreateCommandV1, csrfToken: string): Promise<TavernConnectionStateV1>;
  /** POST /api/tavern/v1/settings/connections/:id/test against the Host-owned probe. */
  testConnection(connectionId: string, expectedRevision: number, csrfToken: string): Promise<TavernConnectionProbeV1>;
  /** POST /api/tavern/v1/settings/connections/:id/activate: selects only a ready record. */
  activateConnection(
    connectionId: string,
    expectedRevision: number,
    csrfToken: string,
  ): Promise<TavernConnectionStateV1>;
  /** POST /api/tavern/v1/settings/connections/:id/model with the record revision. */
  selectConnectionModel(
    connectionId: string,
    command: Readonly<{ expectedRevision: number; modelId: string; thinkingLevel: TavernConnectionThinkingLevelV1 }>,
    csrfToken: string,
  ): Promise<TavernConnectionStateV1>;
  /** DELETE /api/tavern/v1/settings/connections/:id: removes an inactive record and its credential. */
  removeConnection(connectionId: string, expectedRevision: number, csrfToken: string): Promise<TavernConnectionStateV1>;
  /**
   * GET /api/tavern/v1/settings/profiles (browser session; no CSRF header). The
   * two surfaces' own model profiles plus the shipped guidance catalog.
   */
  readModelProfiles(): Promise<TavernModelProfilesV1>;
  /**
   * PUT /api/tavern/v1/settings/profiles with the surface's durable revision.
   * The model id may be anything the player typed; the Host never checks it
   * against the recommended catalog.
   */
  updateModelProfile(command: TavernModelProfileUpdateCommandV1, csrfToken: string): Promise<TavernModelProfilesV1>;
  /** GET /api/tavern/v1/companions: metadata-only companion library. */
  listCompanions(): Promise<CompanionListV1>;
  /** GET /api/tavern/v1/companions/:handle/voice: the mounted companion's performance directive. */
  readCompanionVoice(handle: string): Promise<CompanionVoiceV1>;
  /**
   * GET /api/tavern/v1/companions/:handle/worldbook: the companion's OWN world
   * book (the reviewed card's `character_book`), which is a different thing from
   * the World Info items a conversation can attach.
   */
  readCompanionWorldBook(handle: string): Promise<CompanionWorldBookV1>;
  /**
   * PUT /api/tavern/v1/companions/:handle/worldbook: replaces her own book's entry
   * list, CASed on the revision the read carried. The reply is the Host's own
   * re-projection, so the surface re-renders from what it returned and never from
   * what it asked for.
   */
  updateCompanionWorldBook(
    handle: string,
    command: UpdateCompanionWorldBookCommandV1,
    csrfToken: string,
  ): Promise<CompanionWorldBookV1>;
  /**
   * GET /api/tavern/v1/companions/:handle/profile: the read-only character
   * inspector - one roster companion's own authored facts, by the handle the
   * roster listed. It resolves any listed companion, not only the mounted one.
   */
  readCompanionProfile(handle: string): Promise<CompanionProfileV1>;
  /**
   * PUT /api/tavern/v1/companions/:handle/avatar: replaces that roster companion's
   * picture - any listed companion, not only the mounted one - and answers the digest of
   * the bytes now on disk. The picture goes as one base64 payload, the same spelling the
   * card import uses for a card file, because it is the same thing arriving the same way.
   */
  uploadCompanionAvatar(handle: string, avatarBase64: string, csrfToken: string): Promise<CompanionAvatarV1>;
  /**
   * DELETE /api/tavern/v1/companions/:handle: removes that roster companion for good, CASed
   * on the revision `readCompanionProfile` projected. Her conversations are not part of it.
   */
  deleteCompanion(handle: string, expectedRevision: number, csrfToken: string): Promise<CompanionDeletionV1>;
  /**
   * GET /api/tavern/v1/companions/:handle/card: one roster companion's own records as
   * a standard Tavern V3 card, which the browser saves to disk. Read-only.
   */
  exportCompanionCard(handle: string, format: "json" | "png"): Promise<CompanionCardExportV1>;
  /** PUT /api/tavern/v1/companions/:handle/voice: edit or clear the directive, CASed on its revision. */
  updateCompanionVoice(
    handle: string,
    command: UpdateCompanionVoiceCommandV1,
    csrfToken: string,
  ): Promise<CompanionVoiceV1>;
  /** POST /api/tavern/v1/companions: creates a Host-owned namespace from a display name. */
  createCompanion(name: string, csrfToken: string): Promise<CompanionDetailV1>;
  /** GET /api/tavern/v1/persona: the player's own persona projection. */
  readPersona(): Promise<PersonaV1>;
  /** PUT /api/tavern/v1/persona with durable revision CAS. */
  updatePersona(
    command: Readonly<{ expectedRevision: number; name: string; description?: string }>,
    csrfToken: string,
  ): Promise<PersonaV1>;
  /** GET /api/tavern/v1/scenario. */
  readScenario(): Promise<ScenarioV1>;
  /** PUT /api/tavern/v1/scenario with durable revision CAS. */
  updateScenario(
    command: Readonly<{ expectedRevision: number; name: string; description: string }>,
    csrfToken: string,
  ): Promise<ScenarioV1>;
  /** GET /api/tavern/v1/greeting. */
  readGreeting(): Promise<GreetingV1>;
  /** PUT /api/tavern/v1/greeting with durable revision CAS. */
  updateGreeting(
    command: Readonly<{
      expectedRevision: number;
      label?: string;
      variants: readonly Readonly<{ label?: string; text: string }>[];
    }>,
    csrfToken: string,
  ): Promise<GreetingV1>;
  /** POST /api/tavern/v1/chats/:handle/{archive|restore|trash} with durable lifecycle CAS. */
  transitionChatLifecycle(
    chatHandle: string,
    operation: "archive" | "restore" | "trash",
    expectedManagementRevision: number,
    csrfToken: string,
  ): Promise<ChatRetentionResultV1>;
  /** POST /api/tavern/v1/imports: stage a character card for review (design/28 Import row). */
  stageStCardImport(command: StageStCardImportCommandV1, csrfToken: string): Promise<StCardImportStageResultV1>;
  /** GET /api/tavern/v1/imports/:importId: safe review data for one staged card. */
  readStCardImport(importId: string): Promise<StCardImportReadResultV1>;
  /** POST /api/tavern/v1/imports/:importId/review: record an explicit eligible-field review. */
  reviewStCardImport(
    importId: string,
    reviewedFields: readonly string[],
    approvedAtMs: number,
    csrfToken: string,
  ): Promise<StCardImportReviewResultV1>;
  /** POST /api/tavern/v1/imports/:importId/confirm: provision the reviewed companion. */
  confirmStCardImport(importId: string, csrfToken: string): Promise<StCardImportConfirmResultV1>;
  /** GET /api/tavern/v1/import-history: the durable loss report for confirmed imports. */
  readStCardImportHistory(): Promise<StCardImportHistoryV1>;
}>;

export type ManagementOperationObservation = Readonly<{
  operationId: string;
  outcome: "passed" | "not_applicable" | "blocked";
  projectionRevision?: string;
}>;

export function createManagementPipelineApi(
  fetchLike: typeof fetch = fetch,
  onOperation?: (observation: ManagementOperationObservation) => void,
): ManagementPipelineApi {
  if (typeof fetchLike !== "function") {
    throw new TypeError("createManagementPipelineApi requires a fetch-like function");
  }
  const observe = (
    operationId: string,
    outcome: ManagementOperationObservation["outcome"],
    projectionRevision?: string,
  ): void => {
    onOperation?.(
      Object.freeze({ operationId, outcome, ...(projectionRevision === undefined ? {} : { projectionRevision }) }),
    );
  };
  return Object.freeze({
    async bootstrap(token: string): Promise<TavernStateSnapshotV1> {
      if (!isOpaqueHandle(token)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/bootstrap",
        200,
        validateSnapshot,
        { "Content-Type": "application/json" },
        { apiVersion: TAVERN_BROWSER_API_VERSION, bootstrapToken: token },
      );
    },
    async readState(): Promise<TavernStateSnapshotV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/state", 200, validateSnapshot);
    },
    async listChats(query: ChatListQueryV1 = { apiVersion: TAVERN_BROWSER_API_VERSION }): Promise<ChatListV1> {
      if (!isChatListQuery(query)) throw new TavernProtocolError();
      const params = new URLSearchParams({ apiVersion: String(TAVERN_BROWSER_API_VERSION) });
      if (query.state !== undefined) params.set("state", query.state);
      return exchange(fetchLike, "GET", `/api/tavern/v1/chats?${params.toString()}`, 200, validateChatList);
    },
    async createChat(command: CreateChatCommandV1, csrfToken: string): Promise<ChatCreateResultV1> {
      if (!isCreateChatCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/chats",
        200,
        validateChatCreateResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("chat.create", "passed", result.chat.handle);
      return result;
    },
    async selectChat(command: SelectChatCommandV1, csrfToken: string): Promise<ChatSelectResultV1> {
      if (!isSelectChatCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/chat/select",
        200,
        validateChatSelectResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("chat.select", "passed", result.status);
      return result;
    },
    async readDraft(): Promise<BrowserDraftV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/draft", 200, validateDraft);
    },
    async saveDraft(command: SaveDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1> {
      if (!isSaveDraftCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/draft",
        200,
        validateDraft,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("draft.save", "passed", String(result.revision));
      return result;
    },
    async discardDraft(command: DiscardDraftCommandV1, csrfToken: string): Promise<BrowserDraftV1> {
      if (!isDiscardDraftCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "DELETE",
        "/api/tavern/v1/draft",
        200,
        validateDraft,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("draft.discard", "passed", String(result.revision));
      return result;
    },
    async exportChat(command: ChatExportQueryV1): Promise<ChatExportV1> {
      if (!isRecord(command) || !hasExactKeys(command, ["chatHandle"]) || !isOpaqueHandle(command.chatHandle))
        throw new TavernProtocolError();
      const params = new URLSearchParams({ chatHandle: command.chatHandle });
      return exchange(fetchLike, "GET", `/api/tavern/v1/chat/export?${params.toString()}`, 200, validateChatExport);
    },
    async renameChatTitle(command: RenameChatTitleCommandV1, csrfToken: string): Promise<ChatTitleV1> {
      if (!isRenameChatTitleCommand(command)) throw new TavernProtocolError();
      if (!isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/chat/title",
        200,
        validateChatTitle,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("chat.rename", "passed", String(result.managementRevision));
      return result;
    },
    async selectOpeningVariant(command: ChatOpeningCommandV1, csrfToken: string): Promise<ChatOpeningResultV1> {
      if (!isChatOpeningCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/chat/opening",
        200,
        validateChatOpeningResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("chat.opening", "passed", String(result.openingVariant.index));
      return result;
    },
    async readMemory(): Promise<MemoryReadV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/memory", 200, validateMemoryRead);
    },
    async mutateMemory(command: MemoryMutationCommandV1, csrfToken: string): Promise<MemoryReadV1> {
      if (!isMemoryMutationCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/memory",
        200,
        validateMemoryRead,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("memory.mutate", "passed", result.projectionRevision);
      return result;
    },
    async readWorldInfo(): Promise<WorldInfoStateV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/world-info", 200, validateWorldInfoState);
    },
    async setWorldInfoBinding(command: SetWorldInfoBindingCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isSetWorldInfoBindingCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/world-info",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("world-info.bind", "passed", result.revision);
      return result;
    },
    async readWorldInfoItem(command: WorldInfoItemCommandV1): Promise<WorldInfoContentV1> {
      if (!isWorldInfoItemCommand(command)) throw new TavernProtocolError();
      const params = new URLSearchParams({
        apiVersion: String(TAVERN_BROWSER_API_VERSION),
        selectionGeneration: String(command.selectionGeneration),
        expectedRevision: command.expectedRevision,
        itemHandle: command.itemHandle,
      });
      return exchange(
        fetchLike,
        "GET",
        `/api/tavern/v1/world-info/item?${params.toString()}`,
        200,
        validateWorldInfoContent,
      );
    },
    async createWorldInfo(command: WorldInfoCreateCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isWorldInfoCreateCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/world-info/item",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("world-info.create", "passed", result.revision);
      return result;
    },
    async updateWorldInfo(command: WorldInfoUpdateCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isWorldInfoUpdateCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/world-info/item",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("world-info.update", "passed", result.revision);
      return result;
    },
    async deleteWorldInfo(command: WorldInfoItemCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isWorldInfoItemCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "DELETE",
        "/api/tavern/v1/world-info/item",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("world-info.delete", "passed", result.revision);
      return result;
    },
    async importWorldInfo(command: WorldInfoImportCommandV1, csrfToken: string): Promise<WorldInfoStateV1> {
      if (!isWorldInfoImportCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/world-info/import",
        200,
        validateWorldInfoState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("world-info.import", "passed", result.revision);
      return result;
    },
    async readVoicePreference(): Promise<TavernVoicePreferenceV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/voice-preference", 200, validateVoicePreference);
    },
    async readVoiceDevices(): Promise<TavernVoiceDevicesV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/voice-devices", 200, validateVoiceDevices);
    },
    async readLanguagePreference(): Promise<TavernLanguagePreferenceV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/language", 200, validateLanguagePreference);
    },
    async updateLanguagePreference(
      command: TavernLanguagePreferenceCommandV1,
      csrfToken: string,
    ): Promise<TavernLanguagePreferenceV1> {
      if (!isLanguagePreferenceCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/settings/language",
        200,
        validateLanguagePreference,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("settings.language.update", "passed", String(result.revision));
      return result;
    },
    async readDeliveryPreference(): Promise<TavernDeliveryPreferenceV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/delivery", 200, validateDeliveryPreference);
    },
    async updateDeliveryPreference(
      command: TavernDeliveryPreferenceCommandV1,
      csrfToken: string,
    ): Promise<TavernDeliveryPreferenceV1> {
      if (!isDeliveryPreferenceCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/settings/delivery",
        200,
        validateDeliveryPreference,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("settings.delivery.update", "passed", String(result.revision));
      return result;
    },
    async updateVoicePreference(
      command: TavernVoicePreferenceConsentCommandV1,
      csrfToken: string,
    ): Promise<TavernVoicePreferenceV1> {
      if (!isVoicePreferenceConsentCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/settings/voice-preference",
        200,
        validateVoicePreference,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("settings.voice.consent", "passed", String(result.revision));
      return result;
    },
    async readConnection(): Promise<TavernConnectionStateV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/connection", 200, validateConnectionState);
    },
    async createConnection(
      command: TavernConnectionCreateCommandV1,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (!isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      if (command.apiShape !== undefined && !isOneOf(command.apiShape, CONNECTION_API_SHAPES))
        throw new TavernProtocolError();
      // The browser sends only the fields the selected catalog entry declares.
      // The credential is a write-only request field and is never retained here.
      const body: Record<string, unknown> = { apiVersion: TAVERN_BROWSER_API_VERSION, providerId: command.providerId };
      if (command.apiKey !== undefined) body.apiKey = command.apiKey;
      if (command.baseUrl !== undefined) body.baseUrl = command.baseUrl;
      if (command.apiShape !== undefined) body.apiShape = command.apiShape;
      if (command.modelId !== undefined) body.modelId = command.modelId;
      if (command.apiKeyRequired !== undefined) body.apiKeyRequired = command.apiKeyRequired;
      return exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/settings/connections",
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        body,
      );
    },
    async testConnection(
      connectionId: string,
      expectedRevision: number,
      csrfToken: string,
    ): Promise<TavernConnectionProbeV1> {
      if (!isOpaqueHandle(connectionId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(expectedRevision))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/test`,
        200,
        validateConnectionProbe,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
    },
    async activateConnection(
      connectionId: string,
      expectedRevision: number,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (!isOpaqueHandle(connectionId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(expectedRevision))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/activate`,
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
    },
    async selectConnectionModel(
      connectionId: string,
      command: Readonly<{ expectedRevision: number; modelId: string; thinkingLevel: TavernConnectionThinkingLevelV1 }>,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (
        !isOpaqueHandle(connectionId) ||
        !isOpaqueHandle(csrfToken) ||
        !isNonNegativeSafeInteger(command.expectedRevision) ||
        !isLengthBoundedString(command.modelId, 1, 128) ||
        !isOneOf(command.thinkingLevel, CONNECTION_THINKING_LEVELS)
      )
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/settings/connections/${connectionId}/model`,
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          modelId: command.modelId,
          thinkingLevel: command.thinkingLevel,
        },
      );
    },
    async removeConnection(
      connectionId: string,
      expectedRevision: number,
      csrfToken: string,
    ): Promise<TavernConnectionStateV1> {
      if (!isOpaqueHandle(connectionId) || !isOpaqueHandle(csrfToken) || !isNonNegativeSafeInteger(expectedRevision))
        throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "DELETE",
        `/api/tavern/v1/settings/connections/${connectionId}`,
        200,
        validateConnectionState,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
    },
    async readModelProfiles(): Promise<TavernModelProfilesV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/settings/profiles", 200, validateModelProfiles);
    },
    async updateModelProfile(
      command: TavernModelProfileUpdateCommandV1,
      csrfToken: string,
    ): Promise<TavernModelProfilesV1> {
      if (!isModelProfileUpdateCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/settings/profiles",
        200,
        validateModelProfiles,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("settings.profiles.update", "passed", String(result[command.surface].revision));
      return result;
    },
    async listCompanions(): Promise<CompanionListV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/companions", 200, validateCompanionList);
    },
    async readCompanionVoice(handle: string): Promise<CompanionVoiceV1> {
      if (!isOpaqueHandle(handle)) throw new TavernProtocolError();
      return exchange(fetchLike, "GET", `/api/tavern/v1/companions/${handle}/voice`, 200, validateCompanionVoice);
    },
    async readCompanionWorldBook(handle: string): Promise<CompanionWorldBookV1> {
      if (!isOpaqueHandle(handle)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "GET",
        `/api/tavern/v1/companions/${handle}/worldbook`,
        200,
        validateCompanionWorldBook,
      );
    },
    async readCompanionProfile(handle: string): Promise<CompanionProfileV1> {
      if (!isOpaqueHandle(handle)) throw new TavernProtocolError();
      return exchange(fetchLike, "GET", `/api/tavern/v1/companions/${handle}/profile`, 200, validateCompanionProfile);
    },
    async uploadCompanionAvatar(handle: string, avatarBase64: string, csrfToken: string): Promise<CompanionAvatarV1> {
      if (
        !isOpaqueHandle(handle) ||
        !isOpaqueHandle(csrfToken) ||
        !isLengthBoundedString(avatarBase64, 1, MAX_CARD_FILE_BASE64_CHARS)
      )
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        `/api/tavern/v1/companions/${handle}/avatar`,
        200,
        validateCompanionAvatar,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, avatarBase64 },
      );
      observe("companion.avatar.update", "passed", result.digest.slice(0, 16));
      return result;
    },
    async deleteCompanion(handle: string, expectedRevision: number, csrfToken: string): Promise<CompanionDeletionV1> {
      if (
        !isOpaqueHandle(handle) ||
        !isOpaqueHandle(csrfToken) ||
        !Number.isSafeInteger(expectedRevision) ||
        expectedRevision < 0
      )
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "DELETE",
        `/api/tavern/v1/companions/${handle}`,
        200,
        validateCompanionDeletion,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, expectedRevision },
      );
      observe("companion.delete", "passed", result.handle.slice(0, 8));
      return result;
    },
    async exportCompanionCard(handle: string, format: "json" | "png"): Promise<CompanionCardExportV1> {
      if (!isOpaqueHandle(handle)) throw new TavernProtocolError();
      return exchange(
        fetchLike,
        "GET",
        `/api/tavern/v1/companions/${handle}/card?format=${format}`,
        200,
        validateCompanionCardExport,
      );
    },
    async updateCompanionWorldBook(
      handle: string,
      command: UpdateCompanionWorldBookCommandV1,
      csrfToken: string,
    ): Promise<CompanionWorldBookV1> {
      if (!isOpaqueHandle(handle) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const validated = validateCompanionWorldBookUpdateCommand(command);
      const result = await exchange(
        fetchLike,
        "PUT",
        `/api/tavern/v1/companions/${handle}/worldbook`,
        200,
        validateCompanionWorldBook,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: validated.expectedRevision,
          entries: validated.entries.map((entry) => ({
            title: entry.title,
            keys: [...entry.keys],
            constant: entry.constant,
            content: entry.content,
          })),
        },
      );
      observe("companion.worldbook.update", "passed", String(result.revision));
      return result;
    },
    async updateCompanionVoice(
      handle: string,
      command: UpdateCompanionVoiceCommandV1,
      csrfToken: string,
    ): Promise<CompanionVoiceV1> {
      if (!isOpaqueHandle(handle) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        `/api/tavern/v1/companions/${handle}/voice`,
        200,
        validateCompanionVoice,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedProfileRevision: command.expectedProfileRevision,
          ...("clear" in command ? { clear: true } : { text: command.text }),
        },
      );
      observe("character.voice.update", "passed", String(result.profileRevision));
      return result;
    },
    async createCompanion(name: string, csrfToken: string): Promise<CompanionDetailV1> {
      if (!isLengthBoundedString(name, 1, 128) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/companions",
        200,
        validateCompanionDetail,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, name },
      );
      observe("companion.create", "passed", String(result.name));
      return result;
    },
    async readPersona(): Promise<PersonaV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/persona", 200, validatePersona);
    },
    async updatePersona(
      command: Readonly<{ expectedRevision: number; name: string; description?: string }>,
      csrfToken: string,
    ): Promise<PersonaV1> {
      if (!isNonNegativeSafeInteger(command.expectedRevision) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/persona",
        200,
        validatePersona,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          name: command.name,
          ...(command.description === undefined ? {} : { description: command.description }),
        },
      );
      observe("persona.update", "passed", String(result.revision));
      return result;
    },
    async readScenario(): Promise<ScenarioV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/scenario", 200, validateScenario);
    },
    async updateScenario(
      command: Readonly<{ expectedRevision: number; name: string; description: string }>,
      csrfToken: string,
    ): Promise<ScenarioV1> {
      if (!isNonNegativeSafeInteger(command.expectedRevision) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/scenario",
        200,
        validateScenario,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          name: command.name,
          description: command.description,
        },
      );
      observe("scenario.update", "passed", String(result.revision));
      return result;
    },
    async readGreeting(): Promise<GreetingV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/greeting", 200, validateGreeting);
    },
    async updateGreeting(
      command: Readonly<{
        expectedRevision: number;
        label?: string;
        variants: readonly Readonly<{ label?: string; text: string }>[];
      }>,
      csrfToken: string,
    ): Promise<GreetingV1> {
      if (!isNonNegativeSafeInteger(command.expectedRevision) || !isOpaqueHandle(csrfToken))
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "PUT",
        "/api/tavern/v1/greeting",
        200,
        validateGreeting,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedRevision: command.expectedRevision,
          ...(command.label === undefined ? {} : { label: command.label }),
          variants: command.variants.map((variant) => ({
            ...(variant.label === undefined ? {} : { label: variant.label }),
            text: variant.text,
          })),
        },
      );
      observe("greeting.update", "passed", String(result.revision));
      return result;
    },
    async transitionChatLifecycle(
      chatHandle: string,
      operation: "archive" | "restore" | "trash",
      expectedManagementRevision: number,
      csrfToken: string,
    ): Promise<ChatRetentionResultV1> {
      if (
        !isOpaqueHandle(chatHandle) ||
        !isOpaqueHandle(csrfToken) ||
        !isNonNegativeSafeInteger(expectedManagementRevision) ||
        !isOneOf(operation, RETENTION_OPERATIONS)
      )
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/chats/${chatHandle}/${operation}`,
        200,
        validateChatRetentionResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        {
          apiVersion: TAVERN_BROWSER_API_VERSION,
          expectedManagementRevision,
        },
      );
      observe(
        operation === "archive" ? "chat.archive" : operation === "restore" ? "chat.restore" : "chat.trash",
        "passed",
        String(result.managementRevision),
      );
      return result;
    },
    async stageStCardImport(
      command: StageStCardImportCommandV1,
      csrfToken: string,
    ): Promise<StCardImportStageResultV1> {
      if (!isStageStCardImportCommand(command) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        "/api/tavern/v1/imports",
        200,
        validateStCardImportStageResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        command,
      );
      observe("character.import.stage", "passed", result.importId);
      return result;
    },
    async readStCardImport(importId: string): Promise<StCardImportReadResultV1> {
      if (!isOpaqueHandle(importId)) throw new TavernProtocolError();
      return exchange(fetchLike, "GET", `/api/tavern/v1/imports/${importId}`, 200, validateStCardImportReadResult);
    },
    async reviewStCardImport(
      importId: string,
      reviewedFields: readonly string[],
      approvedAtMs: number,
      csrfToken: string,
    ): Promise<StCardImportReviewResultV1> {
      if (
        !isOpaqueHandle(importId) ||
        !isOpaqueHandle(csrfToken) ||
        !isNonNegativeSafeInteger(approvedAtMs) ||
        !isReviewedFields(reviewedFields)
      )
        throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/imports/${importId}/review`,
        200,
        validateStCardImportReviewResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION, reviewedFields: [...reviewedFields], approvedAtMs },
      );
      observe("character.import.review", "passed", result.importId);
      return result;
    },
    async confirmStCardImport(importId: string, csrfToken: string): Promise<StCardImportConfirmResultV1> {
      if (!isOpaqueHandle(importId) || !isOpaqueHandle(csrfToken)) throw new TavernProtocolError();
      const result = await exchange(
        fetchLike,
        "POST",
        `/api/tavern/v1/imports/${importId}/confirm`,
        200,
        validateStCardImportConfirmResult,
        { "Content-Type": "application/json", "x-csrf-token": csrfToken },
        { apiVersion: TAVERN_BROWSER_API_VERSION },
      );
      observe("character.import.confirm", "passed", result.name);
      return result;
    },
    async readStCardImportHistory(): Promise<StCardImportHistoryV1> {
      return exchange(fetchLike, "GET", "/api/tavern/v1/import-history", 200, validateStCardImportHistory);
    },
  });
}
