import { expect, test, type Page } from "./frontend-coverage";

/**
 * Her example dialogues, from the player's side.
 *
 * The card's `mes_example` rows are the few-shot turns the Chat prompt prints under `[Dialogue
 * Examples]`, and they are the only place the SHAPE of a turn is taught: the system prompt owns
 * the floor and says nothing about form. Until this control existed there was no editor for them
 * anywhere - the card import set them, the card export wrote them back, and a companion the player
 * made directly kept the shipped default's rows for good.
 *
 * So the journeys here hold the three facts that make the control real rather than decorative:
 *
 *  - the rows the Host holds are SHOWN, and a companion with none says so and still gets an
 *    editor (an editor that only appears once she has examples is unreachable for the companion
 *    who has none, which is exactly the player who needs it);
 *  - a save sends the exact set the player sees, against the profile revision the read carried -
 *    the pair of fields the contract declares, not a client-side re-spelling of them;
 *  - a stale save keeps the player's words and CASes the next attempt on the revision the Host
 *    holds, instead of losing what they typed.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const currentHandle = "B".repeat(42) + "A";
const CHAT_HANDLE = "E".repeat(42) + "A";

const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat: {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: CHAT_HANDLE, generation: 1, stateRevision: CHAT_HANDLE },
    chat: {
      companion: { name: "Nova", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
      title: "Reference Game Chat",
      transcript: [],
      draft: { revision: 1, present: true },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  },
  game: null,
};

const draft = { apiVersion: 1, revision: 1, text: "A durable draft." };

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

type ExamplePair = { user: string; companion: string };
type ExamplesState = { profileRevision: number; examples: ExamplePair[] };
type Put = { csrf: string | undefined; body: unknown };

/** The problem body the Host sends when the row set moved under a save. */
const conflict = {
  type: "about:blank",
  title: "Her examples changed",
  status: 409,
  code: "character_examples_conflict",
  requestId: csrfToken,
  retryable: false,
};

/**
 * The Characters surface's reads plus the example-dialogue pair. The stub is stateful, so a save
 * is visible to the next read exactly as a durable Host write would be; `refuseNextSave` makes the
 * next PUT answer the stale-edit refusal instead.
 */
async function stubCharactersSurface(
  page: Page,
  examples: ExamplesState,
  calls: { puts: Put[] },
  options: Readonly<{ refuseNextSave?: boolean }> = {},
): Promise<void> {
  const refuse = { pending: options.refuseNextSave === true };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: [{ handle: currentHandle, name: "Nova", isCurrent: true }] })),
  );
  await page.route(`**/api/tavern/v1/companions/${currentHandle}/voice`, (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, profileRevision: examples.profileRevision, characterVoice: null })),
  );
  await page.route(`**/api/tavern/v1/companions/${currentHandle}/examples`, async (route) => {
    const request = route.request();
    if (request.method() === "PUT") {
      const body = request.postDataJSON() as { expectedProfileRevision: number; examples: ExamplePair[] };
      calls.puts.push({ csrf: request.headers()["x-csrf-token"], body });
      if (refuse.pending) {
        refuse.pending = false;
        // The Host wrote nothing and moved on: the next read carries the newer revision.
        examples.profileRevision = body.expectedProfileRevision + 1;
        await route.fulfill({ status: 409, contentType: "application/problem+json", body: JSON.stringify(conflict) });
        return;
      }
      examples.profileRevision = body.expectedProfileRevision + 1;
      examples.examples = body.examples;
    }
    await route.fulfill(
      jsonOk({ apiVersion: 1, profileRevision: examples.profileRevision, examples: examples.examples }),
    );
  });
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/world-info", (route) =>
    route.fulfill(jsonOk({ state: "none", revision: CHAT_HANDLE, items: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) => route.fulfill(jsonOk({ apiVersion: 1, entries: [] })));
}

