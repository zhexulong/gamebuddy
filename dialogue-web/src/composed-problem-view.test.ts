import assert from "node:assert/strict";
import test from "node:test";
import {
  composedBootstrapProblemView,
  composedProblemView,
  declaredProblemSentence,
  gameOperationFailure,
  gameOperationFailureSentence,
  observedProblemCause,
  observedProblemCode,
  PROBLEM_RETRY_READ,
  problemStepPresentation,
  problemTextWithCode,
} from "./composed-problem-view";
import {
  ComposedReferenceGameProblemError,
  ComposedReferenceGameProtocolError,
  GAME_PROBLEM_CODES,
} from "./composed-reference-game-browser-api";
import { type Messages, messages } from "./i18n";
import { PROBLEM_CODES, TavernProblemError, TavernProtocolError } from "./reference-pipeline-api";
import { ReferencePipelineSessionError } from "./reference-pipeline-session";

/**
 * A refusal becomes a player sentence here, and nowhere else.
 *
 * The measurements behind these properties: sixty-one tavern codes and twenty-three
 * game codes once shared one sentence pair and one "read it again" button, so a stale
 * draft, a busy turn and a real reconciliation conflict all read alike; and the
 * per-operation line said "the result is uncertain" after refusals where the Host had
 * stated the command never ran. Both are decidable from the pure functions alone.
 */

/** A validated tavern problem, as the transport raises one. */
function tavernProblem(code: string, retryable = false): TavernProblemError {
  return new TavernProblemError({
    type: "about:blank",
    title: "request was refused",
    status: retryable ? 503 : 409,
    code,
    requestId: "request-1",
    retryable,
  });
}

/** A composed game refusal, as the shell raises one. */
function gameProblem(code: string, causeCode: string | null = null): ComposedReferenceGameProblemError {
  return new ComposedReferenceGameProblemError(code, 409, "request-1", causeCode);
}

const LOCALES = ["en", "zh-CN"] as const;

void test("a code reaches the player only when it is a bounded token", () => {
  assert.equal(observedProblemCode(tavernProblem("turn_busy")), "turn_busy");
  assert.equal(observedProblemCode(gameProblem("game_unavailable")), "game_unavailable");
  assert.equal(observedProblemCode(new ComposedReferenceGameProtocolError("snapshot_shape")), "snapshot_shape");
  assert.equal(observedProblemCode(new TavernProtocolError()), "tavern_protocol_error");
  assert.equal(observedProblemCode(new Error("something else")), null);

  // A code that is not a bounded token is not shown, whatever carried it: producer text,
  // a path or a sentence would otherwise reach a panel as though it were a code.
  for (const unsafe of ["Provider Rejected", "UPPERCASE", "not-dashed-too-long".repeat(8), ""]) {
    assert.equal(observedProblemCode(gameProblem(unsafe)), null, unsafe);
    assert.equal(observedProblemCode(new ComposedReferenceGameProtocolError(unsafe)), null, unsafe);
    assert.equal(observedProblemCode(tavernProblem(unsafe)), null, unsafe);
  }
});

void test("a coordinator cause is read only from the error that carries one", () => {
  assert.equal(
    observedProblemCause(gameProblem("stardew_manifest_handoff_uncertain", "stardew_bridge_timeout")),
    "stardew_bridge_timeout",
  );
  assert.equal(observedProblemCause(gameProblem("game_unavailable")), null);
  assert.equal(observedProblemCause(tavernProblem("turn_busy")), null);
  assert.equal(observedProblemCause(new Error("plain")), null);
});

void test("every declared tavern code earns a sentence that is not itself", () => {
  const labels = messages("en");
  const findings: string[] = [];
  const sentences = new Set<string>();
  for (const code of PROBLEM_CODES) {
    const sentence = declaredProblemSentence(tavernProblem(code), labels);
    if (sentence === null || sentence.length === 0) findings.push(`${code} has no sentence`);
    else {
      sentences.add(sentence);
      if (sentence.includes(code)) findings.push(`${code} prints itself: ${sentence}`);
    }
  }
  assert.deepEqual(findings, []);
  // Families share sentences on purpose (ten stale-edit refusals say one thing), but a
  // population of sixty-one codes collapsing to a handful would be the old defect again.
  assert.ok(sentences.size > PROBLEM_CODES.length / 2, `${sentences.size} sentences for ${PROBLEM_CODES.length} codes`);
});

void test("a refusal this build does not know leaves the caller's own sentence in place", () => {
  const labels = messages("en");
  const unknown = gameProblem("a_code_from_a_future_host");
  assert.equal(declaredProblemSentence(unknown, labels), null);
  assert.equal(
    problemTextWithCode("the request did not go through", unknown, labels),
    "the request did not go through",
  );
  assert.equal(
    problemTextWithCode("the request did not go through", new Error("plain"), labels),
    "the request did not go through",
  );
  // A named refusal wins over the caller's generic line, which is why the base exists.
  assert.equal(
    problemTextWithCode("the request did not go through", tavernProblem("turn_busy"), labels),
    labels.problemStillRunningDetail,
  );
});

