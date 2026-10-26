import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { TavernArtifactStore } from "./artifact-store.js";
import { type CardMetadata, type TavernArtifact, validateTavernArtifact } from "./types.js";

/**
 * Every field the card author wrote that this product does not interpret, as the companion's own record.
 *
 * The compatibility manifest classifies such fields `preserved_opaque`, which is a promise that they survive the round
 * trip. Until this record existed the import reported that classification and kept none of the text, so an author's
 * `creator_notes`, `tags`, `creator` and `character_version` were lost at import - and the export was blamed for it.
 *
 * It sits beside `card-extensions.json` for the same reasons: it is card data rather than prompt data, no profile field
 * derives from it, and it is never rendered or executed. The one difference is scope - `extensions` is the format's own
 * open bag, while this record carries the card's *other* fields, whatever their names, because the set of names a card
 * may use belongs to the format and not to us.
 */
export async function writeCompanionCardMetadata(
  store: TavernArtifactStore,
  companionRoot: string,
  fields: Readonly<Record<string, unknown>>,
): Promise<void> {
  const artifact: CardMetadata = Object.freeze({
    schemaVersion: 1,
    revision: 1,
    cardMetadataId: cardMetadataId(companionRoot),
    fields,
  });
  await store.write(cardMetadataPath(companionRoot), artifact, validateTavernArtifact);
}

/**
 * The companion's preserved author fields, or `null` when she carries none.
 *
 * A companion created directly - or imported from a card that wrote nothing beyond the interpreted fields - has no
 * record, and the export then writes no field for it rather than an empty object. A record naming another companion
 * fails closed instead of being read as hers.
 */
export async function readCompanionCardMetadata(
  store: TavernArtifactStore,
  companionRoot: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const read = await store.readIfPresent(cardMetadataPath(companionRoot), validateTavernArtifact);
  if (read === undefined) return null;
  if (!isCardMetadata(read.artifact) || read.artifact.cardMetadataId !== cardMetadataId(companionRoot))
    throw new Error("invalid_card_metadata_artifact");
  return read.artifact.fields;
}

function cardMetadataPath(companionRoot: string): string {
  return join(resolve(companionRoot), "card-metadata.json");
}
function cardMetadataId(companionRoot: string): string {
  return `card-metadata-${createHash("sha256").update(resolve(companionRoot), "utf8").digest("hex").slice(0, 32)}`;
}
function isCardMetadata(artifact: TavernArtifact): artifact is CardMetadata {
  return "cardMetadataId" in artifact;
}
