import { expect, test, type Page } from "./frontend-coverage";
import {
  armedRows,
  deriveChatUIState,
  fieldLocked,
  isTurnInFlight,
  replyHasNoModel,
  sendRefused,
  type ChatArmedAction,
  type ChatUIState,
  type ChatUIStateInputs,
} from "../src/components/chat-ui-state";
import type { ChatModelRoute } from "../src/chat-model-route";

/**
 * The Chat surface's one state, and the combinations it makes unrepresentable.
 *
 * These are the failures each test catches - the reason the assertion exists, not a
 * restatement of the code:
 *
 * 1. `a surface with nothing in flight cannot carry a turn's own facts` - the composer used
 *    to be driven by `isGenerating` and `canStop` as two independent booleans, so "Stop, with
 *    no turn to stop" was a state the type allowed (the shell's own derivation happens to make
 *    it unreachable; nothing stopped the next reader from constructing it). In the union a
 *    Stop exists only inside `streaming`, which requires a mounted turn, so there is no field
 *    for the other combination to live in.
 * 2. `one armed act names exactly one row` - the three confirmations were three independent
 *    nullable handles whose mutual exclusion was a convention re-stated in three handlers.
 *    One value means an arm can never name two rows, and the per-row flags are a total
 *    function of it.
 * 3. `the send gate answers both questions at once` - the field's lock (`disabled`) and "a
 *    reply has no model" (`sendUnavailable`) were two booleans for one question, and the
 *    standing banner read the second fact a second time (`modelRoute.kind === "none"` in
 *    ChatSurface, twice). Every gate is cross-checked against the two inputs it is built from,
 *    so a predicate that drifts from the pair fails here instead of on one of the two readers.
 * 4. `the phases partition the turn facts` - the three phases are the whole answer: a mounted
 *    turn is `streaming`, a held submission with no turn is `submitting`, neither is `idle`,
 *    and `isTurnInFlight` agrees with the pair it was derived from.
 * 5. The mounted tests below read the controls the player actually sees, one per phase: a
 *    phase whose slot renders the wrong control (a disabled Send standing in for a running
 *    turn, a Stop where the Host cannot cancel) is the frozen-surface defect this state exists
 *    to make impossible.
 */

const INPUTS: ChatUIStateInputs = {
  submissionInFlight: false,
  turn: null,
  pendingLine: null,
  stopAvailable: false,
  submitAvailable: true,
  messageMutationInFlight: false,
  modelRoute: { kind: "connection" },
  armed: null,
};

function inputs(patch: Partial<ChatUIStateInputs>): ChatUIStateInputs {
  return { ...INPUTS, ...patch };
}

const TURN = Object.freeze({ handle: "T".repeat(42) + "A", canCancel: true });
const PENDING = Object.freeze({ idempotencyKey: "K".repeat(42) + "A", text: "Are you there?" });

test("a surface with nothing in flight cannot carry a turn's own facts", () => {
  // The Host says this exact turn can be cancelled, but no turn is mounted and no submission is
  // held: the old props made this `canStop: true, isGenerating: false`, and the composer silently
  // ignored it. There is nowhere to put it now.
  const nothing = deriveChatUIState(inputs({ stopAvailable: true }));
  expect(nothing.phase).toBe("idle");
  expect("canStop" in nothing, "an idle surface has no field saying a turn may be stopped").toBe(false);
  expect("turnId" in nothing, "and none naming a turn").toBe(false);

  // A submission the Host holds but has not mounted a turn for is busy, and still has nothing to
  // cancel - the whole queued window this phase exists for.
  const submitting = deriveChatUIState(inputs({ submissionInFlight: true, stopAvailable: true, pendingLine: PENDING }));
  expect(submitting.phase).toBe("submitting");
  expect("canStop" in submitting, "a held submission has no turn, so no Stop").toBe(false);

  // A mounted turn is the only phase that carries the pair.
  const streaming = deriveChatUIState(inputs({ submissionInFlight: true, turn: TURN, stopAvailable: true }));
  expect(streaming.phase).toBe("streaming");
  expect(streaming).toMatchObject({ turnId: TURN.handle, canStop: true });
});

test("one armed act names exactly one row", () => {
  const arms: readonly ChatArmedAction[] = [
    { action: "delete", targetId: "D".repeat(42) + "A", expectedOrder: 2 },
    { action: "rewind", targetId: "R".repeat(42) + "A", expectedOrder: 3 },
    { action: "swipe_remove", targetId: "S".repeat(42) + "A" },
  ];
  for (const armed of arms) {
    const state = deriveChatUIState(inputs({ armed }));
    const rows = armedRows(state);
    const named = [rows.delete, rows.rewind, rows.swipeRemove].filter((target) => target !== null);
    expect(named, `arming ${armed.action} names one row, not two`).toEqual([armed.targetId]);
    expect(Object.keys(state).filter((key) => key === "armed"), "the state carries one arm, not one per verb").toHaveLength(1);
  }
  expect(armedRows(deriveChatUIState(INPUTS)), "no arm names no row").toEqual({
    delete: null,
    rewind: null,
    swipeRemove: null,
  });
});

