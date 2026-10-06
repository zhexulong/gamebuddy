/**
 * The live-run persona: one canonical card, loaded as-is, for EVERY loop.
 *
 * The product's authored-context path is a FILE CONVENTION, not a parameter: provisioning writes the
 * card's world book to `<runtimeCwd>/worldbook.json` (`host/src/tavern/new-companion-service.ts:202`),
 * and each runtime reads it back from that cwd — Game via
 * `game-runtime-context-assembly.ts:42` (`readCanonicalWorldBook(runtimePaths.runtimeCwd)`), Chat via
 * `continuity-semantic-chat-runtime-construction.internal.ts:306` (`readWorldBook(join(runtimeCwd,
 * "worldbook.json"))`) — before both are injected as `initialProfile`/`worldBook` in
 * `continuity-semantic-game-runtime-materializer.ts:813-814`.
 *
 * So a run that does not place those two files in its runtime cwd has NO persona, and every naturalness
 * judgement made against it is a judgement of a bare assistant. That was true of the chat loop (its
 * deployment manifest carried no profile and its identity was synthetic), which is exactly why a real
 * conversation read as flat and generic.
 *
 * This module is the one place that knows:
 *   - WHICH card (the reviewed live-run card, `assets/tavern/presets/deepseek-chan`),
 *   - that it is copied **byte for byte, with no modification or preprocessing** (the operator's rule:
 *     load it directly; if that fails, the failure is a system problem, not a reason to rewrite the card),
 *   - and how to ASSERT that a run really mounted it, so an absent persona is a failure instead of a
 *     silent, generic-sounding companion.
 */

import { existsSync } from "node:fs";
import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** `<repo>/assets/tavern/presets/deepseek-chan` — resolved from this module, never from a caller's cwd. */
export const LIVE_RUN_PERSONA_DIR = path.resolve(
  fileURLToPath(new URL("../../../assets/tavern/presets/deepseek-chan", import.meta.url)),
);

/** The card and its world book travel together; naming them here keeps every loop identical. */
export const LIVE_RUN_PERSONA_FILES = Object.freeze(["card.json", "worldbook.json"]);

export function liveRunPersonaPaths({ dir = LIVE_RUN_PERSONA_DIR } = {}) {
  return Object.freeze({
    dir,
    cardPath: path.join(dir, "card.json"),
    worldbookPath: path.join(dir, "worldbook.json"),
  });
}

/**
 * What the card IS, read (never written) for the evidence: the run must say which persona spoke, or two
 * runs judged for naturalness are not comparable.
 */
export async function readLiveRunPersonaIdentity({ dir = LIVE_RUN_PERSONA_DIR } = {}) {
  const { cardPath, worldbookPath } = liveRunPersonaPaths({ dir });
  if (!existsSync(cardPath)) throw new Error("live_run_persona_card_missing");
  if (!existsSync(worldbookPath)) throw new Error("live_run_persona_worldbook_missing");
  const card = JSON.parse(await readFile(cardPath, "utf8"));
  const book = JSON.parse(await readFile(worldbookPath, "utf8"));
  const entries = Array.isArray(book?.entries) ? book.entries : [];
  return Object.freeze({
    dir: path.basename(dir),
    // CCv2 keeps the display name under `data.name`; a v1 card keeps it at the top level.
    name: card?.data?.name ?? card?.name ?? null,
    cardSchema: card?.spec ?? card?.spec_version ?? null,
    worldBookEntries: entries.length,
    alwaysOnEntries: entries.filter((entry) => entry?.alwaysOnPremise === true || entry?.constant === true).length,
  });
}

/**
 * Place the card in a runtime cwd exactly as provisioning does — byte for byte. Returns the identity so
 * the caller can put it in its own evidence.
 */
export async function provisionLiveRunPersona(runtimeCwd, { dir = LIVE_RUN_PERSONA_DIR } = {}) {
  if (typeof runtimeCwd !== "string" || runtimeCwd.length === 0) throw new Error("live_run_persona_cwd_invalid");
  const { cardPath, worldbookPath } = liveRunPersonaPaths({ dir });
  const identity = await readLiveRunPersonaIdentity({ dir });
  for (const [source, name] of [
    [cardPath, "card.json"],
    [worldbookPath, "worldbook.json"],
  ]) {
    await copyFile(source, path.join(runtimeCwd, name));
  }
  return Object.freeze({ identity, cardPath, worldbookPath });
}

/**
 * Is this runtime cwd mounted with the persona? Both files present, the book parseable, at least one
 * entry, and a named card. A run that fails this has no persona, so it cannot support any claim about
 * persona fidelity or naturalness — and it says why instead of sounding merely bland.
 */
export async function assertLiveRunPersonaMounted(runtimeCwd) {
  const problems = [];
  const cardPath = path.join(runtimeCwd, "card.json");
  const worldbookPath = path.join(runtimeCwd, "worldbook.json");
  if (!existsSync(cardPath)) problems.push("card_json_absent");
  if (!existsSync(worldbookPath)) problems.push("worldbook_json_absent");
  let entries = 0;
  let name = null;
  if (!problems.includes("card_json_absent")) {
    try {
      const card = JSON.parse(await readFile(cardPath, "utf8"));
      name = card?.data?.name ?? card?.name ?? null;
      if (typeof name !== "string" || name.length === 0) problems.push("card_name_absent");
    } catch {
      problems.push("card_json_unparseable");
    }
  }
  if (!problems.includes("worldbook_json_absent")) {
    try {
      const book = JSON.parse(await readFile(worldbookPath, "utf8"));
      entries = Array.isArray(book?.entries) ? book.entries.length : 0;
      if (entries === 0) problems.push("worldbook_empty");
    } catch {
      problems.push("worldbook_json_unparseable");
    }
  }
  // Authored templating (char/user tokens) is PART OF the card format, not a defect: the reviewed card
  // ships it. Whether the runtime substitutes those tokens when it injects the book is a separate product
  // fact to observe downstream, so the count is recorded here instead of being called a failure.
  const raw = existsSync(worldbookPath) ? await readFile(worldbookPath, "utf8") : "";
  const macroTokens = (raw.match(/\{\{[^}]*\}\}/g) ?? []).length;
  return Object.freeze({ ok: problems.length === 0, problems, name, worldBookEntries: entries, macroTokens });
}