async function openCharactersSurface(page: Page): Promise<void> {
  await page.addInitScript((value) => localStorage.setItem("gamebuddy.tavern.ui-locale", value), "en");
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

const examplesSection = (page: Page) => page.getByTestId("characters-surface").locator("[data-character-examples]");

test("the rows she carries are shown, and a second row is added and saved as the set the player sees", async ({ page }) => {
  const calls = { puts: [] as Put[] };
  await stubCharactersSurface(page, { profileRevision: 4, examples: [{ user: "早。", companion: "早，先喝水。" }] }, calls);
  await openCharactersSurface(page);

  const section = examplesSection(page);
  await expect(section).toBeVisible();
  const rows = section.locator("[data-character-example-row]");
  await expect(rows).toHaveCount(1);
  // The Host's rows arrive rendered, and the editor shows them exactly as sent.
  await expect(rows.first().locator("textarea").first()).toHaveValue("早。");
  await expect(rows.first().locator("textarea").nth(1)).toHaveValue("早，先喝水。");
  // Present rows mean no absence line.
  await expect(section.locator("[data-character-examples-absent]")).toHaveCount(0);

  await section.locator("[data-character-example-add]").click();
  await expect(rows).toHaveCount(2);
  await rows.nth(1).locator("textarea").first().fill("今天做什么？");
  await rows.nth(1).locator("textarea").nth(1).fill("先把水壶灌满。");
  await section.locator("[data-character-examples-save]").click();

  await expect.poll(() => calls.puts.length).toBe(1);
  // The wire carries the contract's own two fields, the whole set in order, and the profile
  // revision the read handed over - the same CAS the directive editor uses.
  expect(calls.puts[0]?.body).toEqual({
    apiVersion: 1,
    expectedProfileRevision: 4,
    examples: [
      { user: "早。", companion: "早，先喝水。" },
      { user: "今天做什么？", companion: "先把水壶灌满。" },
    ],
  });
  expect(calls.puts[0]?.csrf).toBe(csrfToken);
  await expect(section.locator("[data-character-examples-notice]")).toHaveText("Saved.");
  await expect(rows).toHaveCount(2);
});

test("a companion with no examples says so, and the blank row is how the first one is written", async ({ page }) => {
  const calls = { puts: [] as Put[] };
  await stubCharactersSurface(page, { profileRevision: 1, examples: [] }, calls);
  await openCharactersSurface(page);

  const section = examplesSection(page);
  // Absence is stated, not implied - and the editor is still there, because the companion who has
  // no examples is the one who needs it. One blank row, ready to be filled.
  await expect(section.locator("[data-character-examples-absent]")).toBeVisible();
  const rows = section.locator("[data-character-example-row]");
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("textarea").first()).toHaveValue("");

  await rows.first().locator("textarea").first().fill("你在吗？");
  await rows.first().locator("textarea").nth(1).fill("在，正把柴劈完。");
  await section.locator("[data-character-examples-save]").click();

  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0]?.body).toEqual({
    apiVersion: 1,
    expectedProfileRevision: 1,
    examples: [{ user: "你在吗？", companion: "在，正把柴劈完。" }],
  });
  // And the Host's own read-back is what the surface now shows: the absence line is gone.
  await expect(section.locator("[data-character-examples-absent]")).toHaveCount(0);
});

test("a half-written row is not sent, and removing a row sends the set that is left", async ({ page }) => {
  const calls = { puts: [] as Put[] };
  await stubCharactersSurface(
    page,
    {
      profileRevision: 9,
      examples: [
        { user: "第一句。", companion: "第一句的回答。" },
        { user: "第二句。", companion: "第二句的回答。" },
      ],
    },
    calls,
  );
  await openCharactersSurface(page);

  const section = examplesSection(page);
  const rows = section.locator("[data-character-example-row]");
  await expect(rows).toHaveCount(2);
  // Drop the FIRST row: what is left must be the second one's words, which is what a positional
  // key would get wrong (the surviving row would keep the removed row's text on screen).
  await rows.first().locator("[data-character-example-remove]").click();
  await expect(rows).toHaveCount(1);
  await expect(rows.first().locator("textarea").first()).toHaveValue("第二句。");
  await expect(rows.first().locator("textarea").nth(1)).toHaveValue("第二句的回答。");

  // A third row with only one half written is not an example: the prompt prints both halves, so
  // neither half of a half-row reaches the wire.
  await section.locator("[data-character-example-add]").click();
  await rows.nth(1).locator("textarea").first().fill("只有我说话。");
  await section.locator("[data-character-examples-save]").click();

  await expect.poll(() => calls.puts.length).toBe(1);
  expect(calls.puts[0]?.body).toEqual({
    apiVersion: 1,
    expectedProfileRevision: 9,
    examples: [{ user: "第二句。", companion: "第二句的回答。" }],
  });
});

test("a stale save keeps the player's words and the next save carries the revision the Host holds", async ({ page }) => {
  const calls = { puts: [] as Put[] };
  await stubCharactersSurface(
    page,
    { profileRevision: 2, examples: [{ user: "早。", companion: "早。" }] },
    calls,
    { refuseNextSave: true },
  );
  await openCharactersSurface(page);

  const section = examplesSection(page);
  const rows = section.locator("[data-character-example-row]");
  await rows.first().locator("textarea").nth(1).fill("早，先喝水。");
  await section.locator("[data-character-examples-save]").click();

  // The refusal is stated in the catalogue's own sentence for a stale authored edit - NOT in this
  // section's fallback, which is what an unrecognised code would print - and the words are exactly
  // where the player left them.
  await expect.poll(() => calls.puts.length).toBe(1);
  const refusal = section.locator("[data-character-examples-notice]");
  await expect(refusal).toBeVisible();
  await expect(refusal).not.toContainText("Could not save her examples");
  await expect(rows.first().locator("textarea").nth(1)).toHaveValue("早，先喝水。");

  await section.locator("[data-character-examples-save]").click();
  await expect.poll(() => calls.puts.length).toBe(2);
  // The second attempt CASes on the revision the re-read carried, not the one that lost.
  expect((calls.puts[1]?.body as { expectedProfileRevision: number }).expectedProfileRevision).toBe(3);
  expect((calls.puts[1]?.body as { examples: ExamplePair[] }).examples).toEqual([
    { user: "早。", companion: "早，先喝水。" },
  ]);
  await expect(section.locator("[data-character-examples-notice]")).toHaveText("Saved.");
});
