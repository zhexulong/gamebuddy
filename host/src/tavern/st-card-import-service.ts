import { createHash } from "node:crypto";
import {
  decodeStCard,
  stCardAvatar,
  type StCardAvatarDropReason,
  type StCardImportDisposition,
  type StCardImportReport,
} from "../st-card-import.js";
import type { ArtifactEnvelope, TavernArtifactStore } from "./artifact-store.js";
import { readAvatarFile, writeAvatarFile } from "./companion-avatar/index.js";
import { createNewCompanionService, type NewCompanionReview } from "./new-companion-service.js";
import { type TavernPaths, tavernImportPath } from "./tavern-paths.js";
import {
  type CandidateReviewRecord,
  type CharacterCandidate,
  type StCardImportRecord,
  validateTavernArtifact,
} from "./types.js";

export type PersistedStCardImport = Readonly<{
  candidate: ArtifactEnvelope<CharacterCandidate>;
  report: ArtifactEnvelope<StCardImportRecord>;
}>;
export type PersistedCandidateReview = ArtifactEnvelope<CandidateReviewRecord>;

/**
 * Application boundary for ST-card ingestion. It persists only reviewed-data
 * candidates and an audit report; it never persists or invokes executable ST
 * extensions, regexes, macros, scripts, HTML, or presets.
 */
export class StCardImportService {
  constructor(
    private readonly store: TavernArtifactStore,
    private readonly paths: TavernPaths,
  ) {}

  async import(importId: string, input: string | Uint8Array): Promise<PersistedStCardImport> {
    const report = decodeStCard(input);
    if (report.candidate === undefined || report.format === undefined) throw new Error("st_card_import_rejected");
    const sourceHash = hash(input);
    // The card's own picture, staged BESIDE its candidate rather than inside it.
    // A PNG card's image and the `tEXt` chunk that carries its card are one
    // object, so this is simply the file the player picked, kept where the confirm
    // step will find it. Only a card that decoded has one: a rejected card stages
    // nothing at all, and an import that is staged and then cancelled leaves
    // nothing in any companion's own root - the companion namespace does not
    // exist until confirm provisions it.
    const avatar = stCardAvatar(input);
    const candidate = candidateFromReport(importId, report, sourceHash);
    const importReport = reportFromDecode(
      importId,
      report,
      sourceHash,
      avatar.state === "dropped" ? avatar.reason : undefined,
    );
    const candidatePath = tavernImportPath(this.paths, importId, "candidate.json");
    const reportPath = tavernImportPath(this.paths, importId, "report.json");
    const persistedCandidate = (await this.store.write(
      candidatePath,
      candidate,
      validateTavernArtifact,
    )) as ArtifactEnvelope<CharacterCandidate>;
    const persistedReport = (await this.store.write(
      reportPath,
      importReport,
      validateTavernArtifact,
    )) as ArtifactEnvelope<StCardImportRecord>;
    // Written last, and after the two artifacts above have created the import's
    // own directory: a stage that fails here leaves an inert staging record with
    // no picture rather than a picture nothing describes.
    if (avatar.state === "present")
      await writeAvatarFile(tavernImportPath(this.paths, importId, "avatar.png"), avatar.bytes, this.paths.root);
    return Object.freeze({ candidate: persistedCandidate, report: persistedReport });
  }

  /**
   * Hash-verified readback of the two inert artifacts, suitable for a review UI or export.
   *
   * An id this store stages nothing under is the one refusal here about the request: it names
   * no import any more. A record that is present and does not read back is the opposite fact
   * - the Host's own data - and keeps its own error.
   */
  async read(importId: string): Promise<PersistedStCardImport> {
    const candidate = await this.store.readIfPresent(
      tavernImportPath(this.paths, importId, "candidate.json"),
      validateTavernArtifact,
    );
    const report = await this.store.readIfPresent(
      tavernImportPath(this.paths, importId, "report.json"),
      validateTavernArtifact,
    );
    if (candidate === undefined || report === undefined) throw new Error("st_card_import_not_found");
    if (
      !isCandidate(candidate.artifact) ||
      !isReport(report.artifact) ||
      candidate.artifact.candidateId !== `st-card-${importId}` ||
      report.artifact.importId !== importId ||
      candidate.artifact.sourceHash !== report.artifact.sourceHash
    )
      throw new Error("invalid_st_card_import");
    return Object.freeze({
      candidate: candidate as ArtifactEnvelope<CharacterCandidate>,
      report: report as ArtifactEnvelope<StCardImportRecord>,
    });
  }

