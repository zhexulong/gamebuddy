/**
 * The criteria the journeys in this directory are instances of, asserted as properties rather
 * than as separate behaviours: accessibility, keyboard reach, the layout floor and the quiet
 * walk, on a conversation that carries real content. A frontend change that drops one of them
 * while every behavioural journey still passes is what this file exists to catch.
 */
import { expect, test } from "./frontend-coverage";
import {
  assertAccessibilityBaseline,
  assertCriteriaCoverage,
  assertKeyboardReachable,
  assertLayoutFloor,
  assertQuiet,
  assertSectionsKeyboardReachable,
  resetCriteriaLedger,
  watchSurface,
} from "./frontend-criteria.js";
import { token, draft, chat, root, jsonOk } from "./composed-reference-game-fixtures";

/**
 * The obligations the product surface declares for itself. The reference and
 * management surfaces' criteria journeys went with their shells (13c4c70a,
 * 6406dd0a); the one remaining surface carries their obligations, and this list
 * is what keeps a checker from being dropped quietly.
 */
const PRODUCT_CRITERIA_OBLIGATIONS = [
  "frontend-accessibility-baseline",
  "frontend-keyboard-reach",
  "frontend-layout-floor",
  "frontend-quiet-walk",
] as const;

/**
 * The criteria the journeys above are instances of, asserted as properties of
 * the product surface.
 *
 * The failures this catches: a frontend change that drops an accessibility,
 * keyboard, layout or quietness property while every behavioural journey still
 * passes - which is what the conformance contract (`frontend-criteria.ts`,
 * design/architecture/tavern-frontend-criteria.md) exists to prevent. The
 * conversation carries real content first, because an empty transcript never
 * overflows and has nothing to reach with a keyboard, so a floor measured on it
 * would report a pass that means nothing.
 */

test("conformance: the product surface meets the frontend criteria", async ({ page }) => {
  test.setTimeout(60_000);
  const noise = watchSurface(page);
  // `chat.submit` is published, exactly as the reference profile declares it: the
  // composer's own enablement is a projection of the nested Chat snapshot, so the
  // surface judged here is the operable one a player is actually given.
  const operable = {
    ...root,
    chat: {
      ...chat,
      operations: [
        { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
      ],
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(operable)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.getByRole("textbox", { name: /Type a message/u });
  await expect(composer).toBeVisible();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );

  // Keyboard reach is measured from the document as loaded: no programmatic
  // focus, no pointer event, and before anything has been typed into the
  // composer (typing would leave focus there and Tab would walk away from it).
  resetCriteriaLedger();
  await assertKeyboardReachable(page, composer, "the chat composer");
  await assertSectionsKeyboardReachable(page, "[aria-label]");

  await assertAccessibilityBaseline(page, "composed");
  await assertLayoutFloor(page);
  assertQuiet(noise, "composed");
  assertCriteriaCoverage("composed", PRODUCT_CRITERIA_OBLIGATIONS);
});

