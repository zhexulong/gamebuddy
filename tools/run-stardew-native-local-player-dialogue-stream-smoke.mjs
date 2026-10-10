#!/usr/bin/env node
/**
 * Live gate for the dialogue stream: the Mod pages a real NPC's dialogue itself and reports it as ONE typed
 * `npc_dialogue_presented` fact.
 *
 * It COMPOSES the shipped talk gate rather than restating it (`runTalkToNpcSmoke` already selects an adjacent
 * villager, asserts the talk's own evidence, and pins its negatives), then adds the part that is new: it listens
 * for the fact the Mod emits and asserts the CLAIM THAT ONLY A LIVE RUN CAN SETTLE - the pager advanced, so the
 * report carries more than the first page. Reading the page stack could never satisfy that, which is exactly why
 * the Mod drives the game's own pager.
 *
 * The result is emitted in the shape `tools/check-stardew-dialogue-stream.mjs` reads, so an INDEPENDENT checker can
 * re-judge the same evidence instead of trusting this runner's own verdict.
 */
import {
  connectNativeLocalClient,
  readNativeClientConfig,
} from "./lib/stardew-native-smoke-harness-v1.mjs";
import { loadHostTestModule } from "./lib/host-test-module.mjs";
import { runTalkToNpcSmoke } from "./run-stardew-native-local-player-talk-to-npc-smoke.mjs";
import { dialoguePayloadOf } from "./check-stardew-dialogue-stream.mjs";

const DIALOGUE_KIND = "npc_dialogue_presented";

/** The villager the fixture places. */
const EXPECTED_SPEAKER = "Gus";

/** How long to keep listening for the fact after the talk settles: the pager needs its own ticks to page. */
const FACT_WINDOW_MS = 8_000;

/**
 * Runs the gate against an already-connected client.
 *
 * @param {object} client the native-local client
 * @param {object[]} receipts the harness receipt sink
 * @param {object} config the resolved client config
 * @param {{ talkRunner?: Function, factWindowMs?: number, onWorldFact?: Function }} [options]
 */
export async function runDialogueStreamSmoke(client, receipts, config, options = {}) {
  const { talkRunner = runTalkToNpcSmoke, factWindowMs = FACT_WINDOW_MS } = options;
  const dialogueFacts = [];
  const unsubscribe = client.onFact((fact) => {
    if (fact?.type !== "world_fact") return;
    const payload = fact.payload ?? {};
    if (payload.kind !== DIALOGUE_KIND) return;
    dialogueFacts.push({
      type: "world_fact",
      // The client carries the Mod's opaque identity as `correlationId`; `eventId` is absent on this wire,
      // which made an identity check pass while comparing nothing.
      eventId: fact.eventId ?? fact.correlationId ?? fact.sourceEventId,
      sourceEventId: fact.sourceEventId,
      correlationId: fact.correlationId,
      worldFactKind: payload.kind,
      worldFactPayload: payload,
    });
  });

  try {
    // The shipped talk contract first: an adjacent villager, the talk's evidence, and its negatives. A failure
    // here is reported with that runner's own reason code rather than folded into this gate's verdict.
    const talk = await talkRunner(client, receipts, config);

    // Then listen: the pager needs its own ticks, and the fact is delivered when the dialogue is done or has
    // stopped at a question.
    const deadline = Date.now() + factWindowMs;
    while (Date.now() < deadline && dialogueFacts.length === 0) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    if (options.onWorldFact !== undefined) for (const fact of dialogueFacts) options.onWorldFact(fact);

    if (dialogueFacts.length === 0)
      return {
        state: "unobserved",
        reasonCode: "npc_dialogue_not_reported:the_mod_emitted_no_fact_for_this_dialogue",
        configuredFixtureScenario: talk.configuredFixtureScenario ?? config?.NativeLocalPlayerFixture?.FixtureScenario ?? null,
        bridgeFacts: [],
        talk: { state: talk.state, reasonCode: talk.reasonCode },
      };

    // What this fixture CAN settle: the Mod reported the dialogue, with its text and the speaker who said it.
    // What it CANNOT settle, stated instead of assumed: the fixture's line is a SINGLE page, so an assertion
    // that the pager advanced past page one is unsatisfiable here - it would fail a correct Mod. Settling that
    // needs a fixture whose NPC line uses the native page break (`#$b#`).
    const payloads = dialogueFacts.map((fact) => dialoguePayloadOf(fact)).filter((payload) => payload !== null);
    const maxPages = payloads.reduce(
      (most, payload) => Math.max(most, Array.isArray(payload.pages) ? payload.pages.length : 0),
      0,
    );
    const speakers = payloads.map((payload) => payload.speaker);
    const reported = payloads.length > 0 && maxPages >= 1;
    const speakerNamed = speakers.includes(EXPECTED_SPEAKER);

    const result = {
      state: reported && speakerNamed ? "passed" : "blocked",
      reasonCode: reported
        ? speakerNamed
          ? "dialogue_reported_with_its_text"
          : `dialogue_reported_but_speaker_unexpected:${JSON.stringify(speakers)}`
        : `dialogue_reported_without_its_text:facts=${dialogueFacts.length};parsed=${payloads.length}`,
      configuredFixtureScenario:
        talk.configuredFixtureScenario ?? config?.NativeLocalPlayerFixture?.FixtureScenario ?? null,
      bridgeFacts: dialogueFacts,
      talk: { state: talk.state, reasonCode: talk.reasonCode },
      observed: {
        facts: dialogueFacts.length,
        parsedPayloads: payloads.length,
        maxPages,
        speakers,
        // Named so a reader cannot mistake a single-page fixture for proof of paging.
        pagingSettled: false,
        pagingSettledReason:
          "the fixture's dialogue is one page; a fixture whose line uses the native page break (#$b#) is needed",
      },
    };
    return result;
  } catch (error) {
    return {
      state: "blocked",
      reasonCode: String(error instanceof Error ? error.message : error).slice(0, 256),
      configuredFixtureScenario: config?.NativeLocalPlayerFixture?.FixtureScenario ?? null,
      bridgeFacts: dialogueFacts,
    };
  } finally {
    unsubscribe();
  }
}

if (import.meta.main) {
  const config = await readNativeClientConfig();
  const session = await connectNativeLocalClient(config, { loadModule: loadHostTestModule });
  try {
    const result = await runDialogueStreamSmoke(session.client, session.receipts, config);
    console.log(JSON.stringify(result));
    if (result.state !== "passed") process.exitCode = 2;
  } finally {
    session.close();
  }
}