  /** Safe export exposes only canonical, hash-verified inert artifacts—not an ST card or raw source payload. */
  async export(importId: string): Promise<PersistedStCardImport> {
    return this.read(importId);
  }

  /**
   * The reviewed card's own picture, as the stage step left it.
   *
   * `undefined` is an ordinary state: a `.json` card has no picture, and a PNG
   * card whose image was not a picture was dropped at stage time and said so in
   * the report. A staged file that EXISTS and cannot be used throws instead -
   * confirm must not quietly provision a companion without the picture the stage
   * report told the player about.
   */
  async stagedAvatar(importId: string): Promise<Uint8Array | undefined> {
    const read = await readAvatarFile(tavernImportPath(this.paths, importId, "avatar.png"), this.paths.root);
    return read.state === "absent" ? undefined : read.bytes;
  }

  async recordReview(
    importId: string,
    input: Readonly<{ reviewedFields: readonly string[]; approvedAtMs: number }>,
  ): Promise<PersistedCandidateReview> {
    const imported = await this.read(importId);
    const review = createNewCompanionService({
      async create() {
        throw new Error("review_does_not_create");
      },
    }).review(imported.candidate.artifact, input);
    const artifact: CandidateReviewRecord = Object.freeze({ schemaVersion: 1, revision: 1, importId, ...review });
    const path = tavernImportPath(this.paths, importId, "candidate.json").replace(/candidate\.json$/u, "review.json");
    return this.store.write(path, artifact, validateTavernArtifact) as Promise<PersistedCandidateReview>;
  }

  /**
   * The exact review record. An import that has not been reviewed yet has none, which is a
   * refusal of this call rather than a missing import; a record that exists and does not match
   * this candidate is a different, durable fact.
   */
  async readReview(importId: string): Promise<PersistedCandidateReview> {
    const imported = await this.read(importId);
    const path = tavernImportPath(this.paths, importId, "candidate.json").replace(/candidate\.json$/u, "review.json");
    const review = (await this.store.readIfPresent(path, validateTavernArtifact)) as
      | PersistedCandidateReview
      | undefined;
    if (review === undefined) throw new Error("st_card_import_review_missing");
    if (
      !isReview(review.artifact) ||
      review.artifact.importId !== importId ||
      review.artifact.candidateId !== imported.candidate.artifact.candidateId ||
      review.artifact.candidateRevision !== imported.candidate.artifact.revision ||
      review.artifact.sourceHash !== imported.candidate.artifact.sourceHash
    )
      throw new Error("invalid_st_card_review");
    return review;
  }

  async confirmedReview(importId: string): Promise<NewCompanionReview> {
    const review = (await this.readReview(importId)).artifact;
    return Object.freeze({
      candidateId: review.candidateId,
      candidateRevision: review.candidateRevision,
      sourceHash: review.sourceHash,
      reviewedFields: review.reviewedFields,
      approvedAtMs: review.approvedAtMs,
    });
  }
}

