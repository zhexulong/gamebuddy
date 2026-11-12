/**
 * What the composed bootstrap document is allowed to say.
 *
 * One redemption, the nested Chat and the redacted Game read out of it, the disclosure that
 * publishes the Host's own projection rather than a local guess, and the refusals that must
 * not turn into invented state. The Stardew handoff's two rereads sit here because the
 * handoff itself is a field of that same document.
 */
import { expect, test } from "./frontend-coverage";
import {
  token,
  characterHandle,
  csrfToken,
  expiresAtMs,
  cabinChoiceHandle,
  draft,
  chat,
  game,
  root,
  openGameDrawer,
} from "./composed-reference-game-fixtures";

test("composed profile redeems once, renders nested Chat and redacted Game, then reloads from composed state", async ({ page }) => {
  let bootstrapRequests = 0;
  let composedStateRequests = 0;
  let tavernBootstrapRequests = 0;
  let tavernStateRequests = 0;
  let draftRequests = 0;
  let cabinReadRequests = 0;
  let cabinConfirmRequests = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", async (route) => {
    bootstrapRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().postDataJSON()).toEqual({ apiVersion: 1, bootstrapToken: token });
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    composedStateRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", async (route) => {
    cabinReadRequests += 1;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        choices: [{ displayLabel: "North cabin", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", async (route) => {
    cabinConfirmRequests += 1;
    expect(route.request().method()).toBe("POST");
    expect(route.request().headers()["x-csrf-token"]).toBe(csrfToken);
    const body = route.request().postDataJSON();
    expect(body).toEqual({
      apiVersion: 1,
      idempotencyKey: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
      choiceHandle: cabinChoiceHandle,
      confirmed: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, status: "manifest_admitted" }) });
  });
  await page.route("**/api/tavern/v1/bootstrap", async (route) => {
    tavernBootstrapRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/state", async (route) => {
    tavernStateRequests += 1;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "must_not_be_called" }) });
  });
  await page.route("**/api/tavern/v1/draft", async (route) => {
    draftRequests += 1;
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  await expect(page.getByText("The game projection is read-only.")).toBeVisible();
  // The durable draft is not a resident block between the transcript and the
  // input: it prefills the composer's own field, and its verbs live in the
  // composer band (Composer.tsx).
  await expect(page.getByTestId("chat-surface").locator(".composer-textarea")).toHaveValue(draft.text);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("ConnectionNo game connection");
  await expect(panel).toContainText("CompatibilityNot checked yet");
  await expect(panel.getByText("North cabin")).toBeVisible();
  const confirmButton = panel.getByRole("button", { name: "Confirm cabin" });
  await confirmButton.dblclick();
  await expect(confirmButton).toBeDisabled();
  await expect(panel.getByText("Cabin request admitted. Waiting for the next game setup step.")).toBeVisible();
  expect(cabinConfirmRequests).toBe(1);
  await expect(panel).not.toContainText(cabinChoiceHandle);
  await expect(panel).not.toContainText("cabinId");
  // The concern here is that the panel leaks wire vocabulary or an internal identity, not that it may never use an
  // ordinary English word: the guide's own hint says "Gets the companion ready to play in this session", which the
  // earlier `/ready|connected/i` also matched - a false positive that pinning the surface's copy made inevitable.
  // The identifiers are what must never appear.
  await expect(panel).not.toContainText(/\bready[a-z]*Id\b|\bconnected[A-Z]\w*/u);
  await expect(panel).not.toContainText(/cabin_choice_|attestation_|handoff_/u);
  // The one-time boot token is gone and the profile marker is kept; the drawer
  // this journey opened is the URL's `panel` fact, which survives the reload
  // below and is what restores it (design/26 §7.2).
  await expect(page).toHaveURL(/#profile=composed-reference-game&panel=game$/);
  expect(bootstrapRequests).toBe(1);
  expect(tavernBootstrapRequests).toBe(0);
  expect(tavernStateRequests).toBe(0);

  await page.reload();
  // A reload restores the selected surface, so the conversation is not on screen yet.
  await expect(page.getByTestId("game-surface")).toBeVisible();
  // Two: the Game arrival read on the way in, and the restored surface's own arrival after the
  // reload. What must not move is the redemption, asserted on the line below.
  await expect.poll(() => composedStateRequests).toBe(2);
  // Back from it shows the same conversation the journey left; no second bootstrap
  // was redeemed to get there.
  await page.goBack();
  await expect(page.getByRole("heading", { name: "Reference Game Chat" })).toBeVisible();
  expect(bootstrapRequests).toBe(1);
  expect(tavernBootstrapRequests).toBe(0);
  expect(tavernStateRequests).toBe(0);
  // The draft is in the same read as its revision, so the shell never spends
  // `/api/tavern/v1/draft` on this journey: the body it shows at line 181 arrived in
  // the composed snapshot. A second route here would be the pair read that can
  // disagree with itself while a turn lands.
  expect(draftRequests).toBe(0);
  expect(cabinReadRequests).toBe(2);
});


/**
 * The Game surface's read-only data disclosure.
 *
 * Reachability first: the composed shell mounts exactly one game read
 * (`game.state.read`, declared by `host/src/game-browser-contract/index.ts`), so
 * the only Host game data a browser can actually obtain is that projection. The
 * disclosure renders exactly that, collapsed, and nothing else.
 *
 * The failures this catches: a disclosure that starts open (a debug box pushing
 * the panel's own facts down the surface), a body that is placeholder text
 * rather than the Host's own response (the assertions read fixture values this
 * test chose), and a dump that leaks a session secret (the CSRF token never
 * crosses into it).
 */
test("the Game data disclosure is closed by default and reveals the Host's own published projection", async ({ page }) => {
  const published = {
    ...game,
    game: {
      ...game.game,
      instance: { status: "running", gameTitle: "Stardew Valley", generation: 7 },
      connectionStatus: "active",
      actionAuthority: "active",
      capabilitySummary: { available: true, count: 42 },
    },
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: published }) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ apiVersion: 1, choices: [] }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);

  const disclosure = page.getByTestId("game-diagnostics-disclosure");
  await expect(disclosure).toBeVisible();
  // Closed by default: the dump is not part of the panel's reading order until
  // the player asks for it.
  expect(await disclosure.evaluate((node) => (node as HTMLDetailsElement).open)).toBe(false);
  // Closed, the dump's own DOM is not mounted at all: a collapsed disclosure that
  // keeps a few hundred lines of JSON in the document is still a node the layout
  // walks and an assistive technology can reach.
  expect(await disclosure.evaluate((node) => node.querySelector("pre") === null)).toBe(true);

  await disclosure.locator("summary").click();
  const dump = page.getByTestId("game-diagnostics-json");
  await expect(dump).toBeVisible();
  const text = (await dump.textContent()) ?? "";
  // The values are the Host's own, taken from this response: a hardcoded or
  // placeholder dump cannot carry the fixture values this test chose.
  expect(text).toContain('"generation": 7');
  expect(text).toContain('"count": 42');
  expect(text).toContain("Stardew Valley");
  // Only the nested game projection crosses, so no session secret is renderable.
  expect(text).not.toContain(csrfToken);
  // The disclosure is the region's sibling, so the region still reads as
  // localized player outcomes and never as the Host's raw enum spellings.
  const panelText = await page.getByTestId("game-state-panel").innerText();
  expect(panelText).not.toContain("connected_idle");
  // Closing it again takes the dump back out of the document, so the mount follows
  // the open state and is not a one-way flag.
  await disclosure.locator("summary").click();
  await expect(page.getByTestId("game-diagnostics-json")).toHaveCount(0);
});


