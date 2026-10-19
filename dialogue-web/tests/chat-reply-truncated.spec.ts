import { expect, test, type Page } from "@playwright/test";

/**
 * The reply cut off by the model's length ceiling, mounted, with its own measurements.
 *
 * The player's real pain: a reply the model stopped at its output ceiling is indistinguishable from
 * a finished one, so nothing tells them whether asking again is worth their click. The Host
 * publishes the fact from the model's own stop reason (`BrowserTurnV1.truncated`), and this journey
 * is about what the surface then does with it:
 *
 * 1. `says it on the reply it describes, and nowhere else` - the line belongs to the row the
 *    turn's own generation wrote (the transcript's last companion reply), and the greeting that
 *    opened the conversation never carries it.
 * 2. `carries no control of its own` - the recovery is the Regenerate button the row already has,
 *    and the line is a paragraph, not a second affordance.
 * 3. `does not push the strip's controls away` - measured twice, once with the fact and once
 *    without it: the control strip and the Regenerate button inside it keep exactly their boxes,
 *    because the line sits under them.
 * 4. `is one sentence in each language` - the shape of the words a player reads in `en` and in
 *    `zh-CN`, each naming that catalogue's own Regenerate.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier, and the tide is" },
];

type TruncatedProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  setReplyTruncated(value: boolean): void;
  truncatedReplyRow(handle: string): {
    note: { text: string | null; box: { width: number; height: number; top: number; bottom: number } } | null;
    bubble: { width: number; height: number; top: number; bottom: number };
    strip: { width: number; height: number; top: number; bottom: number };
    regenerate: { width: number; height: number; top: number; bottom: number } | null;
  } | null;
  truncatedSentence(locale: "en" | "zh-CN"): string;
};

declare global {
  interface Window {
    chatProbe: TruncatedProbe;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

test("the length-ceiling line sits under the reply it describes and never moves the strip's controls", async ({
  page,
}) => {
  await openConversation(page);

  // The complete reply first: the fact is absent, so the row carries nothing at all.
  await page.evaluate(() => window.chatProbe.setReplyTruncated(false));
  const complete = await page.evaluate(() => window.chatProbe.truncatedReplyRow("h2"));
  expect(complete).not.toBeNull();
  expect(complete?.note).toBeNull();

  await page.evaluate(() => window.chatProbe.setReplyTruncated(true));
  const truncated = await page.evaluate(() => window.chatProbe.truncatedReplyRow("h2"));
  expect(truncated?.note?.text).toBe("Her reply was cut off by the model's length limit. Regenerate for a complete one.");

  // Where it sits: below the control strip, inside the row, and not on top of either the bubble or
  // the strip it names a control in.
  expect(truncated!.note!.box.top).toBeGreaterThanOrEqual(truncated!.strip.bottom - 0.5);
  expect(truncated!.note!.box.top).toBeGreaterThanOrEqual(truncated!.bubble.bottom - 0.5);
  expect(truncated!.note!.box.height).toBeGreaterThan(0);
  expect(truncated!.note!.box.width).toBeGreaterThan(0);

  // The strip's controls are not pushed away by it: the same boxes, to the pixel, as the row's own
  // complete reply above. The strip is also still one row, which is the shape the strip has.
  expect(truncated!.strip).toEqual(complete!.strip);
  expect(truncated!.regenerate).toEqual(complete!.regenerate);
  expect(truncated!.regenerate).not.toBeNull();
  expect(truncated!.regenerate!.height).toBeGreaterThanOrEqual(44);
  expect(truncated!.strip.height).toBeLessThan(88);

  // The line carries no control: the Regenerate button it names is the row's own, above it.
  await expect(page.locator('[data-testid="message-truncated"] button')).toHaveCount(0);
  await expect(page.locator('li[data-handle="h2"] .regenerate-btn')).toHaveCount(1);

  // Nothing above the reply moved either.
  expect(truncated!.bubble).toEqual(complete!.bubble);

  // The greeting that opened the conversation is not the turn's reply, so the fact never reaches it
  // - and the fact is the Host's, not a second line the surface decided to draw on every row.
  expect(await page.evaluate(() => window.chatProbe.truncatedReplyRow("h0")?.note ?? null)).toBeNull();
  await expect(page.locator('ol.message-list > li[data-handle="h0"] [data-testid="message-truncated"]')).toHaveCount(
    0,
  );
});

test("the line is one sentence in each catalogue, and each names that catalogue's own Regenerate", async ({ page }) => {
  await openConversation(page);

  const english = await page.evaluate(() => window.chatProbe.truncatedSentence("en"));
  const chinese = await page.evaluate(() => window.chatProbe.truncatedSentence("zh-CN"));
  expect(english).toBe("Her reply was cut off by the model's length limit. Regenerate for a complete one.");
  expect(chinese).toBe("她的回复写到长度上限就被截断了。点「重新生成」可以得到完整的一条。");
  // Each catalogue names its own Regenerate word, so the sentence points at the control the player
  // can actually see in that language.
  expect(english).toContain("Regenerate");
  expect(chinese).toContain("重新生成");
  expect(english).not.toBe(chinese);
  // It is information, not a failure: none of the failure vocabulary is reused.
  expect(english).not.toContain("failed");
  expect(english).not.toContain("could not");
});
