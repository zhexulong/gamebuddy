import { createServer, type Server } from "node:http";

import {
  createComposedReferenceGameBrowserRequestHandler,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationIssuer,
  type ComposedReferenceGameBrowserReadContext,
} from "../composed-reference-game-browser.js";
import {
  createReferencePipelineDialogueWebDelegatedHandler,
} from "../reference-pipeline-dialogue-web.delegated.js";
import { TAVERN_BROWSER_API_V1, TavernBrowserValidatorsV1 } from "./browser-contract/index.js";
import type { ChatEventStream } from "./chat-event-stream.js";
import type { ChatPipelineService } from "./chat-pipeline-service.js";
import type { ReferencePipelineStateFacade } from "./reference-pipeline-state.js";
import type { WindowsReparseInspectorCapability } from "../windows-reparse-inspector/index.js";
import type { ComposedReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import type { GameBrowserStateV1, GameLaunchCommandV1 } from "../game-browser-contract/index.js";
import type { TavernStateSnapshotV1 } from "./browser-contract/index.js";
import {
  createTavernStaticArtifactRequestHandler,
  TAVERN_BROWSER_CONTRACT,
  type TavernStaticArtifactIdentity,
  verifyTavernStaticArtifact,
} from "./static-artifact/index.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * The immutable browser artifact is versioned independently from the mounted
 * composed API profile. The composed reference-game profile must not
 * introduce a second static identity or a second listener.
 */
export const COMPOSED_REFERENCE_GAME_BROWSER_ARTIFACT_IDENTITY: TavernStaticArtifactIdentity = Object.freeze({
  browserContract: TAVERN_BROWSER_CONTRACT,
  profileId: "gamebuddy.tavern.browser.v1",
});

export type ComposedReferenceGameStaticShellCompositionOptions = Readonly<{
  profile: ComposedReferenceGameBrowserProfile;
  bootstrapToken: string;
  readGame?: (
    context: ComposedReferenceGameBrowserReadContext,
  ) => Promise<GameBrowserStateV1>;
  referenceStateFacade: ReferencePipelineStateFacade;
  pipelineService?: ChatPipelineService;
  eventStream?: ChatEventStream;
  artifactRoot: string;
  inspector?: WindowsReparseInspectorCapability;
  lifecycleActivationBindingSink?: Readonly<{
    bindBrowserAdmissionIssuer(issuer: ComposedReferenceGameBrowserLifecycleActivationIssuer): void;
    readCabinChoices?: NonNullable<Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["stardewCabins"]>["read"];
    confirmCabinChoice?: NonNullable<Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["stardewCabins"]>["confirm"];
    setupPlayerHost?: NonNullable<Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["gameSetup"]>;
    /** The lifecycle owner may return a private snapshot; the browser callback discards it. */
    launchPlayerHost?: (
      admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
      command: GameLaunchCommandV1,
    ) => Promise<unknown>;
    stopGame?: NonNullable<Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["gameStop"]>;
    disconnectGame?: NonNullable<Parameters<typeof createComposedReferenceGameBrowserRequestHandler>[0]["gameDisconnect"]>;
  }>;
}>;

export type ComposedReferenceGameStaticShellComposition = Readonly<{
  origin: string;
  launchUrl: string;
  closeAllConnections(): void;
  /** Rejects new requests, drains service work, then closes the one listener. */
  close(): Promise<void>;
}>;

/**
 * One verified static browser shell, one composed broker dispatcher, and one
 * delegated reference-pipeline dispatcher on one loopback listener. The composed broker
 * owns bootstrap/session/CSRF for the composed root and all Tavern operations;
 * the delegated reference-pipeline dispatcher serves the mounted Chat
 * operations under `/api/tavern/v1/` using the broker's auth context, without
 * a second bootstrap, session, or CSRF chain.
 */
export async function startComposedReferenceGameStaticShellComposition(
  options: ComposedReferenceGameStaticShellCompositionOptions,
): Promise<ComposedReferenceGameStaticShellComposition> {
  const artifact = await verifyTavernStaticArtifact(
    options.artifactRoot,
    COMPOSED_REFERENCE_GAME_BROWSER_ARTIFACT_IDENTITY,
    options.inspector,
  );
  const staticHandler = createTavernStaticArtifactRequestHandler(artifact);
  const readChat = async (
    context: ComposedReferenceGameBrowserReadContext,
  ): Promise<TavernStateSnapshotV1> =>
    projectComposedChatSnapshot(options, context);
  const composedHandler = createComposedReferenceGameBrowserRequestHandler({
    profile: options.profile,
    bootstrapToken: options.bootstrapToken,
    readChat,
    readGame: options.readGame,
    gameSetup: options.lifecycleActivationBindingSink?.setupPlayerHost?.bind(options.lifecycleActivationBindingSink),
    gameLaunch: options.lifecycleActivationBindingSink?.launchPlayerHost === undefined
      ? undefined
      : async (
          admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
          command: GameLaunchCommandV1,
        ): Promise<void> => {
          await options.lifecycleActivationBindingSink!.launchPlayerHost!(admission, command);
        },
    gameStop: options.lifecycleActivationBindingSink?.stopGame?.bind(options.lifecycleActivationBindingSink),
    gameDisconnect: options.lifecycleActivationBindingSink?.disconnectGame?.bind(options.lifecycleActivationBindingSink),
    stardewCabins:
      options.lifecycleActivationBindingSink?.readCabinChoices !== undefined &&
      options.lifecycleActivationBindingSink.confirmCabinChoice !== undefined
        ? Object.freeze({
            read: options.lifecycleActivationBindingSink.readCabinChoices.bind(options.lifecycleActivationBindingSink),
            confirm: options.lifecycleActivationBindingSink.confirmCabinChoice.bind(options.lifecycleActivationBindingSink),
          })
        : undefined,
  });
  const referenceHandler = createReferencePipelineDialogueWebDelegatedHandler({
    profile: options.profile.tavernProfile,
    referenceStateFacade: options.referenceStateFacade,
    pipelineService: options.pipelineService,
    eventStream: options.eventStream,
    capability: composedHandler.delegatedAuthCapability,
  });
  try {
    options.lifecycleActivationBindingSink?.bindBrowserAdmissionIssuer(
      composedHandler.lifecycleActivationIssuer,
    );
  } catch (bindError) {
    const cleanup = await Promise.allSettled([composedHandler.close(), referenceHandler.close()]);
    const cleanupErrors = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : []
    );
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [bindError, ...cleanupErrors],
        "composed_reference_game_lifecycle_bind_cleanup_failed",
      );
    }
    throw bindError;
  }
  let closed = false;
  const server = createServer((request, response) => {
    const port = (server.address() as { port: number }).port;
    const origin = `http://${LOOPBACK_HOST}:${port}`;
    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", origin).pathname;
    } catch {
      response.writeHead(404, { "Cache-Control": "no-store" });
      response.end();
      return;
    }
    if (pathname.startsWith("/api/composed-reference-game/")) {
      composedHandler.handle(request, response, origin);
    } else if (pathname.startsWith("/api/tavern/")) {
      referenceHandler.handle(request, response, origin);
    } else {
      staticHandler.handle(request, response);
    }
  });
  const port = await listenLoopback(server);
  const bootstrapToken = options.bootstrapToken;
  if (bootstrapToken === undefined) {
    await composedHandler.close();
    await referenceHandler.close();
    server.closeAllConnections();
    await closeServer(server);
    throw new Error("composed_reference_game_bootstrap_token_invalid");
  }
  const origin = `http://${LOOPBACK_HOST}:${port}`;
  return Object.freeze({
    origin,
    // The immutable shell selects the composed reference-game browser surface
    // through this explicit fragment marker (the static handler rejects query
    // strings); the one-time bootstrap token stays in the same fragment.
    launchUrl: `${origin}/#profile=composed-reference-game&boot=${bootstrapToken}`,
    closeAllConnections: () => server.closeAllConnections(),
    async close() {
      if (closed) return;
      closed = true;
      const composedDrain = composedHandler.close();
      const referenceDrain = referenceHandler.close();
      server.closeAllConnections();
      await closeServer(server);
      await composedDrain;
      await referenceDrain;
    },
  });
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolveClose, rejectClose) =>
    server.close((error) => (error === undefined ? resolveClose() : rejectClose(error))),
  );
}

