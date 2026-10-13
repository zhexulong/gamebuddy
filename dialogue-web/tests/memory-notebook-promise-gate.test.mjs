/**
 * The notebook's promise is one production can keep.
 *
 * The Memory surface speaks to the player in the companion's own voice, and the
 * shipped promise said she writes entries down by herself while you talk and work
 * the farm. Production has no such writer. Magic Context's automatic promotion
 * (`memory.auto_promote`) is off - the Host sets it off in
 * `host/src/runtime-core.internal.ts` as a rollout gate - and it could not fill an
 * ordinary conversation even if it were on, because promotion runs only inside a
 * historian fold publish over an *anchored* compartment range, and the fold fires
 * at 65% of the model's usable window. Measured on the product's real runtime
 * store (2026-10-13): a five-turn run wrote no compartments, no chapters and no
 * memories, sat at 0.38% of a 750,000-token window, and reported
 * `times_execute_threshold_reached = 0` - roughly 487,500 tokens short of the
 * fold.
 *
 * So the rule this gate states, in the words of the product's own discovery
 * principle (`design/tasks/active/companion-surface-discovery-principle.md`:
 * "没有入口的功能不写进界面，也不在文案里许诺"): the notebook's promise and its empty
 * state may name the route that exists - the player asking her to keep something -
 * and must not claim automatic accumulation.
 *
 * The assertions read the shipped catalogue itself (`memoryNotebookLabels`), not a
 * copy of its text, so a reworded promise is judged on what it now says. The
 * mutation case pins the detector against the promise that actually shipped, so
 * this gate cannot pass vacuously.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { memoryNotebookLabels } from "../src/components/memory-notebook-labels.ts";

/**
 * Phrases that claim the notebook gains entries without the player asking. The
 * subject is her (or "it"/"the notebook"): a sentence that merely mentions
 * writing down what the player asked for does not match.
 */
const AUTOMATIC_WRITER_PATTERNS = [
  /\bwrites?( this| it| these| them)? down\b/u,
  /\bwriting (this|it|them|these) down\b/u,
  /\bfills? (it|in|itself)\b/u,
  /\bfills in as\b/u,
  /\bnever have to fill\b/u,
  /\bby herself\b/u,
  /\bas you (talk|chat|play|work)\b/u,
  /自己写/u,
  /自己记下/u,
  /填满/u,
  /慢慢填/u,
  /不用动手/u,
  /会把这些事/u,
];

function automaticWriterClaims(text) {
  return AUTOMATIC_WRITER_PATTERNS.filter((pattern) => pattern.test(text)).map((pattern) => String(pattern));
}

test("notebook-promise.1: the promise names the player's own route and claims no automatic writer", (t) => {
  const failures = [];
  let checked = 0;
  for (const locale of ["en", "zh-CN"]) {
    const notebook = memoryNotebookLabels(locale);
    for (const key of ["promise", "empty"]) {
      checked += 1;
      const text = notebook[key];
      const claims = automaticWriterClaims(text);
      if (claims.length > 0)
        failures.push(`${locale}.${key} promises an automatic writer: ${JSON.stringify(text)} via ${claims.join(", ")}`);
      if (key === "promise" && !/\byou\b|\byour\b|你/u.test(text))
        failures.push(`${locale}.${key} must name the player's own route: ${JSON.stringify(text)}`);
    }
  }
  t.diagnostic(`notebook-promise.1: ${checked} promise/empty string(s) checked, ${failures.length} violation(s)`);
  assert.deepEqual(failures, [], "the notebook may only promise the route production really has");
});

test("notebook-promise.2 (mutation): the copy that shipped is reported by the same detector", (t) => {
  // The exact strings this gate exists for. A detector that did not fire on them
  // would be measuring nothing.
  const shipped = {
    en: "Your companion writes this down while you talk and work the farm — you never have to fill anything in.",
    zh: "你聊天、打理农场的时候，伴侣会把这些事自己写进手札——你不用动手填。",
    emptyEn: "Nothing written down yet. It fills in as you talk.",
    emptyZh: "还没有记下什么。随着你们聊天，它会慢慢填满。",
  };
  for (const [label, text] of Object.entries(shipped)) {
    const claims = automaticWriterClaims(text);
    assert.ok(claims.length > 0, `${label} must be reported as an automatic-writer claim`);
    t.diagnostic(`notebook-promise.2: ${label} reported via ${claims.join(", ")}`);
  }
});
