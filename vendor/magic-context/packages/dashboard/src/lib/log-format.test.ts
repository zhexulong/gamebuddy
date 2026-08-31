import { describe, expect, it } from "bun:test";
import { formatLogTimestamp } from "./log-format";

describe("formatLogTimestamp", () => {
  it("converts the ISO timestamp emitted by the plugin logger to local time", () => {
    // The logger writes `[${new Date().toISOString()}] ...`, so retain its
    // millisecond precision and UTC marker in this fixture.
    const loggerTimestamp = new Date("2024-07-08T12:34:56.789Z").toISOString();
    const date = new Date(loggerTimestamp);
    const expected =
      `${date.getFullYear().toString().padStart(4, "0")}-` +
      `${(date.getMonth() + 1).toString().padStart(2, "0")}-` +
      `${date.getDate().toString().padStart(2, "0")} ` +
      `${date.getHours().toString().padStart(2, "0")}:` +
      `${date.getMinutes().toString().padStart(2, "0")}:` +
      `${date.getSeconds().toString().padStart(2, "0")}.` +
      `${date.getMilliseconds().toString().padStart(3, "0")}`;

    expect(loggerTimestamp).toBe("2024-07-08T12:34:56.789Z");
    expect(formatLogTimestamp(loggerTimestamp)).toBe(expected);
  });

  it("passes through a timestamp it cannot parse", () => {
    expect(formatLogTimestamp("not-a-timestamp")).toBe("not-a-timestamp");
  });
});
