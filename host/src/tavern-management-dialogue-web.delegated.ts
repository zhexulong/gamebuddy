/**
 * INTERNAL delegated tavern-management dispatcher for the composed reference-game shell.
 *
 * The standalone management dispatcher owns its own bootstrap/session/CSRF and writes its own
 * cookie, so it cannot share the composed root's single loopback listener where the broker
 * already owns session/CSRF. This mount is that same dispatcher under `delegatedAdmission`: no
 * bootstrap, session or cookie of its own, every admission brokered through the opaque branded
 * capability minted by `composed-reference-game-browser.ts`. It therefore serves the complete
 * management route surface the mounted management profile declares - Chats, drafts, Memory,
 * World Info, Settings (voice/language/connections/model profiles), Characters (companion
 * library, Persona, Scenario, Greeting, retention) and the reviewed card-import stages - and
 * fails closed at construction for any advertised route whose exact service was not given.
 *
 * The reference delegated dispatcher keeps owning the Chat operations (bootstrap, state, draft
 * read, submit/cancel/submission-status, events); the composed static shell routes each path to
 * the dispatcher whose profile declares it.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isComposedReferenceGameBrowserDelegatedAuthCapability,
  type ComposedReferenceGameBrowserDelegatedAuthCapability,
} from "./composed-reference-game-browser.js";
import {
  createTavernManagementDialogueWebRequestHandler,
  type TavernManagementDialogueWebOptions,
} from "./tavern-management-dialogue-web.js";

export type TavernManagementDelegatedOptions = Readonly<
  Pick<
    TavernManagementDialogueWebOptions,
    | "profile"
    | "managementStateFacade"
    | "managementService"
    | "memoryService"
    | "worldInfoService"
    | "playerPreferenceStore"
    | "listVoiceOutputDevices"
    | "connectionService"
    | "modelProfileStore"
    | "libraryService"
    | "companionDetailService"
    | "companionVoiceService"
    | "newCompanionProvisioner"
    | "newChatProvisioner"
    | "chatSelectProvisioner"
    | "personaService"
    | "scenarioService"
    | "greetingService"
    | "stCardImportService"
    | "confirmStCardImport"
    | "stCardImportHistoryService"
  > & {
    /** The broker-minted opaque branded capability; anything else is rejected. */
    capability: ComposedReferenceGameBrowserDelegatedAuthCapability;
  }
>;

export type TavernManagementDelegatedHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse, origin: string): void;
  close(): Promise<void>;
}>;

export function createTavernManagementDialogueWebDelegatedHandler(
  options: TavernManagementDelegatedOptions,
): TavernManagementDelegatedHandler {
  const { capability, ...management } = options;
  if (!isComposedReferenceGameBrowserDelegatedAuthCapability(capability))
    throw new Error("tavern_management_delegated_capability_invalid");
  const handler = createTavernManagementDialogueWebRequestHandler({
    ...management,
    delegatedAdmission: Object.freeze({ capability }),
  });
  return Object.freeze({
    handle(request: IncomingMessage, response: ServerResponse, origin: string): void {
      handler.handle(request, response, origin);
    },
    close: () => handler.close(),
  });
}
