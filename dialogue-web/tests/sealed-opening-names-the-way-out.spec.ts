import { expect, test } from "./frontend-coverage";
import { chat, jsonOk, root, token } from "./composed-reference-game-fixtures";

/**
 * The opening the player cannot change any more, and the one thing the surface owes them at
 * that point: where the alternative lives.
 *
 * The seal itself is the product's own line, recorded where it is decided
 * (`design/research/airp-parity-review-2026-10-21.md:52`: replacing a Chat's opening in an
 * existing conversation is refused by name, `chat_opening_locked`), and the Host derives it
 * from the transcript - the first row that is not the opening closes the choice
 * (`openingLockedAtEventIdOf`, `chat-thread-store.ts`). A card ships several openings, so a
 * player who made a Chat on one they do not want is left with a control that simply
 * disappeared: measured on the shipped shell, `opening-variants.spec.ts` pins
 * `.swipe-controls` count 0 on the sealed row and pins nothing else - the pager vanishes and
 * the row says nothing about it.
 *
 * The failure each journey catches:
 *
 * 1. `names the way out on the row whose switcher the seal took` - the sealed opening row is
 *    the place the player looks (it is where the arrows were), so the sentence that says the
 *    opening is fixed and names the real alternative belongs on that row, in the shell's own
 *    words, and it must be on screen with no control of its own: the row keeps only the two
 *    things it can still do.
 * 2. `says it in the player's own language` - both catalogues carry the sentence, because a
 *    zh-CN surface that falls back to English is the same silence with extra steps.
 * 3. `says nothing while the choice is still open` - an unlocked opening already offers the
 *    pager; printing the sentence beside it would contradict the control next to it.
 * 4. `says nothing on a reply` - only the opening was ever choosable, so a companion reply
 *    that carries no opening projection gets no note.
 */

const OPENINGS = [
  { label: "Default", text: "Good morning, farmer. The valley is quiet today." },
  { label: "Rainy evening", text: "Rain on the roof before you open your eyes." },
  { label: "Late night", text: "It is past midnight and the lamp is still lit." },
];

/**
 * One transcript row, in the shape the Host publishes.
 *
 * The two handles are canonical opaque handles (`isOpaqueHandle`): 43 characters whose final
 * base64url digit is one of the four the last four bits allow, which is why they are `A` and `E`
 * rather than a run of digits.
 */
function row(
  text: string,
  order: number,
  role: "player" | "companion",
  openingVariant?: { index: number; count: number; locked: boolean },
) {
  return {
    handle: (order === 0 ? "A" : "E").repeat(43),
    role,
    text,
    locale: "und",
    order,
    revision: 1,
    ...(openingVariant === undefined
      ? {}
      : {
          openingVariant: {
            variantId: "V".repeat(42) + "A",
            index: openingVariant.index,
            count: openingVariant.count,
            label: OPENINGS[openingVariant.index]!.label,
            locked: openingVariant.locked,
          },
        }),
  };
}

/** The composed root around one transcript. */
function rootWith(transcript: readonly ReturnType<typeof row>[]) {
  const mounted = {
    ...chat,
    operations: [
      {
        operationId: "chat.submit",
        labelKey: "tavern.operation.submit",
        availability: "available" as const,
        routeId: "chat.submit",
      },
    ],
    chat: { ...chat.chat, transcript, draft: { revision: 0, present: false } },
  };
  return { ...root, chat: mounted };
}

async function mount(page: import("playwright").Page, transcript: readonly ReturnType<typeof row>[]): Promise<void> {
  const document = rootWith(transcript);
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(document)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(document)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await expect(page.getByTestId("chat-surface")).toBeVisible();
}

test("names the way out on the row whose switcher the seal took", async ({ page }) => {
  // The shape a card with three openings leaves after the first message: the Chat opened on
  // the second one, the player has spoken, and the Host, therefore, reports the choice sealed.
  await mount(page, [
    row(OPENINGS[1]!.text, 0, "companion", { index: 1, count: 3, locked: true }),
    row("I'll be right out.", 1, "player"),
  ]);

  const opening = page.locator(".message.companion").first();
  // The seal: no switcher, which is the Host's fact and not this surface's choice.
  await expect(opening.locator(".swipe-controls")).toHaveCount(0);
  // And the one thing the row owes the player instead: the fact, and where the alternative is.
  const note = opening.getByTestId("message-opening-sealed");
  await expect(note).toHaveCount(1);
  await expect(note).toHaveText(
    "This opening was fixed by your first message. Start a New Chat to open on a different one.",
  );
  // It is a sentence, not a control: nothing under the bubble can be pressed about it.
  await expect(note.locator("button")).toHaveCount(0);
  expect(await note.evaluate((element) => element.tagName), "the note is prose").toBe("P");

  // The row still offers the two things it can still do, so the note did not displace a control.
  await expect(opening.getByTestId("message-copy")).toHaveCount(1);
  await expect(opening.getByTestId("message-edit")).toHaveCount(1);
});

test("says it in the player's own language", async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem("gamebuddy.tavern.ui-locale", "zh-CN"));
  await mount(page, [
    row(OPENINGS[1]!.text, 0, "companion", { index: 1, count: 3, locked: true }),
    row("我马上出来。", 1, "player"),
  ]);

  await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");
  await expect(page.locator(".message.companion").first().getByTestId("message-opening-sealed")).toHaveText(
    "你发出第一条消息后，这条开场白就固定了。想换个开场白，请新建会话。",
  );
});

test("says nothing while the choice is still open", async ({ page }) => {
  // The new-chat window: the same three openings, the choice not yet made - the pager is the
  // answer here, and a sentence claiming the opening is fixed beside it would be false.
  await mount(page, [row(OPENINGS[1]!.text, 0, "companion", { index: 1, count: 3, locked: false })]);

  const opening = page.locator(".message.companion").first();
  await expect(opening.locator(".swipe-controls")).toHaveCount(1);
  await expect(opening.getByTestId("message-opening-sealed")).toHaveCount(0);
});

test("says nothing on a reply, or on a Chat that opened on a blank one", async ({ page }) => {
  // No opening row at all: the Chat began blank, so there is no choice this seal took and no
  // row to say it on.
  await mount(page, [row("Where are we?", 0, "player"), row("On the pier.", 1, "companion")]);

  await expect(page.getByTestId("message-opening-sealed")).toHaveCount(0);
  await expect(page.getByRole("region", { name: "Chat transcript" })).toContainText("On the pier.");
});
