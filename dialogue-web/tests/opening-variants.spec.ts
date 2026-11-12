/**
 * The conversation's opening: what offers it, what seals it, and what is invented for it.
 *
 * The variant switcher lives on the opening bubble and never in the composer row, it is sealed
 * once the player has spoken, a conversation that already carries a message offers no opening
 * chips and does not read the card's record, and a card with no opening material shows no chip
 * rather than an invented one.
 */
import { expect, test } from "./frontend-coverage";
import { token, draft, chat, root, jsonOk } from "./composed-reference-game-fixtures";

/**
 * The first screen only: a conversation that has already started offers no
 * opening row and the shell does not read the card's record for it. The failure
 * this catches: an opening affordance that survives the first message (offered
 * where it can no longer mean anything), and a shell that reads the greeting
 * record on every chat - the read itself is asserted here, not only the
 * rendering.
 */
test("a conversation with a message offers no opening chips and does not read the card's record", async ({ page }) => {
  let greetingReads = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads += 1;
    return route.fulfill(
      jsonOk({
        apiVersion: 1,
        present: true,
        revision: 1,
        label: "Initial Greeting",
        variants: [{ label: "Default", text: "The lantern over the porch is still lit." }],
      }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".message-list > li")).toHaveCount(1);
  await expect(surface.locator(".composer-chip")).toHaveCount(0);
  await expect(surface.locator(".composer-chips-row")).toHaveCount(0);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);
  expect(greetingReads, "a started conversation asks for no opening material").toBe(0);
});


/**
 * The honest empty case: a card whose greeting record carries nothing (the state
 * the owner's own screenshot was taken in - "还没有保存开场白") offers no opening
 * row at all, and the surface invents none. The failure this catches: fabricated
 * starters, and a first screen that stays blank instead of falling back to the
 * conversation's own zero state.
 */
test("a card with no opening material shows no chip and invents none", async ({ page }) => {
  const emptyRoot = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      chat: { ...chat.chat, transcript: [], draft: { revision: 0, present: false } },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(emptyRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(emptyRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface.locator("[data-empty-anchor]")).toBeVisible();
  await expect(surface.locator(".composer-chip")).toHaveCount(0);
  await expect(surface.locator(".composer-chips-row")).toHaveCount(0);
  // The first screen is still the conversation's own, with a usable composer.
  await expect(surface.locator(".composer-textarea")).toBeEnabled();
});


/**
 * The first screen of a card-provisioned Chat is NOT an empty transcript.
 *
 * The product's own initial-Chat saga draws message zero from the greeting record
 * whenever the companion was provisioned from a card
 * (`initial-chat-exact-content-port.ts` `companionOwnOpening`, invoked from
 * `continuity-semantic-production-coordinator.internal.ts`
 * `materializeExpectedChatContent`), so by the time a player looks at the first
 * screen it already carries the companion's committed opening, projected with
 * `openingVariant`. Choosing among those variants is that message's own switcher
 * (`Default 1/2` - the Host's label for the committed variant and its position in
 * the set), which records the choice through the Host's `chat.opening` route.
 *
 * The failure this catches: a variant chooser anywhere but that switcher - a
 * composer row whose taps submitted the companion's own paragraph as the
 * player's line, which is the inverted path this replaces.
 */
test("the opening's variant switcher lives on the opening bubble, and the composer offers no opening row", async ({ page }) => {
  const openings = [
    { label: "Default", text: "The lantern over the porch is still lit." },
    { label: "Alternate 1", text: "Rain has been falling since dawn." },
  ];
  const openingVariantId = "V".repeat(42) + "A";
  const openedMessageHandle = "W".repeat(42) + "A";
  let greetingReads = 0;

  const firstScreenRoot = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      chat: {
        ...chat.chat,
        transcript: [
          {
            handle: openedMessageHandle,
            role: "companion",
            text: openings[0]!.text,
            locale: "und",
            order: 0,
            revision: 1,
            openingVariant: { variantId: openingVariantId, index: 0, count: 2, label: openings[0]!.label, locked: false },
          },
        ],
        draft: { revision: 0, present: false },
      },
    },
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(firstScreenRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(firstScreenRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads += 1;
    return route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: openings }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();

  // The companion's committed opening is on screen ...
  await expect(surface.locator(".message-list > li")).toHaveCount(1);
  await expect(surface.locator("[data-empty-anchor]")).toHaveCount(0);

  // ... and choosing among the variants is the opening bubble's own control, not
  // a composer row: the message carries the Host's unlocked switcher, worded with
  // the Host's own label for the committed variant and its position in the set.
  await expect(surface.locator(".composer-chip, .composer-chips-row")).toHaveCount(0);
  const opening = surface.locator(".message.companion").first();
  await expect(opening.locator(".swipe-indicator")).toHaveText("Default 1/2");
  await expect(opening.locator(".swipe-btn")).toHaveCount(2);
  expect(greetingReads, "the composer column reads no opening material").toBe(0);
});


/**
 * Once the player has spoken, the opening can no longer be re-chosen: the Host
 * seals it (`openingVariant.locked`), so the bubble's own variant switcher is
 * gone and the composer carries no opening row either.
 *
 * The failure this catches: a switcher that survives the first player message,
 * and a first-screen predicate that treats the companion's opening as "nothing
 * has happened yet" forever.
 */
test("the opening's variant switcher is sealed once a player message follows the opening", async ({ page }) => {
  const openings = [
    { label: "Default", text: "The lantern over the porch is still lit." },
    { label: "Alternate 1", text: "Rain has been falling since dawn." },
  ];
  const startedRoot = {
    ...root,
    chat: {
      ...chat,
      operations: [
        {
          operationId: "chat.submit",
          labelKey: "tavern.operation.submit",
          availability: "available",
          routeId: "chat.submit",
        },
      ],
      chat: {
        ...chat.chat,
        transcript: [
          {
            handle: "W".repeat(42) + "A",
            role: "companion",
            text: openings[0]!.text,
            locale: "und",
            order: 0,
            revision: 1,
            openingVariant: { variantId: "V".repeat(42) + "A", index: 0, count: 2, label: openings[0]!.label, locked: true },
          },
          { handle: "X".repeat(42) + "A", role: "player", text: "I'll be right out.", locale: "und", order: 1, revision: 1 },
        ],
        draft: { revision: 0, present: false },
      },
    },
  };
  let greetingReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(startedRoot)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(startedRoot)));
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) => {
    greetingReads += 1;
    return route.fulfill(
      jsonOk({ apiVersion: 1, present: true, revision: 1, label: "Initial Greeting", variants: openings }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  await expect(surface.locator(".message-list > li")).toHaveCount(2);
  await expect(surface.locator(".composer-chip")).toHaveCount(0);
  await expect(surface.locator(".composer-chips-row")).toHaveCount(0);
  // The opening is sealed once the player has spoken, so its own variant
  // switcher is gone too: the choice cannot be reopened behind the transcript.
  await expect(surface.locator(".swipe-controls")).toHaveCount(0);
  expect(greetingReads, "a conversation the player has spoken in asks for no opening material").toBe(0);
});


