/**
 * The situation card: the one part of the Game surface that is about her rather than about the
 * machinery.
 *
 * The defect family this is written against is the one that made this surface read like an
 * operations console: a player who opened Game met an installation panel, a three-step runbook and
 * a capability board, and nothing anywhere on the page said who was waiting, or that anyone was.
 * The card states three things - her monogram, where she is, and the one next step - and the
 * second of them is the one that can lie.
 *
 * WHAT IS ASSERTED, for every phase the product declares (`GAME_SESSION_PHASES`, each with its own
 * published projection from `GAME_SESSION_INPUTS`, so a phase added to the union joins this gate):
 *
 *   1. one place-clause, and it is the one the projection supports. The six clauses are a bijection
 *      over the six facts they name - `attachment.status: attached`, `instance.status: launching`,
 *      a Player Host up with no attachment, `instance.status: none`, `crashed`/`stopped`, `unread` -
 *      so the check is "the clause that names this fact is on the card exactly when the fact is",
 *      not a hand-written per-phase expectation the product could drift from. This is the
 *      `AGENTS.md` rule the owner's ruling restates: a fact the projection does not publish has no
 *      sentence, and the card says less rather than inventing a location.
 *   2. one next step, and where it names a control it names one this surface really draws. The card
 *      does not draw a second button (one action, one control - `design/26` §1); it says the word
 *      the button says, so the check is that a control with that accessible name is on the page.
 *   3. a named companion's monogram is her initial; an unnamed one has no initial at all.
 *
 * red-proof: `deriveGameSituation` returning the `in_farm` clause for `pre_activation` (one entry of
 *            `GAME_SITUATION_FACTS`) -> `game / pre_activation: the card says "I'm on your farm"
 *            while the Host publishes no attachment` (dialogue-web/tests/game-situation-card.spec.ts)
 */
import { messages } from "../src/i18n";
import { GAME_SESSION_INPUTS, GAME_SESSION_PHASES } from "../src/game-lifecycle-controls";
import { type Page, expect, test } from "./frontend-coverage";
import { chat, csrfToken, expiresAtMs, jsonOk, token } from "./composed-reference-game-fixtures";

const labels = messages("en");

/** The Game half's envelope around one projection, or `null` for a Host that published none. */
function gameEnvelope(projection: unknown): unknown {
  return projection === null
    ? null
    : {
        apiVersion: 1,
        build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
        csrfToken,
        browserSession: { expiresAtMs },
        game: projection,
      };
}

/**
 * Mount the Game surface on one projection.
 *
 * The route set is the smallest one this surface needs to render at all: the composed root (the
 * shell's mount read), the Game slice (`GameSurface`'s own reread), the cabin handoff, and the two
 * reads its siblings make beside it. Everything else the page answers with its own refusal, which
 * cannot reach the card - the card reads the projection and nothing else.
 */
async function mountProjection(page: Page, projection: unknown): Promise<void> {
  const envelope = gameEnvelope(projection);
  const root = {
    apiVersion: 1,
    build: {
      browserContract: "composed_reference_game_browser_api/v1",
      profileId: "gamebuddy.composed.reference-game",
    },
    chat,
    game: envelope,
  };
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/composed-reference-game/v1/game", (route) => route.fulfill(jsonOk(envelope)));
  await page.route("**/api/composed-reference-game/v1/game/stardew/cabins", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, choices: [] })),
  );
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk({ apiVersion: 1, revision: 0, text: null })));
  await page.route("**/api/tavern/v1/settings/language", (route) =>
    route.fulfill(jsonOk({ revision: 1, locale: "en-US" })),
  );
  await page.goto(`/#profile=composed-reference-game&boot=${token}&panel=game`);
  await expect(page.getByTestId("game-surface")).toBeVisible();
  await expect(page.getByTestId("game-state-panel")).toBeVisible();
}

