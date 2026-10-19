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
 *
 * **Caching, and why it is not `immutable`.** The URL is stable for a companion -
 * one handle, one `avatar.png` - but the BYTES behind it are not: the player may
 * replace her picture at that same URL. `immutable` claimed the opposite ("written
 * once and never change under it"), and a browser that believed it would draw the
 * old picture for a year after an upload. So the face answers `no-cache` - the
 * honest header for a mutable resource, meaning "revalidate before you use it" -
 * and publishes the digest of the bytes it just read as the `ETag`. A browser
 * that already holds the picture comes back with `If-None-Match` and gets a
 * bodiless `304` when it is unchanged, or this `200` with the new bytes when it is
 * not. That is also what the client sends: no URL rewriting, no cache-busting
 * query (this face refuses a query string on purpose), and no version plumbing
 * through every surface that draws her.
 */
const COMPANION_AVATAR_ROUTE_PREFIX = "/assets/companions/" as const;

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

/**
 * The face's own view of the picture service: it reads, and nothing else. It is
 * deliberately narrower than `CompanionAvatarService` (which also writes) because the
 * player's upload reaches the file through the management route, never through a face
 * whose whole job is to serve bytes at a stable URL.
 */
export function createCompanionAvatarRequestHandler(
  service: Pick<CompanionAvatarService, "read">,
): CompanionAvatarRequestHandler {
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
  service: Pick<CompanionAvatarService, "read">,
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
  const etag = `"${read.digest}"`;
  const headers = {
    ...SECURITY_HEADERS,
    "Content-Type": "image/png",
    "Cache-Control": "no-cache",
    ETag: etag,
  };
  // Nothing changed for a browser that already holds this exact picture, and a
  // bodiless 304 is what says so. A replaced picture has a different digest, so
  // the same conditional request takes the 200 below with the new bytes: the old
  // picture cannot survive an upload.
  if (matchesEtag(request.headers["if-none-match"], etag)) return void response.writeHead(304, headers).end();
  response.writeHead(200, { ...headers, "Content-Length": String(read.bytes.length) });
  response.end(read.bytes);
}

/**
 * Whether a conditional request already holds exactly this picture.
 *
 * `If-None-Match` is a list of entity-tags, and a browser sends the one it stored;
 * `*` asks whether the resource exists at all, which for a read that just produced
 * these bytes is the same answer. A weak tag (`W/"…"`) is deliberately not
 * honoured: this face never sends one, and matching it as a strong tag would claim
 * a byte identity the caller did not assert.
 */
function matchesEtag(header: string | string[] | undefined, etag: string): boolean {
  if (typeof header !== "string") return false;
  return header.split(",").some((candidate) => candidate.trim() === etag || candidate.trim() === "*");
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
