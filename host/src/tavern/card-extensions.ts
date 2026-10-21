import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { TavernArtifactStore } from "./artifact-store.js";
import { type CardExtensions, type TavernArtifact, validateTavernArtifact } from "./types.js";

/**
 * The imported card's own `extensions` object as the companion's own record.
 *
 * The card's neighbouring authored material already lives this way: her scenario
 * and her greeting set are durable artifacts under her own root, written when she
 * is provisioned and read by the surfaces. `extensions` is the same kind of fact -
 * what the card author wrote - so it gets the same kind of home, and it is NOT
 * folded into `IdentityProfile`: the identity record is prompt input, and this
 * data is never rendered into a prompt at all.
 */
export async function writeCompanionCardExtensions(
  store: TavernArtifactStore,
  companionRoot: string,
  extensions: Readonly<Record<string, unknown>>,
): Promise<void> {
  const artifact: CardExtensions = Object.freeze({
    schemaVersion: 1,
    revision: 1,
    cardExtensionsId: cardExtensionsId(companionRoot),
    extensions,
  });
  await store.write(cardExtensionsPath(companionRoot), artifact, validateTavernArtifact);
}

/**
 * The companion's own `extensions` object, or `null` when she carries none.
 *
 * Absence is an ordinary state - a card that wrote no `extensions` (and every
 * companion created directly) has no record - and the export writes no field for
 * it rather than an empty object. A record that exists but names another
 * companion fails closed instead of being read as hers.
 */
export async function readCompanionCardExtensions(
  store: TavernArtifactStore,
  companionRoot: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const read = await store.readIfPresent(cardExtensionsPath(companionRoot), validateTavernArtifact);
  if (read === undefined) return null;
  if (!isCardExtensions(read.artifact) || read.artifact.cardExtensionsId !== cardExtensionsId(companionRoot))
    throw new Error("invalid_card_extensions_artifact");
  return read.artifact.extensions;
}

function cardExtensionsPath(companionRoot: string): string {
  return join(resolve(companionRoot), "card-extensions.json");
}
/** The one derivation of the companion's own record id, from her own root. */
function cardExtensionsId(companionRoot: string): string {
  return `card-extensions-${createHash("sha256").update(resolve(companionRoot), "utf8").digest("hex").slice(0, 32)}`;
}
function isCardExtensions(artifact: TavernArtifact): artifact is CardExtensions {
  return "cardExtensionsId" in artifact;
}