async function listenLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK_HOST, port: 0 }, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.address !== LOOPBACK_HOST)
    throw new Error("dialogue_loopback_bind_failed");
  return address.port;
}

/**
 * Projects the single mounted Chat snapshot from the reference state facade
 * using the composed profile's exact Tavern identity and the composed broker
 * session context. This mirrors the reference-pipeline snapshot projection;
 * it derives only the mounted Chat domain and never invents Game facts.
 */
async function projectComposedChatSnapshot(
  options: ComposedReferenceGameStaticShellCompositionOptions,
  context: ComposedReferenceGameBrowserReadContext,
): Promise<TavernStateSnapshotV1> {
  const state = await options.referenceStateFacade.read();
  const tavernProfile = options.profile.tavernProfile;
  const snapshot = {
    apiVersion: 1,
    build: {
      browserContract: TAVERN_BROWSER_API_V1,
      profileId: tavernProfile.profileId,
    },
    csrfToken: context.csrfToken,
    browserSession: { expiresAtMs: context.browserSessionExpiresAtMs },
    operations: state.operations,
    navigation: tavernProfile.navigationItemIds.map(navigationItem),
    selection: state.selection,
    chat: {
      companion: { name: state.companionDisplayName },
      title: state.title,
      transcript: [...state.transcript],
      draft: {
        revision: state.draft.revision,
        present: state.draft.text !== null,
      },
      turn: state.turn,
      worldInfo: null,
    },
    memory: {
      readAvailable: false,
      mutationAvailable: false,
      projectionRevision: null,
    },
    eventStream:
      tavernProfile.routeIds.includes("events") && state.eventStream !== null
        ? state.eventStream
        : null,
  };
  if (
    !TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(snapshot) ||
    snapshot.build.profileId !== options.profile.tavernProfile.profileId
  ) {
    throw new Error("composed_reference_game_chat_snapshot_invalid");
  }
  return snapshot as TavernStateSnapshotV1;
}

function navigationItem(itemId: string) {
  if (itemId === "chat")
    return {
      itemId,
      labelKey: "tavern.nav.chat" as const,
      availability: "available" as const,
    };
  return {
    itemId,
    labelKey: "tavern.nav.memory" as const,
    availability: "unavailable" as const,
  };
}