/**
 * Tavern-only optimistic-concurrency guard. It classifies a requested write;
 * it does not execute writes, call a runtime, or invoke Game capabilities.
 */
export type TavernInertArtifactWrite = Readonly<{
  kind: "inert_artifact_write";
  artifactId: string;
  expectedRevision: number;
  nextRevision: number;
}>;

export type TavernResponseMutation = Readonly<{
  kind: "response_mutation";
  threadId: string;
  messageId: string;
  expectedThreadRevision: number;
  expectedMessageRevision: number;
  /** A normal Tavern reply is eligible only when it has no external effects. */
  effect: "none" | "external" | "game";
}>;

export type TavernCausalMutation = TavernInertArtifactWrite | TavernResponseMutation;

export type TavernCausalState = Readonly<{
  artifactRevisions: Readonly<Record<string, number>>;
  responses: Readonly<
    Record<
      string,
      Readonly<{
        threadId: string;
        threadRevision: number;
        messageRevision: number;
        eligible: boolean;
      }>
    >
  >;
}>;

export type TavernCausalDecision =
  | Readonly<{ allowed: true; effect: "inert_artifact_write" | "none" }>
  | Readonly<{
      allowed: false;
      reason:
        | "invalid_mutation"
        | "unknown_target"
        | "stale_revision"
        | "conflicting_revision"
        | "response_ineligible"
        | "external_effect"
        | "game_effect";
    }>;

/**
 * Allows only revision-exact inert artifact writes and current, eligible,
 * effect-free response mutations. Unknown or malformed data is denied.
 */
export function guardTavernCausalMutation(mutation: unknown, state: unknown): TavernCausalDecision {
  if (!isState(state) || !isRecord(mutation)) return deny("invalid_mutation");

  if (mutation.kind === "inert_artifact_write") {
    if (!isId(mutation.artifactId) || !isRevision(mutation.expectedRevision) || !isRevision(mutation.nextRevision))
      return deny("invalid_mutation");
    const current = state.artifactRevisions[mutation.artifactId];
    if (current === undefined) return deny("unknown_target");
    if (mutation.expectedRevision < current) return deny("stale_revision");
    if (mutation.expectedRevision !== current || mutation.nextRevision !== current + 1)
      return deny("conflicting_revision");
    return allow("inert_artifact_write");
  }

  if (mutation.kind === "response_mutation") {
    if (
      !isId(mutation.threadId) ||
      !isId(mutation.messageId) ||
      !isRevision(mutation.expectedThreadRevision) ||
      !isRevision(mutation.expectedMessageRevision) ||
      !isEffect(mutation.effect)
    )
      return deny("invalid_mutation");
    const current = state.responses[mutation.messageId];
    if (current === undefined) return deny("unknown_target");
    if (
      current.threadId !== mutation.threadId ||
      mutation.expectedThreadRevision < current.threadRevision ||
      mutation.expectedMessageRevision < current.messageRevision
    )
      return deny("stale_revision");
    if (
      mutation.expectedThreadRevision !== current.threadRevision ||
      mutation.expectedMessageRevision !== current.messageRevision
    )
      return deny("conflicting_revision");
    if (!current.eligible) return deny("response_ineligible");
    if (mutation.effect === "external") return deny("external_effect");
    if (mutation.effect === "game") return deny("game_effect");
    return allow("none");
  }

  return deny("invalid_mutation");
}

function allow(effect: "inert_artifact_write" | "none"): TavernCausalDecision {
  return Object.freeze({ allowed: true, effect });
}
function deny(reason: Extract<TavernCausalDecision, { allowed: false }>["reason"]): TavernCausalDecision {
  return Object.freeze({ allowed: false, reason });
}
function isState(value: unknown): value is TavernCausalState {
  if (!isRecord(value) || !isRecord(value.artifactRevisions) || !isRecord(value.responses)) return false;
  return (
    Object.values(value.artifactRevisions).every(isRevision) &&
    Object.values(value.responses).every(
      (response) =>
        isRecord(response) &&
        isId(response.threadId) &&
        isRevision(response.threadRevision) &&
        isRevision(response.messageRevision) &&
        typeof response.eligible === "boolean",
    )
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function isId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,128}$/u.test(value);
}
function isRevision(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function isEffect(value: unknown): value is TavernResponseMutation["effect"] {
  return value === "none" || value === "external" || value === "game";
}
