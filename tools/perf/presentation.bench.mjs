/**
 * The Game presentation commit: the last Host boundary before text becomes player-visible.
 *
 * `createFarmhandCompanionPresentationPort().present()` reasserts the Host admission and the
 * interruption epoch twice around the one write, refuses an expression without a source-owned
 * event, strips Magic Context's `§N§` self-tag, and hands the typed request to the bridge. It runs
 * once per player-visible bubble, so its cost is on the path of every companion line in a live run.
 *
 * The op is one commit against a bridge stub that resolves immediately: what is measured is the
 * port's own work, not a fake transport's. The text is the input that scales - a short line, and
 * a long one carrying many self-tags, because the strip is a whole-string pass and that is the
 * part whose cost follows the text.
 *
 * The run trace span a real commit also opens is the `trace.export` case's subject, so it is not
 * folded into this number.
 */
import test from "node:test";

import { loadHostModule, measure, measureRatio, report, reportScaling, scalingRequested } from "./harness.mjs";

const CASE = "presentation.commit";

const { createCompanionInterruption } = await loadHostModule("companion-interruption.js");
const { createFarmhandCompanionPresentationPort, createFarmhandPresentationEpochAdmission } = await loadHostModule(
  "farmhand-companion-presentation.js",
);

const SIZES = Object.freeze([
  Object.freeze({ size: "small", text: "§12§ 我在地里，工具放在门口了。" }),
  Object.freeze({
    size: "large",
    text: Array.from({ length: 160 }, (_, index) => `§${index + 1}§ 今天的活干完了，明天再说。`).join(""),
  }),
]);

/**
 * What the commit's cost may do with the text, and why.
 *
 * The strip is two whole-string passes, so a commit that reads the text costs what the text costs plus
 * a fixed admission/validation overhead that the short line is almost entirely made of. Measured on
 * this machine the pair (46 bytes -> 7 412 bytes, 161x) read 0.58 -> 5.96 µs/op, ratio 10.3: linear in
 * the text, damped by that ~0.55 µs fixed part. A quadratic strip would grow the text's part 161x over
 * again and read ~1 500, and a strip that stopped reading the text at all would read ~1 - which is why
 * the band has a floor and not only a ceiling. The ceiling of 26 is 2.5x the measured ratio.
 */
const SCALING_BAND = Object.freeze({
  min: 2,
  max: 26,
  reason:
    "161x the text measured 10.3 (linear in the text, damped by a ~0.55 µs fixed admission); " +
    "a quadratic strip reads ~1 500, a strip that stopped reading the text reads ~1",
});

/**
 * The op for one text, plus the input field it scales with. Both branches of this file build their
 * fixtures here, so a ratio and a budget reading describe the same work.
 */
function caseFor({ text }) {
  const epochAdmission = createFarmhandPresentationEpochAdmission(createCompanionInterruption());
  const hostBinding = Object.freeze({});
  const admission = Object.freeze({
    hostBinding,
    assertHostCurrent(binding) {
      if (binding !== hostBinding) throw new Error("perf_case_stale_host_binding");
    },
  });
  const bridge = Object.freeze({
    state: Object.freeze({ snapshot: Object.freeze({ revision: 7 }) }),
    async presentCompanionText() {},
    async presentSystemNotice() {},
  });
  const port = createFarmhandCompanionPresentationPort(bridge, epochAdmission);
  const expression = Object.freeze({
    surface: "game",
    expressionId: "expression-1",
    sessionId: "session-1",
    sourceEventId: "event-1",
    text,
    locale: "zh-CN",
  });
  return {
    input: Object.freeze({ textBytes: Buffer.byteLength(text, "utf8") }),
    run: () => port.present(expression, admission),
  };
}

/**
 * One case's measurement, at module scope rather than inside the `test()` that reports it: `present()`
 * awaits the bridge per op, and `node:test` instruments the async work a test body awaits, so a body
 * that ran these windows would charge the runner to the commit. See `measure`'s contract.
 */
async function measureCase(size) {
  return await measure({ id: CASE, size: size.size, run: caseFor(size).run });
}

if (scalingRequested()) {
  const points = SIZES.map((size) => ({ size: size.size, ...caseFor(size) }));
  const ratio = await measureRatio({ id: CASE, axis: "textBytes", points });
  test(`${CASE} scaling`, () => reportScaling(ratio, SCALING_BAND));
} else {
  const outcomes = new Map();
  for (const size of SIZES) {
    try {
      outcomes.set(size.size, { measured: await measureCase(size) });
    } catch (error) {
      // The case that could not be measured fails its own test below, instead of taking the other
      // size's finished measurement down with the file's module load.
      outcomes.set(size.size, { error });
    }
  }

  for (const { size, text } of SIZES) {
    test(`${CASE} ${size}`, () => {
      const outcome = outcomes.get(size);
      if (outcome.error !== undefined) throw outcome.error;
      report({ ...outcome.measured, detail: { textBytes: Buffer.byteLength(text, "utf8") } });
    });
  }
}
