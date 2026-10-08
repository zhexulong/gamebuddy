import type { Messages } from "./i18n";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
} from "./composed-reference-game-browser-api";
import { TavernProblemError, TavernProtocolError } from "./reference-pipeline-api";
import { ReferencePipelineSessionError } from "./reference-pipeline-session";

/**
 * The one place a failure becomes a player-visible chat problem.
 *
 * The failure this module exists for: the composed surface used to render EVERY
 * non-retryable error as "the chat state could not be safely reconciled". A 401
 * with no session, an unknown problem code, a malformed response and a real
 * reconciliation conflict all produced that one sentence, so the text pointed
 * the reader at a consistency fault that did not exist. A failure is now
 * presented as reconciliation only when the code says reconciliation, and
 * anything the client cannot classify shows the code it actually received.
 *
 * Every code that reaches the text is a bounded token (`code`, the client's own
 * protocol `reason`, or the server's bounded `cause`). Raw producer text, paths
 * and tokens can never appear here.
 */

export type ProblemViewState = Readonly<{ kind: "problem"; title: string; detail: string }>;

/** Codes whose own meaning is "there is no live session behind this request". */
const AUTHENTICATION_PROBLEM_CODES: readonly string[] = ["unauthorized", "csrf_failed"];

/** The one code whose own meaning is "the state could not be safely reconciled". */
const RECONCILIATION_PROBLEM_CODES: readonly string[] = ["state_reconciliation_required"];

/** Codes whose own meaning is "the page asked for a route this build does not serve". */
const ABSENT_ROUTE_PROBLEM_CODES: readonly string[] = [
  "not_found",
  "unsupported_api_version",
  "profile_operation_unavailable",
];

/** Bounded token shape for every code that may be shown to the player. */
const BOUNDED_PROBLEM_TOKEN_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function problemCode(error: unknown): string | null {
  if (error instanceof ComposedReferenceGameProblemError) return error.code;
  if (error instanceof TavernProblemError) return error.code;
  if (error instanceof ReferencePipelineSessionError) return error.code;
  return null;
}

function isRetryableProblem(error: unknown): boolean {
  return (
    (error instanceof ComposedReferenceGameProblemError ||
      error instanceof TavernProblemError) &&
    error.retryable
  );
}

/**
 * The code the player would act on: the server's validated problem code, the
 * reducer's own code, or the client's own closed protocol reason. `null` when
 * the failure carries no code at all.
 */
export function observedProblemCode(error: unknown): string | null {
  const code = problemCode(error);
  if (code !== null) return BOUNDED_PROBLEM_TOKEN_PATTERN.test(code) ? code : null;
  if (error instanceof ComposedReferenceGameProtocolError)
    return BOUNDED_PROBLEM_TOKEN_PATTERN.test(error.reason) ? error.reason : null;
  if (error instanceof TavernProtocolError) return "tavern_protocol_error";
  return null;
}

/** The bounded coordinator cause the composed shell reported, when it named one. */
export function observedProblemCause(error: unknown): string | null {
  return error instanceof ComposedReferenceGameProblemError ? error.causeCode : null;
}

function internalProblem(error: unknown, labels: Messages): ProblemViewState {
  const code = observedProblemCode(error) ?? labels.problemInternalErrorNoCode;
  const cause = observedProblemCause(error);
  const template =
    cause === null ? labels.problemInternalErrorDetail : labels.problemInternalErrorCauseDetail;
  return {
    kind: "problem",
    title: labels.problemInternalErrorTitle,
    detail: template.replace("{{code}}", code).replace("{{cause}}", cause ?? ""),
  };
}

export function composedProblemView(error: unknown, labels: Messages): ProblemViewState {
  const code = problemCode(error);

  if (code !== null && AUTHENTICATION_PROBLEM_CODES.includes(code)) {
    return {
      kind: "problem",
      title: labels.problemSessionExpiredTitle,
      detail: labels.problemSessionExpiredDetail,
    };
  }
  if (code !== null && RECONCILIATION_PROBLEM_CODES.includes(code)) {
    return {
      kind: "problem",
      title: labels.problemReconciliationFailedTitle,
      detail: labels.problemReconciliationFailedDetail,
    };
  }
  if (code !== null && ABSENT_ROUTE_PROBLEM_CODES.includes(code)) {
    return {
      kind: "problem",
      title: labels.problemRouteUnavailableTitle,
      detail: labels.problemRouteUnavailableDetail,
    };
  }
  if (isRetryableProblem(error)) {
    return {
      kind: "problem",
      title: labels.problemTemporarilyUnavailableTitle,
      detail: labels.problemTemporarilyUnavailableDetail,
    };
  }
  return internalProblem(error, labels);
}
