import { characterLabels } from "../src/components/character-domain-labels";
import { importIdHandle, openCharactersSurface, stagedCard, stubCharacterReads } from "./character-card-fixtures";
import { characterHandle, jsonOk, token } from "./composed-reference-game-fixtures";
import { expect, test } from "./frontend-coverage";

/**
 * WHY:
 * Assert that the card staging picker cleanly self-heals after a rejection or parse error.
 *
 * HISTORICAL CONTEXT:
 * Early live-run reports printed `staging_failed ("")`, which was traced to the (now-fixed)
 * 32-line card limit rather than an in-situ DOM leak. This gate ensures that sequential
 * dirty-to-clean imports remain provably idempotent, so future refactors never introduce
 * real state leakage.
 *
 * WHAT THE REPORT ACTUALLY SAID, which is why this file exists beside no fix: the label
 * `staging_failed` is the capture kit's own word - `tools/live-run/frontend/capture/r-card-export.cjs:117`
 * mints it from whichever of the surface's two answers it read - so that report described the
 * driver, not the panel. The panel's own answer to a refused card is one node,
 * `[data-card-import-result=error]`, carrying one of `CharacterCardImport`'s own refusal
 * sentences. Nothing in this tree had ever asserted that node is *gone* after the next good pick,
 * so "the panel leaks a refusal into the next import" was neither proven nor excluded. This gate
 * excludes it, over the whole declared population of refusals, on one mount and with no reload.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT RE-ASSERT (so the pair is not a third copy):
 *  - `card-export-import-roundtrip.spec.ts` owns the bytes: the card the export saves is the card
 *    the import takes back, field for field, and the picker's `value` reset lets one file be picked
 *    twice. Two *successful* imports in a row, with no refusal between them.
 *  - `character-card-import.spec.ts` owns one refused *confirm* (a 422 after a successful stage):
 *    it renders `importFailed` and never a created companion. It stops there and never re-imports.
 *  - this file owns refusal -> recovery: each refusal shape leaves one sentence behind, and the
 *    next pick of the good card clears it.
 */

/**
 * The refusal sentences the panel can present, derived from the label record the product owns.
 *
 * `CharacterCardImport` presents a refused card at `[data-card-import-result=error]` and nowhere
 * else, and every sentence it can put there is declared `importFailed*` beside the panel's other
 * words in `character-domain-labels.ts`. Deriving the set from that record is what lets the gate
 * outlive this commit: a fourth refusal sentence joins the population by being declared, and the
 * shapes below must claim it or fail by name. A hand-written list here would cover only the
 * refusals its author remembered, and would pass silently on the one nobody had written yet.
 *
 * The paste box's `importPasteRequired` is deliberately NOT in this population: it renders at a
 * different node (`[data-card-import-paste-problem]`) and states a different fact - that the box is
 * still empty - which stays true across a file import and must not be cleared by one.
 */
const refusalSentences = (): ReadonlyMap<string, string> =>
  new Map(
    Object.entries(characterLabels("en") as unknown as Record<string, string>).filter(([label]) =>
      label.startsWith("importFailed"),
    ),
  );

/** One refusal sentence, by the label that declares it; a missing label is a finding, not a skip. */
const sentenceOf = (label: string): string => {
  const sentence = refusalSentences().get(label);
  if (sentence === undefined) throw new Error(`no refusal sentence is declared as ${label}`);
  return sentence;
};

/** The card the panel's own export control saves, and the bytes its picker is given back. */
const EXPORTED_CARD = {
  spec: "chara_card_v3",
  spec_version: "3.0",
  data: {
    name: "琥珀",
    description: "她在祖辈留下的农场里长大,话不多,先做一个动作再说一句话。",
    personality: "沉静,务实,对天气和土壤有耐心。",
    scenario: "你们一起在祖辈留下的农场里开始新的生活。",
    first_mes: "她把锄头靠在门边,看了你一眼。",
    character_book: {
      scan_depth: 5,
      entries: [{ comment: "温室", content: "温室是她去年冬天自己修好的。", keys: ["温室", "玻璃房"] }],
    },
  },
} as const;
const EXPORTED_CARD_TEXT = JSON.stringify(EXPORTED_CARD);

/** What the stubbed stage route answers: the card staged, the card refused, or no answer at all. */
type StageAnswer = "answer" | "refuse" | "no-answer";

/**
 * One way the panel can be left holding a refusal, and the label its sentence comes from.
 *
 * `cardSource` is the arm the panel must have taken, and it is part of the shape: a picked file's
 * eight signature bytes decide that arm on this side, so a refusal proven on only one arm has not
 * covered the class. `undefined` is the panel's own refusal, which must reach no route at all.
 */
