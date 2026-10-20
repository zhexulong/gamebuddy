import { expect, test, type Page } from "@playwright/test";

/**
 * Choosing the opening when a Chat is created, mounted.
 *
 * The player's New Chat control offers the companion's own preset openings - the
 * set `greeting.read` serves and a new Chat's message zero is drawn from - and the
 * Chat the control creates starts on the one they picked.
 *
 * What each journey pins, and the failure it catches:
 *
 * 1. `creates the Chat on the opening the player picked` - the chosen opening is
 *    the new Chat's message zero. The opening is committed through the one route
 *    that can commit it (`chat.opening`), on the mounted successor and under the
 *    selection generation that mount minted: the route handler asserts the exact
 *    `selectionGeneration`, so a commit sent with the pre-switch generation (the
 *    one a panel still holds when the switch settles) fails here rather than
 *    silently leaving the Chat on its default opening.
 * 2. `offers no chooser when the companion has one opening` - a companion with a
 *    single opening has nothing to choose from, so New Chat stays the immediate
 *    control it is and no dialog ever exists.
 * 3. `says the Chat was created on the default opening when the choice is refused`
 *    - a refused opening commit does not orphan the Chat: the player is landed in
 *    it, the conversation reads the opening it really has, and the surface says
 *    which opening that is instead of reporting a generic failure.
 * 4. `closes on Escape and gives focus back` - the chooser is keyboard-reachable,
 *    Escape closes it, and focus returns to the control that opened it.
 * 5. `the chooser's geometry` measures the open chooser and each option's preview
 *    at 1440x900 and 400x800, and reports it. Nothing is asserted by class name:
 *    every claim is the player-visible text or a measured box.
 */

const token = "A".repeat(43);
const csrfToken = "C".repeat(42) + "A";
const expiresAtMs = 1_900_000_000_000;
const mountedHandle = "B".repeat(42) + "A";
const createdHandle = "E".repeat(42) + "A";
const companionHandle = "D".repeat(42) + "A";
const transcriptHandle = "F".repeat(42) + "A";

const DEFAULT_OPENING = "Good morning, farmer. The valley is quiet today.";
const RAINY_OPENING = "Rain on the roof before you open your eyes.\nThe kettle is already on.";
const NIGHT_OPENING =
  "It is past midnight and the lamp is still lit. The house has gone quiet around you, and the kettle is cold on the stove.\nYou are not alone in the house.";

/** The companion's own greeting set, in the order the Host commits by position. */
const OPENINGS = [
  { label: "Default", text: DEFAULT_OPENING },
  { label: "Rainy evening", text: RAINY_OPENING },
  { label: "Late night", text: NIGHT_OPENING },
];

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const problem = (status: number, code: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({
    type: "about:blank",
    title: "Refused",
    status,
    code,
    requestId: "Z".repeat(43),
    retryable: false,
  }),
});

const game = {
  apiVersion: 1,
  build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
  csrfToken,
  browserSession: { expiresAtMs },
  game: {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none",
  },
};

/** One mounted conversation, as the composed root projects it. */
function chatOf(handle: string, generation: number, title: string | null, messageZero: string) {
  return {
    apiVersion: 1,
    build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
    csrfToken,
    browserSession: { expiresAtMs },
    operations: [],
    navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
    selection: { chatHandle: handle, generation, stateRevision: handle },
    chat: {
      companion: { name: "Mira", handle: companionHandle },
      title,
      transcript: [
        { handle: transcriptHandle, role: "companion", text: messageZero, locale: "und", order: 0, revision: 1 },
      ],
      draft: { revision: 4, present: true },
      turn: null,
      worldInfo: null,
    },
    memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
    eventStream: null,
  };
}

const root = (chat: ReturnType<typeof chatOf>) => ({
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game,
});

/** The model the specs mutate: which Chat is mounted, its generation, and its message zero. */
type Fixture = Readonly<{
  /** Set by the create route, so a journey can tell the Chat the control wrote really exists. */
  isCreated: () => boolean;
  mountedGeneration: () => number;
}>;

