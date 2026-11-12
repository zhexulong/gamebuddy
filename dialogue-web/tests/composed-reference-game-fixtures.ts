/**
 * The composed reference-game document every journey in this directory mounts.
 *
 * One module rather than one copy per spec: the root the shell is given is the same
 * document in all of them, and a second hand-written copy of it would be the drift
 * `contract-mirror-keys-gate.test.mjs` exists to catch - a fixture that agrees with the
 * product today is a disagreement scheduled for later.
 */
import { expect, type Locator, type Page } from "./frontend-coverage";

export const token = "A".repeat(43);
export const handle = "B".repeat(42) + "A";
/** A second opaque handle, so a companion is never keyed by the Chat's own handle. */
export const characterHandle = "D".repeat(42) + "A";
export const csrfToken = "C".repeat(42) + "A";
export const expiresAtMs = 1_900_000_000_000;
export const cabinChoiceHandle = "E".repeat(42) + "A";

export const draft = { apiVersion: 1, revision: 4, text: "A durable delegated draft." };

export const chat = {
  apiVersion: 1,
  build: {
    browserContract: "tavern_browser_api/v1",
    profileId: "gamebuddy.chat-core.reference-pipeline",
  },
  csrfToken,
  browserSession: { expiresAtMs },
  operations: [],
  navigation: [{ itemId: "chat", labelKey: "tavern.nav.chat", availability: "available" }],
  selection: { chatHandle: handle, generation: 1, stateRevision: handle },
  chat: {
    companion: { name: "Mira", handle: "DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDA" },
    title: "Reference Game Chat",
    transcript: [
      {
        handle: "D".repeat(42) + "A",
        role: "companion",
        text: "The game projection is read-only.",
        locale: "und",
        order: 0,
        revision: 1,
      },
    ],
    // The body arrives in this same read. `/composed-reference-game/v1/state` carries
    // `{revision, present, text}`, so the shell needs no second route for the draft - and
    // `present` is the same fact as `text !== null`, written from one facade field
    // (`projectSnapshotDraftV1`, host/src/tavern/browser-contract/index.ts).
    draft: { revision: draft.revision, present: draft.text !== null, text: draft.text },
    turn: null,
    // The mount's World Info, which the Host projects from the same read its
    // `GET /world-info` answers from: empty is where a fresh product's library is.
    worldInfo: { state: "none", revision: handle, items: [] },
  },
  memory: { readAvailable: false, mutationAvailable: false, projectionRevision: null },
  eventStream: null,
};

export const game = {
  apiVersion: 1,
  build: { browserContract: "game_browser_api/v1", profileId: "gamebuddy.game.preview" },
  csrfToken,
  browserSession: { expiresAtMs },
  game: {
    prerequisites: { status: "unknown", detectedGame: null, missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 0 },
    compatibility: { status: "unchecked", message: null },
    attachment: { status: "none", generation: 0 },
    connectionStatus: "none",
    actionAuthority: "unavailable",
    role: null,
    companionName: null,
    selectedWorld: null,
    selectedSave: null,
    capabilitySummary: { available: false, count: 0 },
    latestOutcome: "none",
  },
};

export const root = {
  apiVersion: 1,
  build: {
    browserContract: "composed_reference_game_browser_api/v1",
    profileId: "gamebuddy.composed.reference-game",
  },
  chat,
  game,
};

/**
 * The panel's progress line for an in-flight Game operation.
 *
 * The panel renders one `role="status"` line per fact it has to state, and several of them
 * can be true at once - a resume in flight while the cabin handoff, on the same panel, states
 * that this farm has no cabin yet. A journey that means "the operation's own progress line"
 * has to say which one it means; `[data-tone="progress"]` is the tone every in-flight line
 * already carries.
 */
export function progressStatus(panel: ReturnType<Page["getByRole"]>) {
  return panel.locator('[role="status"][data-tone="progress"]');
}

/**
 * The Game surface is one of the shell's peer surfaces (design/104 §2), so a
 * journey reaches it the way a player does: through the AppBar entry. Every
 * assertion about the panel stays a behavioural assertion about the panel - it
 * just has to be selected first.
 */
export async function openGameDrawer(page: Page): Promise<void> {
  const surface = page.getByTestId("game-surface");
  // The selected surface restores itself from the URL, so this is "select if not
  // already selected": a journey that already has it shown (after a refresh)
  // does not click the entry again.
  if (await surface.isVisible()) return;
  await page.getByRole("button", { name: "Game", exact: true }).click();
  await expect(surface).toBeVisible();
}

/**
 * Step 1's other staging control, where the panel keeps it.
 *
 * The Host refuses setup until companion play has been enabled (`gameActivationRequired`), so the
 * guide leads with activation alone and offers setup behind "Already enabled companion play?".
 * A journey that means "set Stardew Valley up" opens that disclosure first - which is also the
 * only way a player reaches it.
 */
export async function openStagingAlternate(panel: ReturnType<Page["getByRole"]>): Promise<void> {
  const disclosure = panel.getByTestId("game-guide-step-one-alternate");
  await expect(disclosure).toBeVisible();
  await disclosure.locator("summary").click();
  await expect(disclosure.getByRole("button", { name: "Set up Stardew Valley" })).toBeVisible();
}

/**
 * The staged projection the Host really produces once the lifecycle owns a
 * staged Player Host (`game-browser-state-provider.test.ts` pins this exact
 * shape): prerequisites met, no instance yet, and the one expected generation.
 * It is the only wire signal that activation happened.
 */
export const stagedGame = {
  ...game,
  game: {
    ...game.game,
    prerequisites: { status: "met", detectedGame: "Stardew Valley", missingItems: [] },
    instance: { status: "none", gameTitle: null, generation: 1 },
  },
};

export const jsonOk = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/**
 * One player row's own shape, read from the row itself.
 *
 * It exists so the send journey can compare the optimistic row with the settled
 * one on the things a player actually sees change: the monogram beside the
 * bubble, the bubble's tone, radius, type and measure.
 */
export async function readPlayerRow(row: Locator) {
  return await row.evaluate((node) => {
    // The caller may hand this either the row itself or the block that carries it
    // (the optimistic line's marker element wraps the row), so the row is found
    // rather than assumed.
    const element = node.classList.contains("message") ? node : (node.querySelector(".message") ?? node);
    const bubble = element.querySelector<HTMLElement>(".message-bubble");
    const avatar = element.querySelector<HTMLElement>(".avatar");
    const box = bubble?.getBoundingClientRect() ?? null;
    const style = bubble === null || bubble === undefined ? null : getComputedStyle(bubble);
    return {
      isPlayerRow: element.classList.contains("player"),
      hasAvatar: avatar !== null && (avatar.textContent ?? "").trim().length > 0,
      bubbleBackground: style?.backgroundColor ?? null,
      bubbleRadius: style?.borderRadius ?? null,
      bubbleFontSize: style?.fontSize ?? null,
      bubbleWidth: Math.round(box?.width ?? 0),
      bubbleRight: Math.round(box?.right ?? 0),
    };
  });
}
