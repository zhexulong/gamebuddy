import { expect, test } from "./frontend-coverage";

/**
 * A rewind truncates the transcript, and the composer must not offer to add to it while it does.
 *
 * The shell keeps two facts about "something is happening to this conversation" and they were
 * disjoint: every message mutation takes a single-flight latch (`chatMutationRef`, shown as the
 * row's own busy projection), and the send gate reads only the Host's `chat.submit` availability
 * and the pending submission record. During a rewind neither of those is set - the store is not
 * busy yet, because the truncation is exactly what is in flight - so the field was writable and
 * Send was offered into a transcript that was being cut, and the send's own reread and the
 * rewind's then raced for the same rows.
 *
 * The two facts are one: a surface that is rewriting the conversation is not a surface to submit
 * into. The gate reads the same latch the mutations take. What it refuses is the SEND - the field
 * keeps taking the next line while the cut lands, because the rewrite is of the transcript and not
 * of the box the player writes in.
 */

const token = "A".repeat(43);
const csrfToken = `${"C".repeat(42)}A`;
const chatHandle = `${"B".repeat(42)}A`;
const expiresAtMs = 1_900_000_000_000;

const messageHandle = (prefix: string): string => `${prefix}${"A".repeat(43 - prefix.length)}`;

const companionHandle = messageHandle("D");
const greetingsHandle = messageHandle("G");
const playerHandle = messageHandle("P");
const replyHandle = messageHandle("R");

/** The opening, the player's own line, and the reply the rewind is about to cut. */
const transcript = [
  { handle: greetingsHandle, role: "companion", text: "An opening greet.", locale: "und", order: 0, revision: 1 },
  { handle: playerHandle, role: "player", text: "Where are we?", locale: "und", order: 1, revision: 1 },
  { handle: replyHandle, role: "companion", text: "On the pier.", locale: "und", order: 2, revision: 1 },
];

const chat = {
  apiVersion: 1,
  build: { browserContract: "tavern_browser_api/v1", profileId: "gamebuddy.chat-core.reference-pipeline" },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [
    { operationId: "chat.submit", labelKey: "tavern.operation.submit", availability: "available", routeId: "chat.submit" },
  ],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle, generation: 1, stateRevision: chatHandle },
  chat: {
    companion: { name: "Mira", handle: companionHandle },
    title: "A rewind in flight",
    transcript,
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

test("a send is not offered into a transcript a rewind is truncating", async ({ page }) => {
  test.setTimeout(120_000);
  const submits: string[] = [];
  let rewound = false;
  let releaseRewind: (() => void) | null = null;
  const rewind = { inFlight: false };

  const projection = () =>
    rewound
      ? { ...root, chat: { ...chat, chat: { ...chat.chat, transcript: transcript.slice(0, 2) } } }
      : root;

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/messages/rewind", async (route) => {
    rewind.inFlight = true;
    // Held while the truncation is being written, which is the window the composer must not offer.
    await new Promise<void>((resolve) => {
      releaseRewind = resolve;
    });
    rewound = true;
    await route.fulfill(jsonOk({ apiVersion: 1, lastMessage: transcript[1] }));
  });
  await page.route("**/api/tavern/v1/messages", async (route) => {
    submits.push(route.request().headers()["idempotency-key"] ?? "(none)");
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        disposition: "accepted",
        message: { handle: messageHandle("S"), role: "player", text: "Into the cut.", locale: "und", order: 3, revision: 1 },
        turn: { handle: messageHandle("T"), state: "running", projectionRevision: 1, canCancel: true },
      }),
    );
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  const surface = page.getByTestId("chat-surface");
  await expect(surface).toBeVisible();
  const composer = surface.locator(".composer-textarea");
  const send = surface.getByTestId("composer-send");
  await expect(composer).toBeEnabled();

  // The player rewinds to their own line: everything after it is about to be destroyed. The entry lives
  // in the row's overflow now (owner decision 2026-11-16: the strip keeps copy, the pager and Regenerate,
  // and the three that change the conversation sit behind one `…`), so the press that reaches it is the
  // trigger's - a real button with `aria-expanded`, not a hover-only affordance.
  const more = page.locator(`li[data-handle='${playerHandle}']`).getByTestId("message-more");
  await expect(more, "the row's overflow is a real control").toHaveAttribute("aria-expanded", "false");
  await more.click();
  await expect(more, "and it says out loud that pressing it opened one").toHaveAttribute("aria-expanded", "true");
  await page.locator(`li[data-handle='${playerHandle}']`).locator('[data-testid="message-rewind"]').click();
  await page.locator('[data-testid="message-rewind-confirm-yes"]').click();
  await expect.poll(() => rewind.inFlight).toBe(true);

  const measured = await page.evaluate(() => ({
    fieldDisabled: document.querySelector<HTMLTextAreaElement>("textarea.composer-textarea")?.disabled ?? null,
    send: document.querySelectorAll('[data-testid="composer-send"]').length,
    sendDisabled:
      document.querySelector<HTMLButtonElement>('[data-testid="composer-send"]')?.disabled ?? null,
    rowBusy: document.querySelectorAll("li[data-pending]").length,
  }));
  // If the composer is still offered, taking the offer is the defect: the send request is measured
  // rather than assumed. The field is the player's even mid-rewind, so the offer is taken.
  await composer.fill("Into the cut.");
  if ((await send.count()) > 0 && (await send.isEnabled())) await send.click();
  console.log(`MEASURE rewind in flight: ${JSON.stringify(measured)} submits=${JSON.stringify(submits)}`);

  // THE DEFECT: the gate and the mutation latch were disjoint, so a press was admitted into a
  // transcript the rewind was truncating. The control is still drawn - the idle band always offers
  // Send - and what must hold is that it refuses the press and that nothing left the surface. The
  // field itself stays enabled: taking it away would be a second, unrelated refusal.
  await expect(composer).toBeEnabled();
  await expect(send).toBeDisabled();
  expect(submits).toHaveLength(0);

  // The rewind itself lands, and the composer comes back to a conversation that is now settled.
  if (releaseRewind !== null) (releaseRewind as () => void)();
  await expect(surface.locator(`li[data-handle='${replyHandle}']`)).toHaveCount(0);
  await expect(composer).toBeEnabled();
  // The gate is open again: the words go in, and the control behind them would send them.
  await composer.fill("The pier is empty.");
  await expect(send).toBeEnabled();
  expect(submits).toHaveLength(0);
});
