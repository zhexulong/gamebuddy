import { createServer, type Server } from "node:http";

import {
  createComposedReferenceGameBrowserRequestHandler,
  type ComposedReferenceGameBrowserLifecycleActivationAdmission,
  type ComposedReferenceGameBrowserLifecycleActivationBindingSink,
  type ComposedReferenceGameBrowserReadContext,
} from "../composed-reference-game-browser.js";
import { createReferencePipelineDialogueWebDelegatedHandler } from "../reference-pipeline-dialogue-web.delegated.js";
import {
  createTavernManagementDialogueWebDelegatedHandler,
  type TavernManagementDelegatedHandler,
  type TavernManagementDelegatedOptions,
} from "../tavern-management-dialogue-web.delegated.js";
import {
  TAVERN_BROWSER_API_V1,
  TavernBrowserContractV1,
  TavernBrowserValidatorsV1,
  type ComposedTavernProfile,
} from "./browser-contract/index.js";
import type { ChatEventStream } from "./chat-event-stream.js";
import type { ChatPipelineService } from "./chat-pipeline-service.js";
import type { ReferencePipelineStateFacade } from "./reference-pipeline-state.js";
import type { WindowsReparseInspectorCapability } from "../windows-reparse-inspector/index.js";
import type { ComposedReferenceGameBrowserProfile } from "../composed-browser-contract/index.js";
import type {
  GameBrowserStateV1,
  GameLaunchCommandV1,
  GameResumeCommandV1,
  GameResumeResultV1,
  GameSessionResumeCommandV1,
} from "../game-browser-contract/index.js";
import type { TavernStateSnapshotV1 } from "./browser-contract/index.js";
import {
  createTavernStaticArtifactRequestHandler,
  TAVERN_BROWSER_CONTRACT,
  type TavernStaticArtifactIdentity,
  verifyTavernStaticArtifact,
} from "./static-artifact/index.js";
import { ownsCompanionAvatarRequest, type CompanionAvatarRequestHandler } from "./companion-avatar/face.js";

const LOOPBACK_HOST = "127.0.0.1";

/**
 * The immutable browser artifact is versioned independently from the mounted
 * composed API profile. The composed reference-game profile must not
 * introduce a second static identity or a second listener.
 */
const COMPOSED_REFERENCE_GAME_BROWSER_ARTIFACT_IDENTITY: TavernStaticArtifactIdentity = Object.freeze({
  browserContract: TAVERN_BROWSER_CONTRACT,
  profileId: "gamebuddy.tavern.browser.v1",
});

