import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { CompanionLoop } from "./companion-loop.js";

/**
 * NO PROMPT MAY CROSS A STOP THAT ALREADY SEALED THE TURN.
 *
 * <p>
 * A turn is created synchronously and then hands Pi its batch. Between those two moments it re-reads the player's
 * model selection (`CompanionTurnModelReload`) - the Game surface's only read of that selection, and the only place
 * this loop sits still with a turn already in existence and no prompt issued yet. STOP's per-turn cancellation is a
 * promise resolved by `abortAndClear`; the question this file answers, by driving the loop instead of reading it, is
 * whether a STOP that lands inside that pause still reaches Pi.
 * </p>
 *
 * <p>
 * Two readings, and neither stands alone. The runtime one drives a real `CompanionLoop` with a reload the test holds
 * open on purpose, stops it there, and counts what the fake Pi session was handed. The source one enumerates the
 * suspension points actually present between turn creation and the prompt, so a later `await` added to that prologue
 * cannot arrive unsealed and unproven - it fails here by name and line.
 * </p>
 */

const SEALED_RELOAD_AWAIT = "await this.#reloadModelSelectionUnlessSealed(cancelled)";
const TURN_SEAL_INSTALLATION = "this.#cancelQueuedDelivery = resolveCancelled;";
const FIRST_PROMPT = "sendUserMessage(batch,";
const LOOP_SOURCE_NAME = "host/src/companion-loop.ts";

/**
 * The Host root, found by walking up to the package that owns both the Host's test project and this source.
 *
 * The compiled test runs from `host/dist-test` and from ad-hoc staging trees under `host/.tmp`, so the walk is what
 * makes the same reading work from either instead of assuming one directory's parent.
 */
function hostRoot(start: string): string {
  let directory = start;
  for (;;) {
    if (existsSync(join(directory, "tsconfig.test.json")) && existsSync(join(directory, "src", "companion-loop.ts")))
      return directory;
    const parent = dirname(directory);
    if (parent === directory) throw new Error(`host root not found from ${start}`);
    directory = parent;
  }
}

const LOOP_SOURCE_PATH = join(hostRoot(dirname(fileURLToPath(import.meta.url))), "src", "companion-loop.ts");

type Listed = { readonly line: number; readonly text: string };

/**
 * Every suspension point the turn passes through between existing and prompting Pi, read from the loop's own source.
 *
 * The region is the prologue of `#deliverAndObserve`: it opens at the statement that installs this turn's
 * cancellation and closes at the first batch handed to Pi. Whatever else changes there, the turns of `await` inside it
 * are the moments a STOP can interleave with, and they are the population this gate owes an answer for.
 */
function prePromptSuspensions(): readonly Listed[] {
  const lines = readFileSync(LOOP_SOURCE_PATH, "utf8").split(/\r?\n/u);
  const start = lines.findIndex((line) => line.includes(TURN_SEAL_INSTALLATION));
  assert.notEqual(start, -1, `prompt_after_stop_anchor_missing:${LOOP_SOURCE_NAME}: ${TURN_SEAL_INSTALLATION}`);
  const prompt = lines.findIndex((line, index) => index > start && line.includes(FIRST_PROMPT));
  assert.notEqual(prompt, -1, `prompt_after_stop_prompt_missing:${LOOP_SOURCE_NAME}: ${FIRST_PROMPT}`);
  return lines
    .slice(start, prompt)
    .map((text, index) => ({ line: start + index + 1, text: text.trim() }))
    .filter((entry) => /(?:^|[^\w.$])await\s/u.test(entry.text));
}

test("prompt_after_stop_sealed: every suspension between turn creation and the prompt is the seal race", () => {
  const suspensions = prePromptSuspensions();
  for (const entry of suspensions)
    process.stderr.write(`prompt_after_stop_population:${LOOP_SOURCE_NAME}:${entry.line}: ${entry.text}\n`);
  if (suspensions.length === 0)
    throw new Error(
      `prompt_after_stop_population_empty:${LOOP_SOURCE_NAME}: the turn now reaches its prompt without suspending, so the window this gate seals no longer exists - retire the gate deliberately instead of letting it agree with itself`,
    );
  for (const entry of suspensions)
    assert.ok(
      entry.text.includes(SEALED_RELOAD_AWAIT),
      `prompt_after_stop_at:${LOOP_SOURCE_NAME}:${entry.line}: ${entry.text} - the turn suspends here after it exists and before Pi is prompted, so STOP can land in this window and the turn would resume into subscribe and sendUserMessage; race this turn's cancellation instead`,
    );
});