type RefusalShape = Readonly<{
  shape: string;
  sentence: string;
  file: Readonly<{ name: string; mimeType: string; buffer: Buffer }>;
  answer: StageAnswer;
  cardSource: "json" | "png" | undefined;
}>;

const REFUSAL_SHAPES: readonly RefusalShape[] = [
  {
    // The parse-error shape: bytes that decode to nothing a card could be read out of.
    shape: "unreadable_text",
    sentence: "importFailedText",
    file: { name: "not-a-card.txt", mimeType: "text/plain", buffer: Buffer.from("  \n\t \r\n ") },
    answer: "answer",
    cardSource: undefined,
  },
  {
    // The size shape, at the text ceiling (`CharacterCardImport`'s own `MAX_CARD_TEXT_LENGTH`,
    // 2 MiB). Its sibling branch - a file over the decoder's 32 MiB - draws the same sentence.
    shape: "oversize_text",
    sentence: "importFailedTooLarge",
    file: { name: "huge.txt", mimeType: "text/plain", buffer: Buffer.alloc(2_100_000, 0x61) },
    answer: "answer",
    cardSource: undefined,
  },
  {
    // The PNG arm's staging rejection: the signature says PNG and the rest is not a card, so the
    // whole file travels as base64 and the route is what refuses it.
    shape: "route_refuses_png_card",
    sentence: "importFailed",
    file: {
      name: "corrupt.png",
      mimeType: "image/png",
      buffer: Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(64, 0x7a)]),
    },
    answer: "refuse",
    cardSource: "png",
  },
  {
    // The JSON arm's staging rejection: readable text, and not a card.
    shape: "route_refuses_json_card",
    sentence: "importFailed",
    file: { name: "not-a-card.json", mimeType: "application/json", buffer: Buffer.from('{"hello":"world"}') },
    answer: "refuse",
    cardSource: "json",
  },
  {
    // The transport shape: a card the route would have staged, and a request that never completes.
    // The panel presents that as the same sentence it presents a rejection as, because it cannot
    // tell the player which happened - inventing a distinction it does not have is the worse read.
    shape: "transport_failure",
    sentence: "importFailed",
    file: { name: "amber.json", mimeType: "application/json", buffer: Buffer.from(EXPORTED_CARD_TEXT) },
    answer: "no-answer",
    cardSource: "json",
  },
];

test("every refusal sentence the panel can present is driven by a shape in this gate", () => {
  const declared = [...refusalSentences().keys()].sort();
  console.log(`refusal sentences examined ${declared.length}: ${declared.join(", ")}`);
  console.log(`refusal shapes examined ${REFUSAL_SHAPES.length}: ${REFUSAL_SHAPES.map((shape) => shape.shape).join(", ")}`);

  // Zero population is a blocked reading, never a pass: a scan that found no refusal sentence is a
  // scan that has stopped reading the record it names.
  expect(declared.length, "the panel declares refusal sentences, so this gate has a population").toBeGreaterThan(0);

  // Both directions, so neither side can drift quietly. A declared sentence no shape drives is a
  // refusal this gate would let leak; a shape naming an undeclared sentence is an invented word, and
  // the journey below would then be asserting a string no player can be shown.
  const claimed = new Set(REFUSAL_SHAPES.map((shape) => shape.sentence));
  expect(
    declared.filter((label) => !claimed.has(label)),
    "every declared refusal sentence is driven by at least one shape",
  ).toEqual([]);
  expect(
    REFUSAL_SHAPES.map((shape) => shape.sentence).filter((label) => !declared.includes(label)),
    "every shape names a sentence the panel declares",
  ).toEqual([]);
  expect(REFUSAL_SHAPES.length, "no shape is listed twice").toBe(
    new Set(REFUSAL_SHAPES.map((shape) => shape.shape)).size,
  );
});

