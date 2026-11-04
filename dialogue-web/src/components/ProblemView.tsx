export type ProblemViewAction = Readonly<{
  /** The words on the control, from the catalogue. */
  label: string;
  /** What it does. The shell owns the call, because the shell owns the read it repeats. */
  run: () => void;
}>;

/**
 * The shell's own problem screen: a refusal it could not resolve, described and nothing more.
 *
 * It is deliberately not a dead end. Once the shell degraded, the only way out used to be clearing
 * the player's storage, because this card was a heading and a paragraph and no control at all. So it
 * carries one step, and the decision of what that step is belongs to the shell: the read that failed
 * is the shell's (`rereadChat`), it is a real call rather than a reload, and pressing it either
 * recovers the surface or states the next refusal in this same card - it can never lose the place
 * the player had, which is what a reload costs them. `null` is the honest answer when the shell has
 * no step to offer, and this component renders no control rather than a dead one.
 *
 * Nothing else lives here on purpose: the card's virtue is that it is trivially correct.
 */
export function ProblemView({
  title,
  detail,
  action,
}: {
  title: string;
  detail: string;
  action: ProblemViewAction | null;
}) {
  return (
    <main className="problem-view" id="main-content">
      <section className="problem-card" role="alert">
        <h1>{title}</h1>
        <p>{detail}</p>
        {action !== null && (
          // `.problem-card` is already a flex column with the card's own gap, so the control needs
          // no wrapper and no new rule: it is one more row of the card.
          <button type="button" className="small-button" onClick={action.run}>
            {action.label}
          </button>
        )}
      </section>
    </main>
  );
}