test("composed profile renders game null honestly without exposing mutation controls", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, game: null }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await expect(panel).toContainText("Game state is unavailable for this profile.");
  await expect(panel.locator("button, input, textarea, select, form")).toHaveCount(0);
  // Nothing is published, so the read-only disclosure says so instead of
  // rendering an empty box.
  await expect(page.getByTestId("game-diagnostics-disclosure")).toContainText(
    "No game data is published for this profile",
  );
});


test("composed profile fails closed on a malformed root", async ({ page }) => {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ ...root, leakedAuthority: { path: "C:\\secret", token: "secret" } }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);

  await expect(page.getByRole("alert")).toContainText("Unable to read chat");
  // The root was malformed, so this is an internal error and the presentation says
  // so, naming the code the client actually got. It must not claim a reconciliation
  // conflict: that wording sent the reader after a consistency fault that was not
  // the fault.
  await expect(page.getByRole("alert")).toContainText(
    "GameBuddy reported an internal error (code invalid_composed_root).",
  );
  await expect(page.getByText("The chat state could not be safely reconciled.")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Game state" })).toHaveCount(0);
});


test("a management refusal keeps its own problem code instead of none reported", async ({ page }) => {
  // The opening choice is a *management* mutation (`PUT /api/tavern/v1/chat/opening`
  // through `management-pipeline-api`), and the shell hands what it caught straight to
  // `composedProblemView`. The management client used to declare its own
  // `TavernProblemError`, so that check was false for everything this path threw and the
  // shell's only diagnostic - which of the opening's closed refusals happened - was
  // replaced by "none reported".
  const opening = {
    ...chat,
    chat: {
      ...chat.chat,
      transcript: [
        {
          handle: characterHandle,
          role: "companion",
          text: "Good morning.",
          locale: "und",
          order: 0,
          revision: 1,
          openingVariant: { variantId: "greeting-1", index: 0, count: 2, label: null, locked: false },
        },
      ],
    },
  };

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ...root, chat: opening }) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/tavern/v1/chat/opening", (route) =>
    route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Opening already sealed",
        status: 409,
        code: "chat_opening_locked",
        requestId: characterHandle,
        retryable: false,
      }),
    }),
  );
  // A refusal is resolved by the authoritative reread, so it becomes the player's
  // problem only when that reread cannot run either - the state this journey puts the
  // mount in, and the state in which the message is the only thing the player has.
  await page.route("**/api/composed-reference-game/v1/state", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "State unavailable",
        status: 503,
        code: "state_unavailable",
        requestId: characterHandle,
        retryable: true,
      }),
    }),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await page.getByRole("button", { name: "Next variant" }).click();

  await expect(page.getByRole("alert")).toContainText(
    "This conversation has already started, so the greeting it opened on can no longer change.",
  );
  await expect(page.getByRole("alert")).not.toContainText("none reported");
  // The refusal is a fact about this conversation, never a system fault. This assertion was the
  // internal-error sentence naming `chat_opening_locked` until every member of the contract's union
  // got its own words (`problem-code.8`); the force is kept and inverted - the code is not printed,
  // and the reading is not "internal error".
  await expect(page.getByRole("alert")).not.toContainText("internal error");
});



