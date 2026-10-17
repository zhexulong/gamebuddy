import { useState, type ReactElement } from "react";

/**
 * A companion's picture, or her monogram where there is no picture.
 *
 * The monogram is the FALLBACK, not the design. The roster row and the message
 * bubble both draw her name beside this element, so the picture is decoration on
 * those surfaces and an absent, unreadable or undecodable one must land back on
 * the same monogram rather than on a broken-image glyph. That is why the two
 * live in ONE element and one component: a `404` (no picture, or a handle no
 * roster projected) and a decode failure are the same player-visible fact, and a
 * second component for the picture case would be a second place for them to
 * disagree.
 *
 * `aria-hidden` throughout, and deliberately: the name is adjacent everywhere
 * this is used, so the picture must never become a second accessible name for
 * the same row - and it is never the ONLY name.
 *
 * The address is the Host's own (`host/src/tavern/companion-avatar/face.ts`),
 * mirrored here the way every other wire shape is.
 */
export function CompanionAvatar({
  handle,
  name,
  className,
}: {
  /**
   * The companion's own opaque roster handle, or `null` for a row that has no
   * companion at all (the player's side of the transcript), which is a monogram
   * and nothing else.
   */
  handle: string | null;
  name: string;
  /** The existing monogram's own size class, e.g. `avatar-small`. */
  className: string;
}): ReactElement {
  // Tracked per handle rather than as a boolean: the same row renders another
  // companion after a roster refresh or a Chat switch, and a picture that failed
  // for one must not suppress the next one's.
  const [failedHandle, setFailedHandle] = useState<string | null>(null);
  const initial = (Array.from(name)[0] ?? "").toUpperCase();
  return (
    <div className={`avatar ${className}`} aria-hidden="true">
      {handle === null || failedHandle === handle ? (
        initial
      ) : (
        <img
          className="avatar-image"
          src={`/assets/companions/${handle}/avatar.png`}
          alt=""
          decoding="async"
          onError={() => setFailedHandle(handle)}
        />
      )}
    </div>
  );
}
