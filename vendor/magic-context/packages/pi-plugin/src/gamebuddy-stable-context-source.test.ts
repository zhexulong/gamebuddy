import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import {
  GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION,
  materializeGameBuddyAuthoredStableCatalog,
  validateGameBuddyAuthoredStableCatalog,
  __gamebuddyReadAuthoredMaterialization,
  __gamebuddyReplaceAuthoredMaterialization,
  __gamebuddyClearAuthoredMaterialization,
} from "./gamebuddy-stable-context-source";

const scope = {
  continuityId: "continuity-opaque",
  sessionId: "session-opaque",
  surface: "tavern" as const,
  threadId: "thread-opaque",
  profile: { profileId: "profile-opaque", revision: 1, canonicalHash: "a".repeat(64) },
};
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const canonical = (value: unknown): string => Array.isArray(value)
  ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
    : JSON.stringify(value);
function catalog(sources = [{ sourceId: "scenario-1", kind: "scenario" as const, revision: "1", content: "A quiet tavern.", canonicalHash: hash("A quiet tavern."), budgetTokens: 100, totalOrderKey: "0001", provenance: "fixture" }]) {
  const body = { version: GAMEBUDDY_AUTHORED_CONTEXT_CATALOG_VERSION, scope, stableSources: sources };
  return { ...body, canonicalHash: hash(canonical(body)) };
}

describe("GameBuddy authored stable catalog", () => {
  it("validates the exact v2 scope and deeply freezes source data", () => {
    const value = validateGameBuddyAuthoredStableCatalog(catalog(), scope);
    expect(value.version).toBe("gamebuddy-authored-context-catalog/v2");
    expect(value.scope).toEqual(scope);
    expect(Object.isFrozen(value)).toBe(true);
    expect(Object.isFrozen(value.stableSources[0])).toBe(true);
    expect(() => ((value.stableSources[0] as { content: string }).content = "mutated")).toThrow();
  });

  it("rejects a foreign thread/profile and invalid source integrity", () => {
    expect(() => validateGameBuddyAuthoredStableCatalog(catalog(), { ...scope, threadId: "foreign" })).toThrow("catalog scope mismatch");
    expect(() => validateGameBuddyAuthoredStableCatalog(catalog([{ ...catalog().stableSources[0], canonicalHash: "0".repeat(64) }]), scope)).toThrow("source hash mismatch");
    expect(() => validateGameBuddyAuthoredStableCatalog(catalog([{ ...catalog().stableSources[0], kind: "unknown" as never }]), scope)).toThrow("unknown");
  });

  it("replaces and clears only the expected authored materialization", () => {
    const materialized = materializeGameBuddyAuthoredStableCatalog(catalog(), scope);
    __gamebuddyReplaceAuthoredMaterialization(scope.sessionId, materialized);
    expect(__gamebuddyReadAuthoredMaterialization(scope.sessionId)).toBe(materialized);
    const replacement = materializeGameBuddyAuthoredStableCatalog(catalog([{ ...catalog().stableSources[0], content: "Replacement", canonicalHash: hash("Replacement") }]), scope);
    __gamebuddyClearAuthoredMaterialization(scope.sessionId, replacement);
    expect(__gamebuddyReadAuthoredMaterialization(scope.sessionId)).toBe(materialized);
    __gamebuddyClearAuthoredMaterialization(scope.sessionId, materialized);
    expect(__gamebuddyReadAuthoredMaterialization(scope.sessionId)).toBeUndefined();
  });

  it("rejects duplicate or malformed total-order keys", () => {
    const base = catalog().stableSources[0];
    const duplicate = catalog([
      base,
      { ...base, sourceId: "persona-1", kind: "persona", totalOrderKey: base.totalOrderKey },
    ]);
    expect(() => validateGameBuddyAuthoredStableCatalog(duplicate, scope)).toThrow("totalOrderKey");
    const malformed = catalog([{ ...base, totalOrderKey: "order-1" }]);
    expect(() => validateGameBuddyAuthoredStableCatalog(malformed, scope)).toThrow("totalOrderKey");
  });

  it("renders deterministic escaped m[0] content in total-order", () => {
    const first = catalog([
      { sourceId: "scenario-1", kind: "scenario", revision: "1", content: "A <quiet> & tavern.", canonicalHash: hash("A <quiet> & tavern."), budgetTokens: 100, totalOrderKey: "0001", provenance: "fixture" },
      { sourceId: "persona-1", kind: "persona", revision: "1", content: "Player", canonicalHash: hash("Player"), budgetTokens: 50, totalOrderKey: "0000", provenance: "fixture" },
    ]);
    const materialized = materializeGameBuddyAuthoredStableCatalog(first, scope);
    expect(materialized.renderedBlock).toContain("&lt;quiet&gt; &amp; tavern.");
    expect(materialized.renderedBlock.indexOf('kind="persona"')).toBeLessThan(materialized.renderedBlock.indexOf('kind="scenario"'));
    expect(materialized.budgetTokens).toBe(150);
    expect(Object.isFrozen(materialized)).toBe(true);
  });
});
