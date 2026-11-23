import { expect, test } from "./frontend-coverage";

/**
 * A press the Host never answers is still a press this shell must answer for.
 *
 * The measured shape (`turn-settling.spec.ts`'s "a turn that never settles" leaves the fallback poll's
 * budget to be measured; this journey measures the *start* of it): the submit is published as a pending
 * record before the wire call, then the request never comes back. The record is the only thing that
 * starts the fallback poll (`beginTurnMutation`), so a submitting mutation whose answer never arrives
 * used to leave the record set and the poll never started: the optimistic line stayed in a sending
 * state, the action slot stayed a spinner, the field stayed locked, and there was no Send, no Stop and
 * no sentence - for as long as the tab lived. `chat.submission_status` is the route that can say what
 * happened to that submission, and the shell never asked it.
 *
 * The fixture hangs the submit route and answers the status route as `unknown` (the Host has no
 * settlement for that key yet), so only the poll can speak. The clock is virtualized: the subject is
 * the shape at three points in a submission's life, not 130 real seconds.
 */

const token = "A".repeat(43);
const chatHandle = `${"B".repeat(42)}A`;
const csrfToken = `${"C".repeat(42)}A`;
const companionHandle = `${"D".repeat(42)}A`;

const playerText = "The lantern is lit. Tell me what you see from the porch.";

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
    title: "An unanswered press",
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

type Reading = Readonly<{
  fieldDisabled: boolean | null;
  fieldValue: string | null;
  busy: number;
  send: number;
  stop: number;
  notice: string | null;
  optimistic: number;
}>;

test("a send the Host never answers is settled by the submission's own status", async ({ page }) => {
  test.setTimeout(120_000);
  let submits = 0;
  let statusReads = 0;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // The poll's own read is the Chat half's route (`readChatSnapshotPair`), never the aggregate.
  await page.route("**/api/tavern/v1/state", (route) => route.fulfill(jsonOk(root.chat)));
  // The press leaves the browser and nothing comes back: the request stays open for the whole journey.
  await page.route("**/api/tavern/v1/messages", async (route) => {
    submits += 1;
    await new Promise(() => {});
  });
  // The Host has no settlement for that key: neither accepted nor refused, as far as it can say.
  await page.route("**/api/tavern/v1/message-submission-status", (route) => {
    statusReads += 1;
    return route.fulfill(jsonOk({ apiVersion: 1, disposition: "unknown" }));
  });

  await page.clock.install();
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  await expect(composer).toBeEnabled();

  await composer.fill(playerText);
  await surface.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => submits).toBe(1);

  const reading = async (checkedAtS: number): Promise<Reading> => {
    const measured = await page.evaluate<Reading>(() => {
      const field = document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea");
      return {
        fieldDisabled: field?.disabled ?? null,
        fieldValue: field?.value ?? null,
        busy: document.querySelectorAll("[data-composer-busy]").length,
        send: document.querySelectorAll('[data-testid="composer-send"]').length,
        stop: document.querySelectorAll(".composer-section .stop-button").length,
        notice: document.querySelector(".reference-turn-notice")?.textContent ?? null,
        optimistic: document.querySelectorAll('[data-testid="optimistic-player-message"]').length,
      };
    });
    console.log(
      `MEASURE unanswered send at ${checkedAtS}s: ${JSON.stringify(measured)} ` +
        `submits=${submits} statusReads=${statusReads}`,
    );
    return measured;
  };

  /** Step the virtual clock one poll interval at a time, yielding so each mocked round trip lands. */
  const advance = async (milliseconds: number): Promise<void> => {
    for (let elapsed = 0; elapsed < milliseconds; elapsed += 1_000) {
      await page.clock.runFor(1_000);
      await page.waitForTimeout(10);
    }
  };

  // Three points in the same submission's life, read before anything is asserted: the shape is the
  // finding, so the readings stand on their own in the log even when an assertion turns red.

  // 1 s: the press is out and its answer is not back.
  await advance(1_000);
  const atOneSecond = await reading(1);
  // 10 s: still open.
  await advance(9_000);
  const atTenSeconds = await reading(10);
  // Past every budget the client is allowed: the wait is held open by the spinner the submission
  // draws, because the field never leaves the player - it is the same box the words go back into.
  for (let step = 0; step < 400 && (await page.locator("[data-composer-busy]").count()) > 0; step += 1)
    await advance(1_000);
  const afterTheBudget = await reading(200);

  // The record the press published starts the one reader that can say what happened to it.
  expect(statusReads, "the shell asks the Host what happened to the submission it published").toBeGreaterThan(0);
  expect(atOneSecond, "and the attempt is still held while the answer is open").toMatchObject({
    fieldDisabled: false,
    busy: 1,
    send: 0,
    stop: 0,
    optimistic: 1,
  });

  // Still held at 10 s: ten seconds of silence is not a settlement, and it is not a reason to take the
  // field away from the player either - the wait is the spinner's fact, not the box's.
  expect(atTenSeconds, "ten seconds of silence is not a settlement").toMatchObject({
    fieldDisabled: false,
    busy: 1,
    send: 0,
    stop: 0,
    optimistic: 1,
  });

  // Past the budget: the record is spent, the paragraph comes back, and the surface says the one
  // thing it knows - that it could not find out.
  expect(afterTheBudget.fieldDisabled, "the field was never the thing that waited").toBe(false);
  expect(afterTheBudget.send, "and the player has a control again").toBe(1);
  expect(afterTheBudget.busy, "the spinner is the wait, so it leaves with it").toBe(0);
  expect(afterTheBudget.optimistic, "the unconfirmed line stops claiming to be sending").toBe(0);
  expect(afterTheBudget.fieldValue, "the words are the player's, whatever the Host did with them").toBe(playerText);
  // The distinction that must not collapse: not "the reply failed" (nothing says it did) and not
  // success. It says the outcome is unknown, and what to do next.
  expect(afterTheBudget.notice, "an unconfirmed send is stated as unconfirmed").toContain("could not confirm");
  expect(statusReads, "the budget is bounded, and it outlasts the Host's own admission ceiling").toBeGreaterThanOrEqual(
    121,
  );
});