/**
 * The Host as these journeys need it: the mounted Chat, a New Chat that writes a
 * durable second Chat opening on the companion's default, a switch that mounts it
 * and advances the selection generation the way the real successor mount does, and
 * the opening commit that only the mounted generation can perform.
 */
async function mountHost(page: Page, options: Readonly<{ openings?: readonly { label: string; text: string }[]; refuseOpening?: boolean }>): Promise<Fixture> {
  const openings = options.openings ?? OPENINGS;
  let created = false;
  let mounted = "first";
  let generation = 1;
  let messageZero = DEFAULT_OPENING;

  const currentChat = () => {
    if (mounted === "created") return chatOf(createdHandle, generation, null, messageZero);
    return chatOf(mountedHandle, generation, "First conversation", "The game projection is read-only.");
  };
  const currentRoot = () => root(currentChat());

  const entry = (handle: string, isSelected: boolean, preview: string | null) => ({
    handle,
    title: handle === mountedHandle ? "First conversation" : null,
    status: "active" as const,
    managementRevision: 1,
    isSelected,
    updatedAtMs: 1_760_000_000_000,
    preview,
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(currentRoot())));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(currentRoot())));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: true, revision: 1, label: null, variants: openings })),
  );
  await page.route(/(\/api\/tavern\/v1\/chats)(\?|$)/, (route) => {
    if (route.request().method() === "POST") {
      created = true;
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          chat: entry(createdHandle, false, DEFAULT_OPENING),
          opening: DEFAULT_OPENING,
        }),
      );
    }
    return route.fulfill(
      jsonOk({
        apiVersion: 1,
        chats: [
          entry(mountedHandle, mounted === "first", "The game projection is read-only."),
          ...(created ? [entry(createdHandle, mounted === "created", DEFAULT_OPENING)] : []),
        ],
      }),
    );
  });
  await page.route("**/api/tavern/v1/chat/select", (route) => {
    const command = route.request().postDataJSON() as { selectionGeneration: number; chatHandle: string };
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    expect(command.chatHandle).toBe(createdHandle);
    // The switch is the browser's own generation, read from the snapshot it holds.
    expect(command.selectionGeneration).toBe(generation);
    mounted = "created";
    // A settled switch mounts a successor and mints a fresh projection: the real
    // authority advances the selection generation (continuity-semantic-chat-switch
    // asserts successorGeneration > firstGeneration).
    generation += 1;
    messageZero = DEFAULT_OPENING;
    return route.fulfill(jsonOk({ apiVersion: 1, status: "switched" }));
  });
  await page.route("**/api/tavern/v1/chat/opening", (route) => {
    const command = route.request().postDataJSON() as { selectionGeneration: number; targetIndex: number };
    expect(route.request().method()).toBe("PUT");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    // The commit addresses the MOUNTED successor under ITS generation - the one the
    // switch just minted, never the one the Chats panel held before the switch.
    expect(command.selectionGeneration).toBe(generation);
    if (options.refuseOpening === true) return route.fulfill(problem(409, "chat_opening_locked"));
    const variant = openings[command.targetIndex];
    expect(variant).toBeDefined();
    messageZero = variant!.text;
    return route.fulfill(
      jsonOk({
        apiVersion: 1,
        openingVariant: {
          variantId: `greeting-${command.targetIndex + 1}`,
          index: command.targetIndex,
          count: openings.length,
          label: variant!.label,
          locked: false,
        },
      }),
    );
  });

  return {
    isCreated: () => created,
    mountedGeneration: () => generation,
  };
}

async function openChats(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Chats", exact: true }).click();
  await expect(page.getByTestId("chats-surface")).toBeVisible();
}

async function boot(page: Page): Promise<void> {
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "The game projection is read-only.",
  );
}

