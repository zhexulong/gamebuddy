/**
 * The field a refusal is about says so.
 *
 * Memory's three authoring forms each render the Host's refusal as a visible `<p>` directly under the
 * field whose words it refused. The sentence is in the right place for a sighted player and invisible
 * to a screen reader: the field's accessible description is empty, `aria-invalid` is not set, so the
 * failure is announced by nobody and the player is left at a field that looks like any other. This is
 * the one place that turns "this field has a refusal" into the three facts the association needs, so
 * the message keeps being an ordinary visible paragraph (`role="status"` - the polite live region the
 * refusal already used) and no copy of the id is written twice.
 *
 * The message id is the caller's: a form the player can open in more than one place at once (one
 * correction per Memory row) derives it from the row's own handle, because two rows refusing together
 * must not both point at the first row's sentence.
 */
export type FieldError = Readonly<{
  /** `aria-invalid`: `"true"` only while the field's own refusal is on screen, absent otherwise. */
  invalid: "true" | undefined;
  /** `aria-describedby`: the id of that refusal, absent when there is none to point at. */
  describedBy: string | undefined;
  /** The id the message element carries, so the control's pointer has a target. */
  id: string;
}>;

/** The association for one field, from the refusal it is rendering (or `null` when it has none). */
export function fieldError(message: string | null, id: string): FieldError {
  return message === null
    ? { invalid: undefined, describedBy: undefined, id }
    : { invalid: "true", describedBy: id, id };
}
