export type ProblemViewAction = Readonly<{
  /** The words on the control, from the catalogue. */
  label: string;
  /** What it does. The shell owns the call, because the shell owns the read it repeats. */
  run: () => void;
}>;

/**
 * Where a problem card is drawn, which is a fact about what failed rather than about the card.
 *
 *  - `window` - the shell never got a session: the mount's own read was refused, so there is no
 *    region to draw in and nothing else on the page to keep. The card is the page.
 *  - `chat` - a read about the CONVERSATION failed while the shell stood. Chat and Game are peer
 *    surfaces (`design/architecture/product-surfaces.md`), so the card takes the Chat region and
 *    the Game surface keeps its place, its projection and its running Player Host. The wrapper is
 *    the caller's: this card is a `<section>` in either case.
 */
export type ProblemViewRegion = "window" | "chat";

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
 * The card is a props-driven primitive and nothing more: the step arrives as the catalogue's own
 * sentence, and the control arrives only when the failure's step names it
 * (`problemStepLine`/`problemDrawsOwnRead` in `composed-problem-view.ts` own that decision, because
 * it is a fact about the refusal vocabulary). It draws one control and no other - the read taken
 * again - so the marker is written here as a literal rather than imported: `PROBLEM_RETRY_READ`
 * lives where the step vocabulary lives. `tools/check-fail-closed-forward-path.mjs` holds the two
 * spellings equal - it resolves the step's id in that module and fails when no element here carries
 * it - so a rename that misses one of them is caught, not silent.
 *
 * Nothing else lives here on purpose: the card's virtue is that it is trivially correct.
 */
export function ProblemView({
  title,
  detail,
  stepLine,
  action,
  region = "window",
}: {
  title: string;
  detail: string;
  stepLine: string | null;
  action: ProblemViewAction | null;
  region?: ProblemViewRegion;
}) {
  const card = (
    <section className="problem-card" role="alert">
      <h1>{title}</h1>
      <p>{detail}</p>
      {action !== null && (
        // `.problem-card` is already a flex column with the card's own gap, so the control needs
        // no wrapper and no new rule: it is one more row of the card.
        <button type="button" className="small-button" data-testid="problem-retry-read" onClick={action.run}>
          {action.label}
        </button>
      )}
      {stepLine !== null && (
        // One row of the same card, and the only thing this screen can offer when no control of
        // its own is the step: what to do instead, in the catalogue's own words. No class - a name with
        // no rule behind it is what `check:class-name-declarations` exists to refuse.
        <p data-testid="problem-step">{stepLine}</p>
      )}
    </section>
  );
  // The window card is the page and owns the skip link's target. The region card is drawn inside
  // `<main id="main-content">` by the surface it belongs to, so it must not claim that id or a
  // second `main`; `.state-placeholder` (the region's own centred container, already in the
  // stylesheet) is the wrapper it is handed there.
  if (region === "chat") return card;
  return (
    <main className="problem-view" id="main-content" tabIndex={-1}>
      {card}
    </main>
  );
}