export type ComposedReferenceGameStaticShellCompositionOptions = Readonly<{
  profile: ComposedReferenceGameBrowserProfile;
  bootstrapToken: string;
  readGame?: (context: ComposedReferenceGameBrowserReadContext) => Promise<GameBrowserStateV1>;
  referenceStateFacade: ReferencePipelineStateFacade;
  pipelineService?: ChatPipelineService;
  eventStream?: ChatEventStream;
  /**
   * The management domains the shell's Chats/Characters/Game/Settings/Memory
   * World Info panels read and write, on the management profile that declares
   * them (design/104 §2, design/26 §4.2). When every route the profile declares
   * has its exact bound service, a delegated management dispatcher is mounted
   * under `/api/tavern/v1/`; a profile that advertises a route without the
   * service that owns it fails closed before the listener starts (design/26 §1),
   * never a disabled lookalike. The caller supplies the domains and the profile;
   * this listener's own broker mints the admission capability they run under, so
   * it is never supplied from outside.
   */
  management?: Omit<TavernManagementDelegatedOptions, "capability">;
  artifactRoot: string;
  inspector?: WindowsReparseInspectorCapability;
  /**
   * The runtime asset face for companion avatars. When absent, nothing under
   * `/assets/companions/` is served at all - the frozen build tree owns the
   * whole `/assets/` space and answers 404 there, which is the honest state for
   * a Host that was given no avatar read.
   */
  companionAvatar?: CompanionAvatarRequestHandler;
  lifecycleActivationBindingSink?: ComposedReferenceGameBrowserLifecycleActivationBindingSink;
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
  const readChat = async (context: ComposedReferenceGameBrowserReadContext): Promise<TavernStateSnapshotV1> =>
    projectComposedChatSnapshot(options, context);
  const composedHandler = createComposedReferenceGameBrowserRequestHandler({
    profile: options.profile,
    bootstrapToken: options.bootstrapToken,
    readChat,
    ...(options.readGame === undefined ? {} : { readGame: options.readGame }),
    ...(options.lifecycleActivationBindingSink === undefined ||
    options.lifecycleActivationBindingSink.activate === undefined
      ? {}
      : {
          gameActivate: async (admission: ComposedReferenceGameBrowserLifecycleActivationAdmission): Promise<void> => {
            // The owner's private activation snapshot stops here: the browser learns the
            // staged state from the game state projection, not from a lifecycle DTO.
            await options.lifecycleActivationBindingSink!.activate!(admission);
          },
        }),
    ...(options.lifecycleActivationBindingSink?.setupPlayerHost === undefined
      ? {}
      : {
          gameSetup: options.lifecycleActivationBindingSink.setupPlayerHost.bind(
            options.lifecycleActivationBindingSink,
          ),
        }),
    ...(options.lifecycleActivationBindingSink?.launchPlayerHost === undefined
      ? {}
      : {
          gameLaunch: async (
            admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
            command: GameLaunchCommandV1,
          ): Promise<void> => {
            await options.lifecycleActivationBindingSink!.launchPlayerHost!(admission, command);
          },
        }),
    ...(options.lifecycleActivationBindingSink?.stopGame === undefined
      ? {}
      : { gameStop: options.lifecycleActivationBindingSink.stopGame.bind(options.lifecycleActivationBindingSink) }),
    ...(options.lifecycleActivationBindingSink?.disconnectGame === undefined
      ? {}
      : {
          gameDisconnect: options.lifecycleActivationBindingSink.disconnectGame.bind(
            options.lifecycleActivationBindingSink,
          ),
        }),
    ...(options.lifecycleActivationBindingSink?.endgameGame === undefined
      ? {}
      : {
          gameEndgame: options.lifecycleActivationBindingSink.endgameGame.bind(options.lifecycleActivationBindingSink),
        }),
    ...(options.lifecycleActivationBindingSink?.reopenActionAuthority === undefined
      ? {}
      : {
          gameReopen: options.lifecycleActivationBindingSink.reopenActionAuthority.bind(
            options.lifecycleActivationBindingSink,
          ),
        }),
    // The composed wire command is strictly session-less; the coordinator resume
    // seam is session-keyed (GameSessionResumeCommandV1). Without a session
    // handle on the wire the coordinator resolves no registered world binding
    // and fails closed as unavailable; the session-selected resume wiring is
    // the Slice 3 B-path work. Wiring the adapter is still mandatory so the
    // profile declaration and the handler options stay consistent (mismount
    // guard), and it bridges the current declared-but-unwired gap.
    ...(options.lifecycleActivationBindingSink?.resume === undefined
      ? {}
      : {
          gameResume: async (
            admission: ComposedReferenceGameBrowserLifecycleActivationAdmission,
            command: GameResumeCommandV1,
          ): Promise<GameResumeResultV1> =>
            options.lifecycleActivationBindingSink!.resume!(
              admission,
              command as unknown as GameSessionResumeCommandV1,
            ),
        }),
    ...(options.lifecycleActivationBindingSink?.createGameSession === undefined
      ? {}
      : {
          gameCreate: options.lifecycleActivationBindingSink.createGameSession.bind(
            options.lifecycleActivationBindingSink,
          ),
        }),
    ...(options.lifecycleActivationBindingSink?.cancelResume === undefined
      ? {}
      : {
          gameResumeCancel: options.lifecycleActivationBindingSink.cancelResume.bind(
            options.lifecycleActivationBindingSink,
          ),
        }),
    ...(options.lifecycleActivationBindingSink?.gameDiscovery === undefined
      ? {}
      : {
          gameDiscovery: Object.freeze({
            read: options.lifecycleActivationBindingSink.gameDiscovery.read.bind(
              options.lifecycleActivationBindingSink.gameDiscovery,
            ),
            confirm: options.lifecycleActivationBindingSink.gameDiscovery.confirm.bind(
              options.lifecycleActivationBindingSink.gameDiscovery,
            ),
            retry: options.lifecycleActivationBindingSink.gameDiscovery.retry.bind(
              options.lifecycleActivationBindingSink.gameDiscovery,
            ),
            cancel: options.lifecycleActivationBindingSink.gameDiscovery.cancel.bind(
              options.lifecycleActivationBindingSink.gameDiscovery,
            ),
            manualPicker: options.lifecycleActivationBindingSink.gameDiscovery.manualPicker.bind(
              options.lifecycleActivationBindingSink.gameDiscovery,
            ),
          }),
        }),
    ...(options.lifecycleActivationBindingSink === undefined ||
    (options.lifecycleActivationBindingSink.readCabinChoices === undefined &&
      options.lifecycleActivationBindingSink.confirmCabinChoice === undefined)
      ? {}
      : options.lifecycleActivationBindingSink.readCabinChoices !== undefined &&
          options.lifecycleActivationBindingSink.confirmCabinChoice !== undefined
        ? {
            stardewCabins: Object.freeze({
              read: options.lifecycleActivationBindingSink.readCabinChoices.bind(
                options.lifecycleActivationBindingSink,
              ),
              confirm: options.lifecycleActivationBindingSink.confirmCabinChoice.bind(
                options.lifecycleActivationBindingSink,
              ),
            }),
          }
        : (() => {
            throw new Error("composed_reference_game_cabin_operations_mismounted");
          })()),
  });
  const referenceHandler = createReferencePipelineDialogueWebDelegatedHandler({
    profile: options.profile.tavernProfile,
    referenceStateFacade: options.referenceStateFacade,
    ...(options.pipelineService === undefined ? {} : { pipelineService: options.pipelineService }),
    ...(options.eventStream === undefined ? {} : { eventStream: options.eventStream }),
    capability: composedHandler.delegatedAuthCapability,
  });
  // The management domains' delegated dispatcher, mounted only when its
  // services are injected. It is the same dispatcher the standalone
  // tavern_management shell serves, so every management route that shell serves
  // - Chats, drafts, Memory, World Info, Settings, Characters, Persona /
  // Scenario / Greeting, retention and the reviewed card-import stages - is
  // served here from the same durable state. Its routes do not overlap the
  // reference handler's Chat routes, so the two dispatchers share the same
  // `/api/tavern/v1/` prefix without ambiguity.
  const managementHandler: TavernManagementDelegatedHandler | undefined =
    options.management === undefined
      ? undefined
      : createTavernManagementDialogueWebDelegatedHandler({
          ...options.management,
          capability: composedHandler.delegatedAuthCapability,
        });
  const managementProfile = options.management?.profile;
  // Whichever profile declares a /api/tavern/v1/ route owns it. The Chat
  // dispatcher keeps the routes of the frozen reference Chat contract
  // (bootstrap, state, draft read, the turn operations and the event stream) and
  // the management dispatcher serves the rest; `state.read` and `draft.read`
  // are declared by both and stay with the Chat dispatcher, which owns the one
  // root snapshot the composed broker projects. Both route sets come from the
  // one browser contract, so this routing can never drift from the profiles.
  const servesManagementRoute = (method: string | undefined, pathname: string): boolean =>
    managementHandler !== undefined &&
    managementProfile !== undefined &&
    declaresRoute(managementProfile, method, pathname) &&
    !declaresRoute(options.profile.tavernProfile, method, pathname);
  try {
    options.lifecycleActivationBindingSink?.bindBrowserAdmissionIssuer(composedHandler.lifecycleActivationIssuer);
  } catch (bindError) {
    const cleanup = await Promise.allSettled([
      composedHandler.close(),
      referenceHandler.close(),
      managementHandler?.close(),
    ]);
    const cleanupErrors = cleanup.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (cleanupErrors.length > 0) {
      throw new AggregateError([bindError, ...cleanupErrors], "composed_reference_game_lifecycle_bind_cleanup_failed");
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
    } else if (pathname.startsWith("/api/tavern/") && servesManagementRoute(request.method, pathname)) {
      managementHandler?.handle(request, response, origin);
    } else if (pathname.startsWith("/api/tavern/")) {
      referenceHandler.handle(request, response, origin);
    } else if (options.companionAvatar !== undefined && ownsCompanionAvatarRequest(request.url)) {
      // The runtime avatar face owns exactly `/assets/companions/`, which the
      // frozen build tree could only ever 404. The ownership test reads the RAW
      // url, the same string the face itself reads.
      options.companionAvatar.handle(request, response);
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
      const managementDrain = managementHandler?.close();
      server.closeAllConnections();
      await closeServer(server);
      await composedDrain;
      await referenceDrain;
      await managementDrain;
    },
  });
}

