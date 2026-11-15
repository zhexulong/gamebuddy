import { expect, test, type Page } from "./frontend-coverage";

/**
 * An edited line leaves its replies answering words that are no longer there, and the surface now says
 * WHICH replies those are.
 *
 * Saving an edit rewrites ONE row on both authorities - the durable transcript and the model's own
 * session - and leaves every later row exactly where it is, which is what makes an edit an edit rather
 * than a rewind (`editMountedChatMessage`). The consequence was already stated in the editor before the
 * save (`editLaterKept`); what was missing was the other half, on the rows themselves: a reply that
 * answered the old words stood there answering nothing the player could see, with no mark saying so.
 *
 * The measured defect this file exists for, in the order a player meets it:
 *
 *  1. THE MARK IS THE HOST'S. The surface never decides that a row is stale from the text, the order or
 *     the moment of the last edit; it renders the fact a state read publishes
 *     (`BrowserMessageV1.answeredEarlierWording`) and nothing else. A transcript the Host has not marked
 *     carries no note at all - which is the reading this journey starts from, before it hands the fact
 *     over, because a surface that guessed would mark rows the Host never called stale.
 *  2. THE SENTENCE, IN BOTH CATALOGUES. One line, under the row's own strip, with no control of its own
 *     and no live region: it is a settled state of the row, not an announcement and not a new entry.
 *  3. THE ROW KEEPS ITS BOX. The line is added UNDER a row whose bubble, strip and controls are exactly
 *     where they were, at both the desktop and the 400 px floor - the same promise the length-ceiling
 *     line makes, and the reason its stylesheet rule carries `contain: inline-size`.
 *  4. THE PLAYER COULD PREDICT IT. The editor's own sentence says later rows keep their words so a reply
 *     that answered the old ones "stays as it is and says so", which is the mark this file reads.
 */

const CONVERSATION = [
  { role: "companion" as const, text: "An opening greet." },
  { role: "player" as const, text: "Where are we?" },
  { role: "companion" as const, text: "On the pier." },
  { role: "player" as const, text: "And now?" },
  { role: "companion" as const, text: "Still on the pier." },
];

type NoteProbe = {
  text: string | null;
  box: { width: number; height: number; left: number; right: number; top: number; bottom: number };
  tone: string;
  role: string | null;
  bubble: { width: number; height: number; left: number; right: number; top: number; bottom: number } | null;
  strip: { width: number; height: number; left: number; right: number; top: number; bottom: number } | null;
};

type MarkProbe = {
  setConversation(entries: readonly Readonly<{ role: "player" | "companion"; text: string }>[]): void;
  withAnsweredEarlierWording(handle: string): void;
  answeredEarlierNote(handle: string): NoteProbe | null;
  answeredEarlierSentences(locale: "en" | "zh-CN"): { mark: string; editorConsequence: string };
  liveRegionsIn(handle: string): number;
  editCalls(): readonly { handle: string; order: number; text: string }[];
  resetEditCalls(): void;
  copySentences(locale: "en" | "zh-CN"): { notice: string; failed: string; control: string };
};

declare global {
  interface Window {
    chatProbe: MarkProbe;
  }
}

async function openConversation(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => window.chatProbe !== undefined);
  await page.evaluate((entries) => window.chatProbe.setConversation(entries), CONVERSATION);
}

/** The note each row of the conversation draws: its words, or null where the row carries none. */
async function notes(page: Page, handles: readonly string[]): Promise<(string | null)[]> {
  return await page.evaluate((rows) => rows.map((handle) => window.chatProbe.answeredEarlierNote(handle)?.text ?? null), [
    ...handles,
  ]);
}

test("a row the Host has not marked says nothing, and the mark is what makes a reply say it answered the old words", async ({
  page,
}) => {
  await openConversation(page);

  // READING 1 - today's surface, which is the red: the player corrects their own line while two replies
  // follow it, and every row still renders as if the conversation had always read this way.
  await page.evaluate(() => window.chatProbe.resetEditCalls());
  await page.click('[data-handle="h1"] [data-testid="message-edit"]');
  await page.fill('[data-testid="message-edit-field"]', "Where are we, again?");
  await page.click('[data-testid="message-edit-save"]');
  expect(await page.evaluate(() => window.chatProbe.editCalls()), "the save is what asks the Host to rewrite").toEqual(
    [{ handle: "h1", order: 1, text: "Where are we, again?" }],
  );
  expect(
    await notes(page, ["h0", "h1", "h2", "h3", "h4"]),
    "no row claims to answer an earlier wording until the Host says it does",
  ).toEqual([null, null, null, null, null]);

  // READING 2 - the Host's answer. The two replies under the corrected line were written while it said
  // something else, so a state read publishes the mark on them, and the rows say so.
  await page.evaluate(() => {
    window.chatProbe.withAnsweredEarlierWording("h2");
    window.chatProbe.withAnsweredEarlierWording("h4");
  });
  const marked = await notes(page, ["h0", "h1", "h2", "h3", "h4"]);
  const sentence = await page.evaluate(() => window.chatProbe.answeredEarlierSentences("en").mark);
  expect(marked, "exactly the rows the History marked carry the note").toEqual([null, null, sentence, null, sentence]);
  console.log(`[answered-earlier] ${JSON.stringify(marked)}`);
});

