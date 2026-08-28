/**
 * Versioned composed client boundary for the frozen
 * `composed_reference_game_browser_api/v1` broker contract.
 *
 * This module provides a browser-side fetch client that talks to the composed
 * broker endpoints (`/api/composed-reference-game/v1/`). It validates every
 * server response against the strict composed root schema and extracts the
 * nested validated Chat snapshot (`root.chat`) for use with the existing
 * `ReferencePipelineSession` reducer.
 *
 * Chat operations (submit, cancel, events, submission_status) remain
 * delegated to the existing `tavern_browser_api/v1` reference-pipeline
 * client; this module owns only the composed bootstrap and state read.
 */

import {
  ComposedReferenceGameBrowserValidatorsV1,
  type ComposedReferenceGameBrowserRootV1,
} from "./composed-browser-contract/index.js";

// ─── API identity ───────────────────────────────────────────────────────────

const COMPOSED_REFERENCE_GAME_API_V1 = "composed_reference_game_browser_api/v1" as const;
const COMPOSED_REFERENCE_GAME_API_VERSION = 1 as const;

// ─── Error types ────────────────────────────────────────────────────────────

export class ComposedReferenceGameProtocolError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`Composed reference game protocol error: ${reason}`);
    this.name = "ComposedReferenceGameProtocolError";
    this.reason = reason;
  }
}

export class ComposedReferenceGameProblemError extends Error {
  readonly code: string;
  readonly status: number;
  readonly requestId: string;
  constructor(code: string, status: number, requestId: string) {
    super(`Composed reference game problem: ${code}`);
    this.name = "ComposedReferenceGameProblemError";
    this.code = code;
    this.status = status;
    this.requestId = requestId;
  }
}

// ─── Client interface ───────────────────────────────────────────────────────

export type StardewCabinChoiceV1 = Readonly<{
  displayLabel: string;
  availability: "available";
  choiceHandle: string;
  expiresAtMs: number;
}>;

export type StardewCabinChoicesV1 = Readonly<{ apiVersion: 1; choices: readonly StardewCabinChoiceV1[] }>;
export type StardewCabinConfirmationRequestV1 = Readonly<{
  apiVersion: 1;
  idempotencyKey: string;
  choiceHandle: string;
  confirmed: true;
}>;
export type StardewCabinConfirmationV1 = Readonly<{ apiVersion: 1; status: "manifest_admitted" }>;

export type ComposedReferenceGameBrowserClient = Readonly<{
  /**
   * Bootstrap with the composed broker. Returns the validated composed root
   * which contains the nested Chat snapshot (`root.chat`).
   */
  bootstrap(bootToken: string): Promise<ComposedReferenceGameBrowserRootV1>;

  /**
   * Read the current composed state through the session cookie. Returns the
   * validated composed root with the current Chat snapshot.
   */
  readState(): Promise<ComposedReferenceGameBrowserRootV1>;
  readStardewCabins(): Promise<StardewCabinChoicesV1>;
  confirmStardewCabin(request: StardewCabinConfirmationRequestV1): Promise<StardewCabinConfirmationV1>;
}>;

// ─── Client factory ─────────────────────────────────────────────────────────

/**
 * Creates a composed reference game browser client that talks to the exact
 * same-origin composed broker endpoints. The client uses `credentials:
 * "same-origin"` so the HttpOnly Strict session cookie set by the bootstrap
 * response is included in all subsequent requests.
 */