function candidateFromReport(importId: string, report: StCardImportReport, sourceHash: string): CharacterCandidate {
  const value = report.candidate!;
  const profile = value.profileCandidate;
  const fields: CharacterCandidate["fields"] = [
    field("name", profile.identity.name, "profile_eligible_after_explicit_review"),
    field("identity_role", profile.identity.role, "candidate_only"),
    field("continuity", profile.identity.continuity, "candidate_only"),
    ...(value.scenario === undefined
      ? []
      : [field("scenario", value.scenario, "profile_eligible_after_explicit_review")]),
    // The card's own performance directive, shown in review beside the persona
    // and examples. It becomes the profile's `characterVoice` (rendered after
    // the Host floor), so it is reviewed like the other profile-eligible fields.
    ...(value.systemPrompt === undefined
      ? []
      : [field("system_prompt", value.systemPrompt, "profile_eligible_after_explicit_review")]),
    ...(profile.persona === undefined
      ? []
      : [
          ...(profile.persona.core === undefined
            ? []
            : [field("persona_core", profile.persona.core, "profile_eligible_after_explicit_review")]),
          ...(profile.persona.interactionStyle === undefined
            ? []
            : [
                field(
                  "persona_interaction_style",
                  profile.persona.interactionStyle,
                  "profile_eligible_after_explicit_review",
                ),
              ]),
          ...(profile.persona.expressionStyle === undefined
            ? []
            : [
                field(
                  "persona_expression_style",
                  profile.persona.expressionStyle,
                  "profile_eligible_after_explicit_review",
                ),
              ]),
        ]),
    ...profile.examples.map((example, index) =>
      field(`example_${index + 1}`, JSON.stringify(example), "profile_eligible_after_explicit_review"),
    ),
    ...(profile.firstGreeting === undefined
      ? []
      : [field("first_greeting", profile.firstGreeting, "profile_eligible_after_explicit_review")]),
    // Alternate openings ride the same reviewed-field gate as the default. They
    // are labelled by their stable 1-based index (the ST v2/v3 spec attaches no
    // per-entry label) and become greeting-record variants at provision time.
    ...(profile.alternateGreetings ?? []).map((greeting, index) =>
      field(`alternate_greeting_${index + 1}`, greeting, "profile_eligible_after_explicit_review"),
    ),
    ...value.worldBookCandidates.map((entry) => field(`worldbook_${entry.entryId}`, entry.content, "candidate_only")),
  ];
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    candidateId: `st-card-${importId}`,
    sourceFormat: report.format!,
    sourceVersion: report.format!,
    sourceHash,
    name: profile.identity.name,
    reviewState: "pending",
    fields: Object.freeze(fields),
    ...(value.worldBookCandidates.length === 0
      ? {}
      : { worldBookCandidates: Object.freeze(value.worldBookCandidates) }),
    ...(value.worldBookScanDepth === undefined ? {} : { worldBookScanDepth: value.worldBookScanDepth }),
    // The card's open-by-design `extensions` object, carried into the persisted
    // candidate so the confirm step can give it a home: it becomes the companion's
    // own `card-extensions.json` at provisioning and the card export writes it
    // back. It rides outside the reviewed-field list (like the world-book
    // candidates) because it is not a field of hers - it is inert card data that
    // no reader renders or executes.
    ...(value.extensions === undefined ? {} : { extensions: value.extensions }),
    // The card's own closing direction, carried into the persisted candidate so the
    // confirm step can give it a home next to the scenario and the openings. Like
    // `extensions` it rides outside the reviewed-field list: it is not a field of
    // hers, and no reader renders it.
    ...(value.postHistoryInstructions === undefined ? {} : { postHistoryInstructions: value.postHistoryInstructions }),
  });
}
function reportFromDecode(
  importId: string,
  report: StCardImportReport,
  sourceHash: string,
  avatarDrop: StCardAvatarDropReason | undefined,
): StCardImportRecord {
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    importId,
    source: report.source,
    ...(report.format !== undefined ? { sourceFormat: report.format } : {}),
    sourceHash,
    dispositions: Object.freeze([
      ...report.dispositions.map(disposition),
      // The card's picture, when these bytes were a PNG the import could not keep
      // as one. It rides the same disposition vocabulary every other kept or lost
      // field rides, so the player-visible review says it in the same sentence it
      // says everything else - a silently picture-less companion would read as a
      // card that had no picture.
      ...(avatarDrop === undefined
        ? []
        : [Object.freeze({ field: "avatar", classification: "dropped_unsupported" as const, reason: avatarDrop })]),
    ]),
    // The decoder's own counted-loss ledger travels with the audit record, so a
    // review surface reports a loss (a `system_prompt` beyond the voice bound is
    // the common one) through that one vocabulary rather than a second one.
    ...(report.losses.length === 0
      ? {}
      : {
          losses: Object.freeze(
            report.losses.map((loss) => Object.freeze({ field: loss.field, reason: loss.reason, count: loss.count })),
          ),
        }),
  });
}
function disposition(value: StCardImportDisposition): StCardImportRecord["dispositions"][number] {
  return Object.freeze({ field: value.field, classification: value.classification, reason: value.reason });
}
function field(
  fieldName: string,
  text: string,
  eligibility: CharacterCandidate["fields"][number]["eligibility"],
): CharacterCandidate["fields"][number] {
  return Object.freeze({ field: fieldName, text, eligibility });
}
function hash(input: string | Uint8Array): string {
  return createHash("sha256")
    .update(typeof input === "string" ? Buffer.from(input, "utf8") : input)
    .digest("hex");
}
function isCandidate(value: unknown): value is CharacterCandidate {
  return typeof value === "object" && value !== null && "candidateId" in value;
}
function isReport(value: unknown): value is StCardImportRecord {
  return typeof value === "object" && value !== null && "importId" in value;
}
function isReview(value: unknown): value is CandidateReviewRecord {
  return typeof value === "object" && value !== null && "candidateId" in value && "reviewedFields" in value;
}
