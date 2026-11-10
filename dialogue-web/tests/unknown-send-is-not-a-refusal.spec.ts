import { expect, test } from "./frontend-coverage";

/**
 * A send the Host never answered is not a send the Host refused.
 *
 * The two failures are one screen today and they mean opposite things. A problem document off the
 * wire is the Host stating that nothing ran, so the player may write and send again. A dropped
 * connection, a timeout, a body the client could not read - none of those is a statement, and the
 * submission they were about may be the turn the Host is running right now. `handleSend`'s failure
 * branch treated every one of them as the first kind: it put the words back, said the attempt
 * failed, and cleared the pending record. Clearing the record is not bookkeeping - it is the fact
 * that a submission may be held (`use-composed-bootstrap`'s poll dies on its first tick without it,
 * and the composer's own gate reopens) - so the surface invited a resend of a message that had
 * already been submitted, which is a second player row and a second provider turn for one press.
 *
 * This journey makes the Host accept the first submit and then lose the answer. The surface must
 * keep the attempt open until the Host's own receipt settles it, and must not offer a second one.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;
const playerHandle = `${"P".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;

const playerText = "The lamps are lit. Tell me what you see from the mill window.";

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs: 1_900_000_000_000 },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "An unanswered send",
    transcript: [
      { handle: companionHandle, role: "companion", text: "The kettle is on.", locale: "und", order: 0, revision: 1 },
    ],
    draft: { revision: 0, present: false },
    turn: null,
    worldInfo: { state: "none", revision: chatHandle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

const root = {
  apiVersion: 1,
  build: { browserContract: "composed_reference_game_browser_api/v1", profileId: "gamebuddy.composed.reference-game" },
  chat,
  game: null,
};

const jsonOk = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

test("a send whose answer never arrived is held open, not handed back as a refusal", async ({ page }) => {
  test.setTimeout(120_000);
  /** The Host accepted the submission; only the answer to the browser was lost. */
  let accepted = false;
  /** The Host then finishes the turn the accepted submission started. */
  let settled = false;
  const submits: string[] = [];

  const projection = () => ({
    ...root,
    chat: {
      ...chat,
      // The Host holds the submission, so it would not take another: `chat.submit` is what says so.
      operations: accepted
        ? [
            {
              operationId: "chat.submit",
              labelKey: "tavern.operation.submit",
              availability: settled ? "available" : "busy",
              routeId: "chat.submit",
            },
          ]
        : chat.operations,
      chat: {
        ...chat.chat,
        transcript: accepted
          ? [
              ...chat.chat.transcript,
              { handle: playerHandle, role: "player", text: playerText, locale: "und", order: 1, revision: 1 },
            ]
          : chat.chat.transcript,
        turn: accepted
          ? { handle: turnHandle, state: settled ? "completed" : "running", projectionRevision: 1, canCancel: !settled }
          : null,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/messages", async (route) => {
    const key = route.request().headers()["idempotency-key"] ?? "(none)";
    submits.push(key);
    if (submits.length === 1) {
      // The store commits the submission and the turn, and the client never hears about it.
      accepted = true;
      await route.abort("connectionfailed");
      return;
    }
    // A resend while the accepted turn runs: the truthful answer, and the duplicate this journey
    // exists to prevent.
    await route.fulfill({
      status: 409,
      contentType: "application/json",
      body: JSON.stringify({
        type: "about:blank",
        title: "Turn busy",
        status: 409,
        code: "turn_busy",
        requestId: chatHandle,
        retryable: true,
      }),
    });
  });
  await page.route("**/api/tavern/v1/message-submission-status", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, disposition: "accepted" })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  await composer.fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submits.length).toBe(1);

  // The surface has to answer for the attempt it published before it lost the answer.
  await expect(surface.locator(".reference-turn-notice")).toBeVisible();
  const busy = surface.locator("[data-composer-busy]");
  const send = surface.getByTestId("composer-send");
  const measured = await page.evaluate(() => ({
    busy: document.querySelectorAll("[data-composer-busy]").length,
    send: document.querySelectorAll('[data-testid="composer-send"]').length,
    fieldDisabled: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled ?? null,
    fieldValue: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.value ?? null,
    optimistic: document.querySelectorAll('[data-testid="optimistic-player-message"]').length,
    notice: document.querySelector(".reference-turn-notice")?.textContent ?? null,
  }));
  // If the surface still offers a send, the offer is the defect: pressing it is the duplicate.
  if ((await send.count()) > 0) await send.click();
  console.log(`MEASURE unanswered send: ${JSON.stringify(measured)} submits=${JSON.stringify(submits)}`);

  // THE DEFECT: the record was spent and the band handed back exactly as a refusal hands it back, so
  // the player was invited to send a message the Host had already accepted.
  await expect(busy).toHaveCount(1);
  await expect(send).toHaveCount(0);
  await expect(composer).toBeDisabled();
  // The words are still the player's - the failure cost the attempt, never the paragraph.
  await expect(composer).toHaveValue(playerText);
  // …and the line the accepted submission is about is still on screen while its fate is open.
  await expect(surface.getByTestId("optimistic-player-message")).toHaveCount(1);
  // One press, one submission: nothing offered a second provider turn.
  expect(submits).toHaveLength(1);

  // The Host's own receipt settles it: the turn is terminal, so the record is spent and the composer
  // returns - with the player's line in the conversation exactly once.
  settled = true;
  await expect(busy).toHaveCount(0);
  await expect(send).toHaveCount(1);
  await expect(composer).toBeEnabled();
  await expect(surface.locator(".message-list > li", { hasText: playerText })).toHaveCount(1);
  console.log(`MEASURE settled: submits=${JSON.stringify(submits)}`);
  expect(submits).toHaveLength(1);
});