void test("the game's own refusals are read against the game's vocabulary first", () => {
  const labels = messages("en");
  // `game_unavailable` is templated on the bounded coordinator cause the shell named.
  const withCause = declaredProblemSentence(gameProblem("game_unavailable", "stardew_bridge_timeout"), labels);
  assert.notEqual(withCause, null);
  assert.ok(withCause?.includes("stardew_bridge_timeout"), "the cause the Host published is dropped");
  assert.equal(declaredProblemSentence(gameProblem("game_unavailable"), labels), labels.gameProblemUnavailableDetail);
});

void test("every named refusal becomes a card with words and a way out", () => {
  for (const locale of LOCALES) {
    const labels = messages(locale);
    for (const code of PROBLEM_CODES) {
      const view = composedProblemView(tavernProblem(code), labels);
      assert.equal(view.kind, "problem", `${locale} ${code}`);
      assert.ok(view.title.length > 0, `${locale} ${code} has no title`);
      assert.ok(view.detail.length > 0, `${locale} ${code} has no detail`);
      assert.ok(["control", "outside_surface", "self_heals", "no_step"].includes(view.step.kind), `${locale} ${code}`);
    }
    for (const code of GAME_PROBLEM_CODES) {
      const view = composedProblemView(gameProblem(code), labels);
      assert.equal(view.kind, "problem", `${locale} ${code}`);
      assert.ok(view.detail.length > 0, `${locale} ${code} has no detail`);
    }
  }
});

void test("the retry-read step is the output's own constant, not a second spelling", () => {
  const labels = messages("en");
  assert.deepEqual(composedProblemView(tavernProblem("state_reconciliation_required"), labels).step, {
    kind: "control",
    id: PROBLEM_RETRY_READ,
  });
});

/**
 * The card draws the step's sentence or its own control, never both.
 *
 * Both halves used to be decided in `ProblemView`, one line apart: `stepText` returned a sentence for
 * every `control` step and the button was drawn for this one, so the two agreed only because of the
 * `ownControl === null` in front of the sentence. Moving that decision here moved the agreement too,
 * and the first version of the move drew the button and the "that button is elsewhere" sentence
 * together - a card naming two different steps for one refusal, and invisible to every static gate
 * because nothing ran this file. `problemStepPresentation` returns both facts from one decision and
 * this asserts the pairing on every kind the vocabulary has.
 */
void test("the card's step line and its own control are one decision, never both", () => {
  const labels = messages("en");
  const ownRead = problemStepPresentation({ kind: "control", id: PROBLEM_RETRY_READ }, labels);
  assert.deepEqual(ownRead, { stepLine: null, drawsOwnRead: true });

  // A control this whole-window card cannot draw: the sentence names it, and no button is offered.
  const elsewhere = problemStepPresentation({ kind: "control", id: "message-delete" }, labels);
  assert.equal(elsewhere.drawsOwnRead, false);
  assert.equal(elsewhere.stepLine, labels.problemStepElsewhere);

  for (const step of [
    { kind: "outside_surface", step: "open_settings" },
    { kind: "self_heals", because: "host_retries" },
    { kind: "no_step", because: "already_true" },
  ] as const) {
    const presentation = problemStepPresentation(step, labels);
    assert.equal(presentation.drawsOwnRead, false, `${step.kind} must not offer the card's own control`);
    assert.ok(
      presentation.stepLine !== null && presentation.stepLine.length > 0,
      `${step.kind} owes the player a sentence`,
    );
  }
});

void test("an unnamed failure is a diagnostic, and a retryable one says so", () => {
  const labels = messages("en");
  const internal = composedProblemView(gameProblem("a_code_from_a_future_host"), labels);
  assert.equal(internal.title, labels.problemInternalErrorTitle);
  assert.ok(internal.detail.includes("a_code_from_a_future_host"), "the diagnostic drops the code it received");

  const noCode = composedProblemView(new Error("plain"), labels);
  assert.equal(noCode.title, labels.problemInternalErrorTitle);
  assert.ok(noCode.detail.includes(labels.problemInternalErrorNoCode));

  const retryable = composedProblemView(tavernProblem("a_code_from_a_future_host", true), labels);
  assert.equal(retryable.title, labels.problemTemporarilyUnavailableTitle);
  assert.equal(retryable.detail, labels.problemTemporarilyUnavailableDetail);
});

