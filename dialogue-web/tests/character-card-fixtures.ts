/**
 * ---------------------------------------------------------------------------
 * The Characters surface: the character domain and its world book in one place
 * ---------------------------------------------------------------------------
 *
 * These pin the owner's two standing complaints about this surface:
 *
 * 1. Importing a character card must be a file picker, not a staged review
 *    ceremony, and the result must be the Host's own read-back - never a local
 *    guess - with a refusal reported instead of shown as success.
 * 2. A character's card and its world book live in ONE place, so World Info is
 *    no longer a peer surface of the shell.
 */
import { expect, type Page } from "./frontend-coverage";
import { draft, jsonOk, root } from "./composed-reference-game-fixtures";

export const importIdHandle = `${"I".repeat(42)}A`;

/**
 * The GET routes the Characters surface reads once on mount: the identity list,
 * the persona, the scenario, the character's opening, its world book and the
 * durable import history.
 */
export async function stubCharacterReads(
  page: Page,
  overrides: Readonly<{
    companions?: readonly Readonly<{ handle: string; name: string; isCurrent: boolean }>[];
    /**
     * The current companion's OWN world book, as `companion.worldbook.read` serves
     * it. Absent means the companion has no book (`present: false`), which is the
     * state a directly-named companion is in.
     */
    companionWorldBook?: Readonly<Record<string, unknown>>;
  }> = {},
): Promise<void> {
  await page.route("**/api/composed-reference-game/v1/bootstrap", (route) => route.fulfill(jsonOk(root)));
  // The surface's own World Info read is this snapshot's Chat half (the Host builds
  // both from one read), so the mount re-enters through the same root the bootstrap
  // served rather than through the `GET /world-info` route it no longer reads.
  await page.route("**/api/composed-reference-game/v1/state", (route) => route.fulfill(jsonOk(root)));
  await page.route("**/api/tavern/v1/draft", (route) => route.fulfill(jsonOk(draft)));
  await page.route("**/api/tavern/v1/companions", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, companions: overrides.companions ?? [] })),
  );
  await page.route("**/api/tavern/v1/companions/*/worldbook", (route) =>
     route.fulfill(jsonOk(overrides.companionWorldBook ?? { apiVersion: 1, present: false, revision: null, entries: [] })),
  );
  await page.route("**/api/tavern/v1/persona", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null })),
  );
  await page.route("**/api/tavern/v1/scenario", (route) =>
    route.fulfill(
      jsonOk({ apiVersion: 1, present: false, revision: null, name: null, description: null, preview: null }),
    ),
  );
  await page.route("**/api/tavern/v1/greeting", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, present: false, revision: null, label: null, variants: [] })),
  );
  await page.route("**/api/tavern/v1/import-history", (route) =>
    route.fulfill(jsonOk({ apiVersion: 1, entries: [] })),
  );
}

/** The card decoder's report for a card with two lorebook entries, as the Host would stage it. */
export const stagedCard = (): Record<string, unknown> => ({
  apiVersion: 1,
  importId: importIdHandle,
  name: "Nova",
  candidateRevision: 1,
  fields: [
    { field: "name", eligibility: "profile_eligible_after_explicit_review", chars: 4 },
    { field: "persona_core", eligibility: "profile_eligible_after_explicit_review", chars: 19 },
    { field: "worldbook_st-v3-1", eligibility: "candidate_only", chars: 30 },
    { field: "worldbook_st-v3-2", eligibility: "candidate_only", chars: 18 },
  ],
  dispositions: [
    { field: "character_book", classification: "accepted_typed", reason: "bounded_inert_candidate" },
    {
      field: "alternate_greetings",
      classification: "dropped_unsupported",
      reason: "executable_or_prompt_control_field",
    },
  ],
});

export async function stubImportSuccess(page: Page): Promise<{
  imports: Array<Readonly<{ body: unknown; csrf: string | undefined }>>;
  reviews: Array<Readonly<{ body: unknown; csrf: string | undefined }>>;
  confirms: Array<Readonly<{ body: unknown; csrf: string | undefined }>>;
}> {
  const imports: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  const reviews: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  const confirms: Array<Readonly<{ body: unknown; csrf: string | undefined }>> = [];
  await page.route("**/api/tavern/v1/imports", async (route) => {
    imports.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill(jsonOk(stagedCard()));
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/review`, async (route) => {
    reviews.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill(
      jsonOk({
        apiVersion: 1,
        importId: importIdHandle,
        reviewedFields: ["name", "persona_core"],
        approvedAtMs: 1,
      }),
    );
  });
  await page.route(`**/api/tavern/v1/imports/${importIdHandle}/confirm`, async (route) => {
    confirms.push({ body: route.request().postDataJSON(), csrf: route.request().headers()["x-csrf-token"] });
    await route.fulfill(jsonOk({ apiVersion: 1, name: "Nova" }));
  });
  return { imports, reviews, confirms };
}

export async function openCharactersSurface(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Characters", exact: true }).click();
  await expect(page.getByTestId("characters-surface")).toBeVisible();
}

export async function chooseCardFile(page: Page, text: string): Promise<void> {
  await page.getByTestId("characters-surface").locator("[data-card-import-file]").setInputFiles({
    name: "nova.json",
    mimeType: "application/json",
    buffer: Buffer.from(text, "utf8"),
  });
}
