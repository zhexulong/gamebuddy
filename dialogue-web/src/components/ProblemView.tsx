import { assertNever } from "../assert-never";
import type { ProblemStep } from "../composed-problem-view";
import { PROBLEM_RETRY_READ } from "../composed-problem-view";
import type { Messages } from "../i18n";

export type ProblemViewAction = Readonly<{
  /** Which control this action is. The card draws it only for the step that names it. */
  id: string;
  /** The words on the control, from the catalogue. */
  label: string;
  /** What it does. The shell owns the call, because the shell owns the read it repeats. */
  run: () => void;
}>;

/**
 * The shell's own problem screen: a refusal it could not resolve, its own words, and the step it
 * leaves the player.
 *
 * It is deliberately not a dead end. Once the shell degraded, the only way out used to be clearing
 * the player's storage, because this card was a heading and a paragraph and no control at all. It
 * then swung to the opposite defect: every one of the sixty-one tavern refusals and twenty-three
 * game ones was handed the same control - the read taken again - so `turn_busy`, `session_expired`
 * and `payload_too_large` offered a press that could not help any of them.
 *
 * The step is the failure's own type now (see `ProblemStep`), and this card renders it as it is:
 *
 *  - `control` - the shell's own read, drawn as a button, and only when the step names exactly that
 *    control. A step whose control lives on the surface the refusal came from (`message-delete`,
 *    `new-chat`, `game-stop`) is not drawn here, because a button labelled "read it again" is not
 *    that control; the Sentence below the heading already names it, and the card says so.
 *  - `outside_surface` - no control at all: the card names the step that is off this page (a saved
 *    connection in Settings, a fresh GameBuddy).
 *  - `self_heals` - no control at all: the card says it clears by itself, and why.
 *  - `no_step` - no control at all: the card says what makes the request impossible.
 *
 * Nothing else lives here on purpose: the card's virtue is that it is trivially correct.
 */
export function ProblemView({
  title,
  detail,
  step,
  action,
  labels,
}: {
  title: string;
  detail: string;
  step: ProblemStep;
  action: ProblemViewAction | null;
  labels: Messages;
}) {
  const ownControl = step.kind === "control" && action !== null && action.id === step.id ? action : null;
  const stepLine = ownControl === null ? stepText(step, labels) : null;
  return (
    <main className="problem-view" id="main-content">
      <section className="problem-card" role="alert">
        <h1>{title}</h1>
        <p>{detail}</p>
        {ownControl !== null && (
          // `.problem-card` is already a flex column with the card's own gap, so the control needs
          // no wrapper and no new rule: it is one more row of the card.
          <button type="button" className="small-button" data-testid={PROBLEM_RETRY_READ} onClick={ownControl.run}>
            {ownControl.label}
          </button>
        )}
        {stepLine !== null && (
          // One row of the same card, and the only thing this screen can offer when no control of
          // its own is the step: what to do instead, in the catalogue's own words. No class - a name with
          // no rule behind it is what `check:class-name-declarations` exists to refuse.
          <p data-testid="problem-step">{stepLine}</p>
        )}
      </section>
    </main>
  );
}

/** The step in words, for every kind this card cannot draw a control for. */
function stepText(step: ProblemStep, labels: Messages): string | null {
  switch (step.kind) {
    case "control":
      // The control is a real one the player can press - on the surface the sentence beside this
      // line names. The card draws only its own read, so it says where the step is rather than
      // offering a second control that is not it.
      return labels.problemStepElsewhere;
    case "outside_surface":
      return {
        open_settings: labels.problemStepOpenSettings,
        retry_bootstrap: labels.problemStepRetryBootstrap,
        restart_gamebuddy: labels.problemStepRestartGamebuddy,
      }[step.step];
    case "self_heals":
      return {
        host_retries: labels.problemStepSelfHealsHostRetries,
        next_read: labels.problemStepSelfHealsNextRead,
        stream_resumes: labels.problemStepSelfHealsStreamResumes,
      }[step.because];
    case "no_step":
      return {
        over_a_ceiling: labels.problemStepNoStepOverACeiling,
        already_true: labels.problemStepNoStepAlreadyTrue,
        not_this_artifact: labels.problemStepNoStepNotThisArtifact,
      }[step.because];
    default:
      return assertNever(step);
  }
}