void test("a game operation's failure line is the refusal's words, or the uncertainty", () => {
  const labels = messages("en");
  // The panel's own sentence for an operation whose effect the Host did not state.
  const uncertain = labels.gameActivationFailed;

  // Refusals where the Host stated the command did not run: the panel prints those words,
  // not "the result is uncertain", and they are the same words the catalogue gives the code.
  for (const code of [
    "unauthorized",
    "idempotency_conflict",
    "game_operation_in_progress",
    "game_storage_unavailable",
  ]) {
    const failure = gameOperationFailure(gameProblem(code), labels);
    assert.equal(failure.kind, "refused", code);
    const sentence = gameOperationFailureSentence(failure, uncertain);
    assert.notEqual(sentence, uncertain, `${code} still reads as an uncertain result`);
    assert.equal(sentence, declaredProblemSentence(gameProblem(code), labels), `${code} words its refusal twice`);
  }

  // Failures whose effect on the command the Host could not state: the panel says so.
  for (const code of [
    "game_unavailable",
    "state_unavailable",
    "game_runtime_unavailable",
    "game_endgame_settlement_unavailable",
    "stardew_manifest_handoff_uncertain",
  ]) {
    const failure = gameOperationFailure(gameProblem(code), labels);
    assert.deepEqual(failure, { kind: "unsettled" }, code);
    assert.equal(gameOperationFailureSentence(failure, uncertain), uncertain);
  }

  // A failure that is not a game refusal at all tells the panel nothing it can quote.
  for (const error of [new Error("plain"), tavernProblem("turn_busy"), gameProblem("a_code_from_a_future_host")])
    assert.deepEqual(gameOperationFailure(error, labels), { kind: "unsettled" }, String(error));
  const refused = gameOperationFailure(gameProblem("unauthorized"), labels);
  assert.ok(refused.kind === "refused" && refused.sentence.length > 0, "a refusal with no words is a silent panel");
});

/**
 * The mount's own causes, in both catalogues: what the boot card says, and whether its step can be a
 * press at all.
 *
 * The population is the decision, not a list of sentences: every cause the mount can be handed, plus
 * the transient one that must keep the card's own read. A cause whose step is `PROBLEM_RETRY_READ`
 * draws the control, so the assertion is about the STEP and not about the words: a re-read of a Host
 * that is not there, or of a root with no conversation in it, returns the same answer.
 */
void test("the boot card names its own cause and offers a step a press can change", () => {
  const causes = [
    {
      cause: "a Host that is not answering",
      error: new ComposedReferenceGameProtocolError("network_error"),
      key: "problemBootHostNotAnsweringTitle",
      // Nothing on the page can read a process that is not there.
      pressesHelp: false,
    },
    {
      cause: "a Chat projection the Host could not produce",
      error: gameProblem("state_unavailable"),
      key: "problemBootChatsUnreadableTitle",
      pressesHelp: false,
    },
    {
      cause: "an aggregate with no Chat half",
      error: new ReferencePipelineSessionError("state_reconciliation_required"),
      key: "problemBootNoChatTitle",
      pressesHelp: false,
    },
    {
      cause: "an answer this page cannot read",
      error: new ComposedReferenceGameProtocolError("invalid_composed_root"),
      key: "problemBootPageMismatchTitle",
      pressesHelp: false,
    },
    {
      cause: "a Host that answered a shape this build does not serve",
      error: gameProblem("not_found"),
      key: "problemBootPageMismatchTitle",
      pressesHelp: false,
    },
    {
      cause: "a session that ended",
      error: gameProblem("unauthorized"),
      key: "problemSessionExpiredTitle",
      pressesHelp: false,
    },
  ] as const satisfies readonly Readonly<{
    cause: string;
    error: unknown;
    key: keyof Messages;
    pressesHelp: boolean;
  }>[];

  for (const locale of LOCALES) {
    const labels = messages(locale);
    for (const { cause, error, key, pressesHelp } of causes) {
      const view = composedBootstrapProblemView(error, labels);
      const presentation = problemStepPresentation(view.step, labels);
      assert.equal(view.title, labels[key], `${locale}: ${cause} reads "${view.title}"`);
      // The subject is the chats (or the session), never the game: the mount holds no Game projection.
      assert.doesNotMatch(view.detail, /\bgame\b/u, `${locale}: ${cause} claims something about the game`);
      // A raw code is a diagnostic, never a sentence: the internal-error wording carried one.
      assert.doesNotMatch(view.detail, /\{\{|internal error/u, `${locale}: ${cause} leaks the fault's shape`);
      assert.equal(
        presentation.drawsOwnRead,
        pressesHelp,
        `${locale}: ${cause} ${pressesHelp ? "lost" : "still offers"} the read it cannot help`,
      );
      if (!pressesHelp)
        assert.ok(
          (presentation.stepLine ?? "").length > 0,
          `${locale}: ${cause} leaves the card with neither a control nor a step`,
        );
    }
  }
});

void test("a refusal the mount did not cause keeps the words the panels already read", () => {
  for (const locale of LOCALES) {
    const labels = messages(locale);
    for (const error of [gameProblem("storage_unavailable"), tavernProblem("runtime_unavailable", true)]) {
      assert.deepEqual(composedBootstrapProblemView(error, labels), composedProblemView(error, labels));
    }
    // The one transient answer at mount: the card's own read is the step, and it stays.
    assert.equal(
      problemStepPresentation(composedBootstrapProblemView(gameProblem("storage_unavailable"), labels).step, labels)
        .drawsOwnRead,
      true,
    );
  }
});