test("the send gate answers all three questions at once", () => {
  const routes: readonly ChatModelRoute[] = [{ kind: "connection" }, { kind: "none" }, { kind: "unknown" }];
  for (const submitAvailable of [true, false]) {
    for (const messageMutationInFlight of [true, false]) {
      for (const modelRoute of routes) {
        const { send } = deriveChatUIState(inputs({ submitAvailable, messageMutationInFlight, modelRoute }));
        const where = `submitAvailable=${submitAvailable} mutation=${messageMutationInFlight} route=${modelRoute.kind}`;
        // The field follows "would a submission be admitted now": the Host's own answer, and the fact
        // that this surface is not mid-rewrite of the transcript it would be written into.
        const admitted = submitAvailable && !messageMutationInFlight;
        expect(fieldLocked(send), `field lock at ${where}`).toBe(!admitted);
        // The standing sentence follows the model route, and nothing else.
        expect(replyHasNoModel(send), `no-model banner at ${where}`).toBe(modelRoute.kind === "none");
        // Send is refused for any of the reasons - which is why the facts had to become one answer.
        expect(sendRefused(send), `send refusal at ${where}`).toBe(!admitted || modelRoute.kind === "none");
      }
    }
  }
});

test("the phases partition the turn facts", () => {
  for (const submissionInFlight of [true, false]) {
    for (const turn of [TURN, null]) {
      const state = deriveChatUIState(inputs({ submissionInFlight, turn }));
      const expected = turn !== null ? "streaming" : submissionInFlight ? "submitting" : "idle";
      expect(state.phase, `turn=${turn !== null} submission=${submissionInFlight}`).toBe(expected);
      expect(isTurnInFlight(state)).toBe(turn !== null || submissionInFlight);
    }
  }
});

/** The probe's own entry point: one state in, the real composer band re-rendered from it. */
async function openProbe(page: Page): Promise<void> {
  await page.goto("/tests/chat-surface-probe.html");
  await page.waitForFunction(() => (window as unknown as { chatProbe?: unknown }).chatProbe !== undefined);
}

async function setState(page: Page, state: ChatUIState): Promise<void> {
  await page.evaluate(
    (value) =>
      (window as unknown as { chatProbe: { setChatUIState(next: unknown): void } }).chatProbe.setChatUIState(value),
    state,
  );
}

/** What the composer band is actually showing: the controls a player can press. */
async function controls(page: Page) {
  return page.evaluate(() => {
    const section = document.querySelector<HTMLElement>(".composer-section");
    if (section === null) throw new Error("the composer band is not mounted");
    const send = section.querySelector<HTMLButtonElement>(".send-button");
    return {
      send: section.querySelectorAll(".send-button").length,
      stop: section.querySelectorAll(".stop-button").length,
      busy: section.querySelectorAll("[data-composer-busy]").length,
      fieldDisabled: section.querySelector<HTMLTextAreaElement>(".composer-textarea")!.disabled,
      sendDisabled: send === null ? null : send.disabled,
    };
  });
}

test("idle offers Send, and only Send", async ({ page }) => {
  await openProbe(page);
  await page.locator(".composer-textarea").fill("Are you there?");
  await setState(page, deriveChatUIState(inputs({})));

  expect(await controls(page)).toEqual({
    send: 1,
    stop: 0,
    busy: 0,
    fieldDisabled: false,
    sendDisabled: false,
  });
});

test("idle with no model keeps the field writable and refuses the send", async ({ page }) => {
  await openProbe(page);
  await page.locator(".composer-textarea").fill("Are you there?");
  await setState(page, deriveChatUIState(inputs({ modelRoute: { kind: "none" } })));

  expect(await controls(page)).toEqual({
    send: 1,
    stop: 0,
    busy: 0,
    // The one thing that still works while the player goes and brings a connection.
    fieldDisabled: false,
    sendDisabled: true,
  });
});

test("submitting is busy, with the field locked and nothing to stop", async ({ page }) => {
  await openProbe(page);
  await page.locator(".composer-textarea").fill("Are you there?");
  await setState(page, deriveChatUIState(inputs({ submissionInFlight: true, pendingLine: PENDING, submitAvailable: false })));

  expect(await controls(page)).toEqual({
    send: 0,
    stop: 0,
    busy: 1,
    // The Host projects `chat.submit` busy while it holds the submission.
    fieldDisabled: true,
    sendDisabled: null,
  });
});

test("streaming the Host can cancel offers Stop, and only Stop", async ({ page }) => {
  await openProbe(page);
  await page.locator(".composer-textarea").fill("Are you there?");
  await setState(page, deriveChatUIState(inputs({ turn: TURN, stopAvailable: true, submitAvailable: false })));

  expect(await controls(page)).toEqual({
    send: 0,
    stop: 1,
    busy: 0,
    fieldDisabled: true,
    sendDisabled: null,
  });
});

test("streaming the Host cannot cancel says it is busy instead of greying out Send", async ({ page }) => {
  await openProbe(page);
  await page.locator(".composer-textarea").fill("Are you there?");
  await setState(page, deriveChatUIState(inputs({ turn: TURN, stopAvailable: false, submitAvailable: false })));

  expect(await controls(page)).toEqual({
    send: 0,
    stop: 0,
    busy: 1,
    fieldDisabled: true,
    sendDisabled: null,
  });
});
