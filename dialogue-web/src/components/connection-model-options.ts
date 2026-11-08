import type { TavernConnectionProviderV1, TavernConnectionV1 } from "../management-pipeline-api";

/**
 * What the model field offers, in the three kinds the panel renders (design/28 §1).
 *
 * The lists answer three different claims and must never be merged into one, because a player reads
 * them differently:
 *
 * - `served` is what this endpoint actually answered when it was last asked (`/models`, via the
 *   Host-owned probe). It is the only list with evidence behind it.
 * - `catalog` is a model this Host states, `allowedPlayerModels`. Non-empty only for an endpoint this
 *   product runs; an id here is ours, not a guess about someone else's service.
 * - `suggested` is an id the Host documents for the entry's endpoint, `suggestedModelIds`. It exists
 *   for the one state the other two cannot fill: a first run. A probe needs a saved connection and
 *   saving needs a model id, so before the player has typed anything there is nothing to probe and
 *   nothing served - and an empty field with no starting point is the cold start this list answers.
 *   Nothing in it was read from the endpoint, so the panel labels it a suggestion, never as served.
 *
 * One id appears in exactly one list. A suggestion the endpoint later confirms moves up into
 * `served`; it is not offered twice, which would show one id under two contradictory labels.
 *
 * `probed` says whether this provider's connections have ever read a listing, so the panel can say
 * *why* `served` is empty instead of leaving the player to guess between "not asked yet" and
 * "asked, and the answer was nothing".
 */
export type ConnectionModelOptions = Readonly<{
  served: readonly string[];
  catalog: readonly string[];
  suggested: readonly string[];
  probed: boolean;
}>;

export function connectionModelOptions(
  provider: TavernConnectionProviderV1 | undefined,
  connections: readonly TavernConnectionV1[],
): ConnectionModelOptions {
  const rows = connections.filter((row) => row.providerId === provider?.providerId);
  const served: string[] = [];
  for (const row of rows) for (const id of row.modelIds ?? []) if (!served.includes(id)) served.push(id);
  const catalog = (provider?.allowedPlayerModels ?? [])
    .map((model) => model.modelId)
    .filter((id) => !served.includes(id));
  const suggested = (provider?.suggestedModelIds ?? []).filter((id) => !served.includes(id) && !catalog.includes(id));
  return Object.freeze({
    served: Object.freeze(served),
    catalog: Object.freeze(catalog),
    suggested: Object.freeze(suggested),
    probed: rows.some((row) => row.modelIds !== null),
  });
}
