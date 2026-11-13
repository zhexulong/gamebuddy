/**
 * The appearance this browser paints itself in.
 *
 * WHY THIS IS NOT A STYLESHEET-ONLY DECISION
 *
 * The stylesheet carries two token roots - `:root` (the dark set, and the base) and
 * `:root[data-theme="light"]` - so a document with no attribute at all paints exactly the product
 * that shipped. Choosing between them at runtime is this module's whole job, and it is a runtime
 * job because the player's answer can be "whatever the operating system says", which no selector
 * can express: `prefers-color-scheme` decides, and it can change while the page is open.
 *
 * LAYERING
 *
 *   `system`  the operating system's own answer, read now and watched for the rest of the session
 *   `light`   the light token root, whatever the operating system says
 *   `dark`    the dark token root, whatever the operating system says
 *
 * The Host stores the player's CHOICE ("system" included, which is a choice and not an absence);
 * what each appearance paints is the stylesheet's business, and the choice never becomes a colour
 * here.
 */

/** The appearance the player chose. `system` follows the operating system. */
export type AppearanceChoice = "system" | "light" | "dark";

/** The appearance actually painted. There is no "system" colour set. */
export type Appearance = "light" | "dark";

/** The attribute the stylesheet's second token root reads. */
const APPEARANCE_ATTRIBUTE = "data-theme";

/** True when the operating system is asking for the light appearance. */
const SYSTEM_LIGHT_QUERY = "(prefers-color-scheme: light)";

export function isAppearanceChoice(value: unknown): value is AppearanceChoice {
  return value === "system" || value === "light" || value === "dark";
}

/**
 * The appearance to paint: the player's choice when it names one, and otherwise the system's answer.
 * Both are arguments rather than reads, so the rule can be stated once and checked without a browser.
 */
export function resolveAppearance(choice: AppearanceChoice, systemPrefersLight: boolean): Appearance {
  if (choice === "light" || choice === "dark") return choice;
  return systemPrefersLight ? "light" : "dark";
}

type MediaQueryWindow = Pick<Window, "matchMedia">;

/** The operating system's current answer. An environment without `matchMedia` asks for dark, as the base does. */
export function systemPrefersLight(view: MediaQueryWindow | null): boolean {
  if (view === null || typeof view.matchMedia !== "function") return false;
  return view.matchMedia(SYSTEM_LIGHT_QUERY).matches;
}

type DocumentRoot = { documentElement: { setAttribute(name: string, value: string): void } };

/** Writes the resolved appearance onto the document, which is what the token roots select on. */
export function applyAppearance(appearance: Appearance, doc: DocumentRoot | null): void {
  if (doc === null) return;
  doc.documentElement.setAttribute(APPEARANCE_ATTRIBUTE, appearance);
}

/**
 * Calls `onChange` whenever the operating system changes its answer, and returns the disposer.
 *
 * This is what makes "system" mean "follow the system" rather than "follow the system as it was when
 * the page opened": a player who turns their OS to light at dusk sees the product follow without a
 * reload. The listener is removed with the disposer, so a choice of a fixed appearance stops
 * watching - the shell's effect does that by re-running on every choice.
 */
export function watchSystemAppearance(view: MediaQueryWindow | null, onChange: () => void): () => void {
  if (view === null || typeof view.matchMedia !== "function") return () => {};
  const query = view.matchMedia(SYSTEM_LIGHT_QUERY);
  if (typeof query.addEventListener !== "function") return () => {};
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}
