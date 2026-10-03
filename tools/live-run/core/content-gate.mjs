import { readdir, readFile } from "node:fs/promises";
import { join, sep } from "node:path";

/**
 * Content gate over the live-run capture directory (tools/live-run/README.md).
 *
 * The assembly gate only proves hash/id CONSISTENCY ("the same profile was
 * mounted"). It is blind to CONTENT: a default identity profile with no
 * persona has a stable hash and passes the assembly gate while being empty.
 * This module derives content facts FROM the captured evidence (the
 * identity-profile.json inside the run's own capture directory), so a content
 * defect becomes visible instead of passing silently.
 *
 * Content facts are booleans and small strings, never the text itself. The
 * gate never reads player memory content — only the profile asset, which is
 * product-authored (persona / identity / macro placeholders).
 *
 * NOTES
 * - `personaPresent` requires at least one of the three persona fields
 *   (core / interactionStyle / expressionStyle) to be a non-empty string.
 *   The full three-field shape is the product baseline, but a single filled
 *   field is already "the card has a soul"; `personaComplete` additionally
 *   requires all three.
 * - `macroResidue`: unrendered SillyTavern macros ({{char}}, {{user}}) left
 *   in the profile would leak raw placeholders into the prompt tier.
 */

export const DEFAULT_PROFILE_ID = "gamebuddy.companion.default";

const MACRO_PATTERN = /\{\{\s*(char|user|time|random|persona|description)\s*\}\}/gu;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function findMacros(text) {
  const found = new Set();
  if (typeof text !== "string") return found;
  for (const match of text.matchAll(MACRO_PATTERN)) found.add(match[0]);
  return found;
}

function collectProfileText(profile) {
  const parts = [];
  if (isNonEmptyString(profile?.identity?.name)) parts.push(profile.identity.name);
  if (isNonEmptyString(profile?.identity?.role)) parts.push(profile.identity.role);
  if (isNonEmptyString(profile?.identity?.continuity)) parts.push(profile.identity.continuity);
  const persona = profile?.persona ?? {};
  for (const key of ["core", "interactionStyle", "expressionStyle"]) {
    if (isNonEmptyString(persona[key])) parts.push(persona[key]);
  }
  return parts.join("\n");
}

/** Content facts from a parsed identity profile object. */
export function assessIdentityProfile(profile) {
  if (profile === null || profile === undefined) {
    return Object.freeze({
      profileRead: false,
      personaPresent: false,
      personaComplete: false,
      personaFields: Object.freeze({ core: false, interactionStyle: false, expressionStyle: false }),
      macroResidue: [],
      identityName: null,
      isDefaultProfile: false,
    });
  }
  const persona = profile.persona ?? {};
  const personaFields = Object.freeze({
    core: isNonEmptyString(persona.core),
    interactionStyle: isNonEmptyString(persona.interactionStyle),
    expressionStyle: isNonEmptyString(persona.expressionStyle),
  });
  const macros = findMacros(collectProfileText(profile));
  return Object.freeze({
    profileRead: true,
    personaPresent: personaFields.core || personaFields.interactionStyle || personaFields.expressionStyle,
    personaComplete: personaFields.core && personaFields.interactionStyle && personaFields.expressionStyle,
    personaFields,
    macroResidue: [...macros],
    identityName: isNonEmptyString(profile?.identity?.name) ? profile.identity.name : null,
    isDefaultProfile: profile?.profileId === DEFAULT_PROFILE_ID,
  });
}

/**
 * Find the deep identity-profile.json under a capture directory and assess it.
 * Returns `profileRead: false` when the capture has no profile (disposable
 * roots, or a broken capture) — that is a GAP, never an assertion.
 */
export async function assessCapturedIdentityProfile(captureDir, { readFileImpl = readFile, readdirImpl = readdir } = {}) {
  let entries;
  try {
    entries = await readdirImpl(captureDir, { withFileTypes: true });
  } catch {
    return assessIdentityProfile(null);
  }
  const stack = [...entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }))];
  const profileCandidates = [];
  while (stack.length > 0) {
    const entry = stack.pop();
    if (entry.isDirectory) {
      let children;
      try {
        children = await readdirImpl(join(captureDir, entry.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) stack.push({ name: `${entry.name}${sep}${child.name}`, isDirectory: child.isDirectory() });
    } else if (entry.name.endsWith("identity-profile.json")) {
      profileCandidates.push(entry.name);
    }
  }
  // Prefer the captured runtime-root profile (deepest path wins the walk order,
  // but we take the first found under runtime-root if any).
  const runtimeRootPrefix = `runtime-root${sep}`;
  for (const rel of profileCandidates) {
    if (!rel.startsWith(runtimeRootPrefix)) continue;
    try {
      const text = await readFileImpl(join(captureDir, rel), "utf8");
      return assessIdentityProfile(JSON.parse(text));
    } catch {
      // Corrupt profile is a failure to read, not an assessment.
    }
  }
  return assessIdentityProfile(null);
}