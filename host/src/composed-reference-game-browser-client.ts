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
      return validateComposedRoot(raw);
    },

    async readState(): Promise<ComposedReferenceGameBrowserRootV1> {
      const raw = await fetchJson(statePath, { method: "GET" });
      return validateComposedRoot(raw);
    },
  });
}