test("creates the Chat on the opening the player picked", async ({ page }) => {
  const host = await mountHost(page, {});
  await boot(page);
  await openChats(page);

  // The chooser names each opening with the vocabulary the opening bubble's own
  // switcher uses, and shows the first line of what it says.
  await page.getByTestId("new-chat").click();
  const picker = page.getByTestId("opening-picker");
  await expect(picker).toBeVisible();
  await expect(picker.getByTestId("opening-option")).toHaveCount(3);
  await expect(picker.getByTestId("opening-option-name")).toHaveText([
    "Default 1/3",
    "Rainy evening 2/3",
    "Late night 3/3",
  ]);
  await expect(picker.getByTestId("opening-option-line")).toHaveText([
    "Good morning, farmer. The valley is quiet today.",
    "Rain on the roof before you open your eyes.",
    "It is past midnight and the lamp is still lit. The house has gone quiet around you, and the kettle is cold on the stove.",
  ]);

  await picker.getByTestId("opening-option").nth(1).click();

  // The player lands in the Chat the control created, and its message zero is the
  // opening they picked - the whole of it, not just the line the chooser showed.
  const transcript = page.getByRole("region", { name: "Chat transcript" });
  await expect(transcript).toContainText("Rain on the roof before you open your eyes.");
  await expect(transcript).toContainText("The kettle is already on.");
  await expect(transcript).not.toContainText(DEFAULT_OPENING);
  expect(host.isCreated()).toBe(true);
});

test("offers no chooser when the companion has one opening", async ({ page }) => {
  await mountHost(page, { openings: [{ label: "Default", text: DEFAULT_OPENING }] });
  await boot(page);
  await openChats(page);

  // Nothing to choose: the control creates the Chat, and no dialog exists at any
  // point of the journey.
  await page.getByTestId("new-chat").click();
  await expect(page.getByTestId("opening-picker")).toHaveCount(0);
  const transcript = page.getByRole("region", { name: "Chat transcript" });
  await expect(transcript).toContainText(DEFAULT_OPENING);
  await expect(page.getByTestId("opening-picker")).toHaveCount(0);
});

test("says the Chat was created on the default opening when the choice is refused", async ({ page }) => {
  const host = await mountHost(page, { refuseOpening: true });
  await boot(page);
  await openChats(page);

  await page.getByTestId("new-chat").click();
  await page.getByTestId("opening-option").nth(2).click();

  // The Chat exists and the player is in it - a refused opening is not an
  // abandoned creation - and the conversation reads the opening it really has.
  const transcript = page.getByRole("region", { name: "Chat transcript" });
  await expect(transcript).toContainText(DEFAULT_OPENING);
  await expect(transcript).not.toContainText("It is past midnight");
  // The one fact that did not happen is named, and it names the Chat's real
  // state rather than reporting a failure of the creation.
  const notice = page.getByTestId("chat-surface").getByRole("status").filter({ hasText: "default opening" });
  await expect(notice).toHaveCount(1);
  await expect(notice).toContainText("The Chat was created");
  expect(host.mountedGeneration()).toBe(2);
});

test("closes on Escape and gives focus back to the control that opened it", async ({ page }) => {
  await mountHost(page, {});
  await boot(page);
  await openChats(page);

  // The control is reachable and operable from the keyboard.
  await page.getByTestId("new-chat").focus();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("opening-picker")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.getByTestId("opening-picker")).toHaveCount(0);
  await expect(page.getByTestId("new-chat")).toBeFocused();

  // Choosing from the keyboard starts the Chat on the focused option's opening.
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("opening-picker")).toBeVisible();
  const option = page.getByTestId("opening-option").nth(2);
  await option.focus();
  await expect(option).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText(
    "It is past midnight and the lamp is still lit.",
  );
});

/**
 * The chooser's own geometry, measured rather than described: how much of the
 * region it takes, and how many lines of each opening the player can read before
 * choosing. Both viewports of the frontend criteria.
 */
