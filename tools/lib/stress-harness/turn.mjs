import { loadHost, macroTableFor, readCompanionWorldBook } from "./common.mjs";

/**
 * The product's own "run a turn" boundary, as far as it can be reached without a
 * live provider.
 *
 * A real Chat turn is: durable acceptance -> provider start -> observation ->
 * presentation. The provider start needs a mounted ChatGPT runtime lease minted
 * by the coordinator, which no out-of-process harness can obtain - so the suite
 * names that step a skip rather than faking it.
 *
 * What it CAN and DOES drive is the exact content the turn is assembled from:
 * the companion's reviewed profile (the Tier-1 system prompt) and the authored
 * context catalog the mounted runtime materializes (`materializeTavernAuthoredContextCatalog`,
 * the real chat materializer). Those are the two places a 16000-character persona
 * or an unrendered `{{user}}` would show up, and they are the product's own
 * functions, not a reimplementation.
 */

/** Builds the real services and a reviewed companion, then opens one Chat. */
export async function buildCompanionChat(root, id, options) {
  const { openServices, writeProfile, writeCompanionWorldBook } = await import("./common.mjs");
  const services = await openServices(root, id);
  const { paths } = services;

  if (options.profile !== undefined) await writeProfile(options.profilePath, options.profile);
  if (options.worldBook !== undefined) await writeCompanionWorldBook(paths.runtimeCwd, options.worldBook);
  if (options.scenario !== undefined) {
    const { createScenarioManagementService } = await loadHost("tavern/scenario-management/scenario-management.js");
    await createScenarioManagementService(services.artifacts, paths.companionRoot).create({
      name: "Default Scenario",
      description: options.scenario,
    });
  }
  const companion = await services.service.createNewCompanion({
    companionId: id.companionId,
    continuityId: id.continuityId,
    name: options.name,
    profileId: `profile-${id.companionId}`,
    profileRevision: 1,
    profileHash: "a".repeat(64),
  });
  const state = await services.service.createNewChat({
    chatThreadId: options.chatThreadId,
    chatSurfaceSessionId: options.chatSurfaceSessionId,
    ...(options.opening === undefined ? {} : { opening: options.opening }),
  });
  return { services, companion, state };
}

/**
 * The mounted runtime's authored context for one thread, exactly as the Chat
 * materializer computes it. The one input the suite assembles itself is the
 * companion's own world book layer, because that projection lives in the
 * construction module behind the coordinator; it is four lines and mirrors
 * `resolveBoundWorldBookSource` (render each entry through the run's macro table,
 * split always-on from keyword-gated).
 */
export async function materializeChatCatalog(services, id, state, charName, locale = "zh-CN") {
  const { materializeTavernAuthoredContextCatalog } = await loadHost("tavern/catalog-service.js");
  const thread = state.thread;
  const macros = await macroTableFor(charName, locale);
  const binding = Object.freeze({
    continuityId: id.continuityId,
    sessionId: "pi_stress_session",
    surface: "tavern",
    threadId: thread.chatThreadId,
    profile: Object.freeze({
      profileId: thread.profileId,
      revision: thread.profileRevision,
      canonicalHash: thread.profileCanonicalHash,
    }),
  });
  const layer =
    thread.companionWorldBookBinding === undefined
      ? undefined
      : await companionWorldBookLayer(services.paths.runtimeCwd, thread.companionWorldBookBinding, macros);
  return await materializeTavernAuthoredContextCatalog(
    services.paths,
    services.artifacts,
    thread,
    binding,
    macros,
    layer === undefined ? {} : { companionWorldBook: layer },
  );
}

async function companionWorldBookLayer(runtimeCwd, binding, macros) {
  const { renderMacros, hasUnrenderedMacro } = await loadHost("tavern/macro-engine.js");
  const book = await readCompanionWorldBook(runtimeCwd);
  if (book === null) throw new Error("companion_world_book_absent");
  const render = (entry) => {
    const title = renderMacros(entry.title, macros);
    const content = renderMacros(entry.content, macros);
    return hasUnrenderedMacro(title) || hasUnrenderedMacro(content) ? undefined : { title, content };
  };
  const constantEntries = [];
  const keywordEntries = [];
  for (const entry of book.entries) {
    const rendered = render(entry);
    if (rendered === undefined) continue;
    if (entry.constant === true) constantEntries.push(Object.freeze({ entryId: entry.entryId, ...rendered }));
    else
      keywordEntries.push(
        Object.freeze({
          entryId: entry.entryId,
          ...rendered,
          ...(entry.keys === undefined ? {} : { keys: entry.keys }),
          ...(entry.secondaryKeys === undefined ? {} : { secondaryKeys: entry.secondaryKeys }),
          ...(entry.selectiveLogic === undefined ? {} : { selectiveLogic: entry.selectiveLogic }),
        }),
      );
  }
  const alwaysOnPremise = renderMacros(book.alwaysOnPremise, macros);
  return Object.freeze({
    binding,
    alwaysOnPremise,
    ...(constantEntries.length === 0 ? {} : { constantEntries: Object.freeze(constantEntries) }),
    ...(keywordEntries.length === 0 ? {} : { keywordEntries: Object.freeze(keywordEntries) }),
  });
}

/**
 * Every string the model would receive for one mounted Chat: the Tier-1 system
 * prompt plus every authored source the catalog publishes. Used to assert no
 * `{{...}}` survives to the prompt.
 */
export async function promptStrings(profile, catalog) {
  const { buildChatCompanionSystemPrompt } = await loadHost("identity-profile.js");
  const strings = [{ path: "systemPrompt", text: buildChatCompanionSystemPrompt(profile) }];
  for (const [index, source] of catalog.stableSources.entries())
    strings.push({ path: `stableSources[${index}].content`, text: source.content });
  for (const [index, source] of catalog.volatileSources.entries())
    strings.push({ path: `volatileSources[${index}].content`, text: source.content });
  return strings;
}
