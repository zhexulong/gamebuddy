/**
 * A captured live Chat run, reshaped into the transcript the conversational-quality gate reads.
 *
 * The gate at `tools/check-chat-conversational-quality-gate.mjs` has four dimensions and its only
 * input today is a hand-written fixture - so it proves the gate can judge a transcript, not that the
 * product behaves on a real turn. The live run already captures every provider request body (the
 * stub provider records `{ method, url, body }` and `body.messages` is the whole wire), so the
 * missing piece is a converter, not a new instrument.
 *
 * What converts, and what does not - this is the part worth being precise about:
 *
 *   prefixBitStability        converts. It reads the M0 stable block out of the turn, and
 *                             `extractM0StableContext` already accepts `systemPrompt`, scanning it for
 *                             `<gamebuddy-authored-context>` / `<gamebuddy-stable-context>`. The live
 *                             capture has that string, so this dimension runs on real data.
 *
 *   semanticMemoryRetention   does NOT convert. It needs `expectations.needleFacts` - a declaration of
 *   memorySuperseded...       which fact should survive and where. Nobody has declared one for a real
 *   lorebookTriggerPrecision  run, and inventing one here would produce a green that means "the gate
 *                             agreed with a claim this file made up". They stay absent, and the gate
 *                             answers `blocked: no_needle_tests_specified`, which is the honest answer.
 *
 * So the transcript this produces is deliberately PARTIAL: one dimension observable, three explicitly
 * not. A reader who sees three blocked dimensions should conclude "nothing declared those", not
 * "the product failed them".
 */

/* Reuses the wire-contract reader rather than a second copy: the content shape (string vs array of
 * `{type,text}` parts) is one fact, and the first version of this file got it wrong by re-deriving it. */
import { wireMessageText } from "./wire-contract.mjs";

/**
 * The M0 stable block, or undefined when this turn's system prompt carries none.
 *
 * Text is read through `wireMessageText`, not `typeof content === "string"`: the wire sends content as
 * an array of `{ type, text }` parts on some turns, and a string-only reader silently yields "" for
 * them. Measured 2026-11-01 - my first version did exactly that, and a real live run reported
 * `turns: 1 (0 carrying an M0 stable block)` while the M0 was in fact present.
 */
function stableContextOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  const system = messages.find((message) => message?.role === "system");
  const text = wireMessageText(system);
  if (text.length === 0) return undefined;
  const authored = /<gamebuddy-authored-context[\s\S]*?<\/gamebuddy-authored-context>/u.exec(text);
  if (authored !== null) return authored[0];
  const stable = /<gamebuddy-stable-context[\s\S]*?<\/gamebuddy-stable-context>/u.exec(text);
  return stable === null ? undefined : stable[0];
}

/** The last user message in the request, which is the player's line for this turn. */
function playerInputOf(request) {
  const messages = Array.isArray(request?.messages) ? request.messages : [];
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "user") return wireMessageText(messages[index]);
  }
  return "";
}

/**
 * One turn of the transcript per captured provider request.
 *
 * Two fields are deliberately NOT derived, and the reason each matters:
 *
 *   modelResponse  the stub provider answers with a fixed body, so recording it would put a sentence
 *                  in the transcript that no model produced - and the field is named for the model's
 *                  reply. The three dimensions that read it are the same three that need
 *                  `expectations`, so nothing observable is lost by omitting it.
 *
 *   m0StableContextXml  only when the run's system prompt actually carries an authored block. The
 *                  `run-wire-contract-live` composition publishes a bare Chat profile with no
 *                  authored context, so a transcript from THAT run has no M0 and the prefix dimension
 *                  cannot measure it. Measured 2026-11-01: it reports `turns: 1 (0 carrying an M0)`,
 *                  and that is the truth about that composition rather than a reader bug.
 */
export function transcriptFromLiveRun({ requests, identity = {}, description = "" }) {
  const bodies = (Array.isArray(requests) ? requests : [])
    .map((entry) => entry?.body ?? entry)
    .filter((body) => body !== undefined && body !== null);

  const turns = bodies.map((body, index) => {
    const stableContext = stableContextOf(body);
    return Object.freeze({
      turnIndex: index,
      ...(stableContext === undefined
        ? {}
        : { contextComponents: Object.freeze({ m0StableContextXml: stableContext }) }),
      playerInput: playerInputOf(body),
    });
  });

  return Object.freeze({
    schema: "gamebuddy_chat_quality_transcript/v1",
    description:
      description.length > 0
        ? description
        : "Captured from a real Chat live run by tools/live-run/chat/transcript-from-live-run.mjs. " +
          "prefixBitStability is observable here; the other three dimensions need expectations nobody " +
          "has declared for a live run, and the gate reports them blocked rather than passing them.",
    identity: Object.freeze({ ...identity }),
    turns: Object.freeze(turns),
    /* Named absence: the three dimensions that cannot run, and why. */
    notObservable: Object.freeze({
      semanticMemoryRetention: "no needleFacts declared for this run",
      memorySupersededAntiHallucination: "no supersedeTests declared for this run",
      lorebookTriggerPrecision: "no lorebookRules declared for this run",
    }),
  });
}

/** Whether any turn carried an M0 block, so the caller can say "unobserved" instead of "0 turns". */
export function countsOf(transcript) {
  const turns = Array.isArray(transcript?.turns) ? transcript.turns : [];
  const withStable = turns.filter((turn) => turn.contextComponents?.m0StableContextXml !== undefined).length;
  return Object.freeze({ turns: turns.length, withStable });
}
