import { createHash } from "node:crypto";
import { decodeStCard, type StCardImportDisposition, type StCardImportReport } from "../st-card-import.js";
import type { ArtifactEnvelope, TavernArtifactStore } from "./artifact-store.js";
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
    const candidate = candidateFromReport(importId, report, sourceHash);
    const importReport = reportFromDecode(importId, report, sourceHash);
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
    return Object.freeze({ candidate: persistedCandidate, report: persistedReport });
  }

  /** Hash-verified readback of the two inert artifacts, suitable for a review UI or export. */
  async read(importId: string): Promise<PersistedStCardImport> {
    const candidate = await this.store.read(
      tavernImportPath(this.paths, importId, "candidate.json"),
      validateTavernArtifact,
    );
    const report = await this.store.read(tavernImportPath(this.paths, importId, "report.json"), validateTavernArtifact);
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

  async readReview(importId: string): Promise<PersistedCandidateReview> {
    const imported = await this.read(importId);
    const path = tavernImportPath(this.paths, importId, "candidate.json").replace(/candidate\.json$/u, "review.json");
    const review = (await this.store.read(path, validateTavernArtifact)) as PersistedCandidateReview;
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
    field("name", profile.identity.name, "candidate_only"),
    field("identity_role", profile.identity.role, "candidate_only"),
    field("continuity", profile.identity.continuity, "candidate_only"),
    ...(profile.persona === undefined
      ? []
      : [
          field("persona_core", profile.persona.core, "profile_eligible_after_explicit_review"),
          field(
            "persona_interaction_style",
            profile.persona.interactionStyle,
            "profile_eligible_after_explicit_review",
          ),
          field("persona_expression_style", profile.persona.expressionStyle, "profile_eligible_after_explicit_review"),
        ]),
    ...profile.examples.map((example, index) =>
      field(`example_${index + 1}`, JSON.stringify(example), "candidate_only"),
    ),
    ...(profile.firstGreeting === undefined ? [] : [field("first_greeting", profile.firstGreeting, "candidate_only")]),
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
  });
}
function reportFromDecode(importId: string, report: StCardImportReport, sourceHash: string): StCardImportRecord {
  return Object.freeze({
    schemaVersion: 1,
    revision: 1,
    importId,
    source: report.source,
    sourceFormat: report.format,
    sourceHash,
    dispositions: Object.freeze(report.dispositions.map(disposition)),
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