test("uncertain Stardew handoff waits for manual recovery without refetch or retry", async ({ page }) => {
  let cabinReadRequests = 0;
  let cabinConfirmRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReadRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        choices: [{ displayLabel: "North cabin", availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_manifest_handoff_uncertain" }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect(panel.getByText(/still awaiting verification/i)).toBeVisible();
  await page.waitForTimeout(200);
  expect(cabinReadRequests).toBe(1);
  expect(cabinConfirmRequests).toBe(1);
  await expect(panel.getByRole("button", { name: "Confirm cabin" })).toHaveCount(0);
});


test("stale Stardew handoff alone refetches choices and preserves one confirmation", async ({ page }) => {
  let cabinReadRequests = 0;
  let cabinConfirmRequests = 0;
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(root) }),
  );
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(draft) }),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) => {
    cabinReadRequests += 1;
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        apiVersion: 1,
        choices: [{ displayLabel: `North cabin ${cabinReadRequests}`, availability: "available", choiceHandle: cabinChoiceHandle, expiresAtMs }],
      }),
    });
  });
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins/confirm", (route) => {
    cabinConfirmRequests += 1;
    return route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({ code: "stardew_cabin_choice_stale" }),
    });
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openGameDrawer(page);
  const panel = page.getByRole("region", { name: "Game state" });
  await panel.getByRole("button", { name: "Confirm cabin" }).click();
  await expect(panel.getByText("North cabin 2")).toBeVisible();
  expect(cabinReadRequests).toBe(2);
  expect(cabinConfirmRequests).toBe(1);
});