/** The place-clauses the card can say, each with the projection fact that earns it. */
const PLACE_CLAUSES: readonly Readonly<{ sentence: string; published(projection: ProjectionFacts): boolean }>[] = [
  { sentence: labels.gameSituationFarm, published: (projection) => projection.attachment === "attached" },
  { sentence: labels.gameSituationArriving, published: (projection) => projection.instance === "launching" },
  {
    sentence: labels.gameSituationGameRunning,
    published: (projection) =>
      projection.instance === "running" && projection.attachment !== "attached" && projection.phase !== "launching",
  },
  { sentence: labels.gameSituationNotInFarm, published: (projection) => projection.instance === "none" },
  {
    sentence: labels.gameSituationGameGone,
    published: (projection) => projection.instance === "crashed" || projection.instance === "stopped",
  },
  { sentence: labels.gameSituationNotRead, published: (projection) => projection.instance === "unread" },
];

type ProjectionFacts = Readonly<{
  /** `instance.status`, or `null` when the Host published no projection at all. */
  instance: string | null;
  attachment: string | null;
  /** The phase `GAME_SESSION_INPUTS` projects for this fixture, for the one clause two facts share. */
  phase: string;
}>;

for (const phase of GAME_SESSION_PHASES) {
  const input = GAME_SESSION_INPUTS[phase];
  const projection = input.game === null ? null : input.game.game;

  test(`game / ${phase}: the situation card states the facts the Host published, and no others`, async ({ page }) => {
    await mountProjection(page, projection);
    const card = page.getByTestId("game-situation");

    if (projection === null) {
      // No projection is no companion fact: the surface owes a card neither a name nor a place.
      await expect(card, `game / ${phase}: the Host published no Game projection, so there is no card`).toHaveCount(0);
      return;
    }

    await expect(card, `game / ${phase}: the first thing on the Game surface is her situation`).toBeVisible();
    const facts: ProjectionFacts = {
      instance: projection.instance.status,
      attachment: projection.attachment.status,
      phase,
    };
    const line = (await page.getByTestId("game-situation-line").textContent()) ?? "";
    for (const clause of PLACE_CLAUSES) {
      expect(
        line.includes(clause.sentence),
        `game / ${phase}: instance "${String(facts.instance)}" / attachment "${String(facts.attachment)}" - the ` +
          `card says ${JSON.stringify(line.trim())}, and "${clause.sentence}" must be there exactly when its fact is`,
      ).toBe(clause.published(facts));
    }

    // The next step is one thing, and it never carries an unfilled template or a protocol word.
    const next = ((await page.getByTestId("game-situation-next").textContent()) ?? "").trim();
    expect(next.length, `game / ${phase}: the card owes one next step`).toBeGreaterThan(0);
    expect(next, `game / ${phase}: the next step is a sentence, not a template`).not.toContain("{{");
    if (next.startsWith(labels.gameSituationNextAction.split("{{")[0])) {
      const named = next.replace(labels.gameSituationNextAction.split("{{")[0], "").trim();
      const controls = await page
        .getByTestId("game-surface")
        .locator("button, [role=button], a[href]")
        .evaluateAll((nodes) =>
          nodes.map((node) => (node.getAttribute("aria-label") ?? node.textContent ?? "").replace(/\s+/gu, " ").trim()),
        );
      expect(
        controls,
        `game / ${phase}: the card says the next step is "${named}", so a control with that name must be on the ` +
          `surface; it offers ${JSON.stringify(controls)}`,
      ).toContain(named);
    }

    // An unnamed companion has no initial - the card does not invent a name.
    const monogram = ((await card.locator(".game-situation-avatar").textContent()) ?? "").trim();
    const publishedName = projection.companionName;
    expect(
      monogram,
      `game / ${phase}: the Host published companionName ${JSON.stringify(publishedName)}, so the monogram is ` +
        `either her initial or nothing at all`,
    ).toBe(publishedName === null ? "" : Array.from(publishedName)[0]);
  });
}

test("the situation card shows her initial when the Host names the companion", async ({ page }) => {
  const input = GAME_SESSION_INPUTS.attached_connected;
  if (input.game === null) throw new Error("GAME_SESSION_INPUTS.attached_connected publishes no Game projection");
  await mountProjection(page, { ...input.game.game, companionName: "Amber" });
  const card = page.getByTestId("game-situation");
  await expect(card).toBeVisible();
  await expect(card.locator(".game-situation-avatar")).toHaveText("A");
  await expect(page.getByTestId("game-situation-line")).toHaveText(labels.gameSituationFarm);
});
