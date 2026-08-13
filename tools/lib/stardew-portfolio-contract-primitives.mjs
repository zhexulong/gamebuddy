import { createHash } from "node:crypto";

export const PORTFOLIO_TOPOLOGY = "single_player_native_companion";
export const PORTFOLIO_TARGET_VERSION = "1.6.15";
export const PORTFOLIO_TARGET_BUILD_NUMBER = 24356;
export const PORTFOLIO_TARGET_GAME_SHA256 = "7f1e5b8e58d2758b78570ba771bbeb03d33522f62188bf6c32edf0cf626deaee";
export const PORTFOLIO_TARGET_SMAPI_VERSION = "4.5.2";
export const PORTFOLIO_EVIDENCE_SCHEMA_REVISION = 1;

export function hashPortfolioCanonicalJson(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function computePortfolioBindingHash({ saveId, worldId, localPlayerId, companionId, bindingGeneration }) {
  if (
    ![saveId, worldId, localPlayerId, companionId].every((value) => /^[A-Za-z0-9_-]{1,128}$/.test(value ?? "")) ||
    !Number.isSafeInteger(bindingGeneration) ||
    bindingGeneration <= 0
  ) {
    throw new Error("portfolio_binding_hash_input_invalid");
  }
  return createHash("sha256")
    .update(
      `${PORTFOLIO_TOPOLOGY}\n${saveId}\n${worldId}\n${localPlayerId}\n${companionId}\n${PORTFOLIO_TARGET_VERSION}\n${PORTFOLIO_TARGET_BUILD_NUMBER}\n${bindingGeneration}`,
      "utf8",
    )
    .digest("hex");
}

export function canonicalJson(value) {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string")
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  throw new TypeError("portfolio_canonical_json_unsupported_value");
}
