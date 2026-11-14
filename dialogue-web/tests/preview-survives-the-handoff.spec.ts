import { expect, test } from "./frontend-coverage";
import { chat, jsonOk, root as composedRoot, token } from "./composed-reference-game-fixtures";
import { emitStreamEvent, installSyntheticEventStream, streamUrls } from "./synthetic-event-stream";

/**
 * The reply bubble does not blink when the stream hands over to the transcript.
 *
 * The measured defect: `handleEvent` cleared the streaming preview the moment `message.committed`
 * arrived, and the transcript row that replaces it only lands with the authoritative read further
 * down the same handler (`void reconcile()`). Between the frame and that read the conversation had
 * no reply row at all - the text the player was watching vanished and then popped back a fifth of a
 * second later (`Timeline`'s own note on the commit says so: "the wire clears the preview on
 * `message.committed` and the transcript arrives on the read that follows"). A handoff is not a
 * disappearance: the preview may only be spent once the message it was previewing is committed.
 *
 * What this journey holds, sampling every animation frame from before the frame arrives until the
 * committed row is on screen:
 *  - at every sampled frame the reply text exists in exactly one row - the preview or the
 *    transcript's own row, never neither;
 *  - the handoff really happened (a sample with the preview, a later one with the committed row);
 *  - the row that remains is the transcript's row, so the preview is not what was left behind.
 */

const streamEpoch = `${"E".repeat(42)}A`;
const streamCursor = `${"F".repeat(42)}A`;
const turnHandle = `${"T".repeat(42)}A`;
const replyHandle = `${"R".repeat(42)}A`;
const frameId = `${"H".repeat(42)}A`;
const replyText = "The kettle is on, and the porch is quiet.";

function frame(sequence: number, eventType: string, payload: unknown) {
  return { apiVersion: 1, epoch: streamEpoch, sequence, selectionGeneration: 1, eventType, payload };
}

type Sample = Readonly<{ t: number; preview: boolean; committed: boolean }>;

test("the reply bubble survives the stream-to-transcript handoff without a gap", async ({ page }) => {
  test.setTimeout(90_000);
  await installSyntheticEventStream(page);
  // The read the commit triggers is slower than the frame, which is the window the blink lived in.
  const stateReadDelayMs = 600;
  let replyCommitted = false;
  let stateReads = 0;
  const projection = () => ({
    ...composedRoot,
    chat: {
      ...chat,
      eventStream: { epoch: streamEpoch, cursor: streamCursor },
      chat: {
        ...chat.chat,
        transcript: replyCommitted
          ? [
              ...chat.chat.transcript,
              { handle: replyHandle, role: "companion", text: replyText, locale: "und", order: 1, revision: 2 },
            ]
          : chat.chat.transcript,
      },
    },
  });

  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(projection())));
  await page.route("**/api/composed-reference-game/v1/state", async (route) => {
    stateReads += 1;
    // Captured before the delay, so the answer describes durable state at the moment the read was
    // dispatched - the read is slower than the frame, which is the window the blink lived in.
    const body = projection();
    await new Promise((resolve) => setTimeout(resolve, stateReadDelayMs));
    return route.fulfill(jsonOk(body));
  });
  await page.route("**/api/tavern/v1/draft", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, revision: 4, text: "A durable delegated draft." })),
  );
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
  await expect.poll(() => streamUrls(page)).toHaveLength(1);

  // The reply streams: one delta is enough for the row to exist, and the row it creates is the
  // preview's own (`<turnHandle>_preview`, the disjoint key `Timeline` gives it).
  await emitStreamEvent(
    page,
    0,
    frame(1, "companion.delta", { turnHandle, delta: replyText }),
    frameId,
  );
  const previewRow = page.locator(`li[data-handle="${turnHandle}_preview"]`);
  await expect(previewRow).toBeVisible();
  await expect(previewRow).toContainText(replyText);

  // Sample the two rows every frame while the commit is delivered and confirmed.
  await page.evaluate(
    (input: { preview: string; committed: string }) => {
      const state = window as unknown as { __samples: Sample[]; __stopSampling: boolean };
      state.__samples = [];
      state.__stopSampling = false;
      const tick = (): void => {
        if (state.__stopSampling) return;
        state.__samples.push({
          t: Math.round(performance.now()),
          preview: document.querySelector(`li[data-handle="${input.preview}"]`) !== null,
          committed: document.querySelector(`li[data-handle="${input.committed}"]`) !== null,
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    { preview: `${turnHandle}_preview`, committed: replyHandle },
  );

  replyCommitted = true;
  await emitStreamEvent(
    page,
    0,
    frame(2, "message.committed", { handle: replyHandle, role: "companion", text: replyText, locale: "und", order: 1, revision: 2 }),
    // A cursor is an opaque handle too: 43 characters whose last base64url character carries no
    // spare bits ("E" is one of `AEIMQUYcgkosw048`), or the client refuses the frame as a protocol
    // fault and the journey would be measuring a recovery instead of the handoff.
    `${"H".repeat(42)}E`,
  );

  const committedRow = page.locator(`li[data-handle="${replyHandle}"]`);
  await expect(committedRow).toBeVisible();
  await expect.poll(() => stateReads, { message: "the commit was confirmed by the authoritative read" }).toBeGreaterThan(0);

  const samples = await page.evaluate(() => {
    const state = window as unknown as { __samples: Sample[]; __stopSampling: boolean };
    state.__stopSampling = true;
    return state.__samples;
  });
  console.log(`[preview-handoff] samples=${samples.length} stateReads=${stateReads}`);
  console.log(`[preview-handoff/edges] ${JSON.stringify(samples.filter((sample, index) => index === 0 || sample.preview !== samples[index - 1]!.preview || sample.committed !== samples[index - 1]!.committed))}`);

  // The measurement: not one sampled frame had neither row.
  const gaps = samples.map((sample, index) => ({ ...sample, index })).filter((sample) => !sample.preview && !sample.committed);
  expect(
    gaps.length,
    `the reply was absent for ${gaps.length} of ${samples.length} frames (first at index ${gaps[0]?.index ?? "n/a"})`,
  ).toBe(0);
  // ...and the handoff is what happened rather than a preview that simply stayed.
  expect(samples.some((sample) => sample.preview), "the preview was on screen at the start of the handoff").toBe(true);
  expect(samples.some((sample) => sample.committed), "the committed row landed inside the sampled window").toBe(true);

  // The row that remains is the transcript's own: the preview is spent once its message is committed.
  await expect(committedRow).toContainText(replyText);
  await expect(previewRow).toHaveCount(0);
});
