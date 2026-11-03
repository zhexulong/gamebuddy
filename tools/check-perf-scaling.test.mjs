/**
 * The scaling gate's own checks: the decider it uses, and the measurement it decides on.
 *
 * Nothing here spawns the bench suite - that is what the gate itself does, and a falsifier that
 * re-ran it would be as slow as the thing it gates. The decider is a pure function, so it is driven
 * directly with readings of every rejected shape; and the measurement is driven with two closures
 * over the same axis, one linear and one genuinely quadratic, so the pair of them proves the
 * instrument separates "cost follows the input" from "cost follows the input squared".
 *
 * red-proof: inject  a nested loop over the input in one measured closure (linear vs n^2 on the same
 *                    axis) -> the quadratic pair reads outside the declared band and the gate's
 *                    decider names its case, while the linear pair stays inside
 *                    (tools/check-perf-scaling.test.mjs)
 */
import assert from "node:assert/strict";
import test from "node:test";

import { evaluateScaling } from "./check-perf-scaling.mjs";
import { measureRatio } from "./perf/harness.mjs";

const BAND = Object.freeze({ min: 1.2, max: 3.2, reason: "doubling the input must cost less than 3.2x" });

/** One reading as a bench file reports it, so the decider is driven with the real shape. */
const reading = (overrides) => ({
  id: "case.under.test",
  axis: "items",
  multiple: 2,
  ratio: 2,
  points: [
    { size: "small", value: 100, ops: 10, perOpMicros: 1, durationMs: 10 },
    { size: "large", value: 200, ops: 10, perOpMicros: 2, durationMs: 20 },
  ],
  band: BAND,
  ...overrides,
});

test("a ratio outside its band is a finding that names the case, both sizes and the band", () => {
  const findings = evaluateScaling([{ file: "tools/perf/case.bench.mjs", readings: [reading({ ratio: 4.01 })] }]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].code, "ratio_out_of_band");
  assert.equal(findings[0].case, "case.under.test");
  assert.match(findings[0].detail, /2x items cost 4\.01x the per-op time, outside the declared band \[1\.2, 3\.2\]/u);
  assert.match(findings[0].detail, /doubling the input must cost less than 3\.2x/u);
});

test("a ratio inside its band, at either edge, is not a finding", () => {
  const findings = evaluateScaling([
    { file: "tools/perf/case.bench.mjs", readings: [reading({ ratio: 1.2 }), reading({ ratio: 3.2 })] },
  ]);
  assert.deepEqual(findings, []);
});

test("a bench file that reported no pair, a reading with no band, and a pair that does not grow are findings", () => {
  const findings = evaluateScaling([
    { file: "tools/perf/silent.bench.mjs", readings: [] },
    { file: "tools/perf/case.bench.mjs", readings: [reading({ band: undefined }), reading({ multiple: 1, ratio: 1 })] },
  ]);
  assert.deepEqual(
    findings.map((finding) => finding.code),
    ["scaling_absent", "band_not_declared", "axis_not_growing"],
  );
  assert.match(findings[0].detail, /silent\.bench\.mjs reported no PERF_SCALING_RESULT/u);
  assert.equal(findings[2].case, "case.under.test");
});

test("the measurement refuses a pair that differs on two inputs, and an axis that is not an input", async () => {
  const point = (size, input) => ({ size, input, run: () => undefined });
  await assert.rejects(
    measureRatio({
      id: "two.axes",
      axis: "a",
      points: [point("from", { a: 1, b: 1 }), point("to", { a: 2, b: 2 })],
      rounds: 1,
      warmupMs: 0,
    }),
    /scaling_pair_not_single_axis:two\.axes:a\+b!=a/u,
  );
  await assert.rejects(
    measureRatio({
      id: "no.axis",
      axis: "missing",
      points: [point("from", { a: 1 }), point("to", { a: 2 })],
      rounds: 1,
      warmupMs: 0,
    }),
    /scaling_pair_axis_not_an_input:no\.axis:missing/u,
  );
});

/**
 * The same axis at the same two sizes, once linear and once quadratic in it. Each closure returns
 * its total so the work cannot be optimised away, and each does enough per op (~45 µs at the small
 * size) that this box's scheduling noise cannot move the ratio the way it moves a sub-microsecond
 * op: the two shapes are what the band has to separate, not the machine's jitter.
 */
function closureFor(size, { quadratic }) {
  return () => {
    let total = 0;
    if (quadratic) {
      for (let outer = 0; outer < size; outer += 1)
        for (let inner = 0; inner < size; inner += 1) total += (outer ^ inner) & 1;
    } else {
      for (let index = 0; index < size * 300; index += 1) total += index & 1;
    }
    return total;
  };
}

test("a quadratic path on the measured axis reads outside the band, and a linear one inside it", async () => {
  const measure = async (quadratic) => {
    const [from, to] = [300, 600];
    return await measureRatio({
      id: quadratic ? "quadratic.path" : "linear.path",
      axis: "items",
      points: [
        { size: "small", input: { items: from }, run: closureFor(from, { quadratic }) },
        { size: "large", input: { items: to }, run: closureFor(to, { quadratic }) },
      ],
      rounds: 3,
      warmupMs: 0,
      windowMs: 60,
    });
  };

  const linear = await measure(false);
  const quadratic = await measure(true);
  const findings = evaluateScaling([
    {
      file: "tools/perf/injected.bench.mjs",
      readings: [
        { ...linear, band: BAND },
        { ...quadratic, band: BAND },
      ],
    },
  ]);

  assert.equal(linear.multiple, 2);
  assert.equal(quadratic.multiple, 2);
  // Linear in the input: the ratio is the input's own multiple, within the band.
  assert.ok(linear.ratio > 1.2 && linear.ratio < 3.2, `a linear path read ${linear.ratio}x, expected ~2x`);
  // Quadratic in the input: the ratio is the multiple SQUARED, which is what the band exists to refuse.
  assert.ok(quadratic.ratio > 3.2, `a quadratic path read ${quadratic.ratio}x, expected ~4x`);
  assert.equal(findings.length, 1, "only the quadratic pair may be reported");
  assert.equal(findings[0].code, "ratio_out_of_band");
  assert.equal(findings[0].case, "quadratic.path");
});
