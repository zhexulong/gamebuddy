/**
 * Whether this browser sizes a text field from its own content.
 *
 * `field-sizing: content` is the layout engine's own answer to "as tall as the words in it", and the
 * product's two prose fields - the composer's and the editor a message is rewritten in - ask for it
 * in `style.css`, where their floor and ceiling are the sheet's `min-height`/`max-height`.
 *
 * A browser without the property cannot size a field from its content at all, so those two keep the
 * measurement they used to run on every keystroke: write `height: auto`, read `scrollHeight`, write
 * the clamped result. This value is the only thing deciding whether that measurement runs, which is
 * what keeps it a fallback rather than a second, always-paid path.
 *
 * Read once at module load: it is a property of the engine, not of any one field.
 */
export const fieldSizingSupported: boolean =
  typeof CSS !== "undefined" && typeof CSS.supports === "function" && CSS.supports("field-sizing", "content");