export function createComposedReferenceGameBrowserClient(): ComposedReferenceGameBrowserClient {
  const bootstrapPath = "/api/composed-reference-game/v1/bootstrap";
  const statePath = "/api/composed-reference-game/v1/state";
  const stardewCabinsPath = "/api/composed-reference-game/v1/game/stardew/cabins";
  const stardewCabinConfirmPath = `${stardewCabinsPath}/confirm`;

  async function fetchJson(
    url: string,
    options: Readonly<{
      method: string;
      headers?: Readonly<Record<string, string>>;
      body?: string;
    }>,
  ): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(url, {
        method: options.method,
        headers: { ...options.headers },
        body: options.body,
        credentials: "same-origin",
      });
    } catch (error) {
      throw new ComposedReferenceGameProtocolError(
        error instanceof Error ? error.message : "network_error",
      );
    }

    if (!response.ok) {
      let problem: unknown;
      try {
        problem = await response.json();
      } catch {
        throw new ComposedReferenceGameProtocolError("non_json_problem");
      }
      if (
        typeof problem === "object" &&
        problem !== null &&
        typeof (problem as Record<string, unknown>).code === "string"
      ) {
        const p = problem as { code: string; requestId?: string };
        throw new ComposedReferenceGameProblemError(
          p.code,
          response.status,
          p.requestId ?? "unknown",
        );
      }
      throw new ComposedReferenceGameProtocolError("unknown_problem");
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new ComposedReferenceGameProtocolError("non_json_response");
    }

    return body;
  }

  function validateComposedRoot(value: unknown): ComposedReferenceGameBrowserRootV1 {
    if (!ComposedReferenceGameBrowserValidatorsV1.ComposedReferenceGameBrowserRootV1Schema.Check(value)) {
      throw new ComposedReferenceGameProtocolError("invalid_composed_root");
    }
    return value as ComposedReferenceGameBrowserRootV1;
  }

  const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);
  const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]) =>
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const isCanonicalUnpaddedBase64Url = (value: string): boolean => {
    if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return false;
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const finalValue = alphabet.indexOf(value[value.length - 1]!);
    return value.length % 4 === 0 ||
      (value.length % 4 === 2 ? finalValue % 16 === 0 : finalValue % 4 === 0);
  };
  const isCanonicalBase64UrlBytes = (value: unknown, byteLength: number): value is string =>
    typeof value === "string" &&
    value.length === Math.ceil(byteLength * 8 / 6) &&
    isCanonicalUnpaddedBase64Url(value);
  const isChoiceHandle = (value: unknown): value is string => isCanonicalBase64UrlBytes(value, 32);
  const isIdempotencyKey = (value: unknown): value is string => isCanonicalBase64UrlBytes(value, 16);

  function validateCabinChoices(value: unknown): StardewCabinChoicesV1 {
    if (!isRecord(value) || !hasExactKeys(value, ["apiVersion", "choices"]) || value.apiVersion !== 1 || !Array.isArray(value.choices) || value.choices.length > 64) {
      throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_choices");
    }
    for (const choice of value.choices) {
      if (!isRecord(choice) ||
          !hasExactKeys(choice, ["displayLabel", "availability", "choiceHandle", "expiresAtMs"]) ||
          typeof choice.displayLabel !== "string" || choice.displayLabel.length === 0 || choice.displayLabel.length > 128 ||
          choice.availability !== "available" || !isChoiceHandle(choice.choiceHandle) ||
          typeof choice.expiresAtMs !== "number" || !Number.isSafeInteger(choice.expiresAtMs) || choice.expiresAtMs < 0) {
        throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_choice");
      }
    }
    return value as StardewCabinChoicesV1;
  }

  function validateCabinConfirmation(value: unknown): StardewCabinConfirmationV1 {
    if (!isRecord(value) || !hasExactKeys(value, ["apiVersion", "status"]) || value.apiVersion !== 1 || value.status !== "manifest_admitted") {
      throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_confirmation");
    }
    return value as StardewCabinConfirmationV1;
  }

  let csrfToken: string | undefined;
  return Object.freeze({
    async bootstrap(bootToken: string): Promise<ComposedReferenceGameBrowserRootV1> {
      const body = JSON.stringify({
        apiVersion: COMPOSED_REFERENCE_GAME_API_VERSION,
        bootstrapToken: bootToken,
      });
      const raw = await fetchJson(bootstrapPath, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
      });
      const root = validateComposedRoot(raw);
      csrfToken = root.chat.csrfToken;
      return root;
    },

    async readState(): Promise<ComposedReferenceGameBrowserRootV1> {
      const raw = await fetchJson(statePath, { method: "GET" });
      const root = validateComposedRoot(raw);
      csrfToken = root.chat.csrfToken;
      return root;
    },

    async readStardewCabins(): Promise<StardewCabinChoicesV1> {
      return validateCabinChoices(await fetchJson(stardewCabinsPath, { method: "GET" }));
    },

    async confirmStardewCabin(request: StardewCabinConfirmationRequestV1): Promise<StardewCabinConfirmationV1> {
      if (!hasExactKeys(request as Record<string, unknown>, ["apiVersion", "idempotencyKey", "choiceHandle", "confirmed"]) ||
          request.apiVersion !== 1 || !isIdempotencyKey(request.idempotencyKey) ||
          !isChoiceHandle(request.choiceHandle) || request.confirmed !== true) {
        throw new ComposedReferenceGameProtocolError("invalid_stardew_cabin_confirmation_request");
      }
      if (csrfToken === undefined) {
        throw new ComposedReferenceGameProtocolError("missing_composed_session");
      }
      return validateCabinConfirmation(await fetchJson(stardewCabinConfirmPath, {
        method: "POST",
        headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
        body: JSON.stringify(request),
      }));
    },
  });
}