import { expect, test, type Page } from "./frontend-coverage";

/**
 * A reply that takes twenty seconds to write says something - once.
 *
 * Measured defect: the streaming preview carried `data-streaming` and nothing a screen reader could
 * act on. The obvious repair is worse than the silence - a live region over the preview's text reads
 * the same paragraph again on every token, twenty to fifty times a second - so the policy this file
 * pins is:
 *
 *  1. `the streaming row is busy, not live` - `aria-busy="true"` while it streams, and NO live region
 *     in its own subtree. The row is being updated; the reader is not fed the paragraph.
 *  2. `the stream itself says nothing` - thirty deltas, and the conversation's one announced channel
 *     mutates at most once (in fact not at all: it is emptied when the next reply starts).
 *  3. `the commit is said, and says completion` - once, after the reply lands, in the catalogue's own
 *     words. The moment a reply STARTS is the app bar's `role="status"` ("Thinking…", held from the
 *     turn's admission until it is terminal), so this channel speaks only the fact that the reply is
 *     here - which is the one a busy row cannot state.
 *  4. `a second reply is heard too` - an announcement is a change, so the channel is emptied when the
 *     next reply starts; two replies in a row both land on the same sentence and both are said.
 *  5. `leaving the conversation is not a completion` - the reply that lands in a chat the player has
 *     switched to is not the reply this stream was writing, and nothing is announced.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
];

const REPLY = "On the pier, and the tide is in.";

type StreamAnnouncementProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  setPreview(text: string | null): void;
  streamingRow(handle: string): { streaming: boolean; ariaBusy: string | null } | null;
  liveRegionsIn(handle: string): number;
  watchAnnouncement(): void;
  announcements(): readonly string[];
  announcement(): { text: string; role: string | null; width: number; height: number } | null;
  announcementSentences(locale: "en" | "zh-CN"): string;
};

declare global {
  interface Window {
    chatProbe: StreamAnnouncementProbe;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

/** The deltas a real stream sends, driven one at a time so every one is a render of its own. */
async function streamDeltas(page: Page, count: number): Promise<void> {
  let streamed = "";
  for (let index = 0; index < count; index += 1) {
    streamed += `token${index} `;
    await page.evaluate((text) => window.chatProbe.setPreview(text), streamed);
  }
}

const replyLanded = (page: Page, reply: string): Promise<void> =>
  page.evaluate(
    (entries) => window.chatProbe.setConversation(entries),
    [...CONVERSATION, { role: "companion" as const, text: reply }],
  );

test("the streaming row is busy and not live, and thirty deltas say nothing", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.watchAnnouncement());

  await page.evaluate(() => window.chatProbe.setPreview("On"));
  expect(await page.evaluate(() => window.chatProbe.streamingRow("T_preview"))).toEqual({
    streaming: true,
    ariaBusy: "true",
  });
  // The region the timeline owns is the ONLY channel: a live region inside the row that changes
  // twenty times a second is the flood this policy exists to prevent.
  expect(await page.evaluate(() => window.chatProbe.liveRegionsIn("T_preview"))).toBe(0);

  await streamDeltas(page, 30);

  // The row is still streaming, and the channel has said nothing: at most one change is the
  // invariant, and the policy's answer is zero.
  const stillStreaming = await page.evaluate(() => window.chatProbe.streamingRow("T_preview"));
  const duringStream = await page.evaluate(() => window.chatProbe.announcements());
  console.log(
    `MEASURE stream-announcements: 30 delta(s) -> ${duringStream.length} announcement(s) ` +
      `| aria-busy ${String(stillStreaming?.ariaBusy)} | live regions in the row ` +
      `${await page.evaluate(() => window.chatProbe.liveRegionsIn("T_preview"))}`,
  );
  expect(stillStreaming?.streaming).toBe(true);
  expect(duringStream.length, `the stream announced ${JSON.stringify(duringStream)}`).toBeLessThanOrEqual(1);
  expect(duringStream, "the reply being written is not announced, token by token").toHaveLength(0);
  expect(await page.evaluate(() => window.chatProbe.announcement()?.text)).toBe("");

  // The channel itself is the product's polite region, present, and out of the paint: what it says
  // is already on screen for everyone else.
  const region = await page.evaluate(() => window.chatProbe.announcement());
  expect(region?.role).toBe("status");
  expect(region?.width).toBe(0);
  expect(region?.height).toBe(0);
});

test("the commit is announced once, and the sentence names completion in both catalogues", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.watchAnnouncement());
  await page.evaluate(() => window.chatProbe.setPreview("On"));
  await streamDeltas(page, 5);

  // The wire stops the stream on `message.committed`; the transcript arrives on the read that
  // follows. During that gap the reply is not here, so nothing claims it is.
  await page.evaluate(() => window.chatProbe.setPreview(null));
  expect(await page.evaluate(() => window.chatProbe.announcement()?.text)).toBe("");
  expect(await page.evaluate(() => window.chatProbe.announcements())).toHaveLength(0);

  await replyLanded(page, REPLY);

  const english = await page.evaluate(() => window.chatProbe.announcementSentences("en"));
  const chinese = await page.evaluate(() => window.chatProbe.announcementSentences("zh-CN"));
  const afterCommit = await page.evaluate(() => window.chatProbe.announcements());
  console.log(`MEASURE commit-announcement: ${JSON.stringify(afterCommit)}`);
  expect(afterCommit).toEqual([english]);
  const region = await page.evaluate(() => window.chatProbe.announcement());
  expect(region?.text).toBe(english);

  // It names the completion, in the words the player reads: the reply is ready.
  expect(english.toLowerCase()).toContain("ready");
  expect(chinese).not.toBe(english);
  expect(chinese).toContain("写好了");
  expect(english).not.toContain("Thinking");
});

test("the next reply is heard as well: the channel is emptied when it starts", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.watchAnnouncement());
  const ready = await page.evaluate(() => window.chatProbe.announcementSentences("en"));

  for (const reply of [REPLY, "Still on the pier."]) {
    await page.evaluate(() => window.chatProbe.setPreview("On"));
    await streamDeltas(page, 3);
    await page.evaluate(() => window.chatProbe.setPreview(null));
    // Each turn's reply is a new row, so the second stream answers a transcript the first one left.
    await page.evaluate((entries) => window.chatProbe.setConversation(entries), [
      ...CONVERSATION,
      { role: "companion" as const, text: reply },
    ]);
  }

  // Two completions, and the reset between them: an announcement is a change, not a state.
  const said = await page.evaluate(() => window.chatProbe.announcements());
  expect(said.filter((text) => text === ready), `the channel said ${JSON.stringify(said)}`).toHaveLength(2);
});

test("a reply that lands after the player left the conversation is not announced", async ({ page }) => {
  await openConversation(page);
  await page.evaluate(() => window.chatProbe.watchAnnouncement());

  await page.evaluate(() => window.chatProbe.setPreview("On"));
  await streamDeltas(page, 3);
  await page.evaluate(() => window.chatProbe.setPreview(null));
  // The player switched away: the row this stream was answering is gone with the conversation. The
  // chat that is mounted ends on a companion row, which is exactly the shape of a landed reply - and
  // saying "her reply is ready" here would be about a reply this surface never saw written.
  await page.evaluate(() =>
    window.chatProbe.setConversation([{ role: "companion", text: "Somewhere else entirely." }]),
  );

  expect(await page.evaluate(() => window.chatProbe.announcements())).toHaveLength(0);
  expect(await page.evaluate(() => window.chatProbe.announcement()?.text)).toBe("");
});
