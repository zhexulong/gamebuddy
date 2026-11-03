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

import { loadHostModule, measure, report } from "./harness.mjs";

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
 * One case's measurement, at module scope rather than inside the `test()` that reports it: `present()`
 * awaits the bridge per op, and `node:test` instruments the async work a test body awaits, so a body
 * that ran these windows would charge the runner to the commit. See `measure`'s contract.
 */
async function measureCase({ size, text }) {
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
  return await measure({
    id: CASE,
    size,
    run: () => port.present(expression, admission),
  });
}

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