test("the chooser's geometry at 1440x900 and 400x800", async ({ page }) => {
  await mountHost(page, {});
  await boot(page);
  await openChats(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByTestId("new-chat").click();
    const picker = page.getByTestId("opening-picker");
    await expect(picker).toBeVisible();
    const box = await picker.boundingBox();
    expect(box).not.toBeNull();
    // The chooser stays inside the region it opens over.
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.height).toBeLessThanOrEqual(viewport.height);

    const lines: number[] = [];
    const boxes: { width: number; height: number }[] = [];
    for (let index = 0; index < 3; index += 1) {
      const option = page.getByTestId("opening-option").nth(index);
      const optionBox = await option.boundingBox();
      expect(optionBox).not.toBeNull();
      boxes.push({ width: Math.round(optionBox!.width), height: Math.round(optionBox!.height) });
      lines.push(
        await page
          .getByTestId("opening-option-line")
          .nth(index)
          .evaluate((element) => {
            const style = getComputedStyle(element);
            const lineHeight = Number.parseFloat(style.lineHeight);
            // The clamp clips the box, and `clientHeight` is what is left visible.
            return Math.round(element.clientHeight / lineHeight);
          }),
      );
      // "Enough of each opening to choose": at least the first line is readable.
      expect(lines[index]).toBeGreaterThanOrEqual(1);
      expect(lines[index]).toBeLessThanOrEqual(2);
    }
    console.log(
      `[picker] viewport ${viewport.width}x${viewport.height} panel ${Math.round(box!.width)}x${Math.round(box!.height)} ` +
        `options ${boxes.map((entry) => `${entry.width}x${entry.height}`).join(", ")} ` +
        `visible preview lines ${lines.join(", ")}`,
    );

    await page.keyboard.press("Escape");
    await expect(picker).toHaveCount(0);
  }
});

test("the player can read a whole opening before choosing it", async ({ page }) => {
  await mountHost(page, {});
  await boot(page);
  await openChats(page);

  await page.getByTestId("new-chat").click();
  const picker = page.getByTestId("opening-picker");
  await expect(picker).toBeVisible();

  // The card is one line of beat and two of speech: the reading a choice turns on, and not the
  // whole opening. The third one continues past what the card shows - "You are not alone in the
  // house." is below the clamp - so a player choosing that scene could not previously read it.
  const card = picker.getByTestId("opening-option").nth(2);
  await expect(card).not.toContainText("You are not alone in the house.");

  const reveal = picker.getByTestId("opening-option-expand").nth(2);
  await expect(reveal).toHaveAttribute("aria-expanded", "false");
  await reveal.click();

  const full = picker.getByTestId("opening-option-full");
  await expect(full).toHaveCount(1);
  await expect(full).toContainText("You are not alone in the house.");
  await expect(reveal).toHaveAttribute("aria-expanded", "true");
  // The reveal is a sibling of the card, so the card itself is untouched: the player can still
  // choose it with the same control, and picking it uses the whole opening.
  await expect(picker.getByTestId("opening-option")).toHaveCount(3);

  // One at a time: opening another collapses this one, so the list stays scannable.
  await picker.getByTestId("opening-option-expand").nth(0).click();
  await expect(picker.getByTestId("opening-option-full")).toHaveCount(1);
  await expect(picker.getByTestId("opening-option-expand").nth(2)).toHaveAttribute("aria-expanded", "false");

  // The expanded drawer still sits inside the region it opens over, at the narrow width too.
  // The reveal toggles, so the state is forced from the attribute rather than assumed: clicking
  // it again would collapse what this loop is about to measure.
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    const third = picker.getByTestId("opening-option-expand").nth(2);
    if ((await third.getAttribute("aria-expanded")) !== "true") await third.click();
    await expect(picker.getByTestId("opening-option-full")).toHaveCount(1);
    const box = await picker.boundingBox();
    expect(box).not.toBeNull();
    expect(Math.round(box!.width)).toBeLessThanOrEqual(viewport.width);
    expect(Math.round(box!.height)).toBeLessThanOrEqual(viewport.height);
    const fullBox = await picker.getByTestId("opening-option-full").boundingBox();
    expect(fullBox).not.toBeNull();
    expect(Math.round(fullBox!.width)).toBeLessThanOrEqual(viewport.width);
  }

  // And choosing it still creates the Chat on that opening.
  const picked = picker.getByTestId("opening-option").nth(2);
  await picked.click();
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("You are not alone in the house.");
});
