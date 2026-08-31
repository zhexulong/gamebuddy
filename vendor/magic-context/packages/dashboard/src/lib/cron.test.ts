import { describe, expect, it } from "bun:test";
import { describeCron, isValidCronShape } from "./cron";

describe("isValidCronShape", () => {
  it("accepts empty (disabled) and well-formed 5-field crons", () => {
    expect(isValidCronShape("")).toBe(true);
    expect(isValidCronShape("0 3 * * *")).toBe(true);
    expect(isValidCronShape("*/15 * * * *")).toBe(true);
    expect(isValidCronShape("0 4 * * 0")).toBe(true);
  });

  it("rejects wrong field counts and garbage", () => {
    expect(isValidCronShape("0 3 * *")).toBe(false);
    expect(isValidCronShape("0 3 * * * *")).toBe(false);
    expect(isValidCronShape("hello world foo bar baz")).toBe(false);
  });
});

describe("describeCron", () => {
  it("describes the dreamer preset shapes", () => {
    expect(describeCron("")).toBe("Disabled");
    expect(describeCron("0 3 * * *")).toBe("Every day at 3:00 AM");
    expect(describeCron("0 4 * * 0")).toBe("Every Sunday at 4:00 AM");
    expect(describeCron("0 */6 * * *")).toBe("Every 6 hours");
    expect(describeCron("0 * * * *")).toBe("Every hour");
  });

  it("describes common custom shapes", () => {
    expect(describeCron("*/15 * * * *")).toBe("Every 15 minutes");
    expect(describeCron("30 8 * * *")).toBe("Every day at 8:30 AM");
    expect(describeCron("0 14 * * 5")).toBe("Every Friday at 2:00 PM");
    expect(describeCron("0 0 1 * *")).toBe("Monthly on the 1st at 12:00 AM");
  });

  it("falls back to the raw cron when not confidently describable", () => {
    expect(describeCron("0 0 1 1 *")).toBe("0 0 1 1 *");
    expect(describeCron("5,10,15 * * * *")).toBe("5,10,15 * * * *");
    expect(describeCron("not a cron")).toBe("not a cron");
  });
});