test("a refused card leaves no answer behind: the same picker stages the next card clean", async ({ page }) => {
  const stageBodies: Array<{ cardSource?: string }> = [];
  const exportFormats: Array<string | null> = [];
  let answer: StageAnswer = "answer";

  await stubCharacterReads(page, {
    companions: [{ handle: characterHandle, name: EXPORTED_CARD.data.name, isCurrent: true }],
  });
  // The panel's own export, in the form the picker reads back without a second PNG writer here: the
  // Host's JSON card text, which is exactly what `download.path()` hands back below.
  await page.route(
    (url) => url.pathname === `/api/tavern/v1/companions/${characterHandle}/card`,
    (route) => {
      exportFormats.push(new URL(route.request().url()).searchParams.get("format"));
      return route.fulfill(
        jsonOk({
          apiVersion: 1,
          format: "json",
          spec: "chara_card_v3",
          fileName: `${EXPORTED_CARD.data.name}.json`,
          card: EXPORTED_CARD_TEXT,
        }),
      );
    },
  );
  await page.route("**/api/tavern/v1/imports", async (route) => {
    stageBodies.push(route.request().postDataJSON() as { cardSource?: string });
    if (answer === "no-answer") return route.abort("connectionrefused");
    if (answer === "refuse")
      return route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({
          type: "about:blank",
          title: "Card import rejected",
          status: 422,
          code: "st_card_import_rejected",
          requestId: importIdHandle,
          retryable: false,
        }),
      });
    return route.fulfill(jsonOk({ ...stagedCard(), name: EXPORTED_CARD.data.name }));
  });

  await page.goto(`/#profile=composed-reference-game&boot=${token}`);
  await openCharactersSurface(page);
  const surface = page.getByTestId("characters-surface");
  const picker = surface.locator("[data-card-import-file]");
  const review = surface.locator("[data-card-import-review]");
  const confirm = review.locator("[data-card-import-review-confirm]");
  const errorNode = surface.locator("[data-card-import-result=error]");

  // The good card: the bytes the panel's own export control just wrote, read off disk. Nothing is
  // reloaded or re-mounted from here on - one page, one mount, for every shape below.
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    surface.locator("[data-companion-card-export-json]").click(),
  ]);
  expect(download.suggestedFilename(), "the export names the file the picker will read back").toBe(
    `${EXPORTED_CARD.data.name}.json`,
  );
  const exportedPath = await download.path();
  expect(exportedPath, "the export completes, so there is a file to import").not.toBeNull();
  const exportedBytes = await import("node:fs/promises").then((fs) => fs.readFile(exportedPath!));
  expect(exportedBytes.toString("utf8"), "the saved card is the Host's own card text").toBe(EXPORTED_CARD_TEXT);
  expect(exportFormats, "the control that saved it asked for the JSON form").toEqual(["json"]);

  for (const refusal of REFUSAL_SHAPES) {
    // ---- phase 1: the panel is clean, then it is made dirty, and the dirt is the sentence it drew.
    // The clean pre-check is what makes the two phases sequential rather than one assertion on an
    // already-clean page: a shape whose refusal is never rendered fails here, not after phase 2.
    await expect(errorNode, `before ${refusal.shape} the panel holds no answer`).toHaveCount(0);
    await expect(review, `before ${refusal.shape} nothing is staged`).toHaveCount(0);
    const sentBefore = stageBodies.length;
    answer = refusal.answer;
    await picker.setInputFiles(refusal.file);
    await expect(
      errorNode,
      `${refusal.shape} is refused and the panel says so`,
    ).toHaveText(sentenceOf(refusal.sentence));
    if (refusal.cardSource === undefined) {
      // The panel's own refusal: nothing left the browser, which is what makes this a shape of its
      // own rather than a second spelling of the route's rejection.
      expect(stageBodies.length, `${refusal.shape} is decided before any stage request`).toBe(sentBefore);
    } else {
      expect(stageBodies.length, `${refusal.shape} reaches the stage route`).toBe(sentBefore + 1);
      expect(stageBodies[stageBodies.length - 1]!.cardSource, `${refusal.shape} took the ${refusal.cardSource} arm`).toBe(
        refusal.cardSource,
      );
    }

    // ---- phase 2: the good card, into the SAME mounted surface, with no reload in between.
    answer = "answer";
    await picker.setInputFiles({
      name: `${EXPORTED_CARD.data.name}.json`,
      mimeType: "application/json",
      buffer: exportedBytes,
    });
    await expect(review, `after ${refusal.shape} the good card stages a review`).toBeVisible();
    // Read first, then assert: the failure message carries the sentence that was left behind, which
    // is the whole point of the gate - it names what leaked, not merely that something did.
    const leaked = await errorNode.allTextContents();
    expect(
      leaked,
      `dirty_state_leaked_into_the_next_import:${leaked.join(" | ")} (${refusal.shape}, phase 2)`,
    ).toEqual([]);
    await expect(confirm, `after ${refusal.shape} the review offers a decision`).toBeVisible();
    await expect(confirm, `after ${refusal.shape} the decision is not greyed out`).toBeEnabled();
    await expect(review).toContainText(`The card names it ${EXPORTED_CARD.data.name}.`);

    // Cancel returns the panel to "nothing staged" without a route call, so the next shape's phase 1
    // starts from the same clean surface this one did.
    await review.locator("[data-card-import-review-cancel]").click();
    await expect(review, "the staged card was dropped before the next shape").toHaveCount(0);
  }

  // Every pick that could reach the route did: one per phase 2, plus one per shape that is refused
  // by the route itself. A phase 2 that quietly stopped sending would leave the counts above green.
  expect(stageBodies.length, "each shape sent what it should and each good pick reached the route").toBe(
    REFUSAL_SHAPES.length + REFUSAL_SHAPES.filter((shape) => shape.cardSource !== undefined).length,
  );
});
