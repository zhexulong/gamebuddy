import { describe, expect, it } from "bun:test";
import { parse } from "comment-json";
import { parseJsonc, patchDreamerTasksJsonc, removeDreamerBlockJsonc } from "./jsonc";

function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe("object");
  expect(value).not.toBeNull();
  expect(Array.isArray(value)).toBe(false);
  return value as Record<string, unknown>;
}

describe("dashboard JSONC patching", () => {
  const configWithComments = `{// leading comment
  "enabled": true,
  "dreamer": {
    // model comment
    "model": "anthropic/claude",
    "tasks": {
      "verify": { "schedule": "0 3 * * *" }
    }
  },
  // sibling comment
  "other": { "keep": 1 }
}
`;

  it("#given comments and sibling keys #when patching one dreamer task #then comments and siblings survive", () => {
    const next = patchDreamerTasksJsonc(configWithComments, {
      verify: { schedule: "" },
      "promote-primers": { schedule: "0 3 * * *" },
    });

    expect(next).toContain("// leading comment");
    expect(next).toContain("// model comment");
    expect(next).toContain("// sibling comment");

    const parsed = asRecord(parse(next));
    const other = asRecord(parsed.other);
    const dreamer = asRecord(parsed.dreamer);
    const tasks = asRecord(dreamer.tasks);
    const verify = asRecord(tasks.verify);
    const promotePrimers = asRecord(tasks["promote-primers"]);
    expect(parsed.enabled).toBe(true);
    expect(other.keep).toBe(1);
    expect(dreamer.model).toBe("anthropic/claude");
    expect(verify.schedule).toBe("");
    expect(promotePrimers.schedule).toBe("0 3 * * *");
  });

  it("patches only the requested harness task entries", () => {
    const next = patchDreamerTasksJsonc(
      configWithComments,
      { verify: { schedule: "0 3 * * *" } },
      "pi",
      { verify: { model: { model: "anthropic/claude-sonnet", thinking_level: "high" } } },
    );

    const dreamer = asRecord(asRecord(parse(next)).dreamer);
    const pi = asRecord(dreamer.pi);
    const tasks = asRecord(pi.tasks);
    expect(asRecord(tasks.verify).model).toEqual({
      model: "anthropic/claude-sonnet",
      thinking_level: "high",
    });
    expect(dreamer.opencode).toBeUndefined();
  });

  it("#given malformed JSONC #when parsing or patching #then the save path is refused", () => {
    const malformed = `{ "dreamer": { "tasks": `;
    expect(() => parseJsonc(malformed)).toThrow(/Config JSONC parse failed/);
    expect(() => patchDreamerTasksJsonc(malformed, { verify: { schedule: "" } })).toThrow(
      /Config JSONC parse failed/,
    );
  });

  it("#given dangerous object keys #when parsing #then nested and array payloads are refused", () => {
    const polluted = `{
      "nested": { "constructor": { "hidden": true } },
      "items": [{ "__proto__": { "dreamer": { "prompt": "unsafe" } } }]
    }`;

    expect(() => parseJsonc(polluted)).toThrow(/prototype-pollution/);
  });

  it("#given a project override #when reverting #then only the dreamer block is removed", () => {
    const next = removeDreamerBlockJsonc(configWithComments);
    expect(next).toContain("// leading comment");
    expect(next).toContain("// sibling comment");
    const parsed = asRecord(parse(next));
    const other = asRecord(parsed.other);
    expect(parsed.dreamer).toBeUndefined();
    expect(parsed.enabled).toBe(true);
    expect(other.keep).toBe(1);
  });
});
