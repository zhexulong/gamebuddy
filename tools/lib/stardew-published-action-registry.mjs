import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function fail(code) {
  throw new Error(`stardew_published_action_registry_${code}`);
}

/**
 * Reads only the Mod-owned published registrations for non-authoritative live
 * gate descriptor coverage. It never publishes capabilities or affects routing.
 */
export async function readPublishedStardewActionIds({
  registrationsPath = resolve(
    root,
    "integrations",
    "stardew",
    "src",
    "Core",
    "Policy",
    "FarmhandActionDefinitions.cs",
  ),
} = {}) {
  const source = await readFile(registrationsPath, "utf8");
  const body = source.match(
    /\bRegistrations\b\s*=\s*Array\.AsReadOnly\(new\[\]\s*\{([\s\S]*?)\}\);/,
  )?.[1];
  if (!body) fail("missing_mod_registrations");

  const registrations = [
    ...body.matchAll(
      /Registration\("([a-z][a-z0-9_]{1,127})",\s*"[a-z][a-z0-9_]{1,127}",\s*\d+,\s*FarmhandActionHandlerGroup\.[A-Za-z]+(?:,\s*FarmhandActionLifecycle\.(Published|Experimental))?\)/g,
    ),
  ];
  const publishedIds = registrations
    .filter(([, , lifecycle]) => lifecycle !== "Experimental")
    .map(([, actionId]) => actionId);
  if (publishedIds.length === 0 || new Set(publishedIds).size !== publishedIds.length)
    fail("invalid_published_set");
  return Object.freeze(publishedIds);
}