test("the mark is one line under the row, in both catalogues, with no control and no live region of its own", async ({
  page,
}) => {
  await openConversation(page);

  // The row's controls, counted before the Host's fact arrives and after: the line is information, so the
  // buttons the player can press are the ones the row already had.
  const buttonsBefore = await page.locator('li[data-handle="h2"] button').count();
  await page.evaluate(() => window.chatProbe.withAnsweredEarlierWording("h2"));
  expect(await page.locator('li[data-handle="h2"] button').count(), "the note adds no control to the row").toBe(
    buttonsBefore,
  );

  const note = await page.evaluate(() => window.chatProbe.answeredEarlierNote("h2"));
  expect(note, "the marked row draws the line").not.toBeNull();
  const sentences = await page.evaluate(() => window.chatProbe.answeredEarlierSentences("en"));
  expect(note?.text, "the sentence is the catalogue's own, not a string this component invented").toBe(sentences.mark);
  // The two catalogues are two sentences, and the Chinese one is not the English one wearing a different
  // key: the player reading 中文 is told the same fact in their own words.
  const chinese = await page.evaluate(() => window.chatProbe.answeredEarlierSentences("zh-CN"));
  expect(chinese.mark, "the 中文 sentence says the same fact in Chinese").not.toBe(sentences.mark);
  expect(chinese.mark.length, "and it is a sentence, not a placeholder").toBeGreaterThan(8);
  // Information, not an announcement: the row's own settled state, so the conversation's one polite
  // region stays the only thing a screen reader is interrupted by.
  expect(note?.role, "the line is not a live region").toBeNull();
  expect(await page.evaluate(() => window.chatProbe.liveRegionsIn("h2")), "and no region lives in the row").toBe(0);
  // And it is drawn in the muted secondary tone the row's other facts wear, not as a failure.
  expect(note?.tone, "the line takes the row's secondary tone").not.toBe("");
});

test("the mark moves nothing: the row's bubble, strip and controls keep their boxes at both widths", async ({ page }) => {
  await openConversation(page);

  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 400, height: 800 },
  ]) {
    await openConversation(page);
    await page.setViewportSize(viewport);
    const where = `${viewport.width}x${viewport.height}`;
    const before = await page.evaluate(() => window.chatProbe.answeredEarlierNote("h2"));
    expect(before?.text, where).toBeNull();
    const rowWidth = await page.evaluate(
      () => document.querySelector('li[data-handle="h2"]')?.getBoundingClientRect().width ?? 0,
    );

    await page.evaluate(() => window.chatProbe.withAnsweredEarlierWording("h2"));
    const after = await page.evaluate(() => window.chatProbe.answeredEarlierNote("h2"));
    console.log(
      `MEASURE answered-earlier ${where}: bubble ${JSON.stringify(before?.bubble)} -> ${JSON.stringify(after?.bubble)} | ` +
        `strip ${JSON.stringify(before?.strip)} -> ${JSON.stringify(after?.strip)} | ` +
        `note ${JSON.stringify(after?.box)} | row width ${rowWidth}`,
    );

    // The bubble and the strip are exactly the boxes they had: the line is added UNDER the row, so the
    // words the player is reading and the controls under them do not move by a pixel.
    expect(after?.bubble, `${where}: the bubble keeps its box`).toEqual(before?.bubble);
    expect(after?.strip, `${where}: the control strip keeps its box`).toEqual(before?.strip);
    // The line sits after the strip, and inside the row's width: a line that widened the row would
    // re-wrap the reply above it, which is what `contain: inline-size` is there to prevent.
    expect(after?.box.top, `${where}: the line is under the strip`).toBeGreaterThanOrEqual(after?.strip?.bottom ?? 0);
    expect(after?.box.width, `${where}: the line wraps inside the row rather than widening it`).toBeLessThanOrEqual(
      rowWidth + 1,
    );
    expect(after?.box.height, `${where}: the line is really painted`).toBeGreaterThan(0);
  }
});

test("the editor says what the mark will say, before the save", async ({ page }) => {
  await openConversation(page);

  // The prediction the player is owed: with rows after theirs, the editor states that later rows keep
  // their words AND that a reply which answered the old ones says so - which is the line the marked row
  // then carries.
  await page.click('[data-handle="h1"] [data-testid="message-edit"]');
  const consequence = await page.locator('[data-testid="message-edit-consequence"]').textContent();
  const sentences = await page.evaluate(() => window.chatProbe.answeredEarlierSentences("en"));
  expect(consequence?.trim(), "the editor states the consequence in the catalogue's own words").toBe(
    sentences.editorConsequence,
  );
  expect(consequence, "and it says the rows below keep their words and say so").toContain("says so");
  const chinese = await page.evaluate(() => window.chatProbe.answeredEarlierSentences("zh-CN"));
  expect(chinese.editorConsequence, "the 中文 editor makes the same promise").toContain("标明这一点");
});