/**
 * True when the profile declares the browser-contract route whose method and
 * path match this request: the exact route set the profile advertises, so the
 * routes the shell serves and the routes a profile declares can never drift
 * apart. A `:param` segment matches any one non-empty path segment; the
 * dispatcher behind this classification still validates the exact handle shape
 * and answers 404 for anything it does not own.
 */
function declaresRoute(profile: ComposedTavernProfile, method: string | undefined, pathname: string): boolean {
  return TavernBrowserContractV1.routes.some(
    (route) =>
      profile.routeIds.includes(route.routeId) && route.method === method && pathMatchesRoute(route.path, pathname),
  );
}

function pathMatchesRoute(routePath: string, pathname: string): boolean {
  const expected = routePath.split("/");
  const actual = pathname.split("/");
  return (
    expected.length === actual.length &&
    expected.every((segment, index) =>
      segment.startsWith(":") ? actual[index] !== undefined && actual[index] !== "" : segment === actual[index],
    )
  );
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
      companion: { name: state.companionDisplayName, handle: state.companionHandle },
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
    // The additive optional v1 `voice` field belongs to the SNAPSHOT, exactly where
    // the reference projection puts it: the contract's `chat` object is a strict object
    // of six named fields and does not accept a seventh, while `voice` is an optional
    // union on the snapshot that also accepts null. Writing it inside `chat` therefore
    // made every non-null Chat snapshot fail its own validator: the composed bootstrap
    // consumed its one-shot token and answered `state_unavailable`, and every retry
    // answered `unauthorized`, so the launch could only report that it did not open.
    // Projected only when a Host voice surface is attached; absent means no mic icon.
    ...(state.voice === null ? {} : { voice: state.voice }),
    eventStream: tavernProfile.routeIds.includes("events") && state.eventStream !== null ? state.eventStream : null,
  };
  if (
    !TavernBrowserValidatorsV1.TavernStateSnapshotV1Schema.Check(snapshot) ||
    snapshot.build.profileId !== options.profile.tavernProfile.profileId
  ) {
    throw new Error("composed_reference_game_chat_snapshot_invalid");
  }
  // The validator above is what establishes this shape at runtime; the assertion
  // is only how the literal's inferred type reaches the contract's nominal one,
  // and it goes through `unknown` so it cannot silently widen to a near-miss.
  return snapshot as unknown as TavernStateSnapshotV1;
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
