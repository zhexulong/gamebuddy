import { describe, expect, test } from "bun:test";
import { getDreamRunTaskDetail } from "./dream-run-detail";
import type { DreamRunTask } from "./types";

const task = (overrides: Partial<DreamRunTask> = {}): DreamRunTask => ({
  name: "verify-broad",
  durationMs: 1,
  resultChars: 0,
  ...overrides,
});

describe("getDreamRunTaskDetail", () => {
  test("renders new progress neutrally", () => {
    expect(getDreamRunTaskDetail(task({ progress: "verified 33, 0 remain" }), 0)).toEqual({
      text: "verified 33, 0 remain",
      tone: "neutral",
    });
  });

  test("keeps legacy progress-in-error readable without marking success red", () => {
    expect(
      getDreamRunTaskDetail(task({ error: "verify-broad cycle: verified 33, 0 remain" }), 0),
    ).toEqual({ text: "verify-broad cycle: verified 33, 0 remain", tone: "neutral" });
  });

  test("keeps genuine failures red", () => {
    expect(getDreamRunTaskDetail(task({ error: "provider unavailable" }), 1)).toEqual({
      text: "provider unavailable",
      tone: "error",
    });
  });

  test("treats empty detail values as absent", () => {
    expect(getDreamRunTaskDetail(task({ error: "", progress: "" }), 0)).toEqual({
      text: undefined,
      tone: "neutral",
    });
  });
});
