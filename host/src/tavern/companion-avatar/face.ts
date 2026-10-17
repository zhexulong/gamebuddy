import type { IncomingMessage, ServerResponse } from "node:http";

import { SECURITY_HEADERS } from "../static-artifact/index.js";
import type { CompanionAvatarService } from "./index.js";

/**
 * The runtime asset face: one companion's picture, addressed by the opaque
 * handle the roster handed out.
 *
 * The declared browser contract already names this path space
 * (`TavernBrowserContractV1.static.assets`, `GET /assets/:assetPath`), and the
 * frozen build tree serves everything else under `/assets/`. This face exists
 * because an avatar cannot live in that tree: the tree is verified as a build
 * artifact (a sha256 per asset, enumerated before any handler exists), while an
 * avatar is user data that appears exactly when a card is imported.
 *
 * So it repeats the static face's defensive shape - one closed path space, a
 * refusal of `%`/`?`/`#`, the same security headers, no directory listing, no
 * general file serving - and drops the manifest machinery, which has nothing to
 * verify here: the bytes are not ours to have hashed at build time.
 *
 * `auth: "none"` is the owner's decision, recorded here rather than left
 * implicit: the file is the player's own picture, inside the player's own
 * profile root, served on a loopback listener the product itself started, and
 * the only way to name it is a per-mount HMAC handle the roster minted. There is
 * nothing behind this face an unauthenticated peer could not already read from
 * the same user account's disk.
 */
export const COMPANION_AVATAR_ROUTE_PREFIX = "/assets/companions/" as const;

const AVATAR_PATH_PATTERN = /^\/assets\/companions\/([A-Za-z0-9_-]{22,128})\/avatar\.png$/u;

/**
 * Whether a raw request URL is inside this face's one path space.
 *
 * Exported because the listener that mounts this face has to decide whether a
 * request belongs to it or to the frozen build tree, and that decision must be
 * the same one this module makes. It is deliberately a prefix test over the RAW
 * url (the same string `serve` reads): anything that does not start here is not
 * ours, and anything that does is either the one avatar shape or a 404 from this
 * face - never a fallback that would serve a different file.
 */
export function ownsCompanionAvatarRequest(rawUrl: string | undefined): rawUrl is string {
  return rawUrl !== undefined && rawUrl.startsWith(COMPANION_AVATAR_ROUTE_PREFIX);
}

export type CompanionAvatarRequestHandler = Readonly<{
  handle(request: IncomingMessage, response: ServerResponse): void;
}>;

export function createCompanionAvatarRequestHandler(service: CompanionAvatarService): CompanionAvatarRequestHandler {
  return Object.freeze({
    handle(request, response) {
      void serve(service, request, response).catch((error: unknown) => {
        // An unexpected failure is a Host fault. It must not read as "she has no
        // picture", which is what a silent 404 would say.
        reportUnreadable(request.url, error);
        sendStatus(response, 500);
      });
    },
  });
}

async function serve(
  service: CompanionAvatarService,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const rawUrl = request.url;
  if (!ownsCompanionAvatarRequest(rawUrl)) return sendStatus(response, 404);
  // The method is refused for a path this face owns, and only for such a path: a
  // POST to a path outside the avatar space is not this face's to answer.
  if (request.method !== "GET") return sendStatus(response, 405, { Allow: "GET" });
  // `%` would let an encoded dot or slash reach the filesystem, and `?`/`#`
  // would make the URL name something other than the one file. The static face
  // refuses the same three, and for the same reason: the URL must name exactly
  // the one byte string this face looked up.
  if (rawUrl.includes("?") || rawUrl.includes("#") || rawUrl.includes("%")) return sendStatus(response, 404);
  const match = AVATAR_PATH_PATTERN.exec(rawUrl);
  if (match === null) return sendStatus(response, 404);
  let read;
  try {
    read = await service.read(match[1]!);
  } catch (error) {
    reportUnreadable(rawUrl, error);
    return sendStatus(response, 500);
  }
  // `null` is a handle the roster never projected; `absent` is a roster
  // companion who simply has no picture. Both are an ordinary 404 that the UI
  // answers with the monogram - there is nothing to distinguish for the player,
  // and nothing about either is an error.
  if (read === null || read.state === "absent") return sendStatus(response, 404);
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    "Content-Type": "image/png",
    // The URL names one companion, and a companion's identity is minted once per
    // provision: a re-import creates a NEW companion namespace and therefore a
    // NEW handle, so the bytes behind a given URL are written once and never
    // change under it. Immutable caching is the honest header for that, and it
    // is also what keeps a roster of cards from re-fetching every picture.
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": String(read.bytes.length),
  });
  response.end(read.bytes);
}

function sendStatus(response: ServerResponse, status: number, headers: Readonly<Record<string, string>> = {}): void {
  if (response.writableEnded) return;
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    ...headers,
    // A refusal is never cached: an avatar that appears after a re-import must
    // not stay invisible behind a remembered 404.
    "Cache-Control": "no-store",
    "Content-Length": "0",
  });
  response.end();
}

function reportUnreadable(rawUrl: string | undefined, error: unknown): void {
  const reason = (error instanceof Error ? error.message : String(error)).replace(/[\r\n]/gu, " ").slice(0, 200);
  process.stderr.write(`[companion-avatar] unreadable url=${rawUrl ?? ""} reason=${reason}\n`);
}