/**
 * The fake Pi session that records what the loop tried to do to it.
 *
 * `sendUserMessage` records the prompt and resolves without emitting `message_start`: that is the shape STOP's own
 * `clearQueue`/`abort` leave behind, a message accepted by the transport with no consumption claim and no listener
 * left to observe whatever the session does with it next.
 */
function recordingSession() {
  const prompts: string[] = [];
  const subscribes: string[] = [];
  const listeners = new Set<(event: unknown) => void>();
  return {
    prompts,
    subscribes,
    listeners,
    session: {
      async sendUserMessage(text: string) {
        prompts.push(text);
      },
      async abort() {},
      clearQueue() {},
      async waitForIdle() {},
      subscribe(next: (event: unknown) => void) {
        subscribes.push("subscribe");
        listeners.add(next);
        return () => {
          listeners.delete(next);
        };
      },
    },
  };
}

/** A loop whose only extra port is the model reload, so the turn's prologue is the one this file tests. */
function loopWithReload(session: object, reload: () => Promise<void>): CompanionLoop {
  return new CompanionLoop(session as never, undefined, undefined, undefined, undefined, reload);
}

function enqueuePlayerTurn(loop: CompanionLoop): void {
  loop.pump.enqueuePlayerInput({
    source: "player_text",
    inputId: "input_stopped_in_reload",
    eventId: "player_source_stopped_in_reload",
    text: "等等，先别动",
    locale: "zh-CN",
    timestampMs: 1,
  });
}

/** A model reload the test holds open: `entered` resolves once the turn stands still inside it, `release` ends it. */
function heldReload() {
  let calls = 0;
  let enter!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    reload: async () => {
      calls += 1;
      enter();
      await held;
    },
    get calls(): number {
      return calls;
    },
  };
}

test("prompt_after_stop_sealed: STOP inside the model reload never prompts Pi and leaves no listener", async () => {
  const recorded = recordingSession();
  const reload = heldReload();
  const loop = loopWithReload(recorded.session, reload.reload);
  enqueuePlayerTurn(loop);
  const flushing = loop.flush();
  await reload.entered;
  // The turn exists, the reload is in flight, and nothing has been handed to Pi yet.
  assert.equal(reload.calls, 1);
  assert.deepEqual(recorded.prompts, []);
  const stopping = loop.abortAndClear();
  await new Promise<void>((resolve) => setImmediate(resolve));
  reload.release();
  const [outcome] = await Promise.all([flushing, stopping]);
  // The observed calls, in the order the loop made them: this is the reading the assertions below judge.
  process.stderr.write(
    `prompt_after_stop_observed: prompts=${recorded.prompts.length} subscribes=${recorded.subscribes.length} listeners=${recorded.listeners.size}\n`,
  );
  assert.deepEqual(
    recorded.prompts,
    [],
    "STOP sealed this turn before it prompted Pi; nothing may reach the session after it",
  );
  assert.deepEqual(
    recorded.subscribes,
    [],
    "a turn STOP sealed before its prompt installs no listener it would then have to remove",
  );
  assert.equal(recorded.listeners.size, 0);
  assert.equal(outcome, "unobserved");
});

test("prompt_after_stop_sealed: STOP is not hostage to a reload that never settles", async () => {
  const recorded = recordingSession();
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const loop = loopWithReload(recorded.session, async () => {
    entered();
    await new Promise<void>(() => {});
  });
  enqueuePlayerTurn(loop);
  const flushing = loop.flush();
  await enteredPromise;
  const [outcome] = await Promise.all([flushing, loop.abortAndClear()]);
  assert.equal(outcome, "unobserved");
  assert.deepEqual(recorded.prompts, []);
  assert.equal(recorded.listeners.size, 0);
});

test("prompt_after_stop_sealed: a reload that fails still fails the turn and keeps its batch", async () => {
  const recorded = recordingSession();
  const loop = loopWithReload(recorded.session, async () => {
    throw new Error("model_selection_unusable");
  });
  enqueuePlayerTurn(loop);
  await assert.rejects(loop.flush(), /model_selection_unusable/u);
  assert.deepEqual(recorded.prompts, [], "an unusable selection fails the turn instead of prompting Pi with it");
  assert.equal(
    loop.pump.hasPendingDelivery,
    true,
    "the pump restores the exact batch so the retry asks the same question",
  );
});
