/**
 * The Settings surface's tabs, and the presses a journey makes to reach a group that sits on one.
 *
 * The surface is split into three tabs because it was one column of everything a player can change: at
 * 400x800 that column measured 3122 px and the last block sat 2306 px below the fold. A tab is a VIEW of
 * the surface, not a mount of it - the groups on the other two tabs are in the document the whole time
 * and take no room - so a journey about a group's controls presses its tab first.
 *
 * This lives here rather than in each journey for the reason `draft-surfaces.ts` exists: a second
 * spelling of "which tab holds the voice settings" is a second thing to keep in step with the component.
 * The labels are the catalogue's English words, which is the locale the mounted journeys run in
 * (`playwright.config.ts`).
 */
import { type Page, expect } from "./frontend-coverage";

/** The three tabs, by the words the strip shows. */
export const SETTINGS_TAB = {
  connection: "Connection and model",
  preferences: "Preferences",
  advanced: "Advanced and tuning",
} as const;

/** Press one tab, and require that pressing it made it the selected one. */
export async function openSettingsTab(page: Page, tab: string): Promise<void> {
  const surface = page.getByTestId("settings-surface");
  const control = surface.getByRole("tab", { name: tab, exact: true });
  await control.click();
  await expect(control, `the "${tab}" tab is selected after pressing it`).toHaveAttribute("aria-selected", "true");
}

/**
 * Open one of the settings regions that is a `<details>`, and do nothing for the ones that are not.
 *
 * The surface's low-frequency regions arrive closed, so a journey about their controls opens the row
 * first. A region that is not a disclosure has no `summary` and is already open, which is why this is
 * safe to call for any of them: the caller says "make this region's controls reachable", not "click".
 */
export async function openSettingsRegion(page: Page, selector: string): Promise<void> {
  const region = page.getByTestId("settings-surface").locator(selector);
  const summary = region.locator("summary");
  if ((await summary.count()) === 0) return;
  const opened = await region.evaluate((node) => (node as HTMLDetailsElement).open);
  if (opened) return;
  await summary.first().click();
  await expect(region, `the ${selector} region opens when its row is pressed`).toHaveAttribute("open", /.*/u);
}